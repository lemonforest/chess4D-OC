// spectral_qm_current.js — M14.2, second user-visible QM viz layer.
//
// Renders the probability-current vector field j_p(c) = Im(ψ* ∇ψ) as
// per-cell 3D arrow glyphs. The flow is genuinely 4D (one vector per
// 4D lattice cell), but we render in a 3D scene, so we use the lattice's
// (x,y,z) components as the spatial direction and encode the w-component
// as the arrow's color (signed RdBu ramp: blue = -w flow, red = +w flow,
// neutral = no w flow). Total flow magnitude (all 4 components) drives
// the arrow length, so cells with strong w-flow remain visible even when
// their (x,y,z) projection is small.
//
// Why per-cell glyphs rather than streamline integration (à la
// SpectralFilaments):
//   1. Streamlines need to integrate forward through the field — the
//      bridge cost would multiply (one getProbabilityCurrent call per
//      step) OR we'd need to cache the field locally and run the
//      integrator in JS. Glyphs need ONE call per refresh.
//   2. The user can read each cell's flow direction directly. With
//      streamlines you only see the integrated long-range structure.
//   3. M14.x viz family stays simple — one module per QM viz idea.
//
// Sourcing the arrow direction from the lattice is non-trivial because
// boardCoordinates(x,y,z,w) isn't a linear map (boards are arranged on
// an arc, with stack-axis wrap, etc.). For each cell we compute the
// world-space axis vectors by sampling boardCoordinates at the cell and
// at four orthogonal neighbors, then linear-combining by the flow
// components. This is the same technique used by spectral_filaments.js
// for sub-cell interpolation.
//
// Buffer: single LineSegments mesh, 4096 cells × 1 segment per cell ×
// 2 vertices per segment = 8192 vertices. Pre-allocated at the cap; if
// fewer cells are above the magnitude threshold, we just adjust
// drawRange to skip the rest. No reallocation cost on refresh.
//
// Threshold: cells with |j| below the percentile threshold (default
// p25 — show top 75% by magnitude) are hidden so the viz isn't a
// 4096-arrow blizzard. The percentile is configurable via setThreshold.
//
// API:
//   SpectralQmCurrent.init(scene, gameBoard)
//   SpectralQmCurrent.setEnabled(bool)
//   SpectralQmCurrent.refresh()
//   SpectralQmCurrent.setStackScale(s)
//   SpectralQmCurrent.setThreshold(t in [0,1])  — percentile cutoff
//   SpectralQmCurrent.isEnabled()

(function () {
  'use strict';

  const N_CELLS = 4096;
  const MAX_SEGMENTS = N_CELLS;             // one arrow per cell, max
  const STEP_SCALE = 0.45;                  // arrow half-length in lattice units
  const W_COLOR_GAIN = 1.5;                 // multiplier on |jw|/|j| → color saturation

  let lineMesh = null;
  let _scene = null;
  let _gameBoard = null;
  let enabled = false;
  let _initRequested = false;
  let _threshold = 0.25;                    // hide cells below 25th percentile of |j|

  // Cached world-space lattice axis vectors (computed once at init from
  // boardCoordinates samples). Used to convert the 4D flow vector into
  // a world-space arrow direction.
  let _axisX = null, _axisY = null, _axisZ = null;
  // _axisW is intentionally not used for direction — we encode it as
  // color instead. Keeping the comment for clarity.

  // M11.23 SSOT — RdBu signed colormap from spectral_color.js.
  const rdBuColor = (window.SpectralColor && window.SpectralColor.rdBuColor);

  function _ensureMesh() {
    if (lineMesh) return lineMesh;
    if (!_scene) return null;
    const positions = new Float32Array(MAX_SEGMENTS * 2 * 3);
    const colors    = new Float32Array(MAX_SEGMENTS * 2 * 3);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
    geom.setAttribute('color',    new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage));
    geom.setDrawRange(0, 0);
    // depthTest=false + opacity=1.0 so arrows always render above the
    // tints/cloud, matching the SpectralFilaments treatment.
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 1.0,
      depthWrite: false,
      depthTest: false,
    });
    lineMesh = new THREE.LineSegments(geom, mat);
    lineMesh.frustumCulled = false;
    lineMesh.renderOrder = 6; // above filaments (5) and tints (1)
    lineMesh.visible = false;
    _scene.add(lineMesh);
    return lineMesh;
  }

  function _computeAxisVectors() {
    // Sample boardCoordinates at a central cell and its four orthogonal
    // neighbors to get world-space axis vectors. Center pick (3,3,3,3)
    // is on the central super-board; using the corner (0,0,0,0) would
    // give the same result for a linear lattice but boards-on-arc
    // layouts have curvature near the edges. Center sampling is the
    // most representative average direction.
    if (!_gameBoard || !_gameBoard.graphics) return false;
    const gfx = _gameBoard.graphics;
    if (typeof gfx.boardCoordinates !== 'function') return false;
    try {
      const c0 = gfx.boardCoordinates(3, 3, 3, 3);
      const cX = gfx.boardCoordinates(4, 3, 3, 3);
      const cY = gfx.boardCoordinates(3, 4, 3, 3);
      const cZ = gfx.boardCoordinates(3, 3, 4, 3);
      _axisX = { x: cX.x - c0.x, y: cX.y - c0.y, z: cX.z - c0.z };
      _axisY = { x: cY.x - c0.x, y: cY.y - c0.y, z: cY.z - c0.z };
      _axisZ = { x: cZ.x - c0.x, y: cZ.y - c0.y, z: cZ.z - c0.z };
      // _axisW not computed — w-flow is encoded as color, not direction.
      return true;
    } catch (e) {
      console.warn('[m14.2/qm-current] axis vector probe failed:', e);
      return false;
    }
  }

  // Same retry-on-bridge-not-ready dance as SpectralBoardTint / QmDensity.
  let _refreshRetries = 0;
  async function refresh() {
    if (!enabled || !lineMesh) {
      console.log(`[m14.2/qm-current] refresh skipped: enabled=${enabled} mesh=${!!lineMesh}`);
      return;
    }
    if (typeof window === 'undefined' || !window.SpectralBridge) {
      console.warn('[m14.2/qm-current] refresh skipped: no SpectralBridge');
      return;
    }
    if (!window.__SPECTRAL_INFO__) {
      if (_refreshRetries < 30) {
        _refreshRetries++;
        console.log(`[m14.2/qm-current] bridge not ready; retry ${_refreshRetries}/30 in 200ms`);
        setTimeout(() => { refresh(); }, 200);
      } else {
        console.warn('[m14.2/qm-current] bridge still not ready after 30 retries; giving up');
      }
      return;
    }
    _refreshRetries = 0;
    if (!_axisX) {
      if (!_computeAxisVectors()) {
        console.warn('[m14.2/qm-current] cannot compute axis vectors; giving up');
        return;
      }
    }
    try {
      const res = await window.SpectralBridge.getProbabilityCurrent();
      if (!res || !res.ok) {
        console.warn('[m14.2/qm-current] getProbabilityCurrent failed:', res && res.error);
        return;
      }
      // Layout per upstream contract: j[4*idx + axis], idx = x*512+y*64+z*8+w.
      // Length should be 4096 * 4 = 16384.
      const j = res.j;
      if (!j || j.length !== N_CELLS * 4) {
        console.warn(`[m14.2/qm-current] expected j length ${N_CELLS * 4}, got ${j ? j.length : 'null'}`);
        return;
      }
      // Compute |j| per cell, find percentile threshold for visibility.
      const mags = new Float32Array(N_CELLS);
      for (let idx = 0; idx < N_CELLS; idx++) {
        const jx = j[4 * idx + 0];
        const jy = j[4 * idx + 1];
        const jz = j[4 * idx + 2];
        const jw = j[4 * idx + 3];
        mags[idx] = Math.sqrt(jx * jx + jy * jy + jz * jz + jw * jw);
      }
      // Percentile cutoff for showing arrows. Sort a copy to find the
      // threshold magnitude; cells below it are skipped.
      const sortedMags = new Float32Array(mags).sort();
      const cutoffIdx = Math.min(N_CELLS - 1, Math.floor(_threshold * N_CELLS));
      const magCutoff = sortedMags[cutoffIdx];
      // Find max magnitude for length normalization. Falls back to 1
      // if everything's zero so we don't divide by zero.
      const magMax = sortedMags[N_CELLS - 1] || 1;

      // Now write segment positions + colors. drawRange tracks how many
      // segments are actually visible.
      const positions = lineMesh.geometry.attributes.position.array;
      const colors    = lineMesh.geometry.attributes.color.array;
      const gfx = _gameBoard.graphics;
      let segIdx = 0;
      for (let x = 0; x < 8; x++) {
        for (let y = 0; y < 8; y++) {
          for (let z = 0; z < 8; z++) {
            for (let w = 0; w < 8; w++) {
              const idx = (x << 9) | (y << 6) | (z << 3) | w;
              const mag = mags[idx];
              if (mag < magCutoff || mag === 0) continue;
              const jx = j[4 * idx + 0];
              const jy = j[4 * idx + 1];
              const jz = j[4 * idx + 2];
              const jw = j[4 * idx + 3];
              // World-space arrow direction: linear combine the lattice
              // (x,y,z) flow components by the cached world-space axes.
              // (Drop the w-component; it's encoded as color.)
              const wx = jx * _axisX.x + jy * _axisY.x + jz * _axisZ.x;
              const wy = jx * _axisX.y + jy * _axisY.y + jz * _axisZ.y;
              const wz = jx * _axisX.z + jy * _axisY.z + jz * _axisZ.z;
              // Normalize spatial direction; scale length by total |j|.
              const wMag = Math.sqrt(wx * wx + wy * wy + wz * wz);
              // Cell where the flow occurs.
              const center = gfx.boardCoordinates(x, y, z, w);
              const ty = center.y + 4.0; // just above QmDensity's +3.0
              // Length proportional to the FULL 4D magnitude (so cells
              // with mostly-w flow still have visible arrows).
              const lenScale = (mag / magMax) * STEP_SCALE * 50; // 50 = roughly squareSize
              let dx = 0, dy = 0, dz = 0;
              if (wMag > 1e-12) {
                dx = (wx / wMag) * lenScale;
                dy = (wy / wMag) * lenScale;
                dz = (wz / wMag) * lenScale;
              }
              // Bidirectional arrow: line from center-d to center+d.
              const o = segIdx * 6;
              positions[o + 0] = center.x - dx;
              positions[o + 1] = ty - dy;
              positions[o + 2] = center.z - dz;
              positions[o + 3] = center.x + dx;
              positions[o + 4] = ty + dy;
              positions[o + 5] = center.z + dz;
              // Color: signed RdBu ramp on jw normalized to [-1, 1] via
              // the cell's magnitude. Then map to [0,1] for rdBuColor's
              // input, so 0.5 = neutral white, < 0.5 = blue, > 0.5 = red.
              const wRatio = (mag > 1e-12) ? Math.max(-1, Math.min(1, (jw / mag) * W_COLOR_GAIN)) : 0;
              const t = 0.5 + 0.5 * wRatio;
              const c = rdBuColor(t);
              // Both vertices same color (no along-line gradient).
              colors[o + 0] = c[0]; colors[o + 1] = c[1]; colors[o + 2] = c[2];
              colors[o + 3] = c[0]; colors[o + 4] = c[1]; colors[o + 5] = c[2];
              segIdx++;
              if (segIdx >= MAX_SEGMENTS) break;
            }
            if (segIdx >= MAX_SEGMENTS) break;
          }
          if (segIdx >= MAX_SEGMENTS) break;
        }
        if (segIdx >= MAX_SEGMENTS) break;
      }
      lineMesh.geometry.attributes.position.needsUpdate = true;
      lineMesh.geometry.attributes.color.needsUpdate = true;
      lineMesh.geometry.setDrawRange(0, segIdx * 2); // 2 verts per segment
      lineMesh.visible = enabled;
      if (typeof window !== 'undefined') window.__GAME_DIRTY__ = true;
      console.log(
        `[m14.2/qm-current] arrows=${segIdx}/${N_CELLS} ` +
          `magCutoff=${magCutoff.toExponential(3)} magMax=${magMax.toExponential(3)} ` +
          `threshold=p${(_threshold * 100).toFixed(0)}`
      );
    } catch (err) {
      console.warn('[m14.2/qm-current] refresh error:', err);
    }
  }

  window.SpectralQmCurrent = {
    init(scene, gameBoard) {
      if (_initRequested) return;
      _initRequested = true;
      _scene = scene;
      _gameBoard = gameBoard;
      _ensureMesh();
      _computeAxisVectors();
      try {
        const flag = new URLSearchParams(location.search).get('qmCurrent');
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
    setStackScale(s) {
      if (!Number.isFinite(s) || s <= 0) return;
      if (lineMesh) lineMesh.scale.y = s;
      if (typeof window !== 'undefined') window.__GAME_DIRTY__ = true;
    },
    setThreshold(t) {
      if (!Number.isFinite(t) || t < 0 || t >= 1) return;
      if (Math.abs(t - _threshold) < 1e-6) return;
      _threshold = t;
      if (enabled) refresh();
    },
    refresh,
    isEnabled() { return enabled; },
    getThreshold() { return _threshold; },
  };
})();
