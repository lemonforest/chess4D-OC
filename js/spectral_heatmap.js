// spectral_heatmap.js — M10 board signature visualization (M11 cloud refactor).
//
// M10 shipped this as a flat layer of 4096 quads sitting just above the
// per-cell board surface. Visually that "stripes" the lattice — the
// information is there, but it doesn't read as a 4D field, just as a
// stack of 2D heat maps glued to the boards.
//
// M11 turns it into a volumetric cloud:
//   - Per-cell mesh is a BoxGeometry that's TALLER than the gap to the
//     next board layer (verticalIncrement * 0.7 vs the 175 between
//     layers). Adjacent layers' boxes overlap in 3D space, so looking
//     through the stack you see blended translucent volume rather than
//     discrete sheets.
//   - Per-instance scale is modulated by intensity: dim cells shrink to
//     a small core, hot cells expand to fill (and overlap with) their
//     neighbors. Low-intensity regions look like wisps, high-intensity
//     regions look like dense cloud bodies.
//   - Low opacity (0.18) + depthWrite=false so overlapping boxes blend
//     additively-ish without depth artifacts. Pieces (in the separate
//     piecesContainer) render correctly because they're drawn opaque
//     before this transparent pass.
//   - Best paired with the "Hide chess boards" toggle from the spectral
//     overlay card — the boards otherwise occlude cloud volume below
//     their surface.
//
// One InstancedMesh = one draw call for all 4096 cells. Per-instance
// matrix updates each refresh; instanceColor updates each refresh.
//
// API (unchanged from M10):
//   SpectralHeatmap.init(scene, gameBoard)
//   SpectralHeatmap.setChannel(name)
//   SpectralHeatmap.setEnabled(bool)
//   SpectralHeatmap.refresh()
//   SpectralHeatmap.getChannel()  / .isEnabled()

(function () {
  'use strict';

  let im = null; // THREE.InstancedMesh of 4096 boxes
  let _scene = null;
  let _gameBoard = null;
  let enabled = false;
  let channel = 'A1';
  let _initRequested = false;

  // Cached per-cell base translation (no scale) so refresh() only has
  // to compose translation × scale, not re-evaluate boardCoordinates.
  const _basePos = new Float32Array(4096 * 3);
  // Cached per-cell intensity (last-refresh) for tooltip / debugging.
  const _intensity = new Float32Array(4096);

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

  function buildMesh() {
    if (im) return im;
    if (!_scene || !_gameBoard || !_gameBoard.graphics) return null;
    const gfx = _gameBoard.graphics;
    const square   = gfx.squareSize          || 50;
    const vert     = gfx.verticalIncrement   || 175;
    // Box dimensions tuned so adjacent layers overlap by ~10% in Y. The
    // Z-axis is the in-board chess depth, X is in-board chess width;
    // both stay slightly inset (0.95) to leave a hairline gap that
    // reads as cell separation. Y > vertical gap gives the volumetric
    // look; vert*0.7 is the empirical sweet spot for "cloudy but not
    // smeared into a single column".
    const sx = square * 0.95;
    const sy = vert   * 0.70;
    const sz = square * 0.95;
    const geom = new THREE.BoxGeometry(sx, sy, sz);
    const mat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.18,
      depthWrite: false,         // prevents nearer cells from masking far ones
      side: THREE.FrontSide,     // back faces would just add cost; one side reads fine
    });
    im = new THREE.InstancedMesh(geom, mat, 4096);
    im.frustumCulled = false;
    // Render after the (opaque) pieces and after the boards. transparent
    // is true so Three.js auto-sorts back-to-front; renderOrder=2 keeps
    // it consistently last among the transparent passes.
    im.renderOrder = 2;
    // Per-instance color attribute drives the heatmap.
    const colors = new Float32Array(4096 * 3);
    for (let i = 0; i < colors.length; i++) colors[i] = 0.5;
    im.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
    im.instanceColor.setUsage(THREE.DynamicDrawUsage);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Cache base positions; matrices set in refresh() will compose
    // translation × scale per cell so the cloud breathes with intensity.
    const matrix = new THREE.Matrix4();
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) {
        for (let z = 0; z < 8; z++) {
          for (let w = 0; w < 8; w++) {
            const pos = gfx.boardCoordinates(x, y, z, w);
            const idx = (x << 9) | (y << 6) | (z << 3) | w;
            _basePos[idx * 3 + 0] = pos.x;
            // Center the box on the board surface (no extra Y offset
            // — the box already extends up + down by sy/2 from center).
            _basePos[idx * 3 + 1] = pos.y;
            _basePos[idx * 3 + 2] = pos.z;
            // Initial: translation only, unit scale (so without a
            // refresh the cloud is just neutral gray).
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

  // Compose translation × uniform scale into the instance matrix at idx.
  // Scale 0..1; we map intensity onto [0.45, 1.05] so even dim cells have
  // a visible core, and hot cells slightly exceed cell bounds (which is
  // *desired* — that's how they bleed into neighbors and form cloud body).
  function _writeMatrix(idx, t) {
    const s = 0.45 + t * 0.60;
    const tx = _basePos[idx * 3 + 0];
    const ty = _basePos[idx * 3 + 1];
    const tz = _basePos[idx * 3 + 2];
    // Build matrix in-place. We don't need rotation; scale-and-translate
    // is just 12 writes instead of allocating a Matrix4.
    const e = im.instanceMatrix.array;
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
      const arr = res.channels && res.channels[channel];
      if (!arr || !arr.length) {
        console.warn(`[m10/heatmap] channel "${channel}" not in response`);
        return;
      }
      // Normalize using a robust range — channels with a few outliers
      // get their cloud color saturated by the outliers and the rest of
      // the lattice goes dark. We use abs-percentile to keep the typical
      // body of values mapped onto the visible range. A single pass for
      // min/max + a 4096-bucket quantile via Math.* would be O(n log n);
      // we instead compute mean ± 2σ which is O(n) and visually
      // comparable for the channels in chess-spectral.
      let lo = Infinity, hi = -Infinity, sum = 0, sumsq = 0;
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
        sum += v;
        sumsq += v * v;
      }
      const n = arr.length;
      const mean = sum / n;
      const variance = Math.max(0, sumsq / n - mean * mean);
      const std = Math.sqrt(variance);
      // Map [mean - 2σ, mean + 2σ] onto [0, 1], clamping outliers.
      let mapLo = mean - 2 * std;
      let mapHi = mean + 2 * std;
      // If the channel is essentially flat (σ ≈ 0) fall back to lo/hi.
      if (mapHi - mapLo < 1e-12) { mapLo = lo; mapHi = hi; }
      const range = mapHi - mapLo;
      const flat = !Number.isFinite(range) || range < 1e-12;
      for (let i = 0; i < arr.length; i++) {
        let t = flat ? 0.5 : (arr[i] - mapLo) / range;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        _intensity[i] = t;
        const c = viridisColor(t);
        im.instanceColor.setXYZ(i, c[0], c[1], c[2]);
        _writeMatrix(i, t);
      }
      im.instanceColor.needsUpdate  = true;
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere && im.computeBoundingSphere();
      if (typeof window !== 'undefined') window.__GAME_DIRTY__ = true;
      console.log(
        `[m10/heatmap] channel=${channel} cells=${arr.length} ` +
          `lo=${lo.toExponential(3)} hi=${hi.toExponential(3)} ` +
          `μ=${mean.toExponential(3)} σ=${std.toExponential(3)} ` +
          `mapped=[${mapLo.toExponential(3)},${mapHi.toExponential(3)}]`
      );
    } catch (err) {
      console.warn('[m10/heatmap] refresh error:', err);
    }
  }

  window.SpectralHeatmap = {
    init(scene, gameBoard) {
      if (_initRequested) return;
      _initRequested = true;
      _scene = scene;
      _gameBoard = gameBoard;
      buildMesh();
      try {
        const flag = new URLSearchParams(location.search).get('heatmap');
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
      if (en) refresh();
      if (typeof window !== 'undefined') window.__GAME_DIRTY__ = true;
    },
    refresh,
    getChannel() { return channel; },
    isEnabled() { return enabled; },
  };
})();
