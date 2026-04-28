// spectral_worker.js — Pyodide host running in a Web Worker.
//
// Boots Pyodide from CDN, micropip-installs chess-spectral and
// python-chess4d-oana-chiru (>=0.4.0), and exposes a small RPC surface to
// the main thread via spectral_bridge.js.
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
    await micropip.install(
      ['chess-spectral>=1.3.1', 'python-chess4d-oana-chiru>=0.4.0'],
      true /* keep_going */
    );

    // Set up the chess4d adapter once. All handlers below call into this
    // namespace (no per-call API discovery — chess4d 0.4 is stable enough).
    pyodide.runPython(`
import chess4d
from chess4d import (
    Square4D, Move4D, GameState, Color, PieceType, PawnAxis, Piece,
    initial_position, IllegalMoveError,
)
from chess4d.pieces import (
    bishop_moves, king_moves, knight_moves, pawn_moves, queen_moves, rook_moves,
)

# Standard chess letter notation: knight = N (since K is the king).
_PIECE_CHAR = {
    PieceType.PAWN:   'P',
    PieceType.ROOK:   'R',
    PieceType.KNIGHT: 'N',
    PieceType.BISHOP: 'B',
    PieceType.QUEEN:  'Q',
    PieceType.KING:   'K',
}

_PIECE_GEN = {
    PieceType.PAWN:   pawn_moves,
    PieceType.ROOK:   rook_moves,
    PieceType.KNIGHT: knight_moves,
    PieceType.BISHOP: bishop_moves,
    PieceType.QUEEN:  queen_moves,
    PieceType.KING:   king_moves,
}

def _legal_moves_for(state, origin):
    """Filter pseudo-legal moves through GameState.push to drop ones that
    leave the moving side's king in check (paper §3.4 Def 3). Returns a
    list of Move4D. Note: pawn_moves reads pawn_axis off the board, so it
    has the same (origin, color, board) signature as the other generators."""
    piece = state.board.occupant(origin)
    if piece is None:
        return []
    gen = _PIECE_GEN.get(piece.piece_type)
    if gen is None:
        return []
    pseudo = list(gen(origin, piece.color, state.board))
    legal = []
    for m in pseudo:
        try:
            state.push(m)
        except IllegalMoveError:
            continue
        state.pop()
        legal.append(m)
    return legal

def _pieces_to_dicts(state):
    out = []
    for color in (Color.WHITE, Color.BLACK):
        for sq, p in state.board.pieces_of(color):
            out.append({
                'x': int(sq.x), 'y': int(sq.y), 'z': int(sq.z), 'w': int(sq.w),
                'type': p.piece_type.name.lower(),
                'team': int(color),
                'pawn_axis': p.pawn_axis.name.lower() if p.pawn_axis is not None else None,
            })
    return out

def _state_to_pos4(state):
    """Convert chess4d state to {sq_idx: piece_value} for chess_spectral.encoder_4d.
    sq_idx = x*512 + y*64 + z*8 + w (matches chess_spectral.tables_4d.sq4)."""
    pos4 = {}
    for sq, p in state.board._squares.items():
        idx = (int(sq.x) << 9) | (int(sq.y) << 6) | (int(sq.z) << 3) | int(sq.w)
        upper = _PIECE_CHAR[p.piece_type]
        char = upper if p.color == Color.WHITE else upper.lower()
        if p.piece_type == PieceType.PAWN:
            pos4[idx] = (char, p.pawn_axis.name.lower())
        else:
            pos4[idx] = char
    return pos4

# --- Persistent worker state (state.push / state.pop are the primitives) ---
_state = initial_position()
_history_len = 0
_encoder_cache = None

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

print('[py] chess4d 0.4 adapter ready')
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
}
`
      )
      .toJs({ dict_converter: Object.fromEntries });

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
    pyodide.runPython(`
_state = initial_position()
_history_len = 0
_encoder_cache = None
`);
    return { ok: true, history_len: 0 };
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

  // M3.5 parity helpers — run against a fresh initial_position() so they're
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

  // Diagnostic — returns piece count + state type. Used by the debug panel.
  getInitialPositionInfo() {
    if (status !== 'ready') throw new Error(`Worker not ready (status=${status})`);
    return pyodide
      .runPython(
        `
def _do_info():
    s = initial_position()
    count = sum(1 for _ in s.board._squares)
    return {'piece_count': count, 'state_type': type(s).__name__}
_do_info()
`
      )
      .toJs({ dict_converter: Object.fromEntries });
  },
};

self.onmessage = async (event) => {
  const data = event.data || {};
  const { id, method, args = [] } = data;
  if (!id || !method) {
    // Ignore unrelated messages (e.g., extension noise).
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
