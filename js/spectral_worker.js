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
