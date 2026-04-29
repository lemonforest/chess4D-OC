// spectral_heatmap.js — board-signature volumetric cloud.
// Evolution: M10 (flat quads) → M11 (BoxGeometry cloud) → M11.1 (stats) →
// M11.3 (slice + threshold) → M11.3.2 (clip sphere) → M11.3.5 (stack scale).
//
// What it renders: 4096 translucent boxes, one per lattice cell. Per-cell
// color encodes channel intensity (viridis or signed RdBu); per-cell scale
// encodes magnitude. Boxes overlap their layer neighbors so the cloud
// reads as space-filling rather than striped sheets. One InstancedMesh =
// one draw call. A second InstancedMesh (≤512 instances) renders local-
// maxima markers as small spheres on top.
//
// Statistics pipeline (each refresh):
//   1. Apply optional log1p transform (signed-aware: sign(x)·log1p(|x|))
//   2. Robust 5/95 percentile clip; if degenerate, fall back to min/max
//   3. Color via viridis (unipolar) OR RdBu (signed mode)
//   4. Per-instance scale tracks intensity (or |value − neutral| for signed)
//   5. Apply slice / threshold / clip-sphere filters → off-cells get scale 0
//
// Filters (all stack as AND-masks):
//   - sliceAxis ∈ {x,y,z,w} + sliceValue ∈ 0..7 — pin one axis, hide the rest
//   - intensityThreshold ∈ [0,1] — hide cells below normalized intensity
//   - clipMode ∈ {center, peak, click} + clipRadius — 4D Euclidean ball
//
// Source for the techniques: Heatmapper2 (PMC12230736) for the height-
// encoded + annotation-overlay idioms; Hofmann/Rieck/Sadlo 2018 for the
// 4D clipping-sphere idea; standard scivis playbook for percentile-clip
// and local-maxima markers (the paper itself doesn't supply normalization
// math).
//
// API:
//   SpectralHeatmap.init(scene, gameBoard)
//   SpectralHeatmap.setChannel(name)
//   SpectralHeatmap.setEnabled(bool)
//   SpectralHeatmap.refresh()
//   SpectralHeatmap.setTransform('linear' | 'log1p')             — M11.1
//   SpectralHeatmap.setColorMode('unipolar' | 'signed')          — M11.1
//   SpectralHeatmap.setShowLocalMaxima(bool)                     — M11.1
//   SpectralHeatmap.setSlice(axis | null, value)                 — M11.3
//   SpectralHeatmap.setIntensityThreshold(t in [0,1])            — M11.3
//   SpectralHeatmap.setClipSphere(mode, radius)                  — M11.3.2
//   SpectralHeatmap.setClipPin([x,y,z,w] | null)                 — M11.3.2
//   SpectralHeatmap.setStackScale(s)                             — M11.3.5
//   Getters: getChannel / isEnabled / getTransform / getColorMode /
//            getShowLocalMaxima / getSlice / getIntensityThreshold /
//            getClipSphere / getClipPin

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
  // M11.3 — slice axis (null disables) + per-axis index in [0,7]. When
  // a slice is active, off-slice cells get scale=0 (effectively hidden)
  // so the user sees one cross-section through the 4D volume at a time.
  let sliceAxis  = null;         // null | 'x' | 'y' | 'z' | 'w'
  let sliceValue = 4;            // 0..7
  // M11.3 — intensity threshold in [0, 1]. Cells with mapped t below the
  // threshold get scale=0. Slider sweeps a "percentile shell": 0 = show
  // everything (default), 0.75 = show only top quartile, 0.95 = top 5%.
  let intensityThreshold = 0;
  // M11.3.2 — 4D clipping sphere. When clipMode is 'center' or 'peak',
  // hide cells whose 4D Euclidean distance from the chosen reference
  // exceeds clipRadius. Adapted from Hofmann/Rieck/Sadlo 2018 — kills
  // projection-induced clutter by restricting the view to a 4D ball.
  // 'center' = lattice center (3.5, 3.5, 3.5, 3.5).
  // 'peak'   = brightest cell (recomputed each refresh).
  // 'click'  = use a sticky 4D pin set by SpectralHeatmap.setClipPin().
  let clipMode   = 'off';        // 'off' | 'center' | 'peak' | 'click'
  let clipRadius = 14;           // ~max 4D Euclidean diameter is sqrt(4*7^2) ≈ 14
  let _clipPin   = null;         // [x, y, z, w] when clipMode === 'click'

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
        console.warn('[m11/heatmap] getBoardEncoding failed:', res && res.reason);
        return;
      }
      const rawArr = res.channels && res.channels[channel];
      if (!rawArr || !rawArr.length) {
        console.warn(`[m11/heatmap] channel "${channel}" not in response`);
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
      let cellsShown = 0;
      // Pre-compute the "slice axis bit-extractor" once so the inner loop
      // is branch-free per cell.
      // For idx = (x<<9) | (y<<6) | (z<<3) | w, axis bits live at:
      //   x: (idx >> 9) & 7,  y: (idx >> 6) & 7,
      //   z: (idx >> 3) & 7,  w: idx & 7
      const sliceShift = (sliceAxis === 'x') ? 9
                       : (sliceAxis === 'y') ? 6
                       : (sliceAxis === 'z') ? 3
                       : (sliceAxis === 'w') ? 0
                       : -1;
      const useSlice = sliceShift >= 0;
      const useThreshold = intensityThreshold > 0;

      // M11.3.2 — compute clip-sphere reference once before the inner loop.
      let useClip = false;
      let clipCx = 0, clipCy = 0, clipCz = 0, clipCw = 0;
      if (clipMode === 'center') {
        clipCx = 3.5; clipCy = 3.5; clipCz = 3.5; clipCw = 3.5;
        useClip = true;
      } else if (clipMode === 'peak') {
        // Find the brightest cell on the ALREADY-transformed array (so
        // log1p / signed mode reflects in the peak choice).
        let peakIdx = 0, peakVal = -Infinity;
        for (let k = 0; k < arr.length; k++) {
          const v = (colorMode === 'signed') ? Math.abs(arr[k]) : arr[k];
          if (v > peakVal) { peakVal = v; peakIdx = k; }
        }
        clipCx = (peakIdx >> 9) & 7;
        clipCy = (peakIdx >> 6) & 7;
        clipCz = (peakIdx >> 3) & 7;
        clipCw = peakIdx & 7;
        useClip = true;
      } else if (clipMode === 'click' && _clipPin) {
        clipCx = _clipPin[0]; clipCy = _clipPin[1];
        clipCz = _clipPin[2]; clipCw = _clipPin[3];
        useClip = true;
      }
      // Soft falloff zone: 10% of the radius. Cells beyond R hard-clip;
      // cells in [R - falloff, R] linearly fade.
      const clipFalloff = Math.max(0.5, clipRadius * 0.10);
      const clipInner   = clipRadius - clipFalloff;
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
        let s = 0.45 + heightT * 0.60;
        // M11.3 filters: slice mask (hide off-axis cells) and intensity
        // threshold (hide cells below the percentile floor). Either filter
        // collapses the box to scale 0 (invisible). M11.3.2 adds a 4D
        // clipping sphere on top.
        if (useSlice && ((i >> sliceShift) & 7) !== sliceValue) {
          s = 0;
        } else if (useThreshold && (
          (colorMode === 'signed' ? Math.abs(t - 0.5) * 2 : t) < intensityThreshold
        )) {
          s = 0;
        } else if (useClip) {
          const px = (i >> 9) & 7;
          const py = (i >> 6) & 7;
          const pz = (i >> 3) & 7;
          const pw = i & 7;
          const dxc = px - clipCx, dyc = py - clipCy;
          const dzc = pz - clipCz, dwc = pw - clipCw;
          const dist4 = Math.sqrt(dxc*dxc + dyc*dyc + dzc*dzc + dwc*dwc);
          if (dist4 > clipRadius) {
            s = 0;
          } else if (dist4 > clipInner) {
            // Linear falloff in the outer skin so the boundary doesn't
            // pop. Cells at exactly R get scale 0; cells at R-falloff
            // get full scale.
            s *= (clipRadius - dist4) / clipFalloff;
            cellsShown++;
          } else {
            cellsShown++;
          }
        } else {
          cellsShown++;
        }
        _writeMatrix(im, i, s, _basePos[i * 3], _basePos[i * 3 + 1], _basePos[i * 3 + 2]);
      }
      im.instanceColor.needsUpdate  = true;
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere && im.computeBoundingSphere();

      // Local-max overlay: detected on the *transformed* values so a
      // log1p-transform-revealed peak still registers. Renders as
      // bright spheres at the world position of each local-max cell.
      // M11.3: respect the slice and threshold filters so the overlay
      // visibly tracks what the user is exploring.
      if (showMaxima) {
        const overlay = buildMaximaMesh();
        if (overlay) {
          const maxima = _findLocalMaxima(arr);
          let written = 0;
          for (let i = 0; i < maxima.length && written < MAX_LOCAL_MAXIMA_CAP; i++) {
            const cell = maxima[i];
            // Respect slice axis filter.
            if (useSlice && ((cell >> sliceShift) & 7) !== sliceValue) continue;
            // Respect threshold filter.
            if (useThreshold) {
              const t = _intensity[cell];
              const heightT = (colorMode === 'signed') ? Math.abs(t - 0.5) * 2 : t;
              if (heightT < intensityThreshold) continue;
            }
            // M11.3.2: respect the 4D clipping sphere too.
            if (useClip) {
              const px = (cell >> 9) & 7;
              const py = (cell >> 6) & 7;
              const pz = (cell >> 3) & 7;
              const pw = cell & 7;
              const dxc = px - clipCx, dyc = py - clipCy;
              const dzc = pz - clipCz, dwc = pw - clipCw;
              if (Math.sqrt(dxc*dxc + dyc*dyc + dzc*dzc + dwc*dwc) > clipRadius) continue;
            }
            _writeMatrix(
              overlay, written, 1.0,
              _basePos[cell * 3], _basePos[cell * 3 + 1], _basePos[cell * 3 + 2]
            );
            written++;
          }
          overlay.count = written;
          overlay.instanceMatrix.needsUpdate = true;
          overlay.visible = true;
          console.log(`[m11.1/heatmap] local maxima: ${written}/${maxima.length} shown ${written === MAX_LOCAL_MAXIMA_CAP ? '(capped)' : ''}`);
        }
      } else if (imMax) {
        imMax.visible = false;
      }

      if (typeof window !== 'undefined') window.__GAME_DIRTY__ = true;
      console.log(
        `[m11.1/heatmap] ch=${channel} transform=${transform} mode=${colorMode} ` +
          `clip=[${pLo.toExponential(3)}, ${pHi.toExponential(3)}] ` +
          `mapped=[${mapLo.toExponential(3)}, ${mapHi.toExponential(3)}] ` +
          `meanT=${(totalIntensity / arr.length).toFixed(3)} ` +
          `cellsShown=${cellsShown}/${arr.length}` +
          (useSlice ? ` slice=${sliceAxis}=${sliceValue}` : '') +
          (useThreshold ? ` threshold=${intensityThreshold.toFixed(2)}` : '') +
          (useClip ? ` clip=${clipMode}@(${clipCx.toFixed(1)},${clipCy.toFixed(1)},${clipCz.toFixed(1)},${clipCw.toFixed(1)}) R=${clipRadius.toFixed(1)}` : '')
      );
    } catch (err) {
      console.warn('[m11/heatmap] refresh error:', err);
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
        // M11.3 slice/threshold flags. Format: ?heatmapSlice=w:4,
        // ?heatmapThreshold=0.75
        const sFlag = params.get('heatmapSlice');
        if (sFlag) {
          const parts = sFlag.split(':');
          const ax = parts[0];
          const vv = parseInt(parts[1], 10);
          if ((ax === 'x' || ax === 'y' || ax === 'z' || ax === 'w') && Number.isFinite(vv)) {
            sliceAxis = ax;
            sliceValue = Math.max(0, Math.min(7, vv));
          }
        }
        const tFlag2 = params.get('heatmapThreshold');
        const tNum = parseFloat(tFlag2);
        if (Number.isFinite(tNum)) intensityThreshold = Math.max(0, Math.min(1, tNum));
        // M11.3.2 — clip sphere URL flag. Format: ?heatmapClip=peak:6
        // or ?heatmapClip=center:8 (mode:radius).
        const cFlag = params.get('heatmapClip');
        if (cFlag) {
          const parts = cFlag.split(':');
          const m = parts[0];
          if (m === 'off' || m === 'center' || m === 'peak' || m === 'click') {
            clipMode = m;
          }
          const rNum = parseFloat(parts[1]);
          if (Number.isFinite(rNum)) clipRadius = Math.max(0, Math.min(14, rNum));
        }
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
    /**
     * M11.3.5: scale the cloud's vertical (Y) axis to match a stack-
     * compression value applied to the rest of the scene. Called by the
     * 4D Navigation "Stack height" slider so cloud cells stay aligned
     * with the (compressed/expanded) chess boards.
     */
    setStackScale(s) {
      if (!Number.isFinite(s) || s <= 0) return;
      if (im) im.scale.y = s;
      if (imMax) imMax.scale.y = s;
      if (typeof window !== 'undefined') window.__GAME_DIRTY__ = true;
    },
    setShowLocalMaxima(en) {
      if (showMaxima === en) return;
      showMaxima = en;
      if (enabled) refresh();
      else if (imMax) imMax.visible = false;
      if (typeof window !== 'undefined') window.__GAME_DIRTY__ = true;
    },
    /**
     * M11.3: pin a slice axis. Off-slice cells are hidden so the user
     * sees one cross-section through the 4D volume at a time.
     *   axis: null | 'x' | 'y' | 'z' | 'w'    (null disables slicing)
     *   value: integer 0..7 (clamped)
     */
    setSlice(axis, value) {
      const ok = (axis === null || axis === undefined ||
                  axis === 'x' || axis === 'y' || axis === 'z' || axis === 'w');
      if (!ok) return;
      const newAxis = (axis === null || axis === undefined) ? null : axis;
      let newValue = sliceValue;
      if (Number.isFinite(value)) {
        newValue = Math.max(0, Math.min(7, Math.round(value)));
      }
      if (newAxis === sliceAxis && newValue === sliceValue) return;
      sliceAxis = newAxis;
      sliceValue = newValue;
      if (enabled) refresh();
    },
    getSlice() { return { axis: sliceAxis, value: sliceValue }; },
    /**
     * M11.3: hide cells whose mapped intensity is below `t` ∈ [0, 1].
     * t=0 = show everything; t=0.75 = top quartile only; t=0.95 = top 5%.
     * Sweeping the slider visualizes percentile shells.
     */
    setIntensityThreshold(t) {
      if (!Number.isFinite(t)) return;
      const v = Math.max(0, Math.min(1, t));
      if (v === intensityThreshold) return;
      intensityThreshold = v;
      if (enabled) refresh();
    },
    getIntensityThreshold() { return intensityThreshold; },
    /**
     * M11.3.2 — 4D clipping sphere. Hides cells whose 4D Euclidean
     * distance from the chosen reference point exceeds `radius`.
     *   mode: 'off' | 'center' | 'peak' | 'click'
     *     - center: lattice center (3.5, 3.5, 3.5, 3.5)
     *     - peak: brightest cell each refresh
     *     - click: use the sticky pin (set via setClipPin)
     *   radius: 0..14 (max 4D Euclidean diameter ≈ sqrt(4·7²) ≈ 14)
     */
    setClipSphere(mode, radius) {
      const ok = (mode === 'off' || mode === 'center' || mode === 'peak' || mode === 'click');
      if (!ok) return;
      let dirty = false;
      if (mode !== clipMode) { clipMode = mode; dirty = true; }
      if (Number.isFinite(radius)) {
        const r = Math.max(0, Math.min(14, radius));
        if (r !== clipRadius) { clipRadius = r; dirty = true; }
      }
      if (dirty && enabled) refresh();
    },
    getClipSphere() { return { mode: clipMode, radius: clipRadius }; },
    /**
     * M11.3.2 — pin a 4D reference point for the 'click' clip mode.
     * Pass a 4-tuple of integer or float lattice coordinates [x,y,z,w]
     * each in [0,7], or null to clear the pin.
     */
    setClipPin(coords) {
      if (coords === null || coords === undefined) {
        _clipPin = null;
      } else if (Array.isArray(coords) && coords.length === 4 &&
                 coords.every(c => Number.isFinite(c))) {
        _clipPin = [
          Math.max(0, Math.min(7, coords[0])),
          Math.max(0, Math.min(7, coords[1])),
          Math.max(0, Math.min(7, coords[2])),
          Math.max(0, Math.min(7, coords[3])),
        ];
      } else {
        return;
      }
      if (enabled && clipMode === 'click') refresh();
    },
    getClipPin() { return _clipPin ? _clipPin.slice() : null; },
    refresh,
    getChannel()   { return channel; },
    isEnabled()    { return enabled; },
    getTransform() { return transform; },
    getColorMode() { return colorMode; },
    getShowLocalMaxima() { return showMaxima; },
  };
})();
