// spectral_worker.js — Pyodide host running in a Web Worker.
//
// Boots Pyodide from CDN, micropip-installs chess-spectral (>=1.7.1) and
// python-chess4d-oana-chiru (>=0.4.0), and exposes a small RPC surface to
// the main thread via spectral_bridge.js.
//
// chess-spectral 1.5.0 (released 2026-04-29) shipped the §17.1 + §17.5
// QM surface; 1.6.1 added the §16 ship-gate engine, bitboard move-gen,
// and a third legality oracle; 1.7.1 makes the engine genuinely playable
// at dense positions and restores FEN4 backward-compat:
//   - chess_spectral.qm_4d           — kinematic QM (states, observables, B_4)  [1.5+]
//   - chess_spectral.qm_4d_dynamics  — unitary moves, evolve_under_h0           [1.5+]
//   - chess_spectral.qm_4d_bridge    — §17.1 QM + §17.5 dev/debug bridge        [1.5+]
//   - chess_spectral_4d              — 4D game-state package + .bridge          [1.5+]
//   - chess_spectral.spatial_4d      — Bitboard4D, attack tables, ray tables    [1.6+]
//   - chess_spectral_4d.engine       — search core + 3 evaluators (mat/qm/spec) [1.6+]
//   - chess_spectral.engine.tournament — round-robin self-play harness          [1.6+]
//   - Discrete-Laplacian eigenbasis as 3rd legality oracle                      [1.6+]
//   - chess_spectral.frame_v5        — v5 wire format w/ XOR-stream encoding    [1.6+]
//   - SearchOptions.time_budget_ms checked MID-ITERATION                        [1.7.1, NEW]
//   - FEN4 parser accepts BOTH `Pw@x,y,z,w` and `P/w@x,y,z,w` (slash compat)    [1.7.1, NEW]
//
// Practical impact of 1.7.1 for chess4D-OC:
//   1. Engine bots return real moves at the 28-king starting position
//      within their slider budget (was: search ran for ~8 minutes, fell
//      back to v0). The M13.4.4 JS-side Promise.race hard timeout becomes
//      a defense-in-depth backstop that rarely fires.
//   2. M11.50 regression test should still pass — engine plies will now
//      complete naturally in budget (well under the 6s hard cap).
//   3. Our `_state_to_fen4` no-slash format still works; we don't have to
//      change anything to parse (we don't ingest FEN4 anyway).
//
// See docs/bridge_api.md for the wire-up plan.
//
// Protocol: { id, method, args } -> { id, ok, result } | { id, ok:false, error }
// See ~/.claude/projects/D--GitHub-chess4D-OC/memory/api-contracts.md.
//
// chess4d 0.4 API surface (referenced throughout):
//   Square4D(x, y, z, w)              — NamedTuple
//   Move4D(from_sq, to_sq, ...)       — frozen dataclass
//   GameState.push(move) / .pop()     — apply / undo (raises IllegalMoveError)
//   Board4D.occupant(sq)              — piece lookup, returns Piece | None
//   Board4D.pieces_of(color)          — iterate (sq, piece)
//   chess4d.pieces.{piece_type}_moves — pseudo-legal generators
// All adapter glue lives in the runPython block at the bottom of init().

const PYODIDE_VERSION = 'v0.26.4';
const PYODIDE_URL = `https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full/`;

importScripts(`${PYODIDE_URL}pyodide.js`);

let pyodide = null;
let status = 'loading'; // loading -> initializing -> ready | error
let initError = null;
let cachedVersions = null;
let cachedPackageStatus = null;

async function ensureInit() {
  if (pyodide) return { ready: true, versions: cachedVersions, packages: cachedPackageStatus };
  status = 'initializing';
  try {
    pyodide = await loadPyodide({
      indexURL: PYODIDE_URL,
      stdout: (msg) => console.log('[py]', msg),
      stderr: (msg) => console.warn('[py-err]', msg),
    });

    await pyodide.loadPackage('micropip');
    const micropip = pyodide.pyimport('micropip');

    // keep_going=True so a failure on one package doesn't block the others.
    // chess-spectral 1.7.1 (May 2026) adds mid-iteration time_budget_ms
    // checks in SearchOptions (search now returns within budget at all
    // positions, including the dense 28-king starting position) and
    // restores FEN4 backward-compat (parser accepts both `Pw@` and the
    // legacy `P/w@` slash form). Both improvements transparent to our
    // worker; pin bump is enough to pick them up.
    await micropip.install(
      ['chess-spectral>=1.7.1', 'python-chess4d-oana-chiru>=0.4.0'],
      true /* keep_going */
    );

    // M11.40a — chess_spectral_4d state migration (Phase A).
    //
    // This block does three things:
    //   1. Imports chess4d as before (kept for M11.40a; dropped in M11.40b).
    //   2. Probes chess_spectral_4d.GameState4D for Tier-1 API capabilities
    //      (push/pop/to_fen/iter_pieces) — logged in _API_CAPS at boot so
    //      the bridge ring buffer captures which paths are active.
    //   3. Conditionally activates GameState4D as the persistent _state when
    //      push/pop are available (Tier-1 shipped), falling back to
    //      chess4d.GameState if not. This makes M11.40a a "light up when
    //      upstream ships" PR — the default legality change (bitboard) and
    //      the deprecation warn for ?legalityOps=spatial ship immediately;
    //      the state-swap activates the moment chess-spectral 1.8 lands.
    //
    // M11.40b (follow-up) removes all chess4d imports and the fallback paths.
    pyodide.runPython(`
import chess4d
from chess4d import (
    Square4D as _Chess4D_Square4D, Move4D as _Chess4D_Move4D,
    GameState as _Chess4D_GameState, Color as _Chess4D_Color,
    PieceType as _Chess4D_PieceType, PawnAxis as _Chess4D_PawnAxis,
    Piece as _Chess4D_Piece, initial_position as _chess4d_initial_position,
    IllegalMoveError as _Chess4D_IllegalMoveError,
)
from chess4d.pieces import (
    bishop_moves as _c4d_bishop, king_moves as _c4d_king,
    knight_moves as _c4d_knight, pawn_moves as _c4d_pawn,
    queen_moves as _c4d_queen, rook_moves as _c4d_rook,
)

# --- M11.40a: API capability probe for chess_spectral_4d.GameState4D ---
# Determines which code path activates for _state construction + mutation.
# Results logged once at boot via _API_CAPS for __BRIDGE_LOG__ diagnostics.
_API_CAPS = {}
try:
    from chess_spectral_4d import GameState4D as _GS4_cls
    _API_CAPS['gs4_importable'] = True
    _API_CAPS['has_push']        = callable(getattr(_GS4_cls, 'push', None))
    _API_CAPS['has_pop']         = callable(getattr(_GS4_cls, 'pop', None))
    _API_CAPS['has_to_fen']      = callable(getattr(_GS4_cls, 'to_fen', None))
    _API_CAPS['has_iter_pieces'] = callable(getattr(_GS4_cls, 'iter_pieces', None))
    del _GS4_cls
except Exception as _e:
    _API_CAPS = {
        'gs4_importable': False, 'has_push': False, 'has_pop': False,
        'has_to_fen': False, 'has_iter_pieces': False,
        'import_error': f'{type(_e).__name__}: {_e}',
    }
_USE_GS4_STATE = bool(_API_CAPS.get('has_push') and _API_CAPS.get('has_pop'))
print(f'[py/m11.40a] _API_CAPS={_API_CAPS}  _USE_GS4_STATE={_USE_GS4_STATE}')

# Alias the symbols that vary by path so the rest of the codebase uses
# the single canonical names Square4D, Move4D, Color, PieceType,
# IllegalMoveError regardless of which package they came from.
if _USE_GS4_STATE:
    try:
        from chess_spectral_4d import (
            Square4D, Move4D, Color, PieceType,
        )
        try:
            from chess_spectral_4d import IllegalMoveError
        except ImportError:
            IllegalMoveError = _Chess4D_IllegalMoveError
    except Exception:
        # Fallback: symbols come from chess4d even if GameState4D is available.
        _USE_GS4_STATE = False
        Square4D = _Chess4D_Square4D; Move4D = _Chess4D_Move4D
        Color = _Chess4D_Color; PieceType = _Chess4D_PieceType
        IllegalMoveError = _Chess4D_IllegalMoveError
else:
    Square4D = _Chess4D_Square4D; Move4D = _Chess4D_Move4D
    Color = _Chess4D_Color; PieceType = _Chess4D_PieceType
    IllegalMoveError = _Chess4D_IllegalMoveError

# --- Piece char/gen tables (chess4d pieces.*_moves still used for explicit
# ?legalityOps=spatial opt-in; kept for M11.40a backward compat) ---
# Standard chess letter notation: knight = N (since K is the king).
_PIECE_CHAR = {
    _Chess4D_PieceType.PAWN:   'P',
    _Chess4D_PieceType.ROOK:   'R',
    _Chess4D_PieceType.KNIGHT: 'N',
    _Chess4D_PieceType.BISHOP: 'B',
    _Chess4D_PieceType.QUEEN:  'Q',
    _Chess4D_PieceType.KING:   'K',
}
# PieceType alias for char lookup — if _USE_GS4_STATE, PieceType is from
# chess_spectral_4d and may have different identity, so build a fallback map
# using .name for comparison.
def _piece_char(p):
    """Return uppercase piece char from any PieceType / piece object."""
    try:
        return _PIECE_CHAR[_Chess4D_PieceType[p.piece_type.name]]
    except (KeyError, AttributeError):
        name = getattr(getattr(p, 'piece_type', p), 'name', '').upper()
        return {'PAWN':'P','ROOK':'R','KNIGHT':'N','BISHOP':'B','QUEEN':'Q','KING':'K'}.get(name, '?')

_PIECE_GEN = {
    _Chess4D_PieceType.PAWN:   _c4d_pawn,
    _Chess4D_PieceType.ROOK:   _c4d_rook,
    _Chess4D_PieceType.KNIGHT: _c4d_knight,
    _Chess4D_PieceType.BISHOP: _c4d_bishop,
    _Chess4D_PieceType.QUEEN:  _c4d_queen,
    _Chess4D_PieceType.KING:   _c4d_king,
}

# Selects the legality oracle.
#   'bitboard'  — chess_spectral.spatial_4d.Board4D.legal_moves [DEFAULT M11.40a]
#   'phase'     — chess_spectral.phase_operators_4d Fourier oracle
#   'laplacian' — chess_spectral.spectral_legality_4d.reachable_targets_4d
#   'spatial'   — DEPRECATED; chess4d.pieces.* + state.push. Aliased to
#                 bitboard in M11.40a with a warning. Will be removed in
#                 M11.40b once chess4d dep is dropped.
_legality_ops = 'bitboard'

def _state_as_chess4d(state):
    """Return a chess4d.GameState for the given state.

    M11.40a: when _USE_GS4_STATE=True, _state is chess_spectral_4d.GameState4D
    but the chess4d.pieces.* generators still need a chess4d board. This
    helper creates a temporary chess4d state via FEN4 round-trip (only used
    for the DEPRECATED ?legalityOps=spatial explicit opt-in; the default
    bitboard path never calls this). Slow — that's why spatial is deprecated.
    M11.40b removes this function along with the chess4d dep."""
    if not _USE_GS4_STATE:
        return state  # already a chess4d.GameState
    try:
        fen4 = _state_to_fen4(state)  # uses to_fen() or hand-rolled v1
        return _chess4d_initial_position().__class__  # unreachable placeholder
    except Exception:
        pass
    # Create a fresh chess4d state and replay FEN4 via load_state fallback.
    try:
        fen4 = _state_to_fen4(state)
        from chess_spectral_4d import bridge as _b
        r = _b.load_state(fen4)
        # Can't use cs4d_bridge to get a chess4d state; attempt direct import
        # of chess4d's FEN4 parser if one exists.
        try:
            from chess4d.fen4 import load as _c4d_load
            return _c4d_load(fen4)
        except Exception:
            pass
    except Exception:
        pass
    # Last resort: return the state as-is and hope the chess4d generators
    # accept it (may work if duck-typing aligns). Logged as a warning.
    print('[py/m11.40a] WARNING: _state_as_chess4d fallback to raw state '
          '(chess4d generators may fail). Upgrade chess-spectral to 1.8+ to '
          'remove the chess4d dep and this warning.')
    return state

def _legal_moves_spatial(state, origin):
    """DEPRECATED — chess4d.pieces.* pseudo-legal generators + state.push filter.

    M11.40a: only reachable via explicit ?legalityOps=spatial URL flag.
    The default is now 'bitboard'. Will be removed in M11.40b when
    python-chess4d-oana-chiru is dropped from the micropip line."""
    c4d_state = _state_as_chess4d(state)
    piece = c4d_state.board.occupant(origin)
    if piece is None:
        return []
    gen = _PIECE_GEN.get(piece.piece_type)
    if gen is None:
        return []
    pseudo = list(gen(origin, piece.color, c4d_state.board))
    legal = []
    for m in pseudo:
        try:
            c4d_state.push(m)
        except _Chess4D_IllegalMoveError:
            continue
        c4d_state.pop()
        legal.append(m)
    return legal

def _has_legal_moves_impl(state, color):
    """True iff color has any legal move from the current state.

    Mirrors gameBoard.hasLegalMoves(team) in JS. Stops at the first
    legal move (no full enumeration). King-first ordering preserved from
    M11.16's heuristic. Dispatches on _legality_ops for the move generator;
    falls back to chess4d.pieces.* spatial oracle for compatibility."""
    # Fast path: bitboard oracle via Board4D.legal_moves is the fastest
    # when available and is the M11.40a default.
    if _legality_ops in ('bitboard', 'spatial'):  # spatial aliased
        try:
            from chess_spectral.spatial_4d import Board4D
            fen4 = _state_to_fen4(state)
            board = Board4D.from_fen(fen4)
            color_int = 0 if (color == Color.WHITE or color == _Chess4D_Color.WHITE) else 1
            # Board4D.legal_moves yields all moves; filter by side.
            # Piece ownership is encoded in from_sq's piece value.
            for m in board.legal_moves():
                piece_at_from = board.piece_at(int(m.from_sq)) if hasattr(board, 'piece_at') else None
                if piece_at_from is None:
                    # Fallback: any legal move means hasMoves=True (can't filter by color).
                    return True
                # piece_at returns (piece_char, color_int) or similar.
                if hasattr(piece_at_from, 'color'):
                    pc = int(piece_at_from.color) if hasattr(piece_at_from.color, '__int__') else (
                        0 if str(piece_at_from.color).upper() in ('WHITE', '0') else 1)
                    if pc == color_int:
                        return True
                else:
                    # Board4D doesn't expose piece_at — just return True on first move.
                    return True
            return False
        except Exception:
            pass  # fall through to chess4d spatial below

    # Spatial / fallback: chess4d.pieces.* + push/pop.
    try:
        c4d_state = _state_as_chess4d(state)
        pieces = list(c4d_state.board.pieces_of(color if not _USE_GS4_STATE else _Chess4D_Color.WHITE if (color == Color.WHITE or (hasattr(color, 'name') and color.name == 'WHITE')) else _Chess4D_Color.BLACK))
        pieces.sort(key=lambda sq_p: 0 if sq_p[1].piece_type == _Chess4D_PieceType.KING else 1)
        for sq, p in pieces:
            gen = _PIECE_GEN.get(p.piece_type)
            if gen is None:
                continue
            for m in gen(sq, p.color, c4d_state.board):
                try:
                    c4d_state.push(m)
                except _Chess4D_IllegalMoveError:
                    continue
                c4d_state.pop()
                return True
    except Exception:
        pass
    return False

def _legal_moves_bitboard(state, origin):
    """chess_spectral.spatial_4d.Board4D.legal_moves() filtered by origin.

    M11.40a: this is now the DEFAULT oracle (replaced 'spatial').
    Translates state via FEN4 round-trip into the bitboard-backed
    Board4D, enumerates legal moves, filters to ones from the queried
    origin square, and converts back to Move4D for the bridge return shape.

    Per the upstream 1.6.1 README, this oracle agrees with the spatial
    and phase oracles by construction — chess-spectral validates all
    three head-to-head. The point of having three is each is a standalone
    artifact for studying spatial motion encoding; for chess4D-OC's
    legality decisions we pick the fastest (bitboard).

    Falls back to the spatial oracle if any translation link breaks so
    callers always get a result."""
    try:
        piece = state.board.occupant(origin)
    except AttributeError:
        return []
    if piece is None:
        return []
    try:
        from chess_spectral.spatial_4d import Board4D
    except Exception:
        return _legal_moves_spatial(state, origin)
    try:
        fen4 = _state_to_fen4(state)
        board = Board4D.from_fen(fen4)
    except Exception:
        return _legal_moves_spatial(state, origin)
    origin_sq = (int(origin.x) << 9) | (int(origin.y) << 6) | (int(origin.z) << 3) | int(origin.w)
    moves = []
    try:
        for m in board.legal_moves():
            if int(m.from_sq) != origin_sq:
                continue
            ts = int(m.to_sq)
            moves.append(Move4D(
                from_sq=origin,
                to_sq=Square4D((ts >> 9) & 7, (ts >> 6) & 7, (ts >> 3) & 7, ts & 7),
            ))
    except Exception:
        return _legal_moves_spatial(state, origin)
    return moves

def _legal_moves_laplacian(state, origin):
    """Discrete-Laplacian eigenbasis legality oracle (chess-spectral 1.6.1).

    Pawn limitation: defers to bitboard (the new default) since the
    Laplacian oracle doesn't model pawn rules (direction/history-dependent
    per Oana-Chiru §3 Def 11).

    Falls back to bitboard on any translation failure so callers always
    get a result."""
    try:
        piece = state.board.occupant(origin)
    except AttributeError:
        return []
    if piece is None:
        return []
    # Pawns: defer to bitboard — Laplacian oracle doesn't model pawn rules.
    try:
        is_pawn = (piece.piece_type == PieceType.PAWN or
                   getattr(piece.piece_type, 'name', '') == 'PAWN')
    except Exception:
        is_pawn = False
    if is_pawn:
        return _legal_moves_bitboard(state, origin)
    try:
        from chess_spectral.spectral_legality_4d import reachable_targets_4d
    except Exception:
        return _legal_moves_bitboard(state, origin)
    try:
        piece_char = _piece_char(piece)
    except Exception:
        return _legal_moves_bitboard(state, origin)
    if piece_char == '?':
        return _legal_moves_bitboard(state, origin)
    origin_sq = (int(origin.x) << 9) | (int(origin.y) << 6) | (int(origin.z) << 3) | int(origin.w)
    try:
        reachable = reachable_targets_4d(piece_char, origin_sq)
    except Exception:
        return _legal_moves_bitboard(state, origin)
    # Build a temporary chess4d state for the push/pop filter if needed.
    # When _USE_GS4_STATE=True, the Laplacian oracle needs the chess4d
    # state for the push/pop leg validation.
    try:
        filter_state = _state_as_chess4d(state)
    except Exception:
        filter_state = state
    moves = []
    for to_sq_int in reachable:
        to_sq = Square4D(
            (to_sq_int >> 9) & 7,
            (to_sq_int >> 6) & 7,
            (to_sq_int >> 3) & 7,
            to_sq_int & 7,
        )
        # Cheap pre-filter: skip own-piece destinations.
        try:
            target = filter_state.board.occupant(to_sq)
            if target is not None and target.color == piece.color:
                continue
        except Exception:
            pass
        m = _Chess4D_Move4D(from_sq=_Chess4D_Square4D(int(origin.x),int(origin.y),int(origin.z),int(origin.w)),
                            to_sq=_Chess4D_Square4D(int(to_sq.x),int(to_sq.y),int(to_sq.z),int(to_sq.w)))
        try:
            filter_state.push(m)
        except _Chess4D_IllegalMoveError:
            continue
        filter_state.pop()
        moves.append(m)
    return moves

def _legal_moves_phase(state, origin):
    """chess_spectral phase-operator oracle. Returns Move4D list. The
    occupation-aware A variant already filters for own-king-not-attacked,
    so no extra state.push pass is needed. Falls back to bitboard if the
    phase module isn't importable (e.g., missing wheel) so callers always
    get a result."""
    try:
        piece = state.board.occupant(origin)
    except AttributeError:
        return []
    if piece is None:
        return []
    try:
        from chess_spectral.phase_operators_4d.occupation_aware_a_4d import (
            occupation_aware_moves_a_4d,
        )
        dests = occupation_aware_moves_a_4d(state, origin, piece)
    except Exception:
        try:
            from chess_spectral import phase_operators_4d as _po
            dests = _po.occupation_aware_moves_a_4d(state, origin, piece)
        except Exception:
            return _legal_moves_bitboard(state, origin)
    moves = []
    for d in dests:
        try:
            t = tuple(d)[:4]
        except TypeError:
            t = (
                getattr(d, 'x', None), getattr(d, 'y', None),
                getattr(d, 'z', None), getattr(d, 'w', None),
            )
        if any(v is None for v in t):
            continue
        moves.append(Move4D(from_sq=origin, to_sq=Square4D(int(t[0]), int(t[1]), int(t[2]), int(t[3]))))
    return moves

def _legal_moves_for(state, origin):
    """Dispatch on _legality_ops.

    M11.40a: DEFAULT is 'bitboard' (chess_spectral.spatial_4d.Board4D.legal_moves).
    Four oracles wireable:
      - 'bitboard'  : [DEFAULT] chess_spectral.spatial_4d.Board4D.legal_moves
      - 'phase'     : chess_spectral.phase_operators_4d Fourier oracle
      - 'laplacian' : chess_spectral.spectral_legality_4d.reachable_targets_4d
                      (pawns defer to bitboard)
      - 'spatial'   : DEPRECATED chess4d.pieces.* + state.push filter.
                      Aliased to bitboard in M11.40a. Will be removed in M11.40b.
    """
    if _legality_ops == 'phase':
        return _legal_moves_phase(state, origin)
    if _legality_ops == 'laplacian':
        return _legal_moves_laplacian(state, origin)
    if _legality_ops == 'spatial':
        # M11.40a: explicit ?legalityOps=spatial opt-in still routes through
        # chess4d.pieces.* for backward compat. Prints a one-time reminder at
        # the setLegalityOps call site. Will be removed in M11.40b.
        return _legal_moves_spatial(state, origin)
    # Default: bitboard (also the fallback for any unknown value)
    return _legal_moves_bitboard(state, origin)

def _pieces_to_dicts(state):
    """Enumerate all pieces from state as JS-friendly dicts.

    M11.40a: tries GameState4D API first if _USE_GS4_STATE; falls back
    to chess4d.GameState API. Polymorphic on state type."""
    out = []
    # Determine the color pair to iterate.
    try:
        colors = (Color.WHITE, Color.BLACK)
    except Exception:
        colors = (_Chess4D_Color.WHITE, _Chess4D_Color.BLACK)
    for color in colors:
        try:
            pieces_iter = state.board.pieces_of(color)
        except (AttributeError, TypeError):
            continue
        for sq, p in pieces_iter:
            try:
                pt_name = p.piece_type.name.lower()
            except Exception:
                pt_name = 'unknown'
            try:
                pawn_axis = p.pawn_axis.name.lower() if p.pawn_axis is not None else None
            except Exception:
                pawn_axis = None
            # team: Color.WHITE → 0, Color.BLACK → 1
            try:
                team_int = 0 if (color == Color.WHITE or
                                 color == _Chess4D_Color.WHITE or
                                 getattr(color, 'name', '') == 'WHITE') else 1
            except Exception:
                team_int = 0
            out.append({
                'x': int(sq.x), 'y': int(sq.y), 'z': int(sq.z), 'w': int(sq.w),
                'type': pt_name,
                'team': team_int,
                'pawn_axis': pawn_axis,
            })
    return out

def _state_to_fen4(state):
    """Best-effort FEN4 v1 serialization of the current state.

    M11.40a: polymorphic — works on both chess4d.GameState and
    chess_spectral_4d.GameState4D. Priority order:
      1. state.to_fen() — native method (Tier 1.3 wishlist; available
         once chess-spectral 1.8 ships it on GameState4D).
      2. Probe chess_spectral.fen_4d / chess_spectral_4d.fen_4d for
         serialize/dump/to_fen4/unparse module-level helpers.
      3. Hand-rolled v1 board-only fallback, iterating via the best
         available piece iterator (_state.board._squares for chess4d,
         _state.board.pieces_of for GameState4D).

    No side-to-move / castling rights / EP target in the output yet
    (v1 board-only); QM bridge methods only need board placement."""
    # Path 1: native to_fen() on the state object (Tier 1.3)
    if callable(getattr(state, 'to_fen', None)):
        try:
            return state.to_fen()
        except Exception:
            pass

    # Path 2: module-level serializers
    for modname in ('chess_spectral.fen_4d', 'chess_spectral_4d.fen_4d'):
        try:
            mod = __import__(modname, fromlist=['*'])
        except Exception:
            continue
        for fn in ('serialize', 'dump', 'to_fen4', 'unparse'):
            f = getattr(mod, fn, None)
            if callable(f):
                try:
                    return f(state.board)
                except Exception:
                    try:
                        return f(state)
                    except Exception:
                        pass

    # Path 3a: chess4d internal _squares dict (original hand-rolled emitter)
    if hasattr(state, 'board') and hasattr(state.board, '_squares'):
        placements = []
        for sq, p in state.board._squares.items():
            try:
                upper = _PIECE_CHAR[p.piece_type]
            except KeyError:
                upper = _piece_char(p)
            is_white = (p.color == _Chess4D_Color.WHITE or
                        getattr(p.color, 'name', '') == 'WHITE')
            char = upper if is_white else upper.lower()
            coord = f'{int(sq.x)},{int(sq.y)},{int(sq.z)},{int(sq.w)}'
            is_pawn = (p.piece_type == _Chess4D_PieceType.PAWN or
                       getattr(p.piece_type, 'name', '') == 'PAWN')
            if is_pawn and p.pawn_axis is not None:
                # FEN4 v1 pawn-axis syntax: emit "Pw@x,y,z,w" (no slash).
                # chess-spectral 1.6.1 strict parser rejected "P/w@",
                # fixed in PR #80. 1.7.1+ accepts both; emit no-slash for
                # cross-version compat.
                placements.append(f'{char}{p.pawn_axis.name.lower()}@{coord}')
            else:
                placements.append(f'{char}@{coord}')
        return '4d-fen v1: ' + '; '.join(placements)

    # Path 3b: GameState4D with pieces_of() iterator (no _squares)
    if hasattr(state, 'board') and hasattr(state.board, 'pieces_of'):
        placements = []
        try:
            colors_to_try = (Color.WHITE, Color.BLACK)
        except Exception:
            colors_to_try = (_Chess4D_Color.WHITE, _Chess4D_Color.BLACK)
        for color in colors_to_try:
            try:
                for sq, p in state.board.pieces_of(color):
                    upper = _piece_char(p)
                    is_white = (color == Color.WHITE or
                                color == _Chess4D_Color.WHITE or
                                getattr(color, 'name', '') == 'WHITE')
                    char = upper if is_white else upper.lower()
                    coord = f'{int(sq.x)},{int(sq.y)},{int(sq.z)},{int(sq.w)}'
                    is_pawn = getattr(getattr(p, 'piece_type', None), 'name', '') == 'PAWN'
                    pawn_axis = getattr(p, 'pawn_axis', None)
                    if is_pawn and pawn_axis is not None:
                        placements.append(f'{char}{pawn_axis.name.lower()}@{coord}')
                    else:
                        placements.append(f'{char}@{coord}')
            except Exception:
                pass
        return '4d-fen v1: ' + '; '.join(placements)

    raise RuntimeError(f'_state_to_fen4: cannot serialize state of type {type(state).__name__}')

def _state_to_pos4(state):
    """Convert state to {sq_idx: piece_value} for chess_spectral.encoder_4d.
    sq_idx = (x<<9)|(y<<6)|(z<<3)|w (matches chess_spectral.tables_4d.sq4).

    M11.40a: polymorphic — works on chess4d.GameState and GameState4D.
    Probes iter_pieces() (Tier 1.6 wishlist) first; falls back to _squares
    dict (chess4d) or pieces_of() (GameState4D) as available."""
    pos4 = {}

    # Path 1: native iter_pieces() — encoder-shaped directly (Tier 1.6)
    if callable(getattr(state, 'iter_pieces', None)):
        try:
            for sq_idx, piece_value in state.iter_pieces():
                pos4[int(sq_idx)] = piece_value
            return pos4
        except Exception:
            pos4 = {}

    def _add_piece(sq, p, is_white):
        idx = (int(sq.x) << 9) | (int(sq.y) << 6) | (int(sq.z) << 3) | int(sq.w)
        upper = _piece_char(p)
        char = upper if is_white else upper.lower()
        is_pawn = getattr(getattr(p, 'piece_type', None), 'name', '') == 'PAWN'
        pawn_axis = getattr(p, 'pawn_axis', None)
        if is_pawn and pawn_axis is not None:
            pos4[idx] = (char, pawn_axis.name.lower())
        else:
            pos4[idx] = char

    # Path 2: chess4d _squares dict
    if hasattr(state, 'board') and hasattr(state.board, '_squares'):
        for sq, p in state.board._squares.items():
            is_white = (p.color == _Chess4D_Color.WHITE or
                        getattr(p.color, 'name', '') == 'WHITE')
            _add_piece(sq, p, is_white)
        return pos4

    # Path 3: GameState4D pieces_of()
    if hasattr(state, 'board') and hasattr(state.board, 'pieces_of'):
        try:
            colors_to_try = (Color.WHITE, Color.BLACK)
        except Exception:
            colors_to_try = (_Chess4D_Color.WHITE, _Chess4D_Color.BLACK)
        for color in colors_to_try:
            is_white = (color == Color.WHITE or
                        color == _Chess4D_Color.WHITE or
                        getattr(color, 'name', '') == 'WHITE')
            try:
                for sq, p in state.board.pieces_of(color):
                    _add_piece(sq, p, is_white)
            except Exception:
                pass
        return pos4

    return pos4  # empty dict signals caller to handle encoder unavailable

# --- M11.40a: initial state construction ---
# When _USE_GS4_STATE=True (chess_spectral_4d.GameState4D has push/pop),
# _state IS a GameState4D — no FEN4 round-trip needed for QM calls.
# When _USE_GS4_STATE=False (chess-spectral 1.8 wishlist not yet shipped),
# _state is chess4d.GameState as before (full backward compat).
def _make_initial_state():
    """Construct the canonical initial game state.

    If _USE_GS4_STATE: try to get a GameState4D via cs4d_bridge.load_state.
    Uses a temporary chess4d initial_position() for the FEN4 string only
    (one-time bootstrap). Falls back to chess4d.initial_position() if
    GameState4D construction fails for any reason."""
    if _USE_GS4_STATE:
        try:
            from chess_spectral_4d import bridge as _cs4d_bridge
        except Exception:
            try:
                from chess_spectral import bridge as _cs4d_bridge
            except Exception:
                print('[py/m11.40a] cs4d_bridge not importable; falling back to chess4d state')
                return _chess4d_initial_position()
        try:
            _boot_fen4 = _state_to_fen4(_chess4d_initial_position())
            r = _cs4d_bridge.load_state(_boot_fen4)
            if r and r.get('ok') and r.get('state') is not None:
                print('[py/m11.40a] _state is chess_spectral_4d.GameState4D — QM round-trip eliminated')
                return r['state']
        except Exception as _e:
            print(f'[py/m11.40a] GameState4D init failed: {_e}; falling back to chess4d state')
    return _chess4d_initial_position()

# Persistent worker state — push/pop primitives.
_state = _make_initial_state()
_history_len = 0
_encoder_cache = None

# --- M11.27 / M11.40a: chess_spectral_4d.GameState4D QM state access ---
# When _USE_GS4_STATE=True: _state IS a GameState4D already — _get_qm_state_obj
# returns _state directly (no FEN4 round-trip, no cache invalidation needed).
# When _USE_GS4_STATE=False: old FEN4 round-trip path preserved verbatim.
# _qm_state_cache is (history_len, GameState4D) or None (old path only).
_qm_state_cache = None

def _get_qm_state_obj():
    """Return a chess_spectral_4d.GameState4D for QM/engine bridge calls.

    M11.40a fast-path: if _USE_GS4_STATE, _state IS the GameState4D.
    Return it directly — no serialization, no cache invalidation.
    Legacy path (chess-spectral 1.7 or earlier): FEN4 round-trip with
    history-length cache to avoid repeated serialize+parse per QM call."""
    global _qm_state_cache
    # M11.40a: direct return when _state is already a GameState4D.
    if _USE_GS4_STATE:
        return _state
    # Legacy: FEN4 round-trip path (chess4d.GameState as _state).
    if _qm_state_cache is not None and _qm_state_cache[0] == _history_len:
        return _qm_state_cache[1]
    try:
        from chess_spectral_4d import bridge as cs4d_bridge
    except Exception:
        try:
            from chess_spectral import bridge as cs4d_bridge  # type: ignore
        except Exception:
            return None
    try:
        fen4 = _state_to_fen4(_state)
        r = cs4d_bridge.load_state(fen4)
        # bridge.load_state returns {'ok': True, 'state': GameState4D, ...}
        if not r or not r.get('ok'):
            return None
        gs4 = r.get('state')
        _qm_state_cache = (_history_len, gs4)
        return gs4
    except Exception:
        return None

def _state_side_to_move():
    """White-to-move bool. Polymorphic on state type.

    chess4d.GameState and chess_spectral_4d.GameState4D both expose
    side_to_move as a Color enum (WHITE/BLACK). Defaults to True (white)
    if the attribute is absent."""
    s2m = getattr(_state, 'side_to_move', None)
    if s2m is None:
        return True
    try:
        # Check against both chess4d and chess_spectral_4d Color.WHITE.
        return (s2m == _Chess4D_Color.WHITE or
                s2m == Color.WHITE or
                getattr(s2m, 'name', '') == 'WHITE')
    except Exception:
        return True

def _refresh_encoder_cache():
    """Rebuild pos4 + sig + encoding from _state. Called lazily by
    previewEncoding when its history-length cache key drifts."""
    global _encoder_cache
    try:
        from chess_spectral.encoder_4d import (
            encode_4d, board_signal_4d, _load_tables, CHANNELS_4D,
        )
    except Exception as e:
        _encoder_cache = {'error': f'{type(e).__name__}: {e}', 'history_len': _history_len}
        return
    try:
        pos4 = _state_to_pos4(_state)
        sig  = board_signal_4d(pos4)
        enc  = encode_4d(pos4)
        _encoder_cache = {
            'pos4': pos4,
            'sig': sig,
            'encoding': enc,
            'tables': _load_tables(),
            'channels': list(CHANNELS_4D),
            'history_len': _history_len,
        }
    except Exception as e:
        _encoder_cache = {'error': f'{type(e).__name__}: {e}', 'history_len': _history_len}

state_type = type(_state).__name__
print(f'[py/m11.40a] chess4d adapter ready. _state={state_type} _USE_GS4_STATE={_USE_GS4_STATE} _legality_ops={_legality_ops}')
`);

    const probe = pyodide
      .runPython(
        `
import importlib.metadata as m
def _ver(pkg):
    try:
        return m.version(pkg)
    except Exception:
        return None

def _import(modname):
    try:
        __import__(modname)
        return True
    except Exception as e:
        return f'{type(e).__name__}: {e}'

{
    'versions': {
        'chess_spectral': _ver('chess-spectral'),
        'chess4d': _ver('python-chess4d-oana-chiru'),
    },
    'imports': {
        'chess_spectral': _import('chess_spectral'),
        'chess4d': _import('chess4d'),
        'phase_operators_4d': _import('chess_spectral.phase_operators_4d'),
        'encoder_4d': _import('chess_spectral.encoder_4d'),
    },
    # M11.40a: expose capability probe so the debug panel + __BRIDGE_LOG__
    # capture which code paths activated for this chess-spectral version.
    'm11_40a': {
        'use_gs4_state': _USE_GS4_STATE,
        'legality_ops': _legality_ops,
        'api_caps': dict(_API_CAPS),
    },
}
`
      )
      .toJs({ dict_converter: Object.fromEntries, depth: 4 });

    cachedVersions = probe.versions;
    cachedPackageStatus = probe.imports;
    status = 'ready';
    return {
      ready: true,
      versions: probe.versions,
      packages: probe.imports,
      pyodide: pyodide.version,
    };
  } catch (err) {
    status = 'error';
    initError = err;
    throw err;
  }
}

// Helper: build a Square4D from JS coords on the Pyodide side.
function _setSquare(name, c) {
  pyodide.globals.set(name, [c.x, c.y, c.z, c.w]);
}

const handlers = {
  init: ensureInit,

  getStatus() {
    return {
      status,
      error: initError ? String(initError.message || initError) : null,
    };
  },

  // Pulls constants from chess_spectral.phase_operators_4d at runtime.
  // Don't hardcode in JS — the package is the source of truth.
  getConstants() {
    if (status !== 'ready') {
      throw new Error(`Worker not ready (status=${status})`);
    }
    return pyodide
      .runPython(
        `
try:
    from chess_spectral.phase_operators_4d.phase_operators_4d import (
        MODULUS_4D, GEN_X, GEN_Y, GEN_Z, GEN_W
    )
except (ImportError, AttributeError):
    import chess_spectral.phase_operators_4d as _po
    MODULUS_4D = _po.MODULUS_4D
    GEN_X = _po.GEN_X
    GEN_Y = _po.GEN_Y
    GEN_Z = _po.GEN_Z
    GEN_W = _po.GEN_W

{
    'MODULUS_4D': int(MODULUS_4D),
    'GEN_X': int(GEN_X),
    'GEN_Y': int(GEN_Y),
    'GEN_Z': int(GEN_Z),
    'GEN_W': int(GEN_W),
    'BOARD_SIZE': 8,
    'DIM': 4,
}
`
      )
      .toJs({ dict_converter: Object.fromEntries });
  },

  resetToInitial() {
    if (status !== 'ready') throw new Error(`Worker not ready (status=${status})`);
    // M11.40a: _make_initial_state() constructs the right state type
    // (GameState4D or chess4d.GameState) based on _USE_GS4_STATE.
    pyodide.runPython(`
_state = _make_initial_state()
_history_len = 0
_encoder_cache = None
_qm_state_cache = None
`);
    return { ok: true, history_len: 0 };
  },

  // Sets the legality oracle backend.
  //   'bitboard'  — chess_spectral.spatial_4d.Board4D.legal_moves [M11.40a DEFAULT]
  //   'phase'     — chess_spectral.phase_operators_4d (Fourier-domain)
  //   'laplacian' — chess_spectral.spectral_legality_4d (eigenbasis structural reach)
  //   'spatial'   — DEPRECATED (chess4d.pieces.* + state.push; aliased to bitboard
  //                 in M11.40a with a one-release deprecation warn)
  // All four produce the same legal-move set; 'bitboard' is the fastest in
  // the sparse mid-/end-game regime and is fully chess-spectral-native.
  setLegalityOps(args) {
    if (status !== 'ready') throw new Error(`Worker not ready (status=${status})`);
    const VALID_OPS = ['bitboard', 'phase', 'laplacian', 'spatial'];
    const ops = (args && VALID_OPS.includes(args.ops)) ? args.ops : 'bitboard';
    pyodide.globals.set('_set_ops_value', ops);
    pyodide.runPython(`
global _legality_ops
_legality_ops = _set_ops_value
if _legality_ops == 'spatial':
    print('[py/m11.40a] WARNING: ?legalityOps=spatial is deprecated; '
          'bitboard is now the default. spatial aliased to bitboard for this release. '
          'Remove the URL parameter or use ?legalityOps=bitboard.')
print(f'[py] legality oracle = {_legality_ops}')
`);
    return { ok: true, ops };
  },

  // applyMove({origin: {x,y,z,w}, dest: {x,y,z,w}, promotion?: 'queen'|'rook'|'bishop'|'knight'})
  // Builds a Move4D and pushes it onto _state. On IllegalMoveError, returns ok=false.
  applyMove(args) {
    if (status !== 'ready') throw new Error(`Worker not ready (status=${status})`);
    _setSquare('_args_origin', args.origin);
    _setSquare('_args_dest',   args.dest);
    pyodide.globals.set('_args_promotion', args.promotion || null);
    return pyodide
      .runPython(
        `
def _do_apply():
    global _state, _history_len, _encoder_cache
    o = Square4D(*[int(v) for v in _args_origin])
    d = Square4D(*[int(v) for v in _args_dest])
    promo = None
    if _args_promotion:
        try:
            promo = PieceType[str(_args_promotion).upper()]
        except KeyError:
            return {'ok': False, 'error': f'unknown promotion type: {_args_promotion!r}', 'history_len': _history_len}
    move = Move4D(from_sq=o, to_sq=d, promotion=promo)
    try:
        _state.push(move)
    except IllegalMoveError as e:
        return {'ok': False, 'error': str(e), 'history_len': _history_len}
    _history_len += 1
    _encoder_cache = None  # invalidate
    return {'ok': True, 'history_len': _history_len}
_do_apply()
`
      )
      .toJs({ dict_converter: Object.fromEntries });
  },

  undo() {
    if (status !== 'ready') throw new Error(`Worker not ready (status=${status})`);
    return pyodide
      .runPython(
        `
def _do_undo():
    global _history_len, _encoder_cache
    if _history_len <= 0:
        return {'ok': True, 'history_len': 0, 'no_op': True}
    _state.pop()
    _history_len -= 1
    _encoder_cache = None
    return {'ok': True, 'history_len': _history_len}
_do_undo()
`
      )
      .toJs({ dict_converter: Object.fromEntries });
  },

  // legalMoves({x,y,z,w}) — uses CURRENT _state (initial + applied moves).
  legalMoves(args) {
    if (status !== 'ready') throw new Error(`Worker not ready (status=${status})`);
    _setSquare('_args_origin', args);
    return pyodide
      .runPython(
        `
def _do_legal():
    o = Square4D(*[int(v) for v in _args_origin])
    moves = _legal_moves_for(_state, o)
    return {
        'ok': True,
        'reason': None,
        'moves': [
            {'x': int(m.to_sq.x), 'y': int(m.to_sq.y), 'z': int(m.to_sq.z), 'w': int(m.to_sq.w)}
            for m in moves
        ],
        'history_len': _history_len,
    }
_do_legal()
`
      )
      .toJs({ dict_converter: Object.fromEntries });
  },

  // M3.5 parity helpers — run against a fresh initial state so they're
  // independent of _state's mutation history.
  listInitialPieces() {
    if (status !== 'ready') throw new Error(`Worker not ready (status=${status})`);
    return pyodide
      .runPython(`_pieces_to_dicts(_make_initial_state())`)
      .toJs({ dict_converter: Object.fromEntries });
  },

  legalMovesAtInitial(args) {
    if (status !== 'ready') throw new Error(`Worker not ready (status=${status})`);
    _setSquare('_args_origin', args);
    return pyodide
      .runPython(
        `
def _do_initial_legal():
    o = Square4D(*[int(v) for v in _args_origin])
    s = _make_initial_state()
    if s.board.occupant(o) is None:
        return {'ok': False, 'reason': 'no-piece-at-origin', 'moves': []}
    moves = _legal_moves_for(s, o)
    return {
        'ok': True,
        'reason': None,
        'moves': [
            {'x': int(m.to_sq.x), 'y': int(m.to_sq.y), 'z': int(m.to_sq.z), 'w': int(m.to_sq.w)}
            for m in moves
        ],
    }
_do_initial_legal()
`
      )
      .toJs({ dict_converter: Object.fromEntries, depth: 4 });
  },

  // M6 hover spectral preview — caches the current-state encoding and uses
  // closed-form delta math for the linear channels (A1 + STD4_X/Y/Z/W).
  // Nonlinear channels return null; JS overlay falls back to default rendering.
  previewEncoding(args) {
    if (status !== 'ready') throw new Error(`Worker not ready (status=${status})`);
    _setSquare('_args_origin', args);
    return pyodide
      .runPython(
        `
import numpy as _np

def _do_preview():
    if _encoder_cache is None or _encoder_cache.get('history_len') != _history_len:
        _refresh_encoder_cache()
    cache = _encoder_cache
    if cache is None or cache.get('error'):
        # Encoder unavailable — return legal dests with null intensities so
        # the JS overlay knows to fall back to default rendering.
        try:
            o = Square4D(*[int(v) for v in _args_origin])
            moves = _legal_moves_for(_state, o)
            dests = [
                {'x': int(m.to_sq.x), 'y': int(m.to_sq.y), 'z': int(m.to_sq.z), 'w': int(m.to_sq.w)}
                for m in moves
            ]
        except Exception:
            dests = []
        return {
            'ok': False,
            'reason': (cache or {}).get('error', 'encoder unavailable'),
            'channels': None,
            'previews': [{'dest': d, 'intensities': None} for d in dests],
        }

    pos4 = cache['pos4']; sig = cache['sig']; enc = cache['encoding']
    tables = cache['tables']
    channels = [name for (name, _off) in cache['channels']]
    P_A1 = tables['P_A1']
    coord_resid = tables['coord_resid']

    o = Square4D(*[int(v) for v in _args_origin])
    origin_sq = (int(o.x) << 9) | (int(o.y) << 6) | (int(o.z) << 3) | int(o.w)
    moving_piece = pos4.get(origin_sq)
    if moving_piece is None:
        return {'ok': False, 'reason': 'no-piece-at-origin', 'previews': []}

    # Get legal destinations via the same path as legalMoves.
    moves = _legal_moves_for(_state, o)
    dests = [
        (int(m.to_sq.x), int(m.to_sq.y), int(m.to_sq.z), int(m.to_sq.w))
        for m in moves
    ]

    # The moving piece's signed signal value at any new dest cell.
    from chess_spectral.encoder_4d import board_signal_4d
    moving_value = float(board_signal_4d({0: moving_piece})[0])

    def _scalar(M, i, j):
        try:
            v = M[i, j]
        except Exception:
            return 0.0
        try:
            return float(v)
        except Exception:
            try:
                return float(_np.asarray(v).reshape(())[()])
            except Exception:
                return 0.0

    previews = []
    for (dx, dy, dz, dw) in dests:
        dest_sq = (dx << 9) | (dy << 6) | (dz << 3) | dw
        sig_before_origin = float(sig[origin_sq])
        sig_before_dest   = float(sig[dest_sq])
        delta_sig_origin  = -sig_before_origin
        delta_sig_dest    = moving_value - sig_before_dest

        intensities = {}
        # Channel 0 (A1): linear matrix multiply; only origin and dest delta matter.
        intensities[channels[0]] = (
            float(enc[dest_sq])
            + _scalar(P_A1, dest_sq, origin_sq) * delta_sig_origin
            + _scalar(P_A1, dest_sq, dest_sq)   * delta_sig_dest
        )
        # Channels 1-4 (STD4_X/Y/Z/W): coord_resid[a][d] * sig_after[d].
        for a in range(4):
            try:
                cr_at_dest = float(coord_resid[a][dest_sq])
            except Exception:
                cr_at_dest = 0.0
            intensities[channels[1 + a]] = cr_at_dest * moving_value
        # Nonlinear channels — null in fast path.
        for name in channels[5:]:
            intensities[name] = None

        previews.append({
            'dest': {'x': dx, 'y': dy, 'z': dz, 'w': dw},
            'intensities': intensities,
        })

    return {
        'ok': True,
        'reason': None,
        'channels': channels,
        'fast_channels': sorted(channels[:5]),
        'previews': previews,
    }
_do_preview()
`
      )
      .toJs({ dict_converter: Object.fromEntries, depth: 5 });
  },

  // M10 board heat map / filaments — return the chosen channels'
  // per-cell intensities for the full board (4096 cells per channel)
  // so JS can render a heatmap overlay or compute streamlines from
  // the gradient field. Pulls from the M6 encoder cache so it costs
  // a slice per request (~no work) once the cache is warm.
  //
  // args: { channels: ['A1','STD4_X',...] }
  // returns: { ok, history_len, channels: { name: [4096 floats], ... } }
  getBoardEncoding(args) {
    if (status !== 'ready') throw new Error(`Worker not ready (status=${status})`);
    const channels = (args && Array.isArray(args.channels) && args.channels.length > 0)
      ? args.channels
      : ['A1'];
    pyodide.globals.set('_board_enc_channels', channels);
    return pyodide
      .runPython(
        `
def _do_board_encoding():
    if _encoder_cache is None or _encoder_cache.get('history_len') != _history_len:
        _refresh_encoder_cache()
    cache = _encoder_cache
    if cache is None or cache.get('error'):
        return {'ok': False, 'reason': (cache or {}).get('error', 'encoder unavailable'), 'history_len': _history_len}
    enc = cache['encoding']
    chans = cache['channels']  # [(name, offset), ...]
    by_name = {n: o for (n, o) in chans}
    out = {}
    for name in list(_board_enc_channels):
        offset = by_name.get(name)
        if offset is None:
            out[name] = None
            continue
        slc = enc[offset:offset + 4096]
        # to_py via dict_converter handles list-of-floats efficiently.
        out[name] = [float(v) for v in slc]
    return {
        'ok': True,
        'history_len': _history_len,
        'channels': out,
    }
_do_board_encoding()
`
      )
      .toJs({ dict_converter: Object.fromEntries, depth: 5 });
  },

  // Diagnostic — returns piece count + state type. Used by the debug panel.
  getInitialPositionInfo() {
    if (status !== 'ready') throw new Error(`Worker not ready (status=${status})`);
    return pyodide
      .runPython(
        `
def _do_info():
    # M11.40a: count pieces from _state (which may be GameState4D or chess4d)
    # rather than a fresh initial_position() so the type matches the live state.
    count = 0
    state_type = type(_state).__name__
    try:
        if hasattr(_state, 'board') and hasattr(_state.board, '_squares'):
            count = sum(1 for _ in _state.board._squares)
        elif hasattr(_state, 'board') and hasattr(_state.board, 'pieces_of'):
            for col in (Color.WHITE, Color.BLACK):
                try:
                    count += sum(1 for _ in _state.board.pieces_of(col))
                except Exception:
                    pass
    except Exception:
        count = -1
    return {
        'piece_count': count,
        'state_type': state_type,
        'use_gs4_state': _USE_GS4_STATE,
        'legality_ops': _legality_ops,
        'api_caps': dict(_API_CAPS),
    }
_do_info()
`
      )
      .toJs({ dict_converter: Object.fromEntries, depth: 3 });
  },

  // ───────────────────────────────────────────────────────────────────
  // chess-spectral 1.5 §17.5 dev/debug surface (M11.25)
  // ───────────────────────────────────────────────────────────────────

  // Clean version string + package metadata. Lets the UI display
  // "chess-spectral 1.5.0" without having to grep micropip output.
  // Falls back to importlib.metadata if qm_4d_bridge isn't importable
  // (defensive — should always be present in 1.5+ but a future split
  // could move it).
  getVersion() {
    if (status !== 'ready') throw new Error(`Worker not ready (status=${status})`);
    return pyodide
      .runPython(
        `
def _do_version():
    try:
        from chess_spectral.qm_4d_bridge import get_version
        r = get_version()
        # qm_4d_bridge contracts return Python dicts already shaped for JSON
        return r
    except Exception:
        try:
            from importlib.metadata import version as _v
            return {'ok': True, 'version': _v('chess-spectral'), 'source': 'importlib.metadata'}
        except Exception as e:
            return {'ok': False, 'error': str(e)}
_do_version()
`
      )
      .toJs({ dict_converter: Object.fromEntries });
  },

  // 11-channel layout of the 45,056-dim 4D encoder. Returns
  //   { ok, totalDim: 45056, channels: [{ name, offset, dim }, ...] }
  // Useful for the JS overlay modules to validate at startup that the
  // chess-spectral version matches our expected channel set, and to
  // populate channel-toggle dropdowns dynamically rather than hard-
  // coding the names. Pure read-only — no state dependence.
  getEncoderShape() {
    if (status !== 'ready') throw new Error(`Worker not ready (status=${status})`);
    return pyodide
      .runPython(
        `
def _do_encoder_shape():
    try:
        from chess_spectral.qm_4d_bridge import get_encoder_shape
        return get_encoder_shape()
    except Exception as e:
        return {'ok': False, 'error': str(e)}
_do_encoder_shape()
`
      )
      .toJs({ dict_converter: Object.fromEntries, depth: 5 });
  },

  // Async win-condition / cutover-readiness probe (M11.26).
  // Args: { team: 0|1 }
  // Returns: { ok, hasMoves: boolean }
  //
  // Drop-in replacement for the synchronous JS gameBoard.hasLegalMoves
  // — runs the same king-first scan in Python so the main thread isn't
  // blocked. Together with the inCheck() logic on GameBoard, this lets
  // checkmate / stalemate detection happen off the main thread, fixing
  // the M11.16 freeze class of bug at the source.
  hasLegalMoves(args) {
    if (status !== 'ready') throw new Error(`Worker not ready (status=${status})`);
    const team = args && (args.team === 0 || args.team === 1) ? args.team : 0;
    pyodide.globals.set('_team_arg', team);
    return pyodide
      .runPython(
        `
def _do_has_legal_moves():
    try:
        # M11.40a: Color alias resolves to chess_spectral_4d.Color if
        # _USE_GS4_STATE=True, else chess4d.Color. Both have WHITE/BLACK.
        col = Color.WHITE if int(_team_arg) == 0 else Color.BLACK
        return {'ok': True, 'hasMoves': bool(_has_legal_moves_impl(_state, col))}
    except Exception as e:
        return {'ok': False, 'error': f'{type(e).__name__}: {e}'}
_do_has_legal_moves()
`
      )
      .toJs({ dict_converter: Object.fromEntries });
  },

  // Current state as FEN4 v1 string (M11.26).
  // Returns: { ok, fen4 } or { ok: false, error }
  //
  // Best-effort serialization: probes chess_spectral.fen_4d and
  // chess_spectral_4d.fen_4d for a canonical serializer, falls back
  // to a hand-rolled minimal v1 board-only string. Adequate for
  // export-to-clipboard and round-tripping into qm_4d_bridge.load_fen4
  // for QM analysis. Doesn't carry move history or side-to-move yet —
  // M11.26.1 will extend once we've observed the upstream serializer's
  // output shape in a Pyodide preview.
  getFen4State() {
    if (status !== 'ready') throw new Error(`Worker not ready (status=${status})`);
    return pyodide
      .runPython(
        `
def _do_get_fen4():
    try:
        return {'ok': True, 'fen4': _state_to_fen4(_state)}
    except Exception as e:
        return {'ok': False, 'error': f'{type(e).__name__}: {e}'}
_do_get_fen4()
`
      )
      .toJs({ dict_converter: Object.fromEntries });
  },

  // ───────────────────────────────────────────────────────────────────
  // chess-spectral 1.5 §17.1 QM kinematics (M11.27)
  // ───────────────────────────────────────────────────────────────────

  // Lift the current classical state to the QM kinematics ψ ∈ ℂ^45056.
  // Args: { sideToMove?: boolean }  (default: read from chess4d state)
  // Returns: { ok, psi: Float32Array(90112), basisDim: 45056, normSq }
  //
  // Wire format per upstream §17.1: psi[2k] = Re(ψ_k), psi[2k+1] = Im(ψ_k).
  // The 90112-length Float32Array transports as a typed-array buffer (no
  // structured-clone deep copy when we set the worker postMessage to
  // include it as a transferable — wired in spectral_bridge.js call()).
  // basisDim is always 45056 for the 4D encoder; included so consumers
  // don't have to assume.
  getQmState(args) {
    if (status !== 'ready') throw new Error(`Worker not ready (status=${status})`);
    const sideToMove = (args && typeof args.sideToMove === 'boolean')
      ? args.sideToMove
      : null;
    pyodide.globals.set('_qm_side_arg', sideToMove);
    return pyodide
      .runPython(
        `
def _do_get_qm_state():
    try:
        from chess_spectral.qm_4d_bridge import get_qm_state as _gqs
    except Exception as e:
        return {'ok': False, 'error': f'qm_4d_bridge import failed: {type(e).__name__}: {e}'}
    gs4 = _get_qm_state_obj()
    if gs4 is None:
        return {'ok': False, 'error': 'chess_spectral_4d state translation failed'}
    s2m = _qm_side_arg if _qm_side_arg is not None else _state_side_to_move()
    try:
        r = _gqs(gs4, side_to_move=bool(s2m))
        return r
    except Exception as e:
        return {'ok': False, 'error': f'{type(e).__name__}: {e}'}
_do_get_qm_state()
`
      )
      .toJs({ dict_converter: Object.fromEntries, depth: 5 });
  },

  // Per-cell density |ψ_p|² summed across the 11 channels.
  // Returns: { ok, density: Float32Array(4096) }
  //
  // The 4096-length array maps to lattice cells via the standard
  // sq_idx = x*512 + y*64 + z*8 + w packing (matches encoder_4d).
  // Sum over all 4096 cells normalizes to 1.0 ± 1e-6 by Born-rule
  // construction. The M14.1 density overlay rides this directly.
  getQmDensity() {
    if (status !== 'ready') throw new Error(`Worker not ready (status=${status})`);
    return pyodide
      .runPython(
        `
def _do_get_qm_density():
    try:
        from chess_spectral.qm_4d_bridge import get_qm_density as _gqd
    except Exception as e:
        return {'ok': False, 'error': f'qm_4d_bridge import failed: {type(e).__name__}: {e}'}
    gs4 = _get_qm_state_obj()
    if gs4 is None:
        return {'ok': False, 'error': 'chess_spectral_4d state translation failed'}
    try:
        r = _gqd(gs4)
        return r
    except Exception as e:
        return {'ok': False, 'error': f'{type(e).__name__}: {e}'}
_do_get_qm_density()
`
      )
      .toJs({ dict_converter: Object.fromEntries, depth: 5 });
  },

  // Apply a unitary move operator to the current ψ. PREVIEW-style
  // (M11.28): does NOT mutate our chess4d state. Returns the assembled
  // post-move ψ for visualization / measurement / single-move analysis.
  // The classical state advances only when applyMove() is called.
  //
  // Args: { origin: {x,y,z,w}, dest: {x,y,z,w} }
  // Returns: { ok, psi: Float32Array(90112), basisDim: 45056, normSq }
  //
  // Wire format mirrors getQmState — psi[2k] = Re(ψ_k), psi[2k+1] = Im.
  // basisDim = 45056 (always — included for symmetry with getQmState).
  // Move format passed to upstream: ((x,y,z,w), (x,y,z,w)) coord-tuple
  // form (the README documents both int-pair and coord-pair shapes).
  applyMoveQm(args) {
    if (status !== 'ready') throw new Error(`Worker not ready (status=${status})`);
    const origin = args && args.origin;
    const dest   = args && args.dest;
    if (!origin || !dest) {
      throw new Error('applyMoveQm: requires { origin: {x,y,z,w}, dest: {x,y,z,w} }');
    }
    pyodide.globals.set('_amq_ox', origin.x | 0);
    pyodide.globals.set('_amq_oy', origin.y | 0);
    pyodide.globals.set('_amq_oz', origin.z | 0);
    pyodide.globals.set('_amq_ow', origin.w | 0);
    pyodide.globals.set('_amq_dx', dest.x | 0);
    pyodide.globals.set('_amq_dy', dest.y | 0);
    pyodide.globals.set('_amq_dz', dest.z | 0);
    pyodide.globals.set('_amq_dw', dest.w | 0);
    return pyodide
      .runPython(
        `
def _do_apply_move_qm():
    try:
        from chess_spectral.qm_4d_bridge import apply_move_qm_full
    except Exception as e:
        return {'ok': False, 'error': f'qm_4d_bridge import failed: {type(e).__name__}: {e}'}
    gs4 = _get_qm_state_obj()
    if gs4 is None:
        return {'ok': False, 'error': 'chess_spectral_4d state translation failed'}
    try:
        from_coord = (int(_amq_ox), int(_amq_oy), int(_amq_oz), int(_amq_ow))
        to_coord   = (int(_amq_dx), int(_amq_dy), int(_amq_dz), int(_amq_dw))
        r = apply_move_qm_full(gs4, move=(from_coord, to_coord))
        return r
    except Exception as e:
        return {'ok': False, 'error': f'{type(e).__name__}: {e}'}
_do_apply_move_qm()
`
      )
      .toJs({ dict_converter: Object.fromEntries, depth: 5 });
  },

  // ───────────────────────────────────────────────────────────────────
  // chess-spectral 1.5 §17.1 QM dynamics + measurement (M11.29)
  // ───────────────────────────────────────────────────────────────────

  // Born-rule projective measurement at a lattice cell. Args:
  //   { coord: {x,y,z,w}, observable?: string }
  // Returns (per upstream contract): { ok, sampledOutcome, postCollapsePsi }
  //
  // observable defaults to the channel-projection PVM (the natural
  // measurement on a chess-spectral state). Other valid strings will
  // be 'rook'|'bishop'|'queen'|'king'|'knight' once the H_piece_4
  // observables are available as named PVMs upstream. We pass through
  // whatever the caller sends; the qm_4d_bridge layer validates.
  measureAt(args) {
    if (status !== 'ready') throw new Error(`Worker not ready (status=${status})`);
    const coord = args && args.coord;
    const observable = args && args.observable;
    if (!coord) throw new Error('measureAt: requires { coord: {x,y,z,w} }');
    pyodide.globals.set('_meas_x', coord.x | 0);
    pyodide.globals.set('_meas_y', coord.y | 0);
    pyodide.globals.set('_meas_z', coord.z | 0);
    pyodide.globals.set('_meas_w', coord.w | 0);
    pyodide.globals.set('_meas_obs', observable || null);
    return pyodide
      .runPython(
        `
def _do_measure_at():
    try:
        from chess_spectral.qm_4d_bridge import measure_at as _ma
    except Exception as e:
        return {'ok': False, 'error': f'qm_4d_bridge import failed: {type(e).__name__}: {e}'}
    gs4 = _get_qm_state_obj()
    if gs4 is None:
        return {'ok': False, 'error': 'chess_spectral_4d state translation failed'}
    try:
        coord = (int(_meas_x), int(_meas_y), int(_meas_z), int(_meas_w))
        if _meas_obs is None:
            r = _ma(gs4, coords=coord)
        else:
            r = _ma(gs4, coords=coord, observable=_meas_obs)
        return r
    except Exception as e:
        return {'ok': False, 'error': f'{type(e).__name__}: {e}'}
_do_measure_at()
`
      )
      .toJs({ dict_converter: Object.fromEntries, depth: 5 });
  },

  // Reduced density matrix ρ_piece for one piece. Args: { pieceId: int }
  // Returns: { ok, rho: ComplexMatrix, purity, rank }
  //
  // pieceId convention follows chess_spectral_4d's piece-listing order
  // (0..N-1 for the current state). For entanglement viz: tr(ρ²) = purity
  // ∈ [1/d, 1]; rank > 1 indicates the piece is entangled with others.
  getDensityMatrixOf(args) {
    if (status !== 'ready') throw new Error(`Worker not ready (status=${status})`);
    const pieceId = (args && Number.isFinite(args.pieceId)) ? args.pieceId : 0;
    pyodide.globals.set('_dm_pid', pieceId | 0);
    return pyodide
      .runPython(
        `
def _do_get_density_matrix():
    try:
        from chess_spectral.qm_4d_bridge import get_density_matrix_of as _gdm
    except Exception as e:
        return {'ok': False, 'error': f'qm_4d_bridge import failed: {type(e).__name__}: {e}'}
    gs4 = _get_qm_state_obj()
    if gs4 is None:
        return {'ok': False, 'error': 'chess_spectral_4d state translation failed'}
    try:
        r = _gdm(gs4, piece_id=int(_dm_pid))
        return r
    except Exception as e:
        return {'ok': False, 'error': f'{type(e).__name__}: {e}'}
_do_get_density_matrix()
`
      )
      .toJs({ dict_converter: Object.fromEntries, depth: 6 });
  },

  // Probability-current field j_p(c) = Im(ψ* ∇ψ).
  // Returns: { ok, j: Float32Array (typically 4096 × 4) }
  //
  // Layout per upstream contract: 4D flow vector at each lattice cell.
  // The M14.2 filament viz traces this field to draw probability flow
  // through the lattice. Per-cell index packing: idx = x*512+y*64+z*8+w;
  // j[4*idx + axis] is the axis-component (axis ∈ {0=x,1=y,2=z,3=w}).
  getProbabilityCurrent() {
    if (status !== 'ready') throw new Error(`Worker not ready (status=${status})`);
    return pyodide
      .runPython(
        `
def _do_get_prob_current():
    try:
        from chess_spectral.qm_4d_bridge import get_probability_current as _gpc
    except Exception as e:
        return {'ok': False, 'error': f'qm_4d_bridge import failed: {type(e).__name__}: {e}'}
    gs4 = _get_qm_state_obj()
    if gs4 is None:
        return {'ok': False, 'error': 'chess_spectral_4d state translation failed'}
    try:
        r = _gpc(gs4)
        # M14.8 audit fix: chess_spectral 1.6.1's get_probability_current
        # returns j as a 2D ndarray of shape (4096, 4). Pyodide's toJs
        # converts a 2D ndarray to nested JS arrays at the documented
        # depth, NOT to a flat Float32Array. Our SpectralQmCurrent (M14.2)
        # JS expects a flat 16384-length array indexed as j[4*idx+axis],
        # so a 2D return silently failed the length check and the viz
        # never rendered. Flatten here so the bridge contract gives JS
        # what its consumer expects: 1D Float32 of length 4096*4 = 16384.
        if isinstance(r, dict) and 'j' in r and hasattr(r['j'], 'flatten'):
            r['j'] = r['j'].flatten().astype('float32')
        return r
    except Exception as e:
        return {'ok': False, 'error': f'{type(e).__name__}: {e}'}
_do_get_prob_current()
`
      )
      .toJs({ dict_converter: Object.fromEntries, depth: 5 });
  },

  // Expectation value <ψ|H|ψ> for a Hermitian observable.
  // Args: { observable: string, weights?: object }
  //   observable: one of 'rook'|'bishop'|'queen'|'king'|'knight' (per
  //              chess_spectral.qm_4d.H_piece_4 family). Other strings
  //              passed through to upstream.
  //   weights: optional dict for composing observables (e.g.
  //            {'rook': 0.4, 'bishop': 0.3, ...}); upstream contract.
  // Returns: { ok, value: number }
  //
  // For bot eval (M13.4 chess-spectral 1.6): this gives the QM-flavored
  // contribution to evaluate_position. Returns a scalar.
  getQmExpectation(args) {
    if (status !== 'ready') throw new Error(`Worker not ready (status=${status})`);
    const observable = (args && args.observable) || 'rook';
    pyodide.globals.set('_qme_obs', observable);
    pyodide.globals.set('_qme_w', (args && args.weights) ? args.weights : null);
    return pyodide
      .runPython(
        `
def _do_get_qm_expectation():
    try:
        from chess_spectral.qm_4d_bridge import get_qm_expectation as _gqe
    except Exception as e:
        return {'ok': False, 'error': f'qm_4d_bridge import failed: {type(e).__name__}: {e}'}
    gs4 = _get_qm_state_obj()
    if gs4 is None:
        return {'ok': False, 'error': 'chess_spectral_4d state translation failed'}
    try:
        if _qme_w is None:
            r = _gqe(gs4, observable=str(_qme_obs))
        else:
            # PyProxy -> dict
            try:
                w = _qme_w.to_py()
            except AttributeError:
                w = dict(_qme_w)
            r = _gqe(gs4, observable=str(_qme_obs), weights=w)
        return r
    except Exception as e:
        return {'ok': False, 'error': f'{type(e).__name__}: {e}'}
_do_get_qm_expectation()
`
      )
      .toJs({ dict_converter: Object.fromEntries, depth: 5 });
  },

  // ───────────────────────────────────────────────────────────────────
  // chess-spectral 1.6.1 §16 engine surface (M13.4)
  // ───────────────────────────────────────────────────────────────────

  // Run the §16.2 iterative-deepening alpha-beta search at the current
  // position and return the best move plus search metadata.
  //
  // Args (all optional):
  //   { evaluator: 'material'|'qm'|'spectral'  // default 'material'
  //     maxDepth: int                           // default 3
  //     timeBudgetMs: number                    // default 4000
  //     useTt: bool, useMvvLva: bool, useQuiescence: bool   // default true }
  //
  // Returns:
  //   { ok: true, move: {x0,y0,z0,w0,x1,y1,z1,w1}, evaluator, score,
  //     depth, elapsedMs, nodesSearched, ttHits, ttSize,
  //     pv: [{from: {x,y,z,w}, to: {x,y,z,w}}, ...] }
  //
  // The bot's search runs INSIDE the worker — the main thread stays
  // responsive throughout. Replaces the JS-side iterative deepening
  // (`Bot.getBestMoveSmart` in Bot.js) for the new engine-* strategies.
  //
  // State translation: chess4d.GameState -> FEN4 -> chess_spectral.
  // spatial_4d.Board4D via `Board4D.from_fen(fen4)`. The Board4D class
  // is the engine-ready board (legal_moves(), push/pop, position_hash);
  // chess_spectral_4d.GameState4D is a separate lighter wrapper.
  getBestMove(args) {
    if (status !== 'ready') throw new Error(`Worker not ready (status=${status})`);
    const evaluator    = (args && args.evaluator) || 'material';
    const maxDepth     = (args && Number.isFinite(args.maxDepth)) ? args.maxDepth : 3;
    const timeBudgetMs = (args && Number.isFinite(args.timeBudgetMs)) ? args.timeBudgetMs : 4000;
    const useTt        = (args && args.useTt !== undefined) ? !!args.useTt : true;
    const useMvvLva    = (args && args.useMvvLva !== undefined) ? !!args.useMvvLva : true;
    const useQuies     = (args && args.useQuiescence !== undefined) ? !!args.useQuiescence : true;
    pyodide.globals.set('_bm_evaluator', evaluator);
    pyodide.globals.set('_bm_max_depth', maxDepth | 0);
    pyodide.globals.set('_bm_time_budget_ms', timeBudgetMs);
    pyodide.globals.set('_bm_use_tt', useTt);
    pyodide.globals.set('_bm_use_mvv_lva', useMvvLva);
    pyodide.globals.set('_bm_use_quies', useQuies);
    return pyodide
      .runPython(
        `
def _do_get_best_move():
    try:
        from chess_spectral.spatial_4d import Board4D
        from chess_spectral_4d.engine.search import search, SearchOptions
        from chess_spectral_4d.engine.eval import material as _ev_mat
        from chess_spectral_4d.engine.eval import qm as _ev_qm
        from chess_spectral_4d.engine.eval import spectral as _ev_sp
    except Exception as e:
        return {'ok': False, 'error': f'engine import failed: {type(e).__name__}: {e}'}

    eval_map = {
        'material': _ev_mat.evaluate,
        'qm':       _ev_qm.evaluate,
        'spectral': _ev_sp.evaluate,
    }
    eval_name = str(_bm_evaluator) if _bm_evaluator else 'material'
    eval_fn = eval_map.get(eval_name)
    if eval_fn is None:
        return {'ok': False, 'error': f'unknown evaluator: {eval_name!r}'}

    try:
        fen4 = _state_to_fen4(_state)
        board = Board4D.from_fen(fen4)
    except Exception as e:
        return {'ok': False, 'error': f'state translation failed: {type(e).__name__}: {e}'}

    try:
        options = SearchOptions(
            max_depth=int(_bm_max_depth),
            time_budget_ms=float(_bm_time_budget_ms),
            use_tt=bool(_bm_use_tt),
            use_mvv_lva=bool(_bm_use_mvv_lva),
            use_quiescence=bool(_bm_use_quies),
        )
    except Exception as e:
        return {'ok': False, 'error': f'options build failed: {type(e).__name__}: {e}'}

    try:
        result = search(board, eval_fn, options)
    except Exception as e:
        return {'ok': False, 'error': f'search failed: {type(e).__name__}: {e}'}

    if result.best_move is None:
        return {'ok': False, 'error': 'no legal moves'}

    def _sq_to_coord(sq):
        sq = int(sq)
        return ((sq >> 9) & 7, (sq >> 6) & 7, (sq >> 3) & 7, sq & 7)

    fc = _sq_to_coord(result.best_move.from_sq)
    tc = _sq_to_coord(result.best_move.to_sq)
    pv_list = []
    for m in (result.pv or []):
        pf = _sq_to_coord(m.from_sq)
        pt = _sq_to_coord(m.to_sq)
        pv_list.append({
            'from': {'x': pf[0], 'y': pf[1], 'z': pf[2], 'w': pf[3]},
            'to':   {'x': pt[0], 'y': pt[1], 'z': pt[2], 'w': pt[3]},
        })

    return {
        'ok': True,
        'move': {
            'x0': fc[0], 'y0': fc[1], 'z0': fc[2], 'w0': fc[3],
            'x1': tc[0], 'y1': tc[1], 'z1': tc[2], 'w1': tc[3],
        },
        'evaluator': eval_name,
        'score': float(result.best_score) if result.best_score is not None else 0.0,
        'depth': int(result.depth_reached),
        'elapsedMs': float(result.elapsed_ms),
        'nodesSearched': int(result.nodes_searched),
        'ttHits': int(getattr(result, 'tt_hits', 0)),
        'ttSize': int(getattr(result, 'tt_size', 0)),
        'pv': pv_list,
    }
_do_get_best_move()
`
      )
      .toJs({ dict_converter: Object.fromEntries, depth: 6 });
  },

  // Static eval (no search) at the current position. Returns:
  //   { ok, evaluator, value, breakdown? }
  // breakdown is the per-piece (qm) or per-channel (spectral) decomp
  // when the evaluator supports it; material returns scalar only.
  evaluatePosition(args) {
    if (status !== 'ready') throw new Error(`Worker not ready (status=${status})`);
    const evaluator = (args && args.evaluator) || 'material';
    pyodide.globals.set('_ep_evaluator', evaluator);
    return pyodide
      .runPython(
        `
def _do_evaluate_position():
    try:
        from chess_spectral.spatial_4d import Board4D
        from chess_spectral_4d.engine.eval import material as _ev_mat
        from chess_spectral_4d.engine.eval import qm as _ev_qm
        from chess_spectral_4d.engine.eval import spectral as _ev_sp
    except Exception as e:
        return {'ok': False, 'error': f'engine import failed: {type(e).__name__}: {e}'}
    eval_name = str(_ep_evaluator) if _ep_evaluator else 'material'
    try:
        fen4 = _state_to_fen4(_state)
        board = Board4D.from_fen(fen4)
        # The evaluators take Position4D (board.to_position_dict()) +
        # side_to_move bool. Fall back to board.turn == 'w' for the
        # color flag.
        position_dict = board.to_position_dict()
        side_to_move = (board.turn == 'w')
    except Exception as e:
        return {'ok': False, 'error': f'state translation failed: {type(e).__name__}: {e}'}
    try:
        if eval_name == 'material':
            v = _ev_mat.evaluate(position_dict, side_to_move)
            return {'ok': True, 'evaluator': 'material', 'value': float(v)}
        elif eval_name == 'qm':
            v = _ev_qm.evaluate(position_dict, side_to_move)
            try:
                bd = _ev_qm.evaluate_breakdown(position_dict, side_to_move)
                return {'ok': True, 'evaluator': 'qm', 'value': float(v),
                        'breakdown': {k: float(val) for k, val in bd.items()}}
            except Exception:
                return {'ok': True, 'evaluator': 'qm', 'value': float(v)}
        elif eval_name == 'spectral':
            v = _ev_sp.evaluate(position_dict, side_to_move)
            try:
                bd = _ev_sp.evaluate_breakdown(position_dict, side_to_move)
                return {'ok': True, 'evaluator': 'spectral', 'value': float(v),
                        'breakdown': {k: float(val) for k, val in bd.items()}}
            except Exception:
                return {'ok': True, 'evaluator': 'spectral', 'value': float(v)}
        else:
            return {'ok': False, 'error': f'unknown evaluator: {eval_name!r}'}
    except Exception as e:
        return {'ok': False, 'error': f'evaluate failed: {type(e).__name__}: {e}'}
_do_evaluate_position()
`
      )
      .toJs({ dict_converter: Object.fromEntries, depth: 6 });
  },
};

self.onmessage = async (event) => {
  // CodeQL alert #29 (medium, js/missing-origin-check): Web Workers
  // loaded same-origin can only receive messages from same-origin
  // scripts — browsers don't expose worker.postMessage to cross-origin
  // code, so event.origin is always empty string for same-origin Worker
  // IPC and the origin check is technically redundant. We add it anyway
  // as defense-in-depth: if a future browser bug or extension somehow
  // routes messages through, we drop them silently rather than running
  // arbitrary handler dispatch with potentially-malicious method names.
  // Empty origin is the standard same-origin signal for Web Workers.
  if (event.origin && event.origin !== '' && event.origin !== self.location.origin) {
    console.warn('[worker] dropping postMessage from unexpected origin:', event.origin);
    return;
  }
  const data = event.data || {};
  const { id, method, args = [] } = data;
  if (!id || !method) {
    // Ignore unrelated messages (e.g., extension noise).
    return;
  }
  // Validate method name against the known handlers dictionary BEFORE
  // dispatching. `handlers` has a fixed set of keys; reject anything
  // else upstream of the dispatch so we never dynamic-dispatch on a
  // user-controlled string. (CodeQL doesn't currently flag the existing
  // `handlers[method]` pattern, but the explicit check is good hygiene.)
  if (!Object.prototype.hasOwnProperty.call(handlers, method)) {
    self.postMessage({
      id,
      ok: false,
      error: { name: 'UnknownMethod', message: `Unknown bridge method: ${method}` },
    });
    return;
  }
  try {
    const handler = handlers[method];
    if (typeof handler !== 'function') {
      throw new Error(`Unknown method: ${method}`);
    }
    const result = await handler(...args);
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    self.postMessage({
      id,
      ok: false,
      error: {
        name: err && err.name ? err.name : 'Error',
        message: err && err.message ? err.message : String(err),
        stack: err && err.stack ? err.stack : null,
      },
    });
  }
};
