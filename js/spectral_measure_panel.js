// spectral_measure_panel.js — M14.4, Born-rule projective measurement UX.
//
// Surfaces chess-spectral 1.5's measure_at as a small DOM panel. The user
// inputs a lattice cell (x,y,z,w) and clicks "Measure"; the bridge calls
// qm_4d_bridge.measure_at(state, coords=(x,y,z,w)) which performs a
// position-projective measurement: returns the sampled outcome cell, the
// Born-rule probability of that outcome, and the post-collapse Float32
// ψ_post (90,112 length, real+imag interleaved).
//
// What the user sees: typed coord → "Measured cell (x,y,z,w). P = 0.0331".
// The probability tells you how much of the QM state's mass is concentrated
// at that cell — high P means "the wavefunction is strongly localized
// here", low P means "this cell is mostly empty in the QM lift".
//
// v1 scope: panel-driven input only. The post-collapse ψ is acquired but
// not yet routed back into the QM viz layers (M14.1 density tint, M14.2
// current arrows still source from the natural state-derived ψ). M14.4b
// will (a) add Shift+click on the 3D scene via the existing raycaster, and
// (b) optionally route postCollapsePsi into the viz layers as a
// "post-measurement" mode.
//
// API:
//   SpectralMeasurePanel.init()
//   SpectralMeasurePanel.setEnabled(bool)
//   SpectralMeasurePanel.measure(x, y, z, w)   — programmatic entry point
//   SpectralMeasurePanel.isEnabled()

(function () {
  'use strict';

  let _enabled = false;
  let _initRequested = false;
  let _panel = null;
  let _statusEl = null;
  let _xEl = null, _yEl = null, _zEl = null, _wEl = null;
  let _btn = null;

  // Format helper: probability into a friendly string. Born-rule probs
  // for 4D QM range [0, 1] but typical values are 1e-5 to 1e-1.
  function _fmtProb(p) {
    if (!Number.isFinite(p)) return '?';
    if (p === 0) return '0';
    if (p < 1e-3) return p.toExponential(3);
    if (p < 0.01) return p.toFixed(4);
    if (p < 0.1)  return p.toFixed(3);
    return p.toFixed(2);
  }

  // Format helper: classify a probability into a magnitude band so the
  // user gets intuition without parsing scientific notation.
  function _probBand(p) {
    if (!Number.isFinite(p) || p <= 0) return 'zero';
    if (p < 1e-4) return 'very low';
    if (p < 1e-2) return 'low';
    if (p < 0.05) return 'modest';
    if (p < 0.20) return 'high';
    return 'very high';
  }

  function _setStatus(text, kind) {
    if (!_statusEl) return;
    _statusEl.textContent = text;
    _statusEl.style.color =
      kind === 'error' ? '#dc7f7f' :
      kind === 'ok'    ? '#7fdc7f' :
                         '#aaa';
  }

  async function measure(x, y, z, w) {
    if (typeof window === 'undefined' || !window.SpectralBridge ||
        typeof window.SpectralBridge.measureAt !== 'function') {
      _setStatus('(bridge.measureAt unavailable)', 'error');
      return null;
    }
    // Clamp to 0..7 (the lattice bounds) so the user can't crash the bridge.
    const cx = Math.max(0, Math.min(7, x | 0));
    const cy = Math.max(0, Math.min(7, y | 0));
    const cz = Math.max(0, Math.min(7, z | 0));
    const cw = Math.max(0, Math.min(7, w | 0));
    _setStatus(`Measuring at (${cx},${cy},${cz},${cw})…`, 'pending');
    try {
      const r = await window.SpectralBridge.measureAt({
        x: cx, y: cy, z: cz, w: cw,
      });
      if (!r || !r.ok) {
        _setStatus(`Measurement failed: ${r && r.error ? r.error : '?'}`, 'error');
        return null;
      }
      const p = r.probability;
      const band = _probBand(p);
      // sampledOutcome is an int sq index — decode to coords for display.
      const out = (typeof r.sampledOutcome === 'number') ? r.sampledOutcome : -1;
      const ox = (out >> 9) & 7, oy = (out >> 6) & 7, oz = (out >> 3) & 7, ow = out & 7;
      const psiLen = (r.postCollapsePsi && r.postCollapsePsi.length) || 0;
      _setStatus(
        `(${cx},${cy},${cz},${cw}) → outcome (${ox},${oy},${oz},${ow}); ` +
        `P = ${_fmtProb(p)} (${band}); ψ_post len=${psiLen}`,
        'ok'
      );
      console.log(
        `[m14.4/measure] coord=(${cx},${cy},${cz},${cw}) ` +
        `outcome=(${ox},${oy},${oz},${ow}) P=${p.toExponential(4)} ` +
        `psi_post=Float32Array(${psiLen})`
      );
      return r;
    } catch (err) {
      _setStatus(`Measurement threw: ${err && err.message ? err.message : err}`, 'error');
      return null;
    }
  }

  window.SpectralMeasurePanel = {
    init() {
      if (_initRequested) return;
      _initRequested = true;
      _panel = document.getElementById('measure-panel');
      _statusEl = document.getElementById('measure-status');
      _xEl = document.getElementById('measure-x');
      _yEl = document.getElementById('measure-y');
      _zEl = document.getElementById('measure-z');
      _wEl = document.getElementById('measure-w');
      _btn = document.getElementById('measure-btn');
      if (!_panel) return;
      _panel.style.display = _enabled ? '' : 'none';
      if (_btn) {
        _btn.addEventListener('click', function () {
          const x = parseInt(_xEl ? _xEl.value : '0', 10) || 0;
          const y = parseInt(_yEl ? _yEl.value : '0', 10) || 0;
          const z = parseInt(_zEl ? _zEl.value : '0', 10) || 0;
          const w = parseInt(_wEl ? _wEl.value : '0', 10) || 0;
          measure(x, y, z, w);
        });
      }
    },
    setEnabled(en) {
      if (_enabled === en) return;
      _enabled = en;
      if (_panel) _panel.style.display = en ? '' : 'none';
    },
    measure,
    isEnabled() { return _enabled; },
  };
})();
