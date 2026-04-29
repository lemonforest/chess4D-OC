// spectral_heatmap.js — M10 board-wide signature visualization.
//
// Renders 4096 unit-quads, one per cell of the 4D hypercubic board,
// colored by the chosen channel's intensity at that cell. The full
// 45,056-dim encoding is computed by chess_spectral.encoder_4d.encode_4d
// (cached per real move from M6); this module just slices one channel
// and pushes the per-cell colors into a single InstancedMesh.
//
// One draw call for all 4096 cells. Refresh triggered on applyMove only
// (not per hover). Off by default; opt in via the "Board signature"
// dropdown in the spectral overlay card or via ?heatmap=A1|STD4_X|...
//
// API:
//   SpectralHeatmap.init(scene, gameBoard)  — call once after gameBoard exists
//   SpectralHeatmap.setChannel(name)        — pick a channel; auto-refresh
//   SpectralHeatmap.setEnabled(bool)        — show/hide; refreshes on enable
//   SpectralHeatmap.refresh()               — called after each applyMove
//
// Why a separate file from spectral_overlay.js: the M5/M6 overlay tints
// the destination *piece* meshes when a piece is selected. The M10
// heat map paints the *whole board* whether anything is selected or not.

(function () {
  'use strict';

  let im = null; // THREE.InstancedMesh of 4096 unit quads
  let _scene = null;
  let _gameBoard = null;
  let enabled = false;
  let channel = 'A1';
  let _initRequested = false; // guard against re-init

  function viridisColor(t) {
    // Same five-stop ramp as spectral_overlay.js — keeps the two visualizations
    // visually consistent at a glance.
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
    const square = gfx.squareSize || 30;
    // Plane geometry — slight inset so neighboring cells don't z-fight.
    const geom = new THREE.PlaneGeometry(square * 0.92, square * 0.92);
    // Lay flat (default PlaneGeometry is in XY plane; rotate to XZ).
    geom.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.65,
      side: THREE.DoubleSide,
      depthWrite: false, // overlays don't occlude pieces below
    });
    im = new THREE.InstancedMesh(geom, mat, 4096);
    im.frustumCulled = false;
    // Per-instance color attribute drives the heatmap.
    const colors = new Float32Array(4096 * 3);
    for (let i = 0; i < colors.length; i++) colors[i] = 0.5; // neutral gray default
    im.instanceColor = new THREE.InstancedBufferAttribute(colors, 3);
    im.instanceColor.setUsage(THREE.DynamicDrawUsage);
    // Position each instance at boardCoordinates(x,y,z,w). We use the
    // chess-spectral cell-index ordering (x*512 + y*64 + z*8 + w) so the
    // refresh() loop can index into the encoding directly.
    const matrix = new THREE.Matrix4();
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) {
        for (let z = 0; z < 8; z++) {
          for (let w = 0; w < 8; w++) {
            const pos = gfx.boardCoordinates(x, y, z, w);
            // Float the heatmap a tick above the cell surface so it's visible
            // and doesn't z-fight with the checkerboard. boardHeight isn't
            // exposed cleanly; +0.6 is empirical and tracks the 5-unit board.
            matrix.makeTranslation(pos.x, pos.y + 0.6, pos.z);
            const idx = (x << 9) | (y << 6) | (z << 3) | w;
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

  async function refresh() {
    if (!enabled || !im) return;
    if (typeof window === 'undefined' || !window.SpectralBridge) return;
    if (!window.__SPECTRAL_INFO__) return; // bridge not ready yet
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
      // Normalize across all 4096 cells.
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      const range = hi - lo;
      const flat = !Number.isFinite(range) || range < 1e-12;
      // Update per-instance colors. The instance index matches the
      // chess-spectral cell index by construction (see buildMesh).
      for (let i = 0; i < arr.length; i++) {
        const t = flat ? 0.5 : (arr[i] - lo) / range;
        const c = viridisColor(t);
        im.instanceColor.setXYZ(i, c[0], c[1], c[2]);
      }
      im.instanceColor.needsUpdate = true;
      if (typeof window !== 'undefined') window.__GAME_DIRTY__ = true;
      console.log(
        `[m10/heatmap] channel=${channel} cells=${arr.length} ` +
          `lo=${lo.toExponential(3)} hi=${hi.toExponential(3)} ` +
          `range=${flat ? '(FLAT)' : range.toExponential(3)}`
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
      // URL flag drives initial state — `?heatmap=A1` enables and picks channel.
      try {
        const flag = new URLSearchParams(location.search).get('heatmap');
        if (flag && flag !== 'off') {
          channel = flag;
          enabled = true;
          if (im) im.visible = true;
          refresh(); // fire-and-forget; will retry on next applyMove if bridge isn't ready
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
