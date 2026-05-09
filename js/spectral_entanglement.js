// spectral_entanglement.js — M14.3 entanglement viz layer.
//
// Calls bridge.getEntanglementMap() to get { piece_id, sq, char, team, purity,
// rank } for every piece, then paints a translucent halo around each piece
// colored by purity. tr(ρ²) ∈ [1/d, 1]:
//   purity = 1.0  → pure state (no entanglement)
//   purity → 1/d  → maximally mixed (highly entangled with the rest of ψ)
//
// Color ramp: high purity = cool green (independent), low purity = hot red
// (entangled). Hue lerps via HSL: 120° (green) → 0° (red).
//
// Gracefully degrades when chess-spectral hasn't shipped get_density_matrix_of:
// the bridge returns { implemented: false } and this module just hides itself
// with a console note. Auto-checks window.__SPECTRAL_CAPS__.density_matrix_
// implemented at init to skip the call entirely.
//
// API:
//   SpectralEntanglement.init(scene, gameBoard)
//   SpectralEntanglement.setEnabled(bool)
//   SpectralEntanglement.refresh()  — call after each move
//   SpectralEntanglement.isEnabled()

(function () {
  'use strict';

  let _scene = null;
  let _gameBoard = null;
  let _initRequested = false;
  let _enabled = false;

  // Per-piece halo InstancedMesh — sized to 4096 to cover any board state.
  // We compact to the actual piece count via .count each refresh.
  let im = null;

  function _purityColor(purity) {
    if (!Number.isFinite(purity)) return [0.5, 0.5, 0.5];
    // Clamp to [1/65536, 1] — extremely small purities (<1/d for d=65536
    // = max-mixed for a 16-bit Hilbert space) are effectively zero.
    const p = Math.max(1 / 65536, Math.min(1, purity));
    // Map [1/d, 1] log-style so most of the color range applies to the
    // entangled regime, not the boring near-pure tail.
    const t = Math.log(p * 65536) / Math.log(65536);  // ∈ [0, 1]
    // Hue lerp: 0 = red (entangled), 120 = green (pure)
    const hueDeg = 120 * t;
    return _hslToRgb(hueDeg / 360, 0.85, 0.55);
  }

  function _hslToRgb(h, s, l) {
    const a = s * Math.min(l, 1 - l);
    const f = (n) => {
      const k = (n + h * 12) % 12;
      return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    return [f(0), f(8), f(4)];
  }

  function _buildMesh() {
    if (im) return im;
    if (!_scene || !_gameBoard || !_gameBoard.graphics) return null;
    const gfx = _gameBoard.graphics;
    const square = gfx.squareSize || 50;
    // Translucent halo sphere, slightly larger than a piece so it forms
    // an aura. Drawn behind pieces so the piece mesh stays visible.
    const geom = new THREE.SphereGeometry(square * 0.5, 16, 12);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
    });
    im = new THREE.InstancedMesh(geom, mat, 4096);
    im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(4096 * 3), 3);
    im.frustumCulled = false;
    im.renderOrder = 4;
    im.count = 0;
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.instanceColor.setUsage(THREE.DynamicDrawUsage);
    im.visible = false;
    _scene.add(im);
    return im;
  }

  let _refreshRetries = 0;
  async function refresh() {
    if (!_enabled || !im) return;
    if (typeof window === 'undefined' || !window.SpectralBridge ||
        typeof window.SpectralBridge.getEntanglementMap !== 'function') return;
    if (!window.__SPECTRAL_INFO__) {
      if (_refreshRetries++ < 30) setTimeout(() => { refresh(); }, 200);
      return;
    }
    _refreshRetries = 0;

    // Capability gate: if upstream hasn't shipped the implementation,
    // log once and disable the layer.
    const caps = window.__SPECTRAL_CAPS__;
    if (caps && caps.density_matrix_implemented === false) {
      console.warn(
        '[m14.3/entanglement] get_density_matrix_of not implemented in chess-spectral '
        + (caps.chess_spectral_version || '?')
        + ' — entanglement viz disabled. Layer will activate when upstream ships it.'
      );
      _enabled = false;
      if (im) im.visible = false;
      const cb = document.getElementById('entanglement-toggle');
      if (cb) { cb.checked = false; cb.disabled = true; cb.title = 'Disabled — upstream hasn\'t shipped get_density_matrix_of yet'; }
      return;
    }

    try {
      const r = await window.SpectralBridge.getEntanglementMap();
      if (!r || !r.ok) {
        if (r && r.implemented === false) {
          console.warn('[m14.3/entanglement] upstream not implemented; disabling');
          _enabled = false;
          if (im) im.visible = false;
          return;
        }
        console.warn('[m14.3/entanglement] getEntanglementMap failed:', r && r.error);
        return;
      }
      const pieces = r.pieces || [];
      const gfx = _gameBoard.graphics;
      const matrix = new THREE.Matrix4();
      let slot = 0;
      for (const p of pieces) {
        if (slot >= 4096) break;
        const sq = p.sq;
        let pos;
        try {
          pos = gfx.boardCoordinates(sq.x, sq.y, sq.z, sq.w);
        } catch (_) {
          continue;
        }
        // Halo Y-offset slightly above the cell so it surrounds the piece.
        matrix.makeTranslation(pos.x, pos.y + 8, pos.z);
        im.setMatrixAt(slot, matrix);
        const [cr, cg, cb] = _purityColor(p.purity);
        im.instanceColor.setXYZ(slot, cr, cg, cb);
        slot++;
      }
      im.count = slot;
      im.instanceMatrix.needsUpdate = true;
      im.instanceColor.needsUpdate = true;
      im.visible = _enabled;
      if (typeof window !== 'undefined') window.__GAME_DIRTY__ = true;
      console.log(
        `[m14.3/entanglement] ${slot} pieces, purity=`
        + `[${(r.min_purity != null ? r.min_purity.toExponential(3) : '?')}, `
        + `${(r.max_purity != null ? r.max_purity.toExponential(3) : '?')}]`
      );
    } catch (err) {
      console.warn('[m14.3/entanglement] refresh error:', err);
    }
  }

  window.SpectralEntanglement = {
    init(scene, gameBoard) {
      if (_initRequested) return;
      _initRequested = true;
      _scene = scene;
      _gameBoard = gameBoard;
      _buildMesh();
      // URL flag: ?entanglement=1 enables on boot.
      try {
        const flag = new URLSearchParams(location.search).get('entanglement');
        if (flag === '1' || flag === 'on') {
          this.setEnabled(true);
        }
      } catch (_) { /* not in browser */ }
    },
    setEnabled(en) {
      if (_enabled === en) return;
      _enabled = en;
      if (im) im.visible = en;
      if (en) refresh();
      if (typeof window !== 'undefined') window.__GAME_DIRTY__ = true;
    },
    refresh,
    isEnabled() { return _enabled; },
    setStackScale(s) {
      if (!Number.isFinite(s) || s <= 0) return;
      if (im) im.scale.y = s;
      if (typeof window !== 'undefined') window.__GAME_DIRTY__ = true;
    },
  };
})();
