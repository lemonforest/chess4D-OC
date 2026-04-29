// spectral_dotplot.js — M11.9 alternative display: one sphere per cell.
//
// Sibling to spectral_heatmap.js. Same 4096-cell layout, same channel +
// transform + colormode + slice + threshold + clip filter pipeline, but
// the geometry is a SPHERE per cell instead of an overlapping BoxGeometry
// cloud. The visual feel is "discrete dot plot" rather than "blended
// volume cloud" — every cell is a separate, non-overlapping marker.
//
// Why a separate module rather than a display-mode switch on
// spectral_heatmap.js? Two reasons:
//   1. Independent toggle: users can run cloud + dot-plot together
//      (cloud as soft volume, dots as discrete markers on top), or
//      either alone, without the modules fighting over state.
//   2. Different per-instance scaling logic: the cloud expands on
//      intensity (overlap = cloud body); the dot-plot uses fixed-radius
//      spheres with intensity in color only, so high-intensity cells
//      don't visually crowd into neighbors.
//
// Performance: 4096 sphere instances at low segment count (8x6 = 48
// triangles each, 196k total). One InstancedMesh, one draw call. Same
// budget as the cloud.
//
// API mirrors SpectralHeatmap exactly so the two are interchangeable
// and any future "display mode" radio in the UI just swaps which one
// is enabled:
//   SpectralDotplot.init(scene, gameBoard)
//   SpectralDotplot.setEnabled(bool)
//   SpectralDotplot.setChannel(name)
//   SpectralDotplot.setTransform('linear' | 'log1p')
//   SpectralDotplot.setColorMode('unipolar' | 'signed')
//   SpectralDotplot.setSlice(axis | null, value)
//   SpectralDotplot.setIntensityThreshold(t)
//   SpectralDotplot.setStackScale(s)
//   SpectralDotplot.refresh()

(function () {
  'use strict';

  let im = null; // InstancedMesh of 4096 spheres
  let _scene = null;
  let _gameBoard = null;
  let enabled = false;
  let channel = 'A1';
  let transform = 'linear';
  let colorMode = 'unipolar';
  let sliceAxis  = null;
  let sliceValue = 4;
  let intensityThreshold = 0;
  let _initRequested = false;
  // Cached per-cell base translation so refresh() composes scale × translate
  // without re-evaluating boardCoordinates.
  const _basePos = new Float32Array(4096 * 3);

  // M11.23 — viridisColor, rdBuColor, percentileBounds now come from the
  // SSOT module (js/spectral_color.js). The previous "future: factor to a
  // tiny spectral_colors.js if we add a third copy" TODO is now resolved.
  const viridisColor      = (window.SpectralColor && window.SpectralColor.viridisColor);
  const rdBuColor         = (window.SpectralColor && window.SpectralColor.rdBuColor);
  const _percentileBounds = (window.SpectralColor && window.SpectralColor.percentileBounds);

  function _applyTransform(arr) {
    if (transform !== 'log1p') return arr;
    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      out[i] = v >= 0 ? Math.log1p(v) : -Math.log1p(-v);
    }
    return out;
  }

  function buildMesh() {
    if (im) return im;
    if (!_scene || !_gameBoard || !_gameBoard.graphics) return null;
    const gfx = _gameBoard.graphics;
    const square = gfx.squareSize || 50;
    // Sphere radius ~ 1/4 of a cell so neighboring spheres don't touch
    // even at maximum intensity scale (scale up to ~1.4 at top intensity).
    // 8x6 segments = 48 triangles per sphere × 4096 = ~200k tris. Cheap.
    const geom = new THREE.SphereGeometry(square * 0.25, 8, 6);
    const mat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    im = new THREE.InstancedMesh(geom, mat, 4096);
    im.frustumCulled = false;
    // Render between cloud (renderOrder 2) and filaments (5) — sits in the
    // transparent-pass stack as a discrete-marker layer over the cloud.
    im.renderOrder = 2.5;
    const colors = new Float32Array(4096 * 3);
    for (let i = 0; i < colors.length; i++) colors[i] = 0.5;
    im.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
    im.instanceColor.setUsage(THREE.DynamicDrawUsage);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    const matrix = new THREE.Matrix4();
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) {
        for (let z = 0; z < 8; z++) {
          for (let w = 0; w < 8; w++) {
            const pos = gfx.boardCoordinates(x, y, z, w);
            const idx = (x << 9) | (y << 6) | (z << 3) | w;
            // Center the sphere on the cell coords (above the board surface).
            // boardCoordinates returns the board ANCHOR; we lift to the
            // surface (+2.5 = boardHeight/2) plus a small clearance so the
            // sphere isn't half-buried in the board mesh.
            _basePos[idx * 3 + 0] = pos.x;
            _basePos[idx * 3 + 1] = pos.y + 4;
            _basePos[idx * 3 + 2] = pos.z;
            matrix.makeTranslation(pos.x, pos.y + 4, pos.z);
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

  function _writeMatrix(idx, s, tx, ty, tz) {
    const e = im.instanceMatrix.array;
    const o = idx * 16;
    e[o + 0] = s; e[o + 1] = 0; e[o + 2] = 0; e[o + 3] = 0;
    e[o + 4] = 0; e[o + 5] = s; e[o + 6] = 0; e[o + 7] = 0;
    e[o + 8] = 0; e[o + 9] = 0; e[o + 10] = s; e[o + 11] = 0;
    e[o + 12] = tx; e[o + 13] = ty; e[o + 14] = tz; e[o + 15] = 1;
  }

  // Bridge-readiness retry: same pattern as M11.3.7 fix in tint module.
  let _refreshRetries = 0;
  async function refresh() {
    if (!enabled || !im) return;
    if (typeof window === 'undefined' || !window.SpectralBridge) return;
    if (!window.__SPECTRAL_INFO__) {
      if (_refreshRetries < 30) {
        _refreshRetries++;
        setTimeout(() => { refresh(); }, 200);
      }
      return;
    }
    _refreshRetries = 0;
    try {
      const res = await window.SpectralBridge.getBoardEncoding([channel]);
      if (!res || !res.ok) {
        console.warn('[m11.9/dotplot] getBoardEncoding failed:', res && res.reason);
        return;
      }
      const rawArr = res.channels && res.channels[channel];
      if (!rawArr || !rawArr.length) {
        console.warn(`[m11.9/dotplot] channel "${channel}" not in response`);
        return;
      }
      const arr = _applyTransform(rawArr);

      const [pLo, pHi] = _percentileBounds(arr, 0.05, 0.95);
      let mapLo = pLo, mapHi = pHi;
      if (colorMode === 'signed') {
        const M = Math.max(Math.abs(pLo), Math.abs(pHi));
        if (!Number.isFinite(M) || M < 1e-12) { mapLo = -1; mapHi = 1; }
        else { mapLo = -M; mapHi = M; }
      } else if (!Number.isFinite(mapHi - mapLo) || (mapHi - mapLo) < 1e-12) {
        // Fallback to absolute min/max if percentile collapses.
        let aLo = Infinity, aHi = -Infinity;
        for (let k = 0; k < arr.length; k++) {
          if (arr[k] < aLo) aLo = arr[k];
          if (arr[k] > aHi) aHi = arr[k];
        }
        mapLo = aLo; mapHi = aHi;
      }
      const range = mapHi - mapLo;
      const flat = !Number.isFinite(range) || range < 1e-12;

      const colorFn = (colorMode === 'signed') ? rdBuColor : viridisColor;

      const sliceShift = (sliceAxis === 'x') ? 9
                       : (sliceAxis === 'y') ? 6
                       : (sliceAxis === 'z') ? 3
                       : (sliceAxis === 'w') ? 0
                       : -1;
      const useSlice = sliceShift >= 0;
      const useThreshold = intensityThreshold > 0;

      let cellsShown = 0;
      for (let i = 0; i < arr.length; i++) {
        let t = flat ? 0.5 : (arr[i] - mapLo) / range;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const c = colorFn(t);
        im.instanceColor.setXYZ(i, c[0], c[1], c[2]);

        // Sphere SCALE varies less than cloud BOX scale — dot-plot stays
        // discrete. Range [0.5, 1.4]: dim cells shrink to half-radius,
        // hot cells grow to 1.4x but never overlap neighbors (since
        // base radius is square*0.25, max diameter ≈ square*0.7).
        const heightT = (colorMode === 'signed') ? Math.abs(t - 0.5) * 2 : t;
        let s = 0.5 + heightT * 0.9;

        // M11.3.8: sub-cell slice scrubbing — fractional sliceValue
        // blends adjacent slabs at weight (1 - dist).
        let sliceWeight = 1;
        if (useSlice) {
          const cellAxis = (i >> sliceShift) & 7;
          const dist = Math.abs(sliceValue - cellAxis);
          sliceWeight = dist >= 1 ? 0 : (1 - dist);
        }
        if (useSlice && sliceWeight === 0) {
          s = 0;
        } else if (useThreshold && heightT < intensityThreshold) {
          s = 0;
        } else {
          cellsShown++;
          if (useSlice && sliceWeight < 1) s *= sliceWeight;
        }
        _writeMatrix(i, s, _basePos[i * 3], _basePos[i * 3 + 1], _basePos[i * 3 + 2]);
      }
      im.instanceColor.needsUpdate = true;
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere && im.computeBoundingSphere();
      if (typeof window !== 'undefined') window.__GAME_DIRTY__ = true;
      console.log(
        `[m11.9/dotplot] ch=${channel} transform=${transform} mode=${colorMode} ` +
          `cells=${cellsShown}/${arr.length}` +
          (useSlice ? ` slice=${sliceAxis}=${sliceValue}` : '') +
          (useThreshold ? ` threshold=${intensityThreshold.toFixed(2)}` : '')
      );
    } catch (err) {
      console.warn('[m11.9/dotplot] refresh error:', err);
    }
  }

  window.SpectralDotplot = {
    init(scene, gameBoard) {
      if (_initRequested) return;
      _initRequested = true;
      _scene = scene;
      _gameBoard = gameBoard;
      buildMesh();
      try {
        const flag = new URLSearchParams(location.search).get('dotplot');
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
    setChannel(name) {
      if (typeof name !== 'string' || name === channel) return;
      channel = name;
      if (enabled) refresh();
    },
    setTransform(name) {
      if (name !== 'linear' && name !== 'log1p') return;
      if (name === transform) return;
      transform = name;
      if (enabled) refresh();
    },
    setColorMode(name) {
      if (name !== 'unipolar' && name !== 'signed') return;
      if (name === colorMode) return;
      colorMode = name;
      if (enabled) refresh();
    },
    setSlice(axis, value) {
      const ok = (axis === null || axis === undefined ||
                  axis === 'x' || axis === 'y' || axis === 'z' || axis === 'w');
      if (!ok) return;
      const newAxis = (axis === null || axis === undefined) ? null : axis;
      let newValue = sliceValue;
      // M11.3.8: allow fractional slice values for sub-cell scrubbing.
      if (Number.isFinite(value)) newValue = Math.max(0, Math.min(7, value));
      if (newAxis === sliceAxis && newValue === sliceValue) return;
      sliceAxis = newAxis;
      sliceValue = newValue;
      if (enabled) refresh();
    },
    setIntensityThreshold(t) {
      if (!Number.isFinite(t)) return;
      const v = Math.max(0, Math.min(1, t));
      if (v === intensityThreshold) return;
      intensityThreshold = v;
      if (enabled) refresh();
    },
    setStackScale(s) {
      if (!Number.isFinite(s) || s <= 0) return;
      if (im) im.scale.y = s;
      if (typeof window !== 'undefined') window.__GAME_DIRTY__ = true;
    },
    refresh,
    getChannel() { return channel; },
    isEnabled()  { return enabled; },
  };
})();
