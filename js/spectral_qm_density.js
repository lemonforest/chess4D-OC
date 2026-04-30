// spectral_qm_density.js — M14.1, first user-visible QM viz layer.
//
// Renders the per-cell quantum density |ψ_p|² as a tint on the board
// surface. Mirrors spectral_board_tint.js's structure (InstancedMesh of
// 4096 thin colored quads sitting just above the board) but the data
// source is bridge.getQmDensity() instead of bridge.getBoardEncoding().
//
// Why a separate module rather than a "QM_DENSITY" channel inside
// SpectralBoardTint:
//   1. The QM density isn't one of the 11 encoder channels. Mixing it
//      into the existing channel-switcher UI would confuse the channel
//      semantics (encoder energy vs. Born-rule probability mass).
//   2. We want both layers togglable independently — encoder channel
//      tint AND QM density tint side-by-side via vertical stacking, or
//      either alone.
//   3. M14.2/M14.3/M14.4 each get their own module too; consistent
//      structure across the QM viz family.
//
// Layout: tint quads at board surface +3.0 Y (same as SpectralBoardTint
// — they don't actually conflict since they're toggled at different
// times for visual clarity, but they could coexist with z-fight if both
// enabled at the same time on the same board layer; M14.x stack-height
// adjustment will give each its own Y offset). For v1, just don't enable
// both at once; UI nudge in the help tooltip.
//
// Math:
//   getQmDensity() returns Float32Array(4096) with sum ≈ 1.0 (Born rule).
//   Density values are tiny (~1/4096 = 2.4e-4 if uniform), so we use the
//   same percentile-clip + viridis ramp as SpectralBoardTint to give
//   visible variation. The ramp shows: dim cells (low |ψ|²) = blue,
//   bright cells (high |ψ|²) = red.
//
// API:
//   SpectralQmDensity.init(scene, gameBoard)
//   SpectralQmDensity.setEnabled(bool)
//   SpectralQmDensity.refresh()
//   SpectralQmDensity.setStackScale(s)   — for stack-height slider
//   SpectralQmDensity.isEnabled()

(function () {
  'use strict';

  let im = null;
  let _scene = null;
  let _gameBoard = null;
  let enabled = false;
  let _initRequested = false;

  // M11.23 SSOT — viridis ramp + percentile clip from spectral_color.js.
  const viridisColor      = (window.SpectralColor && window.SpectralColor.viridisColor);
  const _percentileBounds = (window.SpectralColor && window.SpectralColor.percentileBounds);

  function buildMesh() {
    if (im) return im;
    if (!_scene || !_gameBoard || !_gameBoard.graphics) return null;
    const gfx = _gameBoard.graphics;
    const square = gfx.squareSize || 50;
    // Match SpectralBoardTint's quad geometry — 92% inset so a hairline
    // of the underlying board still shows through (acts as a grid line).
    const geom = new THREE.PlaneGeometry(square * 0.92, square * 0.92);
    geom.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      transparent: false,
      side: THREE.DoubleSide,
      depthWrite: true,
    });
    im = new THREE.InstancedMesh(geom, mat, 4096);
    im.frustumCulled = false;
    // renderOrder=1 same as SpectralBoardTint — sits at the bottom of
    // the transparent stack so the cloud + filaments layer on top. If
    // both BoardTint and QmDensity are enabled simultaneously they'll
    // z-fight; UI tooltip nudges the user not to enable both at once
    // (M14.x can introduce per-tier Y offsets to deconflict).
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
            // Cell index packing matches the QM density wire format:
            // idx = x*512 + y*64 + z*8 + w (matches encoder_4d sq_idx).
            const idx = (x << 9) | (y << 6) | (z << 3) | w;
            // +3.0 Y matches BoardTint's "just above the board surface"
            // placement. If both are enabled simultaneously they will
            // z-fight at the same elevation; that's a known v1 limit.
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

  // Same retry-on-bridge-not-ready dance as SpectralBoardTint.
  let _refreshRetries = 0;
  async function refresh() {
    if (!enabled || !im) {
      console.log(`[m14.1/qm-density] refresh skipped: enabled=${enabled} im=${!!im}`);
      return;
    }
    if (typeof window === 'undefined' || !window.SpectralBridge) {
      console.warn('[m14.1/qm-density] refresh skipped: no SpectralBridge');
      return;
    }
    if (!window.__SPECTRAL_INFO__) {
      if (_refreshRetries < 30) {
        _refreshRetries++;
        console.log(`[m14.1/qm-density] bridge not ready; retry ${_refreshRetries}/30 in 200ms`);
        setTimeout(() => { refresh(); }, 200);
      } else {
        console.warn('[m14.1/qm-density] bridge still not ready after 30 retries; giving up');
      }
      return;
    }
    _refreshRetries = 0;
    try {
      const res = await window.SpectralBridge.getQmDensity();
      if (!res || !res.ok) {
        console.warn('[m14.1/qm-density] getQmDensity failed:', res && res.error);
        return;
      }
      const arr = res.density;
      if (!arr || arr.length !== 4096) {
        console.warn(`[m14.1/qm-density] expected density length 4096, got ${arr ? arr.length : 'null'}`);
        return;
      }
      // Born-rule normalization sanity-check. In practice the sum is
      // 1.0 ± 1e-6; if it drifts further, log it but still render.
      let sum = 0;
      for (let i = 0; i < arr.length; i++) sum += arr[i];
      if (Math.abs(sum - 1.0) > 1e-3) {
        console.warn(`[m14.1/qm-density] normSq sum drift: ${sum.toFixed(6)} (expected ~1.0)`);
      }

      const [pLo, pHi] = _percentileBounds(arr, 0.05, 0.95);
      let mapLo = pLo, mapHi = pHi;
      let flat = false;
      // Same percentile-degenerate fallback to absolute min/max as
      // SpectralBoardTint — Born-rule density at the initial position
      // is highly symmetric, so percentile range can collapse.
      if (!Number.isFinite(mapHi - mapLo) || (mapHi - mapLo) < 1e-12) {
        let aLo = Infinity, aHi = -Infinity;
        for (let k = 0; k < arr.length; k++) {
          if (arr[k] < aLo) aLo = arr[k];
          if (arr[k] > aHi) aHi = arr[k];
        }
        if (Number.isFinite(aHi - aLo) && (aHi - aLo) > 1e-12) {
          mapLo = aLo; mapHi = aHi;
          console.log('[m14.1/qm-density] percentile range degenerate; using min/max fallback');
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
      im.visible = enabled;
      if (typeof window !== 'undefined') window.__GAME_DIRTY__ = true;
      console.log(
        `[m14.1/qm-density] cells=${arr.length} sum=${sum.toFixed(6)} ` +
          `clip=[${pLo.toExponential(3)}, ${pHi.toExponential(3)}] ` +
          `mapped=[${mapLo.toExponential(3)}, ${mapHi.toExponential(3)}]` +
          (flat ? ' (FLAT — density near-uniform)' : '')
      );
    } catch (err) {
      console.warn('[m14.1/qm-density] refresh error:', err);
    }
  }

  window.SpectralQmDensity = {
    init(scene, gameBoard) {
      if (_initRequested) return;
      _initRequested = true;
      _scene = scene;
      _gameBoard = gameBoard;
      buildMesh();
      try {
        const flag = new URLSearchParams(location.search).get('qmDensity');
        if (flag === '1' || flag === 'on') {
          enabled = true;
          if (im) im.visible = true;
          refresh();
        }
      } catch (_) { /* no window — leave defaults */ }
    },
    setEnabled(en) {
      if (enabled === en) return;
      enabled = en;
      if (im) im.visible = en;
      if (en) refresh();
      if (typeof window !== 'undefined') window.__GAME_DIRTY__ = true;
    },
    setStackScale(s) {
      if (!Number.isFinite(s) || s <= 0) return;
      if (im) im.scale.y = s;
      if (typeof window !== 'undefined') window.__GAME_DIRTY__ = true;
    },
    refresh,
    isEnabled() { return enabled; },
  };
})();
