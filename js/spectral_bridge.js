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
