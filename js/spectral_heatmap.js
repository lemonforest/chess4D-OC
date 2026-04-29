// spectral_heatmap.js — M10 board signature, M11 cloud, M11.1 stats refactor.
//
// M10 → M11: flat quads → volumetric BoxGeometry cloud (per-instance scale +
// per-instance color, mean ± 2σ normalization).
//
// M11.1 (this revision) — surface structure better:
//   - **Robust normalization** via 5th/95th percentile clip (was mean ± 2σ).
//     Single-cell outliers no longer dim the rest of the lattice.
//   - **log1p transform** option (signed-aware: sign(x)·log1p(|x|)). Heavy-
//     tailed channels like A1 / FIB_SYM_* compress dynamic range so every
//     cell contributes visibly.
//   - **Diverging color mode** for signed channels (STD4_X/Y/Z/W). Maps
//     [-M, +M] onto a blue→white→red ramp; per-instance height scales
//     with |value| not value, so positive and negative lobes both expand.
//   - **Local-maxima overlay**: a second InstancedMesh of small spheres
//     positioned at every cell whose scalar exceeds all 8 face-neighbors.
//     One draw call, count clamped per refresh. Instantly surfaces the
//     topological skeleton of the field.
//
// Source for the techniques: Heatmapper2 (PMC12230736) for the height-
// encoded + annotation overlay idioms, plus the standard scivis playbook
// (perceptual ramps + percentile-clip + Morse-style local-max markers)
// since the paper itself doesn't supply normalization math.
//
// API (M11.1 additions marked •):
//   SpectralHeatmap.init(scene, gameBoard)
//   SpectralHeatmap.setChannel(name)
//   SpectralHeatmap.setEnabled(bool)
//   SpectralHeatmap.refresh()
// • SpectralHeatmap.setTransform('linear' | 'log1p')
// • SpectralHeatmap.setColorMode('unipolar' | 'signed')
// • SpectralHeatmap.setShowLocalMaxima(bool)
//   SpectralHeatmap.getChannel()    / .isEnabled() / .getTransform()
//   SpectralHeatmap.getColorMode()  / .getShowLocalMaxima()

(function () {
  'use strict';

  let im      = null; // InstancedMesh of 4096 cloud boxes
  let imMax   = null; // InstancedMesh of up to 512 local-max spheres
  let _scene  = null;
  let _gameBoard = null;
  let enabled = false;
  let channel = 'A1';
  let transform  = 'linear';     // 'linear' | 'log1p'
  let colorMode  = 'unipolar';   // 'unipolar' | 'signed'
  let showMaxima = false;
  let _initRequested = false;

  // Cached per-cell base translation (no scale) so refresh() only has
  // to compose translation × scale, not re-evaluate boardCoordinates.
  const _basePos   = new Float32Array(4096 * 3);
  const _intensity = new Float32Array(4096);

  const MAX_LOCAL_MAXIMA_CAP = 512; // hard cap; chess channels rarely exceed ~80

  // ---------- color ramps -----------------------------------------------------
  // Unipolar viridis-ish (0..1).
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
  // Diverging RdBu-style for signed values; t=0.5 is neutral white.
  function rdBuColor(t) {
    if (t < 0.5) {
      const u = t * 2;                 // blue → white
      return [0.20 + u * 0.80, 0.30 + u * 0.70, 0.65 + u * 0.35];
    } else {
      const u = (t - 0.5) * 2;         // white → red
      return [1.00 - u * 0.20, 1.00 - u * 0.80, 1.00 - u * 0.85];
    }
  }

  // ---------- value transform -------------------------------------------------
  // signed log1p: keep sign, compress magnitude. log1p(0)=0 so neutral cells
  // stay neutral; |x| of ~1e-3 maps to ~1e-3, |x| of 1 maps to ln(2)≈0.693,
  // |x| of 1000 maps to ln(1001)≈6.9 — heavy tail flattened nicely.
  function _applyTransform(arr) {
    if (transform !== 'log1p') return arr;
    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      out[i] = v >= 0 ? Math.log1p(v) : -Math.log1p(-v);
    }
    return out;
  }

  // ---------- percentile clip --------------------------------------------------
  // Returns [pLo, pHi] using p5 / p95 of `arr`. Robust to single-cell outliers.
  // Float32Array.sort() is numeric by default — no comparator needed.
  function _percentileBounds(arr, lo = 0.05, hi = 0.95) {
    const sorted = new Float32Array(arr).sort();
    const n = sorted.length;
    return [sorted[Math.floor(lo * n)], sorted[Math.min(n - 1, Math.floor(hi * n))]];
  }

  // ---------- local-max detection ---------------------------------------------
  // 4D face-neighbor strict-greater test. Returns array of cell indices that
  // are strict local maxima (value > all 8 valid face-neighbors). At a
  // boundary cell with fewer neighbors, we still require strict > over the
  // available ones; this matches the topological intuition (no neighbor
  // outranks) while letting boundary peaks register.
  function _findLocalMaxima(arr) {
    const out = [];
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) {
        for (let z = 0; z < 8; z++) {
          for (let w = 0; w < 8; w++) {
            const idx = (x << 9) | (y << 6) | (z << 3) | w;
            const v = arr[idx];
            let isMax = true;
            // Walk the 8 face-neighbors; bail on first violation.
            // X axis
            if (x > 0 && arr[idx - 512] >= v) { isMax = false; }
            if (isMax && x < 7 && arr[idx + 512] >= v) { isMax = false; }
            // Y axis
            if (isMax && y > 0 && arr[idx - 64]  >= v) { isMax = false; }
            if (isMax && y < 7 && arr[idx + 64]  >= v) { isMax = false; }
            // Z axis
            if (isMax && z > 0 && arr[idx - 8]   >= v) { isMax = false; }
            if (isMax && z < 7 && arr[idx + 8]   >= v) { isMax = false; }
            // W axis
            if (isMax && w > 0 && arr[idx - 1]   >= v) { isMax = false; }
            if (isMax && w < 7 && arr[idx + 1]   >= v) { isMax = false; }
            if (isMax) out.push(idx);
            if (out.length >= MAX_LOCAL_MAXIMA_CAP) return out;
          }
        }
      }
    }
    return out;
  }

  // ---------- cloud mesh build ------------------------------------------------
  function buildMesh() {
    if (im) return im;
    if (!_scene || !_gameBoard || !_gameBoard.graphics) return null;
    const gfx = _gameBoard.graphics;
    const square = gfx.squareSize        || 50;
    const vert   = gfx.verticalIncrement || 175;
    const sx = square * 0.95;
    const sy = vert   * 0.70;
    const sz = square * 0.95;
    const geom = new THREE.BoxGeometry(sx, sy, sz);
    const mat  = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
      side: THREE.FrontSide,
    });
    im = new THREE.InstancedMesh(geom, mat, 4096);
    im.frustumCulled = false;
    im.renderOrder = 2;
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
            _basePos[idx * 3 + 0] = pos.x;
            _basePos[idx * 3 + 1] = pos.y;
            _basePos[idx * 3 + 2] = pos.z;
            matrix.makeTranslation(pos.x, pos.y, pos.z);
            im.setMatrixAt(idx, matrix);
          }
        }
      }
    }
    im.instanceMatrix.needsUpdate = true;
    im.instanceColor.needsUpdate  = true;
    im.visible = false;
    _scene.add(im);
    return im;
  }

  // ---------- local-max overlay build ----------------------------------------
  function buildMaximaMesh() {
    if (imMax) return imMax;
    if (!_scene || !_gameBoard || !_gameBoard.graphics) return null;
    const gfx = _gameBoard.graphics;
    const square = gfx.squareSize || 50;
    // Small bright sphere — sits visibly within the cloud body. Low segment
    // count keeps tri budget tiny (192 tris × 512 instances = 98k tris).
    const geom = new THREE.SphereGeometry(square * 0.18, 8, 6);
    const mat  = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    imMax = new THREE.InstancedMesh(geom, mat, MAX_LOCAL_MAXIMA_CAP);
    imMax.frustumCulled = false;
    imMax.renderOrder = 4; // above cloud + filaments
    imMax.count = 0;       // start hidden until refresh writes positions
    imMax.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    imMax.visible = false;
    _scene.add(imMax);
    return imMax;
  }

  // Compose translation × scale into the instance matrix at idx.
  function _writeMatrix(target, idx, s, tx, ty, tz) {
    const e = target.instanceMatrix.array;
    const o = idx * 16;
    e[o + 0] = s;  e[o + 1] = 0;  e[o + 2] = 0;  e[o + 3] = 0;
    e[o + 4] = 0;  e[o + 5] = s;  e[o + 6] = 0;  e[o + 7] = 0;
    e[o + 8] = 0;  e[o + 9] = 0;  e[o + 10] = s; e[o + 11] = 0;
    e[o + 12] = tx; e[o + 13] = ty; e[o + 14] = tz; e[o + 15] = 1;
  }

  async function refresh() {
    if (!enabled || !im) return;
    if (typeof window === 'undefined' || !window.SpectralBridge) return;
    if (!window.__SPECTRAL_INFO__) return;
    try {
      const res = await window.SpectralBridge.getBoardEncoding([channel]);
      if (!res || !res.ok) {
        console.warn('[m10/heatmap] getBoardEncoding failed:', res && res.reason);
        return;
      }
      const rawArr = res.channels && res.channels[channel];
      if (!rawArr || !rawArr.length) {
        console.warn(`[m10/heatmap] channel "${channel}" not in response`);
        return;
      }

      // Apply transform (log1p, signed-aware) before percentile clip — clip
      // operates on the perceived scale, not the raw scale.
      const arr = _applyTransform(rawArr);

      // Percentile-clip bounds.
      let [pLo, pHi] = _percentileBounds(arr, 0.05, 0.95);
      let mapLo, mapHi;
      if (colorMode === 'signed') {
        // Symmetric clip around zero: [-M, +M] where M = max(|p5|, |p95|).
        const M = Math.max(Math.abs(pLo), Math.abs(pHi));
        if (!Number.isFinite(M) || M < 1e-12) { mapLo = -1; mapHi = 1; }
        else { mapLo = -M; mapHi = M; }
      } else {
        mapLo = pLo;
        mapHi = pHi;
        if (!Number.isFinite(mapHi - mapLo) || (mapHi - mapLo) < 1e-12) {
          mapLo = arr[0]; mapHi = arr[0] + 1;
        }
      }
      const range = mapHi - mapLo;

      const colorFn = (colorMode === 'signed') ? rdBuColor : viridisColor;
      let totalIntensity = 0;
      for (let i = 0; i < arr.length; i++) {
        let t = (arr[i] - mapLo) / range;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        _intensity[i] = t;
        totalIntensity += t;
        const c = colorFn(t);
        im.instanceColor.setXYZ(i, c[0], c[1], c[2]);
        // Height-as-second-channel: in signed mode the box scale tracks
        // |value| (distance from neutral), so positive AND negative lobes
        // both get visible volume. In unipolar mode, scale tracks t directly.
        const heightT = (colorMode === 'signed') ? Math.abs(t - 0.5) * 2 : t;
        const s = 0.45 + heightT * 0.60;
        _writeMatrix(im, i, s, _basePos[i * 3], _basePos[i * 3 + 1], _basePos[i * 3 + 2]);
      }
      im.instanceColor.needsUpdate  = true;
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere && im.computeBoundingSphere();

      // Local-max overlay: detected on the *transformed* values so a
      // log1p-transform-revealed peak still registers. Renders as
      // bright spheres at the world position of each local-max cell.
      if (showMaxima) {
        const overlay = buildMaximaMesh();
        if (overlay) {
          const maxima = _findLocalMaxima(arr);
          const k = Math.min(maxima.length, MAX_LOCAL_MAXIMA_CAP);
          for (let i = 0; i < k; i++) {
            const cell = maxima[i];
            _writeMatrix(
              overlay, i, 1.0,
              _basePos[cell * 3], _basePos[cell * 3 + 1], _basePos[cell * 3 + 2]
            );
          }
          overlay.count = k;
          overlay.instanceMatrix.needsUpdate = true;
          overlay.visible = true;
          console.log(`[m11.1/heatmap] local maxima: ${k} ${k === MAX_LOCAL_MAXIMA_CAP ? '(capped)' : ''}`);
        }
      } else if (imMax) {
        imMax.visible = false;
      }

      if (typeof window !== 'undefined') window.__GAME_DIRTY__ = true;
      console.log(
        `[m11.1/heatmap] ch=${channel} transform=${transform} mode=${colorMode} ` +
          `clip=[${pLo.toExponential(3)}, ${pHi.toExponential(3)}] ` +
          `mapped=[${mapLo.toExponential(3)}, ${mapHi.toExponential(3)}] ` +
          `meanT=${(totalIntensity / arr.length).toFixed(3)}`
      );
    } catch (err) {
      console.warn('[m10/heatmap] refresh error:', err);
    }
  }

  // ---------- public API ------------------------------------------------------
  window.SpectralHeatmap = {
    init(scene, gameBoard) {
      if (_initRequested) return;
      _initRequested = true;
      _scene = scene;
      _gameBoard = gameBoard;
      buildMesh();
      // Read URL flags so debug links work without UI clicking.
      try {
        const params = new URLSearchParams(location.search);
        const tFlag = params.get('heatmapTransform');
        if (tFlag === 'log1p') transform = 'log1p';
        const mFlag = params.get('heatmapMode');
        if (mFlag === 'signed') colorMode = 'signed';
        const xFlag = params.get('heatmapMaxima');
        if (xFlag === '1' || xFlag === 'on') showMaxima = true;
        const flag = params.get('heatmap');
        if (flag && flag !== 'off') {
          channel = flag;
          enabled = true;
          if (im) im.visible = true;
          refresh();
        }
      } catch (_) { /* no window — leave defaults */ }
    },
    setChannel(name) {
      if (typeof name !== 'string' || name === channel) return;
      channel = name;
      refresh();
    },
    setEnabled(en) {
      if (enabled === en) return;
      enabled = en;
      if (im) im.visible = en;
      if (imMax) imMax.visible = en && showMaxima;
      if (en) refresh();
      if (typeof window !== 'undefined') window.__GAME_DIRTY__ = true;
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
    setShowLocalMaxima(en) {
      if (showMaxima === en) return;
      showMaxima = en;
      if (enabled) refresh();
      else if (imMax) imMax.visible = false;
      if (typeof window !== 'undefined') window.__GAME_DIRTY__ = true;
    },
    refresh,
    getChannel()   { return channel; },
    isEnabled()    { return enabled; },
    getTransform() { return transform; },
    getColorMode() { return colorMode; },
    getShowLocalMaxima() { return showMaxima; },
  };
})();
