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

    // keep_going=True so a failure on one package (e.g. missing pure-python
    // wheel) doesn't block the others. We then probe what actually imported
    // and surface the gap to JS via the `packages` field of the init result.
    await micropip.install(
      ['chess-spectral>=1.3.1', 'python-chess4d-oana-chiru>=0.3.3'],
      true /* keep_going */
    );

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

  // M4a state tracking — Python-canonical state with a JS-side mirror.
  // Keeps a move-history list and rebuilds state on demand. Slow on long
  // games (O(N) per query) but reliable across chess4d API variations.
  // M4b will replace with an in-place state mutation once the chess4d
  // API surface is locked down.

  resetToInitial() {
    if (status !== 'ready') {
      throw new Error(`Worker not ready (status=${status})`);
    }
    pyodide.runPython('_move_history = []');
    return { ok: true, history_len: 0 };
  },

  applyMove(args) {
    if (status !== 'ready') {
      throw new Error(`Worker not ready (status=${status})`);
    }
    pyodide.globals.set('_move_origin', [args.origin.x, args.origin.y, args.origin.z, args.origin.w]);
    pyodide.globals.set('_move_dest',   [args.dest.x,   args.dest.y,   args.dest.z,   args.dest.w]);
    return pyodide
      .runPython(
        `
import chess4d
try:
    _move_history
except NameError:
    _move_history = []

origin = tuple(int(v) for v in _move_origin)
dest   = tuple(int(v) for v in _move_dest)
_move_history.append((origin, dest))

# Validate by reconstructing — roll back if reconstruction fails.
def _try_apply(state, o, d):
    """Try various chess4d API shapes for applying a move."""
    for fn_name in ('apply_move', 'make_move', 'move', 'do_move', 'push'):
        fn = getattr(state, fn_name, None)
        if callable(fn):
            try:
                r = fn(o, d)
                return r if r is not None else state
            except TypeError:
                try:
                    r = fn((o, d))
                    return r if r is not None else state
                except Exception:
                    continue
            except Exception:
                continue
    fn = getattr(chess4d, 'apply_move', None) or getattr(chess4d, 'make_move', None)
    if callable(fn):
        try:
            return fn(state, o, d)
        except Exception:
            pass
    raise RuntimeError('No apply-move API found on chess4d state')

try:
    state = chess4d.initial_position()
    for (o, d) in _move_history:
        state = _try_apply(state, o, d)
    result = {'ok': True, 'history_len': len(_move_history)}
except Exception as e:
    _move_history.pop()
    result = {'ok': False, 'error': f'{type(e).__name__}: {e}', 'history_len': len(_move_history)}

result
`
      )
      .toJs({ dict_converter: Object.fromEntries });
  },

  undo() {
    if (status !== 'ready') {
      throw new Error(`Worker not ready (status=${status})`);
    }
    return pyodide
      .runPython(
        `
try:
    _move_history
except NameError:
    _move_history = []
if _move_history:
    _move_history.pop()
{'ok': True, 'history_len': len(_move_history)}
`
      )
      .toJs({ dict_converter: Object.fromEntries });
  },

  // M4a public legalMoves — uses CURRENT state (initial + applied moves).
  // Replaces M3.5's legalMovesAtInitial as the canonical query API.
  legalMoves(args) {
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
try:
    _move_history
except NameError:
    _move_history = []

origin = (int(_origin_x), int(_origin_y), int(_origin_z), int(_origin_w))

def _try_apply(state, o, d):
    for fn_name in ('apply_move', 'make_move', 'move', 'do_move', 'push'):
        fn = getattr(state, fn_name, None)
        if callable(fn):
            try:
                r = fn(o, d)
                return r if r is not None else state
            except TypeError:
                try:
                    r = fn((o, d))
                    return r if r is not None else state
                except Exception:
                    continue
            except Exception:
                continue
    raise RuntimeError('apply-move api missing')

# Rebuild current state from history.
state = chess4d.initial_position()
for (o, d) in _move_history:
    try:
        state = _try_apply(state, o, d)
    except Exception:
        # Skip moves that fail to apply — the state at least reflects
        # what we could replay.
        pass

# Find piece at origin (best-effort).
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
    result = {'ok': False, 'reason': 'no-piece-at-origin', 'moves': [], 'history_len': len(_move_history)}
else:
    moves = None
    err = None
    # 1) chess-spectral phase-operator oracle (preferred — same engine the
    # encoder will use in M5).
    try:
        from chess_spectral.phase_operators_4d.occupation_aware_a_4d import (
            occupation_aware_moves_a_4d,
        )
        moves = occupation_aware_moves_a_4d(state, origin, piece)
    except Exception as e:
        err = f'spectral: {type(e).__name__}: {e}'

    if moves is None:
        try:
            from chess_spectral import phase_operators_4d as po
            moves = po.occupation_aware_moves_a_4d(state, origin, piece)
        except Exception as e:
            err = (err or '') + f' | po: {type(e).__name__}: {e}'

    # 2) chess4d's native legality (works without chess-spectral).
    if moves is None:
        try:
            all_legal = chess4d.legal_moves(state)
            moves = [m.dest for m in all_legal if getattr(m, 'origin', None) == origin]
        except Exception as e:
            err = (err or '') + f' | chess4d: {type(e).__name__}: {e}'

    if moves is None:
        result = {'ok': False, 'reason': err or 'unknown', 'moves': [], 'history_len': len(_move_history)}
    else:
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
        result = {'ok': True, 'reason': None, 'moves': out, 'history_len': len(_move_history)}

result
`
      )
      .toJs({ dict_converter: Object.fromEntries, depth: 4 });
  },

  // M6 hover spectral preview — caches the current-state encoding and uses
  // closed-form delta math for the linear channels (A1 + STD4_X/Y/Z/W)
  // instead of re-encoding once per candidate destination. For nonlinear
  // channels (FIB_SYM_*, FA_PAWN_*, FD_DIAG) the value at the dest cell
  // depends on neighborhood structure, so we return null intensity in
  // the fast path and let JS fall back to default rendering.
  //
  // Math (see chess_spectral/encoder_4d.py for definitions):
  //   sig[s] = piece_value[piece_at(s)]                (sparse)
  //   A1     = P_A1 @ sig                              (matrix-vec)
  //   STD4_a = coord_resid[a] * sig                    (element-wise)
  //
  // For a move origin -> dest:
  //   delta_sig[origin] = -sig_before[origin]
  //   delta_sig[dest]   = piece_value(moving) - sig_before[dest]
  //   A1_after[d] = A1_before[d] + P_A1[d, origin]*Δo + P_A1[d, dest]*Δd
  //   STD4_a_after[d] = coord_resid[a][d] * sig_after[d]
  //
  // The encoder cache is refreshed whenever _move_history advances so
  // applyMove invalidates it implicitly.
  previewEncoding(args) {
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
import numpy as np
try:
    _move_history
except NameError:
    _move_history = []

# Try to load encoder pieces. encode_4d + board_signal_4d + _load_tables
# are all in chess_spectral.encoder_4d as of v1.3.1.
encoder_err = None
encode_4d = None
board_signal_4d = None
_load_tables = None
CHANNELS_4D = None
try:
    from chess_spectral.encoder_4d import (
        encode_4d, board_signal_4d, _load_tables, CHANNELS_4D as _CH,
    )
    CHANNELS_4D = list(_CH)
except Exception as e:
    encoder_err = f'{type(e).__name__}: {e}'

origin = (int(_origin_x), int(_origin_y), int(_origin_z), int(_origin_w))

def _sq4(x, y, z, w):
    return (int(x) << 9) | (int(y) << 6) | (int(z) << 3) | int(w)

def _try_apply(state, o, d):
    for fn_name in ('apply_move', 'make_move', 'move', 'do_move', 'push'):
        fn = getattr(state, fn_name, None)
        if callable(fn):
            try:
                r = fn(o, d)
                return r if r is not None else state
            except TypeError:
                try:
                    r = fn((o, d))
                    return r if r is not None else state
                except Exception:
                    continue
            except Exception:
                continue
    raise RuntimeError('apply-move api missing')

def _state_to_pos4(state):
    """Best-effort chess4d state -> {sq_idx: piece_value} for encode_4d.
    Pawn axis defaults to 'y'; if chess4d exposes a per-pawn axis attr we
    pick it up automatically."""
    pos4 = {}
    pieces = []
    if hasattr(state, 'board'):
        b = state.board
        if hasattr(b, 'pieces'):
            try:
                pieces = [p for p in b.pieces if p is not None and getattr(p, 'kind', getattr(p, 'piece_type', getattr(p, 'type', None)))]
            except Exception:
                pieces = []
    if not pieces and hasattr(state, 'pieces'):
        try:
            pieces = [p for p in state.pieces if p is not None and getattr(p, 'kind', getattr(p, 'piece_type', getattr(p, 'type', None)))]
        except Exception:
            pieces = []
    for p in pieces:
        x = getattr(p, 'x', None)
        y = getattr(p, 'y', None)
        z = getattr(p, 'z', None)
        w = getattr(p, 'w', None)
        if any(v is None for v in (x, y, z, w)):
            continue
        team = getattr(p, 'team', getattr(p, 'color', getattr(p, 'side', 0)))
        ptype_raw = str(getattr(p, 'kind', getattr(p, 'piece_type', getattr(p, 'type', 'P'))))
        first = ptype_raw[0].upper() if ptype_raw else 'P'
        char = first if int(team) == 0 else first.lower()
        if first == 'P':
            axis = getattr(p, 'axis', 'y')
            value = (char, str(axis).lower())
        else:
            value = char
        pos4[_sq4(x, y, z, w)] = value
    return pos4

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

# Rebuild current state from history (replay all moves from initial).
state = chess4d.initial_position()
for (o, d) in _move_history:
    try:
        state = _try_apply(state, o, d)
    except Exception:
        pass

piece = _piece_at(state, origin)

# Get legal destinations (same as legalMoves uses).
def _legal_dests(state, origin, piece):
    if piece is None:
        return []
    try:
        from chess_spectral.phase_operators_4d.occupation_aware_a_4d import (
            occupation_aware_moves_a_4d,
        )
        return list(occupation_aware_moves_a_4d(state, origin, piece))
    except Exception:
        try:
            all_legal = chess4d.legal_moves(state)
            return [m.dest for m in all_legal if getattr(m, 'origin', None) == origin]
        except Exception:
            return []

dests_raw = _legal_dests(state, origin, piece)
dests = []
for m in dests_raw:
    try:
        t = tuple(m)[:4]
    except TypeError:
        t = (
            getattr(m, 'x', None), getattr(m, 'y', None),
            getattr(m, 'z', None), getattr(m, 'w', None),
        )
    if all(v is not None for v in t):
        dests.append((int(t[0]), int(t[1]), int(t[2]), int(t[3])))

if piece is None:
    result = {'ok': False, 'reason': 'no-piece-at-origin', 'previews': []}
elif encode_4d is None:
    # Encoder unavailable — surface destinations with null intensities so
    # the JS overlay knows to fall back to default rendering.
    result = {
        'ok': False,
        'reason': f'encoder unavailable: {encoder_err}',
        'channels': None,
        'previews': [{'dest': {'x': d[0], 'y': d[1], 'z': d[2], 'w': d[3]}, 'intensities': None} for d in dests],
    }
else:
    # ---- M6 fast path: cache current encoding + linear-channel delta ----
    # Cache is keyed on len(_move_history); applyMove implicitly invalidates.
    try:
        _encoder_cache
    except NameError:
        _encoder_cache = None

    if _encoder_cache is None or _encoder_cache.get('history_len') != len(_move_history):
        try:
            cur_pos4 = _state_to_pos4(state)
            cur_sig = board_signal_4d(cur_pos4)
            cur_encoding = encode_4d(cur_pos4)
            tables = _load_tables()
            _encoder_cache = {
                'pos4': cur_pos4,
                'sig': cur_sig,
                'encoding': cur_encoding,
                'tables': tables,
                'history_len': len(_move_history),
            }
        except Exception as e:
            _encoder_cache = {'error': f'{type(e).__name__}: {e}', 'history_len': len(_move_history)}

    if _encoder_cache.get('error'):
        result = {
            'ok': False,
            'reason': f'cache error: {_encoder_cache["error"]}',
            'channels': [name for (name, _) in (CHANNELS_4D or [])],
            'previews': [{'dest': {'x': d[0], 'y': d[1], 'z': d[2], 'w': d[3]}, 'intensities': None} for d in dests],
        }
    else:
        pos4   = _encoder_cache['pos4']
        sig    = _encoder_cache['sig']
        enc    = _encoder_cache['encoding']
        tables = _encoder_cache['tables']
        P_A1   = tables['P_A1']
        coord_resid = tables['coord_resid']
        CHANNEL_DIM = 4096

        origin_sq = _sq4(*origin)
        moving_piece = pos4.get(origin_sq)

        def _piece_value_for_sig(piece_value):
            """Get the moving piece's signed value at any new square."""
            if piece_value is None:
                return 0.0
            mock_sig = board_signal_4d({0: piece_value})
            return float(mock_sig[0])

        moving_piece_value = _piece_value_for_sig(moving_piece)

        # Channel-name list aligned with CHANNELS_4D layout in encoder_4d.py.
        channel_names = [name for (name, _) in CHANNELS_4D]
        # Linear channels: A1 = channels[0], STD4_X..W = channels[1..4]
        LINEAR_NAMES = set(channel_names[:5])  # A1, STD4_X/Y/Z/W

        def _scalar(M, i, j):
            try:
                v = M[i, j]
            except Exception:
                return 0.0
            try:
                return float(v)
            except Exception:
                try:
                    return float(np.asarray(v).reshape(())[()])
                except Exception:
                    return 0.0

        previews = []
        for (dx, dy, dz, dw) in dests:
            dest_sq = _sq4(dx, dy, dz, dw)
            sig_before_origin = float(sig[origin_sq])
            sig_before_dest   = float(sig[dest_sq])
            delta_sig_origin  = -sig_before_origin
            delta_sig_dest    = moving_piece_value - sig_before_dest
            sig_after_at_dest = moving_piece_value

            intensities = {}
            # Channel 0 (A1): linear in sig, matrix multiply.
            a1_before_at_dest = float(enc[dest_sq])
            a1_delta_at_dest  = (
                _scalar(P_A1, dest_sq, origin_sq) * delta_sig_origin
                + _scalar(P_A1, dest_sq, dest_sq) * delta_sig_dest
            )
            intensities[channel_names[0]] = a1_before_at_dest + a1_delta_at_dest

            # Channels 1-4 (STD4_X/Y/Z/W): coord_resid[a][d] * sig[d]
            # Only sig[dest] matters for the dest-cell value; sig[origin]
            # changing doesn't reach the dest cell in this element-wise channel.
            for a in range(4):
                ch_idx = 1 + a
                cr = coord_resid[a]
                try:
                    cr_at_dest = float(cr[dest_sq])
                except Exception:
                    cr_at_dest = 0.0
                intensities[channel_names[ch_idx]] = cr_at_dest * sig_after_at_dest

            # Nonlinear channels — null in fast path, JS falls back.
            for name in channel_names[5:]:
                intensities[name] = None

            previews.append({
                'dest': {'x': dx, 'y': dy, 'z': dz, 'w': dw},
                'intensities': intensities,
            })

        result = {
            'ok': True,
            'reason': None,
            'channels': channel_names,
            'fast_channels': sorted(list(LINEAR_NAMES)),
            'previews': previews,
        }

result
`
      )
      .toJs({ dict_converter: Object.fromEntries, depth: 5 });
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
