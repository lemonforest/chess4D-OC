// spectral_worker.js — Pyodide host running in a Web Worker.
//
// Boots Pyodide from CDN, micropip-installs chess-spectral (>=1.9.0), and
// exposes a small RPC surface to the main thread via spectral_bridge.js.
// python-chess4d-oana-chiru dropped in M11.40b — chess_spectral_4d is now
// the sole canonical state type.
//
// Module surface (cumulative):
//   - chess_spectral.qm_4d           — kinematic QM (states, observables, B_4)  [1.5+]
//   - chess_spectral.qm_4d_dynamics  — unitary moves, evolve_under_h0           [1.5+]
//   - chess_spectral.qm_4d_bridge    — §17.1 QM + §17.5 dev/debug bridge        [1.5+]
//   - chess_spectral_4d              — 4D game-state, GameState4D, bridge        [1.5+]
//   - chess_spectral.spatial_4d      — Bitboard4D, attack tables, ray tables    [1.6+]
//   - chess_spectral_4d.engine       — search core + 3 evaluators (mat/qm/spec) [1.6+]
//   - chess_spectral.engine.tournament — round-robin self-play harness          [1.6+]
//   - Discrete-Laplacian eigenbasis as 3rd legality oracle                      [1.6+]
//   - chess_spectral.frame_v5        — v5 wire format w/ XOR-stream encoding    [1.6+]
//   - SearchOptions.time_budget_ms checked MID-ITERATION                        [1.7.1]
//   - FEN4 parser: `Pw@x,y,z,w` AND `P/w@x,y,z,w` both accepted                [1.7.1]
//   - GameState4D.push/pop, .to_fen(), .iter_pieces(), .is_check/mate/stale    [1.8.0]
//   - search() accepts GameState4D directly (no FEN4 round-trip)               [1.8.0]
//   - chess_spectral_4d.initial_position(), STARTING_FEN4                      [1.8.1]
//   - SheetState non-Markovian aux block (castling/EP/STM/halfmove/rep)        [1.9.0]
//   - ENCODING_DIM constant + encode_4d(pos4, sheets=...) → 45056 or 45067    [1.9.0]
//   - get_sheet_state / encode_sheet_aux / decode_sheet_aux_from_vector        [1.9.0]
//
// State model (M11.40b): _state is chess_spectral_4d.GameState4D throughout.
// No chess4d dep. No FEN4 round-trip for QM calls. _get_qm_state_obj()
// returns _state directly.
//
// Future (bit-serialized resonant HDC instrument): encoder output will
// shift from Float32 to packed binary hypervectors (ALU-only). Use
// ENCODING_DIM constant; never hardcode 45056.
//
// See docs/bridge_api.md for the wire-up plan.
// Protocol: { id, method, args } -> { id, ok, result } | { id, ok:false, error }

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

    // M11.40b — chess_spectral_4d is now the sole runtime dep.
    // python-chess4d-oana-chiru removed; chess-spectral 1.9.0 ships all
    // Tier-1 wishlist items (GameState4D push/pop/to_fen/iter_pieces/
    // is_check/is_checkmate/is_stalemate, initial_position(), STARTING_FEN4,
    // search(gs4) overload) plus the 1.9.0 SheetState non-Markovian aux block.
    await micropip.install(
      ['chess-spectral>=1.9.0'],
      true /* keep_going */
    );

    pyodide.runPython(`
# M11.40b: chess_spectral_4d is the single persistent state type.
# All chess4d imports removed. No polymorphic fallback paths.
from chess_spectral_4d import (
    GameState4D, Move4D, Square4D, Color, PieceType,
    IllegalMoveError, initial_position, STARTING_FEN4,
)

# Standard chess letter notation: knight = N (since K is the king).
# Used only by the Laplacian oracle (reachable_targets_4d takes a char).
_PIECE_CHAR = {
    PieceType.PAWN: 'P', PieceType.ROOK: 'R', PieceType.KNIGHT: 'N',
    PieceType.BISHOP: 'B', PieceType.QUEEN: 'Q', PieceType.KING: 'K',
}

# Selects the legality oracle.
#   'bitboard'  — chess_spectral.spatial_4d.Board4D.legal_moves [DEFAULT]
#   'phase'     — chess_spectral.phase_operators_4d Fourier oracle
#   'laplacian' — chess_spectral.spectral_legality_4d.reachable_targets_4d
#                 (pawns defer to bitboard; no pawn-rule model in eigenbasis)
_legality_ops = 'bitboard'

def _has_legal_moves_impl(state, color):
    """True iff color has at least one legal move.

    M11.40b fast-path: GameState4D.is_checkmate() and .is_stalemate()
    both imply no legal moves for the CURRENT side_to_move. When the
    queried color matches the current side, these are O(1) predicates.
    For the non-current side, fall through to bitboard enumeration."""
    # Fast path: GameState4D predicates (O(1), checks _state.side_to_move)
    stm = getattr(state, 'side_to_move', None)
    if stm is not None:
        try:
            stm_name = stm.name if hasattr(stm, 'name') else str(stm)
            color_name = color.name if hasattr(color, 'name') else str(color)
            if stm_name == color_name:
                return not (state.is_checkmate() or state.is_stalemate())
        except Exception:
            pass
    # Fallback: enumerate via bitboard oracle
    try:
        from chess_spectral.spatial_4d import Board4D
        board = Board4D.from_fen(state.to_fen())
        for _m in board.legal_moves():
            return True  # any legal move found
        return False
    except Exception:
        return True  # conservative: assume moves exist on failure

def _legal_moves_bitboard(state, origin):
    """chess_spectral.spatial_4d.Board4D.legal_moves() filtered by origin.

    Default oracle. Translates state via state.to_fen() into Board4D,
    enumerates legal moves, filters to the queried origin square.
    Falls back to an empty list on any failure (callers handle null sets)."""
    piece = state.board.occupant(origin)
    if piece is None:
        return []
    try:
        from chess_spectral.spatial_4d import Board4D
        board = Board4D.from_fen(state.to_fen())
    except Exception as _e:
        print(f'[py/bitboard] Board4D unavailable: {_e}')
        return []
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
    except Exception as _e:
        print(f'[py/bitboard] legal_moves iteration failed: {_e}')
    return moves

def _legal_moves_laplacian(state, origin):
    """Discrete-Laplacian eigenbasis oracle. Pawns defer to bitboard
    (Laplacian doesn't model pawn rules). Uses native GameState4D push/pop
    for occupation/check filtering (no chess4d shim needed — M11.40b)."""
    piece = state.board.occupant(origin)
    if piece is None:
        return []
    if getattr(piece.piece_type, 'name', '') == 'PAWN':
        return _legal_moves_bitboard(state, origin)
    try:
        from chess_spectral.spectral_legality_4d import reachable_targets_4d
    except Exception:
        return _legal_moves_bitboard(state, origin)
    piece_char = _PIECE_CHAR.get(piece.piece_type, '?')
    if piece_char == '?':
        return _legal_moves_bitboard(state, origin)
    origin_sq = (int(origin.x) << 9) | (int(origin.y) << 6) | (int(origin.z) << 3) | int(origin.w)
    try:
        reachable = reachable_targets_4d(piece_char, origin_sq)
    except Exception:
        return _legal_moves_bitboard(state, origin)
    moves = []
    for to_sq_int in reachable:
        to_sq = Square4D(
            (to_sq_int >> 9) & 7, (to_sq_int >> 6) & 7,
            (to_sq_int >> 3) & 7, to_sq_int & 7,
        )
        # Pre-filter: skip own-piece destinations
        try:
            target = state.board.occupant(to_sq)
            if target is not None and target.color == piece.color:
                continue
        except Exception:
            pass
        m = Move4D(from_sq=origin, to_sq=to_sq)
        try:
            state.push(m)  # native GameState4D push (M11.40b)
        except IllegalMoveError:
            continue
        state.pop()
        moves.append(m)
    return moves

def _legal_moves_phase(state, origin):
    """Phase-operator oracle. The occupation-aware A variant already
    filters for king-not-in-check, so no push/pop pass needed.
    Falls back to bitboard if phase module unavailable."""
    piece = state.board.occupant(origin)
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
            t = (getattr(d,'x',None), getattr(d,'y',None), getattr(d,'z',None), getattr(d,'w',None))
        if any(v is None for v in t):
            continue
        moves.append(Move4D(from_sq=origin, to_sq=Square4D(int(t[0]),int(t[1]),int(t[2]),int(t[3]))))
    return moves

def _legal_moves_for(state, origin):
    """Dispatch to the active legality oracle.
    Three oracles (M11.40b — 'spatial' removed):
      'bitboard'  [DEFAULT] — chess_spectral.spatial_4d.Board4D.legal_moves
      'phase'               — phase_operators_4d Fourier oracle
      'laplacian'           — spectral_legality_4d eigenbasis (pawns→bitboard)
    """
    if _legality_ops == 'phase':
        return _legal_moves_phase(state, origin)
    if _legality_ops == 'laplacian':
        return _legal_moves_laplacian(state, origin)
    return _legal_moves_bitboard(state, origin)

def _pieces_to_dicts(state):
    """Enumerate all pieces from a GameState4D as JS-friendly dicts."""
    out = []
    for color in (Color.WHITE, Color.BLACK):
        team_int = 0 if color == Color.WHITE else 1
        for sq, p in state.board.pieces_of(color):
            out.append({
                'x': int(sq.x), 'y': int(sq.y), 'z': int(sq.z), 'w': int(sq.w),
                'type': p.piece_type.name.lower(),
                'team': team_int,
                'pawn_axis': p.pawn_axis.name.lower() if getattr(p, 'pawn_axis', None) is not None else None,
            })
    return out

def _state_to_fen4(state):
    """Serialize GameState4D to FEN4 via native to_fen() (M11.40b)."""
    return state.to_fen()

def _state_to_pos4(state):
    """Convert GameState4D to {sq_idx: piece_value} for encoder_4d.
    Uses native iter_pieces() (M11.40b — Tier 1.6 shipped in 1.8.0)."""
    return dict(state.iter_pieces())

# Persistent worker state (M11.40b: GameState4D is the sole state type)
_state = initial_position()
_history_len = 0
_encoder_cache = None

def _get_qm_state_obj():
    """Return _state directly — it IS the GameState4D (M11.40b).
    No FEN4 round-trip, no cache invalidation, no translation layer."""
    return _state

def _state_side_to_move():
    """White-to-move bool from GameState4D.side_to_move."""
    s2m = getattr(_state, 'side_to_move', None)
    if s2m is None:
        return True
    return s2m == Color.WHITE or getattr(s2m, 'name', '') == 'WHITE'

def _refresh_encoder_cache():
    """Rebuild pos4 + sig + encoding from _state.
    Uses ENCODING_DIM constant (not hardcoded 45056) for HDC future-proofing."""
    global _encoder_cache
    try:
        from chess_spectral.encoder_4d import (
            encode_4d, board_signal_4d, _load_tables, CHANNELS_4D, ENCODING_DIM,
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
            'encoding_dim': int(ENCODING_DIM),  # runtime constant, not hardcoded
            'history_len': _history_len,
        }
    except Exception as e:
        _encoder_cache = {'error': f'{type(e).__name__}: {e}', 'history_len': _history_len}

print(f'[py/m11.40b] chess_spectral_4d 1.9.0 native state ready. '
      f'legality_ops={_legality_ops}  starting_fen4_len={len(STARTING_FEN4)}')
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
    },
    'imports': {
        'chess_spectral': _import('chess_spectral'),
        'chess_spectral_4d': _import('chess_spectral_4d'),
        'phase_operators_4d': _import('chess_spectral.phase_operators_4d'),
        'encoder_4d': _import('chess_spectral.encoder_4d'),
        'spatial_4d': _import('chess_spectral.spatial_4d'),
    },
    # M11.40b: chess4d removed; GameState4D is always active.
    'm11_40b': {
        'state_type': type(_state).__name__,
        'legality_ops': _legality_ops,
        'starting_fen4_available': bool(STARTING_FEN4),
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
    // M11.40b: initial_position() always returns a GameState4D.
    pyodide.runPython(`
_state = initial_position()
_history_len = 0
_encoder_cache = None
`);
    return { ok: true, history_len: 0 };
  },

  // Sets the legality oracle backend.
  //   'bitboard'  — chess_spectral.spatial_4d.Board4D.legal_moves [M11.40a DEFAULT]
  //   'phase'     — chess_spectral.phase_operators_4d (Fourier-domain)
  //   'laplacian' — chess_spectral.spectral_legality_4d (eigenbasis)
  // M11.40b: 'spatial' removed (was chess4d.pieces.* — dep dropped).
  setLegalityOps(args) {
    if (status !== 'ready') throw new Error(`Worker not ready (status=${status})`);
    const VALID_OPS = ['bitboard', 'phase', 'laplacian'];
    const ops = (args && VALID_OPS.includes(args.ops)) ? args.ops : 'bitboard';
    pyodide.globals.set('_set_ops_value', ops);
    pyodide.runPython(`
global _legality_ops
_legality_ops = _set_ops_value
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
      .runPython(`_pieces_to_dicts(initial_position())`)
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
    s = initial_position()
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
  // args: { channels: ['A1','STD4_X',...], useSheets?: bool }
  //   useSheets=true: encode_4d(pos4, sheets=SheetState) → 45067-dim.
  //   The base 11 channels still occupy offsets 0..45055; sheet aux
  //   sits at 45056..45066. Non-Markovian context (castling, EP, STM,
  //   halfmove, rep) is baked into the full vector so positions that
  //   differ only by history are now correctly distinguished. Opt-in:
  //   default false preserves the existing 45056-dim behavior.
  // returns: { ok, history_len, channels: { name: [4096 floats], ... },
  //            encoding_dim, used_sheets }
  getBoardEncoding(args) {
    if (status !== 'ready') throw new Error(`Worker not ready (status=${status})`);
    const channels = (args && Array.isArray(args.channels) && args.channels.length > 0)
      ? args.channels
      : ['A1'];
    const useSheets = !!(args && args.useSheets);
    pyodide.globals.set('_board_enc_channels', channels);
    pyodide.globals.set('_board_enc_use_sheets', useSheets);
    return pyodide
      .runPython(
        `
def _do_board_encoding():
    if _encoder_cache is None or _encoder_cache.get('history_len') != _history_len:
        _refresh_encoder_cache()
    cache = _encoder_cache
    if cache is None or cache.get('error'):
        return {'ok': False, 'reason': (cache or {}).get('error', 'encoder unavailable'), 'history_len': _history_len}

    if _board_enc_use_sheets:
        # Rebuild with SheetState for the representation-complete encoding.
        try:
            from chess_spectral import SheetState, encode_aux_block
            from chess_spectral.encoder_4d import encode_4d, ENCODING_DIM
            sheet = SheetState.from_game_state_4d(_state)
            enc = encode_4d(cache['pos4'], sheets=sheet)
            enc_dim = len(enc)  # 45067
        except Exception as _e:
            # Fall back to base encoding + log
            print(f'[py/sheet] SheetState encode failed: {_e}; using base')
            enc = cache['encoding']
            enc_dim = cache.get('encoding_dim', 45056)
    else:
        enc = cache['encoding']
        enc_dim = cache.get('encoding_dim', 45056)

    chans = cache['channels']  # [(name, offset), ...]
    by_name = {n: o for (n, o) in chans}
    out = {}
    for name in list(_board_enc_channels):
        offset = by_name.get(name)
        if offset is None:
            out[name] = None
            continue
        slc = enc[offset:offset + 4096]
        out[name] = [float(v) for v in slc]
    return {
        'ok': True,
        'history_len': _history_len,
        'channels': out,
        'encoding_dim': enc_dim,
        'used_sheets': _board_enc_use_sheets,
    }
_do_board_encoding()
`
      )
      .toJs({ dict_converter: Object.fromEntries, depth: 5 });
  },

  // ───────────────────────────────────────────────────────────────────
  // chess-spectral 1.9.0 §19 SheetState non-Markovian aux block (M19.1)
  //
  // The 11-dim SheetState captures position context that the base 45056-dim
  // encoder cannot distinguish: castling rights (4 bools), en-passant target
  // (1 float via Z₆₄ carrier), side-to-move (1 float), half-move clock
  // (1 float via Z₁₀₁ Fourier carrier for exact round-trip on [0,100]),
  // fullmove number (1 float), and repetition count (1 float).
  //
  // With sheets, encode_4d(pos4, sheets=SheetState) → ndarray(45067,).
  // Without sheets (default), → ndarray(45056,). Existing viz modules keep
  // working on the 45056-dim base; sheets are purely additive.
  //
  // HDC future-proofing: the aux block will be bundled into the hypervector
  // when the bit-serialized resonant ALU instrument ships. Use ENCODING_DIM
  // constant; never hardcode 45056.
  // ───────────────────────────────────────────────────────────────────

  // Returns the current position's SheetState as a human-readable dict +
  // the 11-dim aux vector. Useful for the "position completeness" debug
  // panel and for understanding which non-Markovian features affect
  // the representation-complete spectral signature.
  getSheetState() {
    if (status !== 'ready') throw new Error(`Worker not ready (status=${status})`);
    return pyodide
      .runPython(
        `
def _do_get_sheet_state():
    try:
        from chess_spectral import SheetState, encode_aux_block
    except ImportError as _e:
        return {'ok': False, 'error': f'SheetState not available: {_e}'}
    try:
        sheet = SheetState.from_game_state_4d(_state)
        aux = encode_aux_block(sheet)
        # Expose human-readable fields from the sheet object where accessible.
        # SheetState carries castling rights, EP target, STM, halfmove clock,
        # fullmove number, repetition count per the 1.9.0 API.
        def _safe(attr, default=None):
            v = getattr(sheet, attr, default)
            try: return bool(v) if isinstance(v, bool) else (int(v) if isinstance(v, int) else float(v))
            except Exception: return str(v) if v is not None else default
        return {
            'ok': True,
            'aux_vector': [float(x) for x in aux],
            'dim': len(aux),
            'side_to_move': _safe('side_to_move', None),
            'halfmove_clock': _safe('halfmove_clock', None),
            'fullmove_number': _safe('fullmove_number', None),
            'repetition_count': _safe('repetition_count', None),
            'en_passant': _safe('en_passant', None),
            'castling': {
                'white_kingside':   _safe('castling_white_kingside', None),
                'white_queenside':  _safe('castling_white_queenside', None),
                'black_kingside':   _safe('castling_black_kingside', None),
                'black_queenside':  _safe('castling_black_queenside', None),
            },
        }
    except Exception as e:
        return {'ok': False, 'error': f'{type(e).__name__}: {e}'}
_do_get_sheet_state()
`
      )
      .toJs({ dict_converter: Object.fromEntries, depth: 5 });
  },

  // Returns the current encoding dimensions:
  //   { base: 45056, withSheets: 45067 }
  // Use this instead of hardcoding. When the bit-serialized resonant HDC
  // instrument ships, these numbers will change.
  getEncodingDim() {
    if (status !== 'ready') throw new Error(`Worker not ready (status=${status})`);
    return pyodide
      .runPython(
        `
try:
    from chess_spectral.encoder_4d import ENCODING_DIM
    {'ok': True, 'base': int(ENCODING_DIM), 'withSheets': int(ENCODING_DIM) + 11}
except Exception as _e:
    {'ok': False, 'error': f'{type(_e).__name__}: {_e}', 'base': 45056, 'withSheets': 45067}
`
      )
      .toJs({ dict_converter: Object.fromEntries });
  },

  // Diagnostic — returns piece count + state type. Used by the debug panel.
  getInitialPositionInfo() {
    if (status !== 'ready') throw new Error(`Worker not ready (status=${status})`);
    return pyodide
      .runPython(
        `
def _do_info():
    # M11.40b: _state is always GameState4D; use iter_pieces() for count.
    try:
        count = sum(1 for _ in _state.iter_pieces())
    except Exception:
        count = -1
    try:
        from chess_spectral.encoder_4d import ENCODING_DIM
        enc_dim = int(ENCODING_DIM)
    except Exception:
        enc_dim = None
    return {
        'piece_count': count,
        'state_type': type(_state).__name__,
        'legality_ops': _legality_ops,
        'encoding_dim_base': enc_dim,
        'encoding_dim_with_sheets': (enc_dim + 11) if enc_dim is not None else None,
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
        # M11.40b: search() accepts GameState4D directly (1.8.0 — no FEN4 round-trip)
        result = search(_state, eval_fn, options)
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
        # M11.40b: derive position_dict from _state.iter_pieces() directly.
        # No FEN4 round-trip via Board4D needed.
        position_dict = dict(_state.iter_pieces())
        side_to_move = _state_side_to_move()
    except Exception as e:
        return {'ok': False, 'error': f'state read failed: {type(e).__name__}: {e}'}
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
