// spectral_worker.js — Pyodide host running in a Web Worker.
//
// Boots Pyodide from CDN, micropip-installs chess-spectral and
// python-chess4d-oana-chiru, and exposes a small RPC surface to
// the main thread via spectral_bridge.js.
//
// Protocol: { id, method, args } -> { id, ok, result } | { id, ok:false, error }
// See ~/.claude/projects/D--GitHub-chess4D-OC/memory/api-contracts.md.

const PYODIDE_VERSION = 'v0.26.4';
const PYODIDE_URL = `https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full/`;

importScripts(`${PYODIDE_URL}pyodide.js`);

let pyodide = null;
let status = 'loading'; // loading -> initializing -> ready | error
let initError = null;
let cachedVersions = null;

async function ensureInit() {
  if (pyodide) return { ready: true, versions: cachedVersions };
  status = 'initializing';
  try {
    // eslint-disable-next-line no-undef -- loadPyodide is global from importScripts
    pyodide = await loadPyodide({
      indexURL: PYODIDE_URL,
      stdout: (msg) => console.log('[py]', msg),
      stderr: (msg) => console.warn('[py-err]', msg),
    });

    await pyodide.loadPackage('micropip');
    const micropip = pyodide.pyimport('micropip');
    await micropip.install([
      'chess-spectral>=1.3.0',
      'python-chess4d-oana-chiru>=0.3.3',
    ]);

    // Confirm both packages import. Versions are best-effort —
    // some upstream packages don't export __version__.
    const versions = pyodide
      .runPython(
        `
import importlib.metadata as m
def _ver(pkg):
    try:
        return m.version(pkg)
    except Exception:
        return 'unknown'
import chess_spectral
import chess4d
{
    'chess_spectral': _ver('chess-spectral'),
    'chess4d': _ver('python-chess4d-oana-chiru'),
}
`
      )
      .toJs({ dict_converter: Object.fromEntries });

    cachedVersions = versions;
    status = 'ready';
    return {
      ready: true,
      versions,
      pyodide: pyodide.version,
    };
  } catch (err) {
    status = 'error';
    initError = err;
    throw err;
  }
}

const handlers = {
  init: ensureInit,

  getStatus() {
    return {
      status,
      error: initError ? String(initError.message || initError) : null,
    };
  },

  // Pulls constants from chess_spectral.phase_operators_4d. The plan calls
  // out that the package is the source of truth — never hardcode in JS.
  // Tries the canonical import path, falls back to package-level attrs.
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

  // M3.5 parity helper: list every piece in the initial position so the
  // parity harness can iterate them and ask both engines for legal moves
  // at each square. Returns array of {x, y, z, w, type, team} dicts.
  listInitialPieces() {
    if (status !== 'ready') {
      throw new Error(`Worker not ready (status=${status})`);
    }
    return pyodide
      .runPython(
        `
import chess4d
state = chess4d.initial_position()

# chess4d's piece-list shape varies; try the common attribute paths.
def _iter_pieces(s):
    for path in [('board', 'pieces'), ('pieces',), ('board',)]:
        obj = s
        for attr in path:
            obj = getattr(obj, attr, None)
            if obj is None:
                break
        if obj is not None:
            try:
                iter(obj)
                return obj
            except TypeError:
                continue
    return []

def _piece_dict(p):
    # Pieces commonly expose .x/.y/.z/.w (or .position tuple) and .team/.type
    coords = None
    for attr in ('position', 'square', 'pos'):
        v = getattr(p, attr, None)
        if v is not None:
            try:
                coords = tuple(v)[:4]
                break
            except TypeError:
                pass
    if coords is None:
        coords = (
            getattr(p, 'x', None), getattr(p, 'y', None),
            getattr(p, 'z', None), getattr(p, 'w', None),
        )
    return {
        'x': int(coords[0]) if coords[0] is not None else -1,
        'y': int(coords[1]) if coords[1] is not None else -1,
        'z': int(coords[2]) if coords[2] is not None else -1,
        'w': int(coords[3]) if coords[3] is not None else -1,
        'type': str(getattr(p, 'kind', getattr(p, 'piece_type', getattr(p, 'type', type(p).__name__)))),
        'team': int(getattr(p, 'team', getattr(p, 'color', getattr(p, 'side', -1)))),
    }

[_piece_dict(p) for p in _iter_pieces(state)]
`
      )
      .toJs({ dict_converter: Object.fromEntries });
  },

  // M3.5 parity helper: returns legal destinations for the piece at the
  // given (x, y, z, w) in the initial position, as an array of
  // {x, y, z, w} dicts. Uses chess_spectral.phase_operators_4d's
  // occupation-aware oracle. Best-effort API discovery — chess-spectral's
  // exact import path varies between releases; fall through alternatives.
  legalMovesAtInitial(args) {
    if (status !== 'ready') {
      throw new Error(`Worker not ready (status=${status})`);
    }
    const x = args.x, y = args.y, z = args.z, w = args.w;
    pyodide.globals.set('_origin_x', x);
    pyodide.globals.set('_origin_y', y);
    pyodide.globals.set('_origin_z', z);
    pyodide.globals.set('_origin_w', w);
    return pyodide
      .runPython(
        `
import chess4d
state = chess4d.initial_position()
origin = (int(_origin_x), int(_origin_y), int(_origin_z), int(_origin_w))

# Find the piece at origin (best-effort across chess4d API shapes).
def _piece_at(s, coords):
    if hasattr(s, 'board'):
        b = s.board
        for fn in ('get_piece', 'piece_at', 'at'):
            f = getattr(b, fn, None)
            if callable(f):
                try:
                    return f(*coords)
                except TypeError:
                    try:
                        return f(coords)
                    except Exception:
                        pass
        if hasattr(b, 'pieces'):
            for p in b.pieces:
                pos = (
                    getattr(p, 'x', None), getattr(p, 'y', None),
                    getattr(p, 'z', None), getattr(p, 'w', None),
                )
                if pos == coords:
                    return p
    if hasattr(s, 'pieces'):
        for p in s.pieces:
            pos = (
                getattr(p, 'x', None), getattr(p, 'y', None),
                getattr(p, 'z', None), getattr(p, 'w', None),
            )
            if pos == coords:
                return p
    return None

piece = _piece_at(state, origin)
if piece is None:
    result = {'ok': False, 'reason': 'no-piece-at-origin', 'moves': []}
else:
    # Try the canonical occupation-aware-moves API and fall through.
    moves = None
    err = None
    try:
        from chess_spectral.phase_operators_4d.occupation_aware_a_4d import (
            occupation_aware_moves_a_4d,
        )
        moves = occupation_aware_moves_a_4d(state, origin, piece)
    except Exception as e:
        err = f'occupation_aware_a_4d: {type(e).__name__}: {e}'
    if moves is None:
        try:
            from chess_spectral import phase_operators_4d as po
            moves = po.occupation_aware_moves_a_4d(state, origin, piece)
        except Exception as e:
            err = (err or '') + f' | po: {type(e).__name__}: {e}'
    if moves is None:
        # Last resort: chess4d's own legal_moves and filter by origin.
        try:
            all_legal = chess4d.legal_moves(state)
            moves = [m.dest for m in all_legal if getattr(m, 'origin', None) == origin]
        except Exception as e:
            err = (err or '') + f' | chess4d.legal_moves: {type(e).__name__}: {e}'

    if moves is None:
        result = {'ok': False, 'reason': err or 'unknown', 'moves': []}
    else:
        # Normalize destinations to [{x,y,z,w}, ...]
        out = []
        for m in moves:
            try:
                t = tuple(m)[:4]
            except TypeError:
                t = (
                    getattr(m, 'x', None), getattr(m, 'y', None),
                    getattr(m, 'z', None), getattr(m, 'w', None),
                )
            if all(v is not None for v in t):
                out.append({'x': int(t[0]), 'y': int(t[1]), 'z': int(t[2]), 'w': int(t[3])})
        result = {'ok': True, 'reason': None, 'moves': out}

result
`
      )
      .toJs({ dict_converter: Object.fromEntries, depth: 4 });
  },

  // Sanity check that chess4d.initial_position() works in Pyodide.
  // Returns the piece count (~896) and the type repr for diagnostics.
  getInitialPositionInfo() {
    if (status !== 'ready') {
      throw new Error(`Worker not ready (status=${status})`);
    }
    return pyodide
      .runPython(
        `
import chess4d
state = chess4d.initial_position()

# chess4d's GameState may expose pieces under different attribute paths
# depending on version. Try the most common layouts in order.
def _piece_count(s):
    for path in [('board', 'pieces'), ('pieces',), ('board',)]:
        obj = s
        for attr in path:
            obj = getattr(obj, attr, None)
            if obj is None:
                break
        if obj is not None:
            try:
                return len(obj)
            except TypeError:
                continue
    return -1

{
    'piece_count': _piece_count(state),
    'state_type': type(state).__name__,
}
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
