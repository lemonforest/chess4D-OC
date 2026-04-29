// spectral_filaments.js — M10 streamline overlay.
//
// Visualizes the 4D vector field (STD4_X, STD4_Y, STD4_Z, STD4_W) as
// streamlines integrated through the lattice. The four STD4_* channels
// are coord-residual × signal at each cell — the natural lattice
// vector representation of the matter field. Streamlines integrate the
// gradient flow: starting at a seed cell, repeatedly step in the
// direction of the vector at the current cell.
//
// Why streamlines surface the spatial structure: the cells where pieces
// are dense pull the flow toward them; the field-line geometry traces
// the lattice's response to the current position. Cross-slice steps
// (∂z, ∂w) make the lines weave through the 3D rendering of the 64
// stacked boards — visually expressing structure that doesn't fit on
// any single 2D slice.
//
// API:
//   SpectralFilaments.init(scene, gameBoard)
//   SpectralFilaments.setEnabled(bool)
//   SpectralFilaments.refresh()  — call after each applyMove

(function () {
  'use strict';

  // Param caps (M10.2). Pre-allocated geometry sizes to the upper bounds
  // so setParams() changes only re-walk the lattice — no buffer reallocs.
  const SEED_COUNT_MAX = 512;
  const STEP_COUNT_MAX = 40;
  // Live params; mutable via setParams().
  let SEED_COUNT = 192;
  let STEP_COUNT = 18;
  const STEP_SCALE  = 1.0;  // unit step on the lattice
  const STD4_NAMES  = ['STD4_X', 'STD4_Y', 'STD4_Z', 'STD4_W'];

  let lineMesh = null;
  let _scene = null;
  let _gameBoard = null;
  let enabled = false;
  let _initRequested = false;

  function _ensureMesh() {
    if (lineMesh) return lineMesh;
    if (!_scene) return null;
    // Pre-allocate to the param caps so setParams() never reallocates.
    const maxSegments = SEED_COUNT_MAX * STEP_COUNT_MAX;
    const positions = new Float32Array(maxSegments * 2 * 3);
    const colors    = new Float32Array(maxSegments * 2 * 3);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
    geom.setAttribute('color',    new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage));
    geom.setDrawRange(0, 0);
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });
    lineMesh = new THREE.LineSegments(geom, mat);
    lineMesh.frustumCulled = false;
    lineMesh.visible = false;
    _scene.add(lineMesh);
    return lineMesh;
  }

  function _cellIdx(x, y, z, w) {
    return (x << 9) | (y << 6) | (z << 3) | w;
  }

  // Sample seed cells: deterministic stride so the visualization is
  // reproducible across refreshes. We pick every Nth cell index.
  function _seedIndices() {
    const seeds = [];
    const stride = Math.max(1, Math.floor(4096 / SEED_COUNT));
    for (let i = 0; i < 4096; i += stride) {
      seeds.push(i);
      if (seeds.length >= SEED_COUNT) break;
    }
    return seeds;
  }

  function _idxToXYZW(idx) {
    return [(idx >> 9) & 7, (idx >> 6) & 7, (idx >> 3) & 7, idx & 7];
  }

  // Color along the streamline: cool head → warm tail, so the eye picks
  // up "direction of flow" without arrow heads.
  function _colorAt(t) {
    if (t < 0.5) {
      const u = t * 2;
      return [0.20 + u * 0.10, 0.50 + u * 0.30, 0.85];
    }
    const u = (t - 0.5) * 2;
    return [0.30 + u * 0.55, 0.80 - u * 0.40, 0.85 - u * 0.65];
  }

  async function refresh() {
    if (!enabled || !_gameBoard || !_gameBoard.graphics) return;
    if (typeof window === 'undefined' || !window.SpectralBridge) return;
    if (!window.__SPECTRAL_INFO__) return;
    const mesh = _ensureMesh();
    if (!mesh) return;
    try {
      const res = await window.SpectralBridge.getBoardEncoding(STD4_NAMES);
      if (!res || !res.ok) {
        console.warn('[m10/filaments] getBoardEncoding failed:', res && res.reason);
        return;
      }
      const X = res.channels.STD4_X;
      const Y = res.channels.STD4_Y;
      const Z = res.channels.STD4_Z;
      const W = res.channels.STD4_W;
      if (!X || !Y || !Z || !W) {
        console.warn('[m10/filaments] STD4 channel slice incomplete');
        return;
      }

      const positions = mesh.geometry.attributes.position.array;
      const colors    = mesh.geometry.attributes.color.array;
      let writeIdx = 0;

      const gfx = _gameBoard.graphics;

      const seeds = _seedIndices();
      for (const seed of seeds) {
        let [cx, cy, cz, cw] = _idxToXYZW(seed);
        let prevWorld = gfx.boardCoordinates(cx, cy, cz, cw);
        for (let step = 0; step < STEP_COUNT; step++) {
          const idx = _cellIdx(cx, cy, cz, cw);
          const vx = X[idx], vy = Y[idx], vz = Z[idx], vw = W[idx];
          const mag = Math.hypot(vx, vy, vz, vw);
          if (!Number.isFinite(mag) || mag < 1e-12) break;
          // Snap step to lattice direction: round each component of the
          // unit vector. This produces +/- 1 increments per axis, which
          // walks the lattice without leaving cell-aligned positions.
          const inv = STEP_SCALE / mag;
          let dx = Math.round(vx * inv);
          let dy = Math.round(vy * inv);
          let dz = Math.round(vz * inv);
          let dw = Math.round(vw * inv);
          if (dx === 0 && dy === 0 && dz === 0 && dw === 0) {
            // Vector is sub-lattice — round in dominant direction.
            const ax = Math.abs(vx), ay = Math.abs(vy), az = Math.abs(vz), aw = Math.abs(vw);
            const m = Math.max(ax, ay, az, aw);
            if (m === ax) dx = vx >= 0 ? 1 : -1;
            else if (m === ay) dy = vy >= 0 ? 1 : -1;
            else if (m === az) dz = vz >= 0 ? 1 : -1;
            else dw = vw >= 0 ? 1 : -1;
          }
          const nx = cx + dx, ny = cy + dy, nz = cz + dz, nw = cw + dw;
          if (nx < 0 || nx > 7 || ny < 0 || ny > 7 || nz < 0 || nz > 7 || nw < 0 || nw > 7) {
            break; // walked off the board
          }
          const nextWorld = gfx.boardCoordinates(nx, ny, nz, nw);
          // Float a hair above the heatmap so they're visible on top.
          const yOffset = 1.2;
          // Segment: prevWorld -> nextWorld
          positions[writeIdx * 3 + 0] = prevWorld.x;
          positions[writeIdx * 3 + 1] = prevWorld.y + yOffset;
          positions[writeIdx * 3 + 2] = prevWorld.z;
          positions[writeIdx * 3 + 3] = nextWorld.x;
          positions[writeIdx * 3 + 4] = nextWorld.y + yOffset;
          positions[writeIdx * 3 + 5] = nextWorld.z;
          // Color: lerp from cool (start) to warm (end).
          const t0 = step / STEP_COUNT;
          const t1 = (step + 1) / STEP_COUNT;
          const c0 = _colorAt(t0);
          const c1 = _colorAt(t1);
          colors[writeIdx * 3 + 0] = c0[0];
          colors[writeIdx * 3 + 1] = c0[1];
          colors[writeIdx * 3 + 2] = c0[2];
          colors[writeIdx * 3 + 3] = c1[0];
          colors[writeIdx * 3 + 4] = c1[1];
          colors[writeIdx * 3 + 5] = c1[2];
          writeIdx += 2;
          cx = nx; cy = ny; cz = nz; cw = nw;
          prevWorld = nextWorld;
        }
      }

      mesh.geometry.setDrawRange(0, writeIdx);
      mesh.geometry.attributes.position.needsUpdate = true;
      mesh.geometry.attributes.color.needsUpdate = true;
      mesh.geometry.computeBoundingSphere();
      if (typeof window !== 'undefined') window.__GAME_DIRTY__ = true;
      console.log(`[m10/filaments] vertices=${writeIdx} (segments=${writeIdx/2})`);
    } catch (err) {
      console.warn('[m10/filaments] refresh error:', err);
    }
  }

  function _clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  window.SpectralFilaments = {
    /**
     * Update integration params and re-render. Both args optional.
     * Out-of-range values are clamped to the buffer caps; geometry isn't
     * reallocated (caps were sized to the maximums at mesh construction).
     */
    setParams(args) {
      let dirty = false;
      if (args && Number.isFinite(args.seedCount)) {
        const v = Math.round(_clamp(args.seedCount, 16, SEED_COUNT_MAX));
        if (v !== SEED_COUNT) { SEED_COUNT = v; dirty = true; }
      }
      if (args && Number.isFinite(args.stepCount)) {
        const v = Math.round(_clamp(args.stepCount, 2, STEP_COUNT_MAX));
        if (v !== STEP_COUNT) { STEP_COUNT = v; dirty = true; }
      }
      if (dirty && enabled) refresh();
    },
    getParams() {
      return { seedCount: SEED_COUNT, stepCount: STEP_COUNT };
    },
    init(scene, gameBoard) {
      if (_initRequested) return;
      _initRequested = true;
      _scene = scene;
      _gameBoard = gameBoard;
      _ensureMesh();
      // URL flag: ?filaments=1 enables on load.
      try {
        const flag = new URLSearchParams(location.search).get('filaments');
        if (flag === '1' || flag === 'on') {
          enabled = true;
          if (lineMesh) lineMesh.visible = true;
          refresh();
        }
      } catch (_) { /* no window — leave defaults */ }
    },
    setEnabled(en) {
      if (enabled === en) return;
      enabled = en;
      if (lineMesh) lineMesh.visible = en;
      if (en) refresh();
      if (typeof window !== 'undefined') window.__GAME_DIRTY__ = true;
    },
    refresh,
    isEnabled() { return enabled; },
  };
})();
