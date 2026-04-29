// spectral_filaments.js — M10 streamlines, M11 sub-cell + gradient refactor.
//
// M10 shipped this with two visual problems:
//   1. Lines were straight because every step was snapped to ±1 along the
//      dominant lattice axis. The lattice IS discrete but the field is
//      a discrete sampling of an underlying continuum, and the eye needs
//      sub-cell smoothness to read curves.
//   2. Lines all went to the same spot because forward-only gradient
//      flow converges to local maxima (basins of attraction). A user
//      asking "show me the shape of the heat map" expects field lines
//      that pass THROUGH structure, not lines that sink into it.
//
// M11 fixes both:
//   - Continuous sub-cell positions (cx, cy, cz, cw) ∈ [0,7] in each
//     axis. Each step moves a fractional amount in the unit-vector
//     direction, so the polyline curves through the lattice.
//   - Quadrilinear interpolation to sample channel values at sub-cell
//     positions; central differences (h=0.5) to compute the gradient
//     at any point.
//   - Bidirectional integration: from each seed, walk half the steps
//     forward (gradient direction) and half backward (-gradient). The
//     line passes through the seed instead of starting there, so
//     visually the streamlines trace structure rather than terminate
//     at it.
//   - Channel binding: by default the filaments use the STD4 4-vector
//     field (the natural "lattice direction" of the matter field). When
//     the M10 board-signature dropdown selects a non-STD4 channel, the
//     filaments switch to that channel's gradient automatically — one
//     dropdown drives both visualizations.
//
// Buffer layout is unchanged from M10 (pre-allocated to the param caps),
// so the seed/step sliders mutate parameters without reallocating.

(function () {
  'use strict';

  // Param caps. Pre-allocate geometry to the upper bounds.
  const SEED_COUNT_MAX = 512;
  const STEP_COUNT_MAX = 40;
  let SEED_COUNT = 192;
  let STEP_COUNT = 24; // bidirectional → ~12 forward + 12 backward by default
  // STEP_SCALE controls sub-cell step length. 0.55 lattice units gives
  // visibly curved arcs without losing too much polyline reach. Total
  // streamline length ≈ STEP_COUNT × STEP_SCALE lattice units.
  const STEP_SCALE = 0.55;
  const STD4_NAMES = ['STD4_X', 'STD4_Y', 'STD4_Z', 'STD4_W'];

  let lineMesh = null;
  let _scene = null;
  let _gameBoard = null;
  let enabled = false;
  let _initRequested = false;

  // null / 'off' / 'STD4' → 4-vector field mode (STD4_X..STD4_W).
  // Anything else → fetch that scalar channel and follow its gradient.
  let _channel = null;

  function _ensureMesh() {
    if (lineMesh) return lineMesh;
    if (!_scene) return null;
    // Bidirectional → 2 vertices per segment, up to STEP_COUNT_MAX
    // segments per seed. Allocate to the cap so setParams() never
    // reallocates.
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
    lineMesh.renderOrder = 3; // after the heat-map cloud
    lineMesh.visible = false;
    _scene.add(lineMesh);
    return lineMesh;
  }

  function _cellIdx(x, y, z, w) { return (x << 9) | (y << 6) | (z << 3) | w; }

  // Sample seed cells: deterministic stride for reproducibility.
  function _seedIndices() {
    const seeds = [];
    const stride = Math.max(1, Math.floor(4096 / SEED_COUNT));
    for (let i = 0; i < 4096 && seeds.length < SEED_COUNT; i += stride) {
      seeds.push(i);
    }
    return seeds;
  }

  function _idxToXYZW(idx) {
    return [(idx >> 9) & 7, (idx >> 6) & 7, (idx >> 3) & 7, idx & 7];
  }

  // Cool head → warm tail color along the streamline. Same ramp as M10.
  function _colorAt(t) {
    if (t < 0.5) {
      const u = t * 2;
      return [0.20 + u * 0.10, 0.50 + u * 0.30, 0.85];
    }
    const u = (t - 0.5) * 2;
    return [0.30 + u * 0.55, 0.80 - u * 0.40, 0.85 - u * 0.65];
  }

  // Quadrilinear interpolation of `arr` (length 4096, indexed
  // x*512 + y*64 + z*8 + w) at continuous lattice position (x,y,z,w).
  // Out-of-range coords are clamped to the lattice boundary.
  function _sample4D(arr, x, y, z, w) {
    if (x < 0) x = 0; else if (x > 7) x = 7;
    if (y < 0) y = 0; else if (y > 7) y = 7;
    if (z < 0) z = 0; else if (z > 7) z = 7;
    if (w < 0) w = 0; else if (w > 7) w = 7;
    const x0 = Math.floor(x); const x1 = x0 + 1 > 7 ? 7 : x0 + 1; const tx = x - x0;
    const y0 = Math.floor(y); const y1 = y0 + 1 > 7 ? 7 : y0 + 1; const ty = y - y0;
    const z0 = Math.floor(z); const z1 = z0 + 1 > 7 ? 7 : z0 + 1; const tz = z - z0;
    const w0 = Math.floor(w); const w1 = w0 + 1 > 7 ? 7 : w0 + 1; const tw = w - w0;
    let v = 0;
    for (let dx = 0; dx <= 1; dx++) {
      const ax = dx ? x1 : x0; const wx = dx ? tx : (1 - tx);
      for (let dy = 0; dy <= 1; dy++) {
        const ay = dy ? y1 : y0; const wy = dy ? ty : (1 - ty);
        for (let dz = 0; dz <= 1; dz++) {
          const az = dz ? z1 : z0; const wz = dz ? tz : (1 - tz);
          const wxyz = wx * wy * wz;
          for (let dw = 0; dw <= 1; dw++) {
            const aw = dw ? w1 : w0; const ww = dw ? tw : (1 - tw);
            v += arr[(ax << 9) | (ay << 6) | (az << 3) | aw] * wxyz * ww;
          }
        }
      }
    }
    return v;
  }

  // Central-difference gradient of a scalar channel at a sub-cell pos.
  // Returns a [gx, gy, gz, gw] tuple.
  const _GRAD_OUT = [0, 0, 0, 0];
  function _gradientScalar(arr, x, y, z, w) {
    const h = 0.5;
    _GRAD_OUT[0] = (_sample4D(arr, x + h, y, z, w) - _sample4D(arr, x - h, y, z, w));
    _GRAD_OUT[1] = (_sample4D(arr, x, y + h, z, w) - _sample4D(arr, x, y - h, z, w));
    _GRAD_OUT[2] = (_sample4D(arr, x, y, z + h, w) - _sample4D(arr, x, y, z - h, w));
    _GRAD_OUT[3] = (_sample4D(arr, x, y, z, w + h) - _sample4D(arr, x, y, z, w - h));
    return _GRAD_OUT;
  }

  // 4-vector field sample for STD4 mode. Reuses _GRAD_OUT to avoid alloc.
  function _vectorSTD4(X, Y, Z, W, x, y, z, w) {
    _GRAD_OUT[0] = _sample4D(X, x, y, z, w);
    _GRAD_OUT[1] = _sample4D(Y, x, y, z, w);
    _GRAD_OUT[2] = _sample4D(Z, x, y, z, w);
    _GRAD_OUT[3] = _sample4D(W, x, y, z, w);
    return _GRAD_OUT;
  }

  // Walk a path from (sx, sy, sz, sw) for up to `maxSteps` substeps,
  // stepping in `dirSign * unit(field)` each iteration. `out` is a
  // Float32Array of size at least (maxSteps + 1) * 4 — gets [cx,cy,cz,cw]
  // for each visited point. Returns the number of points written
  // (always ≥ 1, since the seed itself is written first).
  function _walk(sampleField, sx, sy, sz, sw, dirSign, maxSteps, out) {
    out[0] = sx; out[1] = sy; out[2] = sz; out[3] = sw;
    let cx = sx, cy = sy, cz = sz, cw = sw;
    let count = 1;
    for (let step = 0; step < maxSteps; step++) {
      const v = sampleField(cx, cy, cz, cw);
      const mag = Math.hypot(v[0], v[1], v[2], v[3]);
      if (!Number.isFinite(mag) || mag < 1e-6) break;
      const inv = (dirSign * STEP_SCALE) / mag;
      const nx = cx + v[0] * inv;
      const ny = cy + v[1] * inv;
      const nz = cz + v[2] * inv;
      const nw = cw + v[3] * inv;
      // Bail if we're walking off the lattice — clamping would just
      // smear lines along the boundary which reads as noise.
      if (nx < 0 || nx > 7 || ny < 0 || ny > 7 || nz < 0 || nz > 7 || nw < 0 || nw > 7) break;
      cx = nx; cy = ny; cz = nz; cw = nw;
      const off = count * 4;
      out[off] = cx; out[off + 1] = cy; out[off + 2] = cz; out[off + 3] = cw;
      count++;
    }
    return count;
  }

  // Pre-allocated scratch buffers for forward + backward paths.
  const _bwdPath = new Float32Array((STEP_COUNT_MAX + 1) * 4);
  const _fwdPath = new Float32Array((STEP_COUNT_MAX + 1) * 4);

  async function refresh() {
    if (!enabled || !_gameBoard || !_gameBoard.graphics) return;
    if (typeof window === 'undefined' || !window.SpectralBridge) return;
    if (!window.__SPECTRAL_INFO__) return;
    const mesh = _ensureMesh();
    if (!mesh) return;
    try {
      // Pick the field source. Default = STD4 4-vector. Else = gradient
      // of a single scalar channel.
      let sampleField;
      let sourceLabel;
      const useChannel = (_channel && _channel !== 'off' && _channel !== 'STD4');
      if (useChannel) {
        const res = await window.SpectralBridge.getBoardEncoding([_channel]);
        if (!res || !res.ok) {
          console.warn('[m10/filaments] getBoardEncoding(scalar) failed:', res && res.reason);
          return;
        }
        const arr = res.channels && res.channels[_channel];
        if (!arr || !arr.length) {
          console.warn(`[m10/filaments] channel "${_channel}" not in response`);
          return;
        }
        sampleField = function (x, y, z, w) { return _gradientScalar(arr, x, y, z, w); };
        sourceLabel = `∇${_channel}`;
      } else {
        const res = await window.SpectralBridge.getBoardEncoding(STD4_NAMES);
        if (!res || !res.ok) {
          console.warn('[m10/filaments] getBoardEncoding(STD4) failed:', res && res.reason);
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
        sampleField = function (x, y, z, w) { return _vectorSTD4(X, Y, Z, W, x, y, z, w); };
        sourceLabel = 'STD4';
      }

      const positions = mesh.geometry.attributes.position.array;
      const colors    = mesh.geometry.attributes.color.array;
      let writeIdx = 0;
      const gfx = _gameBoard.graphics;

      // Float a hair above the heat-map cloud center so the lines are
      // visible against it. The cloud is centered on the cell's Y; +0.4
      // is empirical — far above pieces but inside the cloud body.
      const yOffset = 0.4;

      const seeds = _seedIndices();
      const halfBack = Math.floor(STEP_COUNT / 2);
      const halfFwd  = STEP_COUNT - halfBack;
      const maxBufferSegments = SEED_COUNT_MAX * STEP_COUNT_MAX;

      for (const seed of seeds) {
        const [sx, sy, sz, sw] = _idxToXYZW(seed);
        // Forward (gradient direction) and backward (anti-gradient) walks.
        const bwdCount = _walk(sampleField, sx, sy, sz, sw, -1, halfBack, _bwdPath);
        const fwdCount = _walk(sampleField, sx, sy, sz, sw, +1, halfFwd,  _fwdPath);
        // Combine: backward path REVERSED so it ends at the seed,
        // then forward path starting from seed (skip duplicate seed
        // by starting the forward concat at index 1).
        const totalPoints = bwdCount + fwdCount - 1;
        if (totalPoints < 2) continue;
        const totalSegs = totalPoints - 1;

        // Walk through points emitting LineSegments-compatible pairs.
        // For point[i] → point[i+1], we need both endpoints.
        let prevWorld = null;
        for (let i = 0; i < totalPoints; i++) {
          // Source the i-th continuous point: indices 0..bwdCount-1 are
          // backward path REVERSED (so [bwdCount-1] = seed). Indices
          // bwdCount..totalPoints-1 are forward path[1..fwdCount-1].
          let cx, cy, cz, cw;
          if (i < bwdCount) {
            const off = (bwdCount - 1 - i) * 4;
            cx = _bwdPath[off]; cy = _bwdPath[off + 1];
            cz = _bwdPath[off + 2]; cw = _bwdPath[off + 3];
          } else {
            const off = (i - bwdCount + 1) * 4;
            cx = _fwdPath[off]; cy = _fwdPath[off + 1];
            cz = _fwdPath[off + 2]; cw = _fwdPath[off + 3];
          }
          const world = gfx.boardCoordinates(cx, cy, cz, cw);
          if (prevWorld) {
            // Check buffer guard before writing the segment.
            if (writeIdx / 2 >= maxBufferSegments) break;
            // Segment prevWorld → world, color t along total path.
            const t0 = (i - 1) / totalSegs;
            const t1 = i / totalSegs;
            const c0 = _colorAt(t0);
            const c1 = _colorAt(t1);
            positions[writeIdx * 3 + 0] = prevWorld.x;
            positions[writeIdx * 3 + 1] = prevWorld.y + yOffset;
            positions[writeIdx * 3 + 2] = prevWorld.z;
            positions[writeIdx * 3 + 3] = world.x;
            positions[writeIdx * 3 + 4] = world.y + yOffset;
            positions[writeIdx * 3 + 5] = world.z;
            colors[writeIdx * 3 + 0] = c0[0]; colors[writeIdx * 3 + 1] = c0[1]; colors[writeIdx * 3 + 2] = c0[2];
            colors[writeIdx * 3 + 3] = c1[0]; colors[writeIdx * 3 + 4] = c1[1]; colors[writeIdx * 3 + 5] = c1[2];
            writeIdx += 2;
          }
          prevWorld = world;
        }
      }

      mesh.geometry.setDrawRange(0, writeIdx);
      mesh.geometry.attributes.position.needsUpdate = true;
      mesh.geometry.attributes.color.needsUpdate    = true;
      mesh.geometry.computeBoundingSphere();
      if (typeof window !== 'undefined') window.__GAME_DIRTY__ = true;
      console.log(
        `[m10/filaments] source=${sourceLabel} seeds=${seeds.length} ` +
          `step=${STEP_SCALE} totalSteps=${STEP_COUNT} ` +
          `vertices=${writeIdx} (segments=${writeIdx / 2})`
      );
    } catch (err) {
      console.warn('[m10/filaments] refresh error:', err);
    }
  }

  function _clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  window.SpectralFilaments = {
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
    /**
     * Bind the filament field source to a channel. Call with:
     *   - 'off' / null / 'STD4' → STD4 4-vector field (default)
     *   - 'A1' / 'FIB_SYM_1' / etc → gradient of that scalar channel
     * Driven by the M10 board-signature dropdown so the same dropdown
     * controls heat-map fill and filament tracing.
     */
    setChannel(name) {
      const next = (name === undefined || name === null) ? null : name;
      if (next === _channel) return;
      _channel = next;
      if (enabled) refresh();
    },
    getChannel() { return _channel; },
    init(scene, gameBoard) {
      if (_initRequested) return;
      _initRequested = true;
      _scene = scene;
      _gameBoard = gameBoard;
      _ensureMesh();
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
