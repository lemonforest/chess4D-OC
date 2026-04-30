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

  // Three legality oracles (1.6.1: all three in-house, head-to-head validated):
  //   spatial  — chess4d.pieces.{type}_moves + state.push filter (default; cheap)
  //   phase    — chess_spectral.phase_operators_4d.occupation_aware_moves_a_4d
  //              (Fourier-domain; same legality result, founded on the M5/M6
  //              encoder's eigenbasis)
  //   bitboard — chess_spectral.spatial_4d.Board4D.legal_moves (M11.32, 1.6.1+)
  //              The "engineering lens" — bitboard4d primitive with magic-style
  //              ray casting and per-piece attack tables. Fastest in principle;
  //              chess4D-OC's gain is mostly nominal since legality lookup is
  //              already cheap, but useful as a third parity oracle.
  const opsFlag = new URLSearchParams(location.search).get('legalityOps');
  window.__LEGALITY_OPS__ = ['phase', 'bitboard'].includes(opsFlag) ? opsFlag : 'spatial';

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

    // ───────────────────────────────────────────────────────────────
    // chess-spectral 1.5 §17.5 dev/debug surface (M11.25)
    // ───────────────────────────────────────────────────────────────

    // Clean { ok, version, source? } — replaces grepping the micropip
    // output for the chess-spectral version.
    getVersion: () => call('getVersion'),

    // 11-channel encoder layout: { ok, totalDim, channels: [{name, offset, dim}, ...] }.
    // Cache this once at boot — it's runtime-invariant for a given
    // chess-spectral version.
    getEncoderShape: () => call('getEncoderShape'),

    // ───────────────────────────────────────────────────────────────
    // M11.26: async legality + state read-out for checkmate/stalemate
    // detection without blocking the main thread.
    // ───────────────────────────────────────────────────────────────

    // Async drop-in for gameBoard.hasLegalMoves(team). Returns
    //   { ok, hasMoves: boolean }
    // Goes through applyChain so it observes the post-move state when
    // called immediately after applyMove resolves. Designed to drive
    // checkmate / stalemate detection off the main thread (the M11.16
    // freeze fix's principled cutover path).
    hasLegalMoves: (team) =>
      applyChain.then(() => call('hasLegalMoves', { team })),

    // Returns { ok, fen4 } — current state as FEN4 v1 string. Best-
    // effort serialization (probes chess_spectral.fen_4d for a canonical
    // serializer; falls back to hand-rolled minimal v1). Suitable for
    // M11.6-style export-to-clipboard and round-trip into the QM
    // bridge for analysis.
    getFen4State: () => applyChain.then(() => call('getFen4State')),

    // ───────────────────────────────────────────────────────────────
    // chess-spectral 1.5 §17.1 QM kinematics (M11.27)
    // ───────────────────────────────────────────────────────────────

    // Lift current classical state to ψ ∈ ℂ^45056. Returns:
    //   { ok, psi: Float32Array(90112), basisDim: 45056, normSq }
    // psi[2k] = Re(ψ_k), psi[2k+1] = Im(ψ_k). Goes through applyChain
    // so post-move QM state is consistent with the move just applied.
    // Optional opts: { sideToMove?: boolean } overrides the classical
    // state's side-to-move (default: read from chess4d state).
    getQmState: (opts) =>
      applyChain.then(() => call('getQmState', opts || {})),

    // Per-cell density |ψ_p|² summed across the 11 channels. Returns:
    //   { ok, density: Float32Array(4096) }
    // Cell index packing: idx = x*512 + y*64 + z*8 + w. Sum normalizes
    // to 1.0 ± 1e-6 by Born-rule construction. M14.1 density overlay
    // consumes this directly.
    getQmDensity: () => applyChain.then(() => call('getQmDensity')),

    // M11.28: PREVIEW-style apply_move_qm. Returns the assembled ψ_post
    // for a hypothetical move WITHOUT mutating the underlying chess4d
    // state. Use applyMove() for the actual game-state advance; this
    // method is for visualization / single-move QM analysis.
    //
    // Returns: { ok, psi: Float32Array(90112), basisDim: 45056, normSq }
    applyMoveQm: (origin, dest) =>
      applyChain.then(() => call('applyMoveQm', { origin, dest })),

    // ───────────────────────────────────────────────────────────────
    // chess-spectral 1.5 §17.1 QM dynamics + measurement (M11.29)
    // ───────────────────────────────────────────────────────────────

    // Born-rule projective measurement at a lattice cell. observable
    // defaults to the channel-projection PVM if omitted; pass
    // 'rook'|'bishop'|'queen'|'king'|'knight' to measure in the
    // corresponding H_piece_4 eigenbasis. Returns:
    //   { ok, sampledOutcome, postCollapsePsi }
    // The post-collapse ψ is what M14.4 click-to-measure shows after
    // the user clicks a cell.
    measureAt: (coord, observable) =>
      applyChain.then(() => call('measureAt', { coord, observable })),

    // Reduced density matrix ρ_piece for one piece. Returns:
    //   { ok, rho, purity, rank }
    // pieceId: 0..N-1 in chess_spectral_4d's piece-listing order.
    // Used by M14.3 entanglement viz (purity = tr(ρ²); rank > 1 ⇒
    // piece is entangled with others).
    getDensityMatrixOf: (pieceId) =>
      applyChain.then(() => call('getDensityMatrixOf', { pieceId })),

    // Probability-current vector field j_p(c) = Im(ψ* ∇ψ). Returns:
    //   { ok, j: Float32Array }
    // Shape per upstream contract — typically 4096 × 4 (4D flow vector
    // per cell). M14.2 filament viz traces this field.
    getProbabilityCurrent: () =>
      applyChain.then(() => call('getProbabilityCurrent')),

    // Expectation value ⟨ψ|H|ψ⟩ for a Hermitian observable. Returns:
    //   { ok, value }
    // observable: one of 'rook'|'bishop'|'queen'|'king'|'knight';
    // weights (optional dict): for composing observables, e.g.
    //   { rook: 0.4, bishop: 0.3, knight: 0.3 }.
    // M13.4 chess-spectral 1.6 will use this for QM-flavored bot eval.
    getQmExpectation: (observable, weights) =>
      applyChain.then(() => call('getQmExpectation', { observable, weights })),

    // ───────────────────────────────────────────────────────────────
    // chess-spectral 1.6.1 §16 engine surface (M13.4)
    // ───────────────────────────────────────────────────────────────

    // Run iterative-deepening alpha-beta search at the current state.
    //   opts: { evaluator: 'material'|'qm'|'spectral', maxDepth?,
    //           timeBudgetMs?, useTt?, useMvvLva?, useQuiescence? }
    //   → { ok, move: {x0,y0,z0,w0,x1,y1,z1,w1}, evaluator, score,
    //       depth, elapsedMs, nodesSearched, ttHits, ttSize,
    //       pv: [{from:{x,y,z,w}, to:{x,y,z,w}}, ...] }
    //
    // Search runs in the worker, freeing the main thread. PV (principal
    // variation) is the engine's predicted continuation — drives M14.5
    // ghost-arrow overlay.
    getBestMove: (opts) =>
      applyChain.then(() => call('getBestMove', opts || {})),

    // Static eval at the current state without searching. Returns:
    //   { ok, evaluator, value, breakdown? }
    // breakdown is the per-piece (qm) / per-channel (spectral) decomp;
    // material returns scalar only. M14.6 eval-bar overlay rides this.
    evaluatePosition: (opts) =>
      applyChain.then(() => call('evaluatePosition', opts || {})),
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
