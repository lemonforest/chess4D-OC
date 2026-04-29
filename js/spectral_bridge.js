// spectral_bridge.js — main-thread RPC client for the Pyodide worker.
//
// Spawns the worker, holds a pending-resolvers Map keyed by request id,
// auto-initializes the worker on script load, and exposes a small async
// API on `window.SpectralBridge`. Sets `window.__SMOKE_READY__ = true`
// when the worker has loaded chess-spectral and chess4d successfully.
//
// Hand-rolled, no Comlink. Plan: ~/.claude/plans/4d-chess-spectral-visualizer-floating-church.md
// API contract: ~/.claude/projects/D--GitHub-chess4D-OC/memory/api-contracts.md

(function () {
  'use strict';

  // M4a feature flag: ?legalityEngine= controls who drives move legality.
  //   js     — JS engine is sole authority (default; current behavior)
  //   shadow — JS drives; Python runs in parallel and logs diffs to console
  //   py     — Python is sole authority (M4b — not yet wired)
  const flagFromUrl = new URLSearchParams(location.search).get('legalityEngine') || 'js';
  window.__LEGALITY_ENGINE__ = ['js', 'shadow', 'py'].includes(flagFromUrl) ? flagFromUrl : 'js';

  // M7d feature flag: ?renderer= picks the rendering path.
  //   legacy    — 896 individual Mesh children of piecesContainer (default)
  //   instanced — 12 InstancedMesh objects (per-type per-team), per-instance
  //               color for highlight, lower draw-call count
  const renderFlag = new URLSearchParams(location.search).get('renderer');
  window.__RENDERER__ = (renderFlag === 'instanced') ? 'instanced' : 'legacy';

  // Spatial vs phase legality oracle:
  //   spatial — chess4d.pieces.{type}_moves + state.push filter (default; cheap)
  //   phase   — chess_spectral.phase_operators_4d.occupation_aware_moves_a_4d
  //             (Fourier-domain; same legality result, mostly here for parity
  //             validation since it's the same oracle the M5/M6 encoder is
  //             founded on)
  const opsFlag = new URLSearchParams(location.search).get('legalityOps');
  window.__LEGALITY_OPS__ = (opsFlag === 'phase') ? 'phase' : 'spatial';

  // M7e feature flag: ?gpu= picks the renderer backend.
  //   webgl  — Three.js WebGLRenderer (default; broadly compatible)
  //   webgpu — Three.js WebGPURenderer (r184 GA; falls back to webgl
  //            automatically if navigator.gpu is missing or init() fails)
  // BatchedMesh on WebGPU is currently slower than WebGL on Android per
  // mrdoob/three.js#29580 — keep webgl as the default until benchmarks
  // say otherwise.
  const gpuFlag = new URLSearchParams(location.search).get('gpu');
  window.__GPU__ = (gpuFlag === 'webgpu') ? 'webgpu' : 'webgl';

  const worker = new Worker('js/spectral_worker.js');
  const pending = new Map();
  let nextId = 1;

  worker.addEventListener('message', (event) => {
    const data = event.data || {};
    const { id, ok, result, error } = data;
    if (!id) return;
    const handler = pending.get(id);
    if (!handler) return;
    pending.delete(id);
    if (ok) {
      handler.resolve(result);
    } else {
      const err = new Error(
        error && error.message ? error.message : 'Worker call failed'
      );
      if (error && error.name) err.name = error.name;
      if (error && error.stack) err.stack = error.stack;
      handler.reject(err);
    }
  });

  worker.addEventListener('error', (event) => {
    console.error('[SpectralBridge] worker error:', event.message || event);
  });

  function call(method, ...args) {
    return new Promise((resolve, reject) => {
      const id = String(nextId++);
      pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, method, args });
      } catch (err) {
        pending.delete(id);
        reject(err);
      }
    });
  }

  // Apply-chain queue: serializes applyMove and undo so that the worker's
  // move history advances atomically, and legalMoves observes the latest
  // state. Other read-only methods don't need this — they're idempotent.
  let applyChain = Promise.resolve();
  function chained(method, ...args) {
    const p = applyChain.then(() => call(method, ...args));
    applyChain = p.catch(() => {}); // swallow rejections so the chain doesn't poison
    return p;
  }

  // M5 hover coalescer — single in-flight previewEncoding plus a single
  // queued one. New hover requests replace the queued one; older queued
  // promises resolve to the most-recent result. This stops backpressure
  // when hovering across many pieces faster than encode_4d can run.
  let previewInFlight = null;
  let previewQueued = null;
  function previewCoalesced(origin) {
    if (previewInFlight === null) {
      previewInFlight = applyChain
        .then(() => call('previewEncoding', origin))
        .finally(() => {
          previewInFlight = null;
          if (previewQueued) {
            const next = previewQueued;
            previewQueued = null;
            next.start();
          }
        });
      return previewInFlight;
    }
    // There is already one in flight — supersede the queued one.
    if (previewQueued) {
      previewQueued.cancel(new Error('superseded'));
    }
    let resolveOuter, rejectOuter;
    const outer = new Promise((res, rej) => {
      resolveOuter = res;
      rejectOuter = rej;
    });
    previewQueued = {
      origin,
      start() {
        previewInFlight = applyChain
          .then(() => call('previewEncoding', origin))
          .then(
            (v) => {
              previewInFlight = null;
              if (previewQueued) {
                const next = previewQueued;
                previewQueued = null;
                next.start();
              }
              resolveOuter(v);
            },
            (e) => {
              previewInFlight = null;
              if (previewQueued) {
                const next = previewQueued;
                previewQueued = null;
                next.start();
              }
              rejectOuter(e);
            }
          );
      },
      cancel(err) {
        rejectOuter(err);
      },
    };
    return outer;
  }

  const bridge = {
    init: () => call('init'),
    getStatus: () => call('getStatus'),
    getConstants: () => call('getConstants'),
    getInitialPositionInfo: () => call('getInitialPositionInfo'),

    // M4a stateful API — bridge enforces serial ordering of mutations.
    applyMove: (origin, dest) => chained('applyMove', { origin, dest }),
    undo: () => chained('undo'),
    resetToInitial: () => chained('resetToInitial'),
    legalMoves: (origin) => applyChain.then(() => call('legalMoves', origin)),
    setLegalityOps: (ops) => call('setLegalityOps', { ops }),

    // M5 hover spectral preview — debounced via the hover-coalescing
    // pattern (one in-flight + one queued, replace queued on new hover).
    previewEncoding: (origin) => previewCoalesced(origin),

    // M10 full-board encoding for the heat-map / filament overlays.
    // Refreshes only when the move-history advances (cheap slice off the
    // cached 45,056-dim vector).
    getBoardEncoding: (channels) =>
      applyChain.then(() => call('getBoardEncoding', { channels: channels || ['A1'] })),

    // M3.5 parity helpers — kept for the parity harness. listInitialPieces
    // is still the cleanest way to enumerate the canonical starting position.
    listInitialPieces: () => call('listInitialPieces'),
    legalMovesAtInitial: (origin) => call('legalMovesAtInitial', origin),
  };
  window.SpectralBridge = bridge;

  // Auto-initialize on script load. The loading overlay covers the UI
  // until init resolves; smoke test waits for window.__SMOKE_READY__.
  bridge
    .init()
    .then(async (info) => {
      console.log('[SpectralBridge] init complete', info);

      // Push the URL-flagged legality-ops choice into the worker so
      // _legal_moves_for dispatches correctly from the first call.
      try {
        await bridge.setLegalityOps(window.__LEGALITY_OPS__);
      } catch (err) {
        console.warn('[SpectralBridge] setLegalityOps failed:', err);
      }

      let constants = null;
      let initialPos = null;
      try {
        constants = await bridge.getConstants();
      } catch (err) {
        console.warn('[SpectralBridge] getConstants failed:', err);
      }
      try {
        initialPos = await bridge.getInitialPositionInfo();
      } catch (err) {
        console.warn('[SpectralBridge] getInitialPositionInfo failed:', err);
      }

      window.__SPECTRAL_INFO__ = { ...info, constants, initialPos };
      window.__SMOKE_READY__ = true;

      // Hide the loading overlay (CSS handles fade-out).
      const overlay = document.getElementById('engine-loading-overlay');
      if (overlay) overlay.classList.add('engine-loading-overlay--hidden');

      // Update the optional debug panel if it exists.
      const debugStatus = document.getElementById('engine-debug-status');
      if (debugStatus) {
        const v = info.versions || {};
        const c = constants || {};
        const p = initialPos || {};
        debugStatus.textContent =
          `chess-spectral ${v.chess_spectral || '?'}, ` +
          `chess4d ${v.chess4d || '?'}, ` +
          `pyodide ${info.pyodide || '?'}, ` +
          `MODULUS_4D=${c.MODULUS_4D || '?'}, ` +
          `pieces=${p.piece_count != null ? p.piece_count : '?'}`;
      }
    })
    .catch((err) => {
      console.error('[SpectralBridge] init failed:', err);
      window.__SMOKE_READY__ = false;
      window.__SPECTRAL_ERROR__ = err && err.message ? err.message : String(err);

      const overlay = document.getElementById('engine-loading-overlay');
      if (overlay) {
        overlay.classList.add('engine-loading-overlay--error');
        const detail = overlay.querySelector('.engine-loading-detail');
        if (detail) {
          detail.textContent = `Engine failed to load: ${window.__SPECTRAL_ERROR__}`;
        }
      }
    });
})();
