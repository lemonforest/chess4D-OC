// spectral_pv.js — M14.5, principal-variation ghost-arrow overlay.
//
// When an engine-* bot strategy finishes searching, chess-spectral 1.6.1's
// SearchResult.pv carries the engine's predicted line of play (the
// "principal variation"). M14.5 renders that line as faded arrows on top
// of the lattice — the user sees what the bot is thinking through the
// next several plies, not just the move it's about to play.
//
// Visual design:
//   - One arrow per PV move (origin cell → destination cell)
//   - Ply 0 (the move about to be played) shows brightest
//   - Each subsequent ply darker / cooler — yellow-orange → red-purple
//     gradient so the user reads the plies in temporal order
//   - depthTest: false so arrows always sit on top
//   - Cleared automatically when the bot's actual move executes
//     (at which point ply 0 is no longer "predicted" — it's history).
//
// API (consumed by Bot._engineGetBestMove + GameBoard.move):
//   SpectralPV.init(scene, gameBoard)
//   SpectralPV.setEnabled(bool)
//   SpectralPV.show(pv, team)   // pv: [{from:{x,y,z,w}, to:{x,y,z,w}}, ...]
//   SpectralPV.clear()
//   SpectralPV.isEnabled()
//
// The "ghost arrow" framing matches the user's mental model from
// classical chess engine viewers (Stockfish, Lichess analysis board)
// where the engine's PV is shown as a faint highlighted line.

(function () {
  'use strict';

  const MAX_PV_PLIES = 32;          // way more than typical chess search depths
  const ELEVATION = 5.0;             // Y offset above the board surface
  let lineMesh = null;
  let _scene = null;
  let _gameBoard = null;
  let enabled = false;
  let _initRequested = false;
  let _currentPv = null;             // last shown PV (for re-render on enable toggle)
  let _currentTeam = 0;

  function _ensureMesh() {
    if (lineMesh) return lineMesh;
    if (!_scene) return null;
    const positions = new Float32Array(MAX_PV_PLIES * 2 * 3);
    const colors    = new Float32Array(MAX_PV_PLIES * 2 * 3);
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
    geom.setAttribute('color',    new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage));
    geom.setDrawRange(0, 0);
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      depthTest: false,
      linewidth: 2, // hint only — most WebGL impls clamp to 1
    });
    lineMesh = new THREE.LineSegments(geom, mat);
    lineMesh.frustumCulled = false;
    // renderOrder 7: above QM current arrows (6), filaments (5), tints (1)
    lineMesh.renderOrder = 7;
    lineMesh.visible = false;
    _scene.add(lineMesh);
    return lineMesh;
  }

  // Color gradient over ply index: bright warm at ply 0, fading to
  // cool/dark at later plies. Hand-tuned for visibility against the
  // typical dark scene background. Returns [r, g, b] in [0, 1].
  function _plyColor(plyIdx, totalPlies) {
    // Normalize ply index to t ∈ [0, 1] where 0 = next move, 1 = last
    // ply in PV. Total plies <= MAX_PV_PLIES; we want ply 0 saturated.
    const denom = Math.max(1, totalPlies - 1);
    const t = Math.min(1, plyIdx / denom);
    // Warm-to-cool ramp: yellow (1, 1, 0.2) → orange (1, 0.5, 0) →
    // red (0.9, 0.1, 0.1) → purple (0.5, 0.1, 0.5) → blue (0.1, 0.1, 0.6)
    if (t < 0.25) {
      const u = t / 0.25;
      return [1.0, 1.0 - u * 0.5, 0.2 - u * 0.2];          // yellow → orange
    } else if (t < 0.5) {
      const u = (t - 0.25) / 0.25;
      return [1.0 - u * 0.1, 0.5 - u * 0.4, u * 0.1];      // orange → red
    } else if (t < 0.75) {
      const u = (t - 0.5) / 0.25;
      return [0.9 - u * 0.4, 0.1, 0.1 + u * 0.4];           // red → purple
    } else {
      const u = (t - 0.75) / 0.25;
      return [0.5 - u * 0.4, 0.1, 0.5 + u * 0.1];           // purple → blue
    }
  }

  function _render() {
    if (!lineMesh || !_gameBoard || !_gameBoard.graphics) return;
    if (!enabled || !_currentPv || _currentPv.length === 0) {
      lineMesh.geometry.setDrawRange(0, 0);
      lineMesh.visible = false;
      if (typeof window !== 'undefined') window.__GAME_DIRTY__ = true;
      return;
    }
    const gfx = _gameBoard.graphics;
    const positions = lineMesh.geometry.attributes.position.array;
    const colors    = lineMesh.geometry.attributes.color.array;
    const n = Math.min(MAX_PV_PLIES, _currentPv.length);
    for (let i = 0; i < n; i++) {
      const move = _currentPv[i];
      if (!move || !move.from || !move.to) continue;
      const f = move.from, t = move.to;
      let world_f, world_t;
      try {
        world_f = gfx.boardCoordinates(f.x | 0, f.y | 0, f.z | 0, f.w | 0);
        world_t = gfx.boardCoordinates(t.x | 0, t.y | 0, t.z | 0, t.w | 0);
      } catch (e) { continue; }
      const o = i * 6;
      positions[o + 0] = world_f.x;
      positions[o + 1] = world_f.y + ELEVATION;
      positions[o + 2] = world_f.z;
      positions[o + 3] = world_t.x;
      positions[o + 4] = world_t.y + ELEVATION;
      positions[o + 5] = world_t.z;
      const c = _plyColor(i, n);
      // Both endpoints same color — keeps the line readable as a single
      // ply. (We could fade along the line but that confuses temporal
      // reading vs spatial direction.)
      colors[o + 0] = c[0]; colors[o + 1] = c[1]; colors[o + 2] = c[2];
      colors[o + 3] = c[0]; colors[o + 4] = c[1]; colors[o + 5] = c[2];
    }
    lineMesh.geometry.attributes.position.needsUpdate = true;
    lineMesh.geometry.attributes.color.needsUpdate = true;
    lineMesh.geometry.setDrawRange(0, n * 2);
    lineMesh.visible = true;
    if (typeof window !== 'undefined') window.__GAME_DIRTY__ = true;
    console.log(`[m14.5/pv] rendered ${n} plies (team=${_currentTeam === 0 ? 'white' : 'black'})`);
  }

  window.SpectralPV = {
    init(scene, gameBoard) {
      if (_initRequested) return;
      _initRequested = true;
      _scene = scene;
      _gameBoard = gameBoard;
      _ensureMesh();
      try {
        const flag = new URLSearchParams(location.search).get('pv');
        if (flag === '1' || flag === 'on') {
          enabled = true;
        }
      } catch (_) { /* no window */ }
    },
    setEnabled(en) {
      if (enabled === en) return;
      enabled = en;
      _render();
    },
    /**
     * Show the engine's principal variation. pv format matches what
     * bridge.getBestMove returns: array of {from, to} where each is
     * {x, y, z, w}. team is 0=white, 1=black (informational, used in
     * the console log; visual encoding is by ply order, not team).
     */
    show(pv, team) {
      if (!Array.isArray(pv)) return;
      _currentPv = pv;
      _currentTeam = team | 0;
      if (enabled) _render();
    },
    /**
     * Clear the displayed PV. Called by GameBoard.move() after a move
     * commits (the previously-shown ply 0 is now history, not preview).
     */
    clear() {
      _currentPv = null;
      if (lineMesh) {
        lineMesh.geometry.setDrawRange(0, 0);
        lineMesh.visible = false;
      }
      if (typeof window !== 'undefined') window.__GAME_DIRTY__ = true;
    },
    isEnabled() { return enabled; },
  };
})();
