// spectral_board_tint.js — M11.3.6 alternative to "hide chess boards".
//
// User insight: instead of HIDING the 64 boards to expose the cloud,
// PAINT each cell of the chess board by the active channel value. The
// boards become the display surface for the spectral heatmap — cells
// stay visible (so piece positions are still readable), but their tint
// encodes the spectral signature.
//
// Visually this is closer to a "2D heatmap stacked on each board" than
// the volumetric cloud — flatter, denser, more legible at chess-game
// scale. Pairs naturally with the cloud (turn both on for double-coding):
//   - Cloud above the board: volumetric "where is the field"
//   - Tinted cells on the board: per-cell "what is the field at this position"
//
// Implementation: InstancedMesh of 4096 thin colored quads at board surface
// level, one per cell, per-instance color from the current channel slice.
// Renders before the cloud (renderOrder=1) so the cloud blends on top.
//
// API:
//   SpectralBoardTint.init(scene, gameBoard)
//   SpectralBoardTint.setChannel(name)
//   SpectralBoardTint.setEnabled(bool)
//   SpectralBoardTint.refresh()
//   SpectralBoardTint.getChannel()  / .isEnabled()

(function () {
  'use strict';

  let im = null;
  let _scene = null;
  let _gameBoard = null;
  let enabled = false;
  let channel = 'A1';
  let _initRequested = false;

  // M11.8: previously cached per-cell base positions, but this module
  // never reads them back — the InstancedMesh matrices are set once in
  // buildMesh and refresh() only updates colors, not positions. Removed.

  // Viridis-ish ramp — copy of spectral_heatmap.js so the modules stay
  // independent (heatmap might evolve to a custom ramp later).
  function viridisColor(t) {
    if (t < 0.25) {
      const u = t / 0.25;
      return [0.10, 0.18 + u * 0.42, 0.55 + u * 0.45];
    } else if (t < 0.5) {
      const u = (t - 0.25) / 0.25;
      return [0.10 + u * 0.05, 0.60 + u * 0.30, 1.00 - u * 0.50];
    } else if (t < 0.75) {
      const u = (t - 0.5) / 0.25;
      return [0.15 + u * 0.65, 0.90 - u * 0.10, 0.50 - u * 0.40];
    } else {
      const u = (t - 0.75) / 0.25;
      return [0.80 + u * 0.20, 0.80 - u * 0.55, 0.10];
    }
  }

  // 5/95 percentile clip — robust to single-cell outliers (same as the M11.1
  // heatmap normalization).
  function _percentileBounds(arr, lo, hi) {
    const sorted = new Float32Array(arr).sort();
    const n = sorted.length;
    return [sorted[Math.floor(lo * n)], sorted[Math.min(n - 1, Math.floor(hi * n))]];
  }

  function buildMesh() {
    if (im) return im;
    if (!_scene || !_gameBoard || !_gameBoard.graphics) return null;
    const gfx = _gameBoard.graphics;
    const square = gfx.squareSize || 50;
    // Thin quad with a small inset so neighboring cells don't z-fight
    // at the seam. The original board cells are 50 wide; we paint at
    // 92% so a hairline of the original board shows through (acts as a
    // grid line).
    const geom = new THREE.PlaneGeometry(square * 0.92, square * 0.92);
    // PlaneGeometry is in the XY plane by default; rotate so it lies on
    // the XZ plane (the board surface plane in our scene).
    geom.rotateX(-Math.PI / 2);
    // Fully opaque so the spectral color completely covers the
    // underlying light/dark checker square — the user gets the
    // SPECTRAL color *in place of* the original board color, not
    // mixed with it. (transparent=false disables alpha blending,
    // which is also faster.)
    const mat = new THREE.MeshBasicMaterial({
      transparent: false,
      side: THREE.DoubleSide,
      depthWrite: true,
    });
    im = new THREE.InstancedMesh(geom, mat, 4096);
    im.frustumCulled = false;
    // Render BEFORE the cloud (renderOrder=2) and BEFORE filaments
    // (renderOrder=3). Sits at the bottom of the transparent stack so
    // the cloud + filaments visually layer on top.
    im.renderOrder = 1;
    const colors = new Float32Array(4096 * 3);
    for (let i = 0; i < colors.length; i++) colors[i] = 0.5;
    im.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
    im.instanceColor.setUsage(THREE.DynamicDrawUsage);

    const matrix = new THREE.Matrix4();
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) {
        for (let z = 0; z < 8; z++) {
          for (let w = 0; w < 8; w++) {
            const pos = gfx.boardCoordinates(x, y, z, w);
            const idx = (x << 9) | (y << 6) | (z << 3) | w;
            // boardCoordinates returns the board ANCHOR Y; the actual
            // top surface of the 5-unit-thick board mesh sits at
            // approximately pos.y + boardHeight/2 = pos.y + 2.5. Place
            // the tint quad just above that (+3.0) so it sits on top
            // of the board, not inside the mesh — prevents z-fight with
            // the merged checker geometry. Pieces stand on the surface
            // at slightly higher Y so they remain visible above the tint.
            const ty = pos.y + 3.0;
            matrix.makeTranslation(pos.x, ty, pos.z);
            im.setMatrixAt(idx, matrix);
          }
        }
      }
    }
    im.instanceMatrix.needsUpdate = true;
    im.instanceColor.needsUpdate = true;
    im.visible = false;
    _scene.add(im);
    return im;
  }

  // M11.3.7 fix: refresh has multiple bail-out paths that fail SILENTLY
  // (returning early when bridge isn't ready, channel slice missing,
  // or array flat). User reported "tint doesn't seem to do anything"
  // — almost certainly because they enabled the checkbox before
  // __SPECTRAL_INFO__ was published OR because A1 at initial position
  // is near-uniform per cell. Now: retry once if bridge isn't ready,
  // and ALWAYS log refresh attempts so the diagnostics make it obvious.
  let _refreshRetries = 0;
  async function refresh() {
    if (!enabled || !im) {
      console.log(`[m11.3.6/tint] refresh skipped: enabled=${enabled} im=${!!im}`);
      return;
    }
    if (typeof window === 'undefined' || !window.SpectralBridge) {
      console.warn('[m11.3.6/tint] refresh skipped: no SpectralBridge');
      return;
    }
    if (!window.__SPECTRAL_INFO__) {
      // Bridge not ready yet — schedule a retry instead of bailing silently.
      // Up to 30 retries × 200ms = 6 seconds total before giving up.
      if (_refreshRetries < 30) {
        _refreshRetries++;
        console.log(`[m11.3.6/tint] bridge not ready; retry ${_refreshRetries}/30 in 200ms`);
        setTimeout(() => { refresh(); }, 200);
      } else {
        console.warn('[m11.3.6/tint] bridge still not ready after 30 retries; giving up');
      }
      return;
    }
    _refreshRetries = 0;
    try {
      const res = await window.SpectralBridge.getBoardEncoding([channel]);
      if (!res || !res.ok) {
        console.warn('[m11.3.6/tint] getBoardEncoding failed:', res && res.reason);
        return;
      }
      const arr = res.channels && res.channels[channel];
      if (!arr || !arr.length) {
        console.warn(`[m11.3.6/tint] channel "${channel}" not in response`);
        return;
      }
      const [pLo, pHi] = _percentileBounds(arr, 0.05, 0.95);
      let mapLo = pLo, mapHi = pHi;
      let flat = false;
      // Robust normalization: percentile can collapse on near-uniform
      // channels (A1 at initial position is highly symmetric). Fall
      // back to absolute min/max so we still get visible variation.
      if (!Number.isFinite(mapHi - mapLo) || (mapHi - mapLo) < 1e-12) {
        let aLo = Infinity, aHi = -Infinity;
        for (let k = 0; k < arr.length; k++) {
          if (arr[k] < aLo) aLo = arr[k];
          if (arr[k] > aHi) aHi = arr[k];
        }
        if (Number.isFinite(aHi - aLo) && (aHi - aLo) > 1e-12) {
          mapLo = aLo; mapHi = aHi;
          console.log('[m11.3.6/tint] percentile range degenerate; using min/max fallback');
        } else {
          flat = true;
        }
      }
      const range = mapHi - mapLo;
      for (let i = 0; i < arr.length; i++) {
        let t = flat ? 0.5 : (arr[i] - mapLo) / range;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const c = viridisColor(t);
        im.instanceColor.setXYZ(i, c[0], c[1], c[2]);
      }
      im.instanceColor.needsUpdate = true;
      // Defensive: also force the InstancedMesh visible flag in case
      // some other code flipped it.
      im.visible = enabled;
      if (typeof window !== 'undefined') window.__GAME_DIRTY__ = true;
      console.log(
        `[m11.3.6/tint] ch=${channel} cells=${arr.length} ` +
          `clip=[${pLo.toExponential(3)}, ${pHi.toExponential(3)}] ` +
          `mapped=[${mapLo.toExponential(3)}, ${mapHi.toExponential(3)}]` +
          (flat ? ' (FLAT — channel near-constant; all cells uniform color)' : '')
      );
    } catch (err) {
      console.warn('[m11.3.6/tint] refresh error:', err);
    }
  }

  window.SpectralBoardTint = {
    init(scene, gameBoard) {
      if (_initRequested) return;
      _initRequested = true;
      _scene = scene;
      _gameBoard = gameBoard;
      buildMesh();
      try {
        const flag = new URLSearchParams(location.search).get('boardTint');
        if (flag === '1' || flag === 'on') {
          enabled = true;
          if (im) im.visible = true;
          refresh();
        }
      } catch (_) { /* no window — leave defaults */ }
    },
    setChannel(name) {
      if (typeof name !== 'string' || name === channel) return;
      channel = name;
      if (enabled) refresh();
    },
    setEnabled(en) {
      if (enabled === en) return;
      enabled = en;
      if (im) im.visible = en;
      if (en) refresh();
      if (typeof window !== 'undefined') window.__GAME_DIRTY__ = true;
    },
    /**
     * M11.3.5 — scale.y for the stack-height slider. Match SpectralHeatmap
     * and SpectralFilaments so the tinted quads stay aligned with the
     * boards as the stack compresses/expands.
     */
    setStackScale(s) {
      if (!Number.isFinite(s) || s <= 0) return;
      if (im) im.scale.y = s;
      if (typeof window !== 'undefined') window.__GAME_DIRTY__ = true;
    },
    refresh,
    getChannel() { return channel; },
    isEnabled() { return enabled; },
  };
})();
