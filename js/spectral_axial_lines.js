// spectral_axial_lines.js — M14.7, 4D axial guide lines through a focal piece.
//
// User request: draw x/y/z axial lines through the currently selected piece
// (player- or bot-attention) to "draw the eye to where what's happening."
//
// Visual: four colored tubes — one per lattice axis (x/y/z/w) — passing
// through the focal cell. Each tube traces a CatmullRom curve through the
// 8 lattice cells along that axis at the focal piece's position in the
// other 3 axes. Color is axis-canonical:
//
//   x = red    (across files within a board, in chess parlance)
//   y = green  (across rows within a board)
//   z = blue   (across "boards" in the stack — the third dimension)
//   w = yellow (across super-boards — the fourth dimension)
//
// Why TubeGeometry vs LineBasicMaterial:
//   WebGL `linewidth` is a hint that most browsers (Chromium especially)
//   clamp to 1 pixel. A "thickness" slider on LineBasicMaterial is
//   visually a no-op. TubeGeometry wraps a smooth tube of adjustable
//   radius around the curve and respects that radius across all browsers.
//
// API (consumed by main.js selectPiece/deselectPiece + Bot integration):
//   SpectralAxialLines.init(scene, gameBoard)
//   SpectralAxialLines.setEnabled(bool)
//   SpectralAxialLines.setFocus({x,y,z,w})    — set focal cell, rebuild tubes
//   SpectralAxialLines.clear()                 — no focus, hide tubes
//   SpectralAxialLines.setOpacity(t in [0,1])  — material opacity
//   SpectralAxialLines.setThickness(r)         — tube radius in world units
//   SpectralAxialLines.isEnabled()
//
// Performance: rebuild costs are small (4 tubes × 8 control points each).
// A selectPiece event triggers one rebuild; idle frames are pure render.

(function () {
  'use strict';

  const AXIS_COLORS = {
    x: 0xff4040, // red
    y: 0x40ff40, // green
    z: 0x4080ff, // blue
    w: 0xffd040, // yellow / amber
  };
  const AXIS_KEYS = ['x', 'y', 'z', 'w'];
  const TUBE_SEGMENTS = 32;       // tubular subdivisions along the curve
  const TUBE_RADIAL_SEGMENTS = 8; // around the tube cross-section
  let _tubeRadius = 1.5;          // default thickness; setThickness updates
  let _opacity = 0.65;            // default opacity; setOpacity updates

  let _scene = null;
  let _gameBoard = null;
  let _enabled = false;
  let _initRequested = false;
  // One Mesh per axis, indexed by 'x'|'y'|'z'|'w'. Each Mesh swaps its
  // .geometry on setFocus; the material is a single shared instance per
  // axis (so opacity changes apply to everything in lockstep).
  const _meshes = {};
  const _materials = {};
  let _currentFocus = null;       // {x,y,z,w} or null

  function _ensureMaterials() {
    for (const axis of AXIS_KEYS) {
      if (_materials[axis]) continue;
      _materials[axis] = new THREE.MeshBasicMaterial({
        color: AXIS_COLORS[axis],
        transparent: true,
        opacity: _opacity,
        depthWrite: false,
        depthTest: true,    // tubes sit at piece elevation; let pieces occlude
      });
    }
  }

  function _buildAxisCurve(axis, focus) {
    if (!_gameBoard || !_gameBoard.graphics) return null;
    const gfx = _gameBoard.graphics;
    if (typeof gfx.boardCoordinates !== 'function') return null;
    const points = [];
    for (let i = 0; i < 8; i++) {
      // Build the lattice coord at step i along this axis, holding the
      // other three axes at the focus value.
      const c = { x: focus.x, y: focus.y, z: focus.z, w: focus.w };
      c[axis] = i;
      try {
        const p = gfx.boardCoordinates(c.x | 0, c.y | 0, c.z | 0, c.w | 0);
        // Lift slightly above the board surface so the tube is visible
        // above the piece bodies but below the cloud / filaments.
        points.push(new THREE.Vector3(p.x, p.y + 4.5, p.z));
      } catch (_) {
        return null;
      }
    }
    return new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.0);
  }

  function _rebuildAxis(axis, focus) {
    const curve = _buildAxisCurve(axis, focus);
    if (!curve) return;
    const newGeom = new THREE.TubeGeometry(
      curve,
      TUBE_SEGMENTS,
      _tubeRadius,
      TUBE_RADIAL_SEGMENTS,
      false /* closed */
    );
    if (_meshes[axis]) {
      // Dispose the old geometry to avoid GPU buffer leaks across many
      // selection-changes (e.g., a long bot match could re-trigger 100s
      // of rebuilds).
      _meshes[axis].geometry.dispose();
      _meshes[axis].geometry = newGeom;
    } else {
      const m = new THREE.Mesh(newGeom, _materials[axis]);
      m.frustumCulled = false;
      m.renderOrder = 4; // above QmCurrent/PV/etc; below pieces (default 0+)
      _meshes[axis] = m;
      _scene.add(m);
    }
    _meshes[axis].visible = _enabled;
  }

  function _rebuildAll() {
    if (!_currentFocus) {
      for (const axis of AXIS_KEYS) {
        if (_meshes[axis]) _meshes[axis].visible = false;
      }
      if (typeof window !== 'undefined') window.__GAME_DIRTY__ = true;
      return;
    }
    _ensureMaterials();
    for (const axis of AXIS_KEYS) {
      _rebuildAxis(axis, _currentFocus);
    }
    if (typeof window !== 'undefined') window.__GAME_DIRTY__ = true;
  }

  window.SpectralAxialLines = {
    init(scene, gameBoard) {
      if (_initRequested) return;
      _initRequested = true;
      _scene = scene;
      _gameBoard = gameBoard;
      _ensureMaterials();
    },
    setEnabled(en) {
      if (_enabled === en) return;
      _enabled = en;
      for (const axis of AXIS_KEYS) {
        if (_meshes[axis]) _meshes[axis].visible = en && !!_currentFocus;
      }
      if (en && _currentFocus) _rebuildAll();
      if (typeof window !== 'undefined') window.__GAME_DIRTY__ = true;
    },
    setFocus(coord) {
      if (!coord || typeof coord.x !== 'number') return;
      const c = {
        x: Math.max(0, Math.min(7, coord.x | 0)),
        y: Math.max(0, Math.min(7, coord.y | 0)),
        z: Math.max(0, Math.min(7, coord.z | 0)),
        w: Math.max(0, Math.min(7, coord.w | 0)),
      };
      // Skip rebuild if focus hasn't actually changed.
      if (_currentFocus &&
          _currentFocus.x === c.x && _currentFocus.y === c.y &&
          _currentFocus.z === c.z && _currentFocus.w === c.w) return;
      _currentFocus = c;
      if (_enabled) _rebuildAll();
    },
    clear() {
      _currentFocus = null;
      for (const axis of AXIS_KEYS) {
        if (_meshes[axis]) _meshes[axis].visible = false;
      }
      if (typeof window !== 'undefined') window.__GAME_DIRTY__ = true;
    },
    setOpacity(t) {
      if (!Number.isFinite(t)) return;
      _opacity = Math.max(0, Math.min(1, t));
      for (const axis of AXIS_KEYS) {
        if (_materials[axis]) _materials[axis].opacity = _opacity;
      }
      if (typeof window !== 'undefined') window.__GAME_DIRTY__ = true;
    },
    setThickness(r) {
      if (!Number.isFinite(r) || r <= 0) return;
      _tubeRadius = r;
      // Thickness change requires geometry rebuild (TubeGeometry bakes
      // the radius at construction). Cheap enough to do per slider tick
      // since 4 tubes × 32×8 verts = ~1k verts each.
      if (_currentFocus && _enabled) _rebuildAll();
    },
    isEnabled() { return _enabled; },
    getOpacity() { return _opacity; },
    getThickness() { return _tubeRadius; },
  };
})();
