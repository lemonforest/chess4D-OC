// spectral_eval_breakdown.js — M14.6, eval-breakdown debug bars.
//
// chess-spectral 1.6.1's evaluators return a `breakdown: Dict[str, float]`
// alongside the scalar `value` from `evaluate_breakdown(...)`:
//   - qm evaluator     → per-piece-name contributions (rook, bishop, etc.)
//   - spectral eval    → per-channel contributions (A1, STD4_X, FIB_SYM_*, ...)
//   - material eval    → no breakdown (scalar only)
//
// M14.6 renders the breakdown as horizontal stacked bars in a small DOM
// panel in the Bot Strategy card. Each component is one bar; bar length
// is proportional to |contribution| and color encodes sign (positive =
// green / advantage to side-to-move, negative = red / disadvantage).
//
// Why DOM bars not Three.js: the breakdown is a small set of named
// scalars (5-11 components), best read as text + bars rather than a
// 3D scene element. DOM is also cheaper to update.
//
// Refresh trigger: after each move (hooked from GameBoard.move). The
// active evaluator is configurable via the dropdown next to the panel.
//
// API:
//   SpectralEvalBreakdown.init()              — find DOM panel, wire selector
//   SpectralEvalBreakdown.setEnabled(bool)
//   SpectralEvalBreakdown.setEvaluator(name)  — 'material' | 'qm' | 'spectral'
//   SpectralEvalBreakdown.refresh()           — recompute + redraw bars
//   SpectralEvalBreakdown.isEnabled()

(function () {
  'use strict';

  let _enabled = false;
  let _evaluator = 'spectral'; // default — breakdown is richest here
  let _initRequested = false;
  let _panel = null;
  let _bodyEl = null;
  let _statusEl = null;

  function _normalizedColor(value, maxAbs) {
    // value > 0 = green (advantage to side-to-move)
    // value < 0 = red
    const t = Math.max(-1, Math.min(1, value / Math.max(1e-9, maxAbs)));
    if (t >= 0) {
      // Green ramp: light green → saturated green
      const g = 0.4 + t * 0.5;
      return `rgb(${Math.round(40 + (1 - t) * 80)}, ${Math.round(g * 255)}, ${Math.round(40 + (1 - t) * 60)})`;
    } else {
      // Red ramp: light red → saturated red
      const u = -t;
      const r = 0.5 + u * 0.45;
      return `rgb(${Math.round(r * 255)}, ${Math.round(50 + (1 - u) * 60)}, ${Math.round(50 + (1 - u) * 60)})`;
    }
  }

  function _drawBars(value, breakdown) {
    if (!_bodyEl) return;
    _bodyEl.innerHTML = '';
    if (!breakdown || typeof breakdown !== 'object') {
      const note = document.createElement('p');
      note.className = 'spectral-hint';
      note.style.fontSize = '0.85em';
      note.textContent = '(no breakdown for material eval; switch to qm or spectral)';
      _bodyEl.appendChild(note);
      return;
    }
    const entries = Object.entries(breakdown).map(([k, v]) => [k, +v || 0]);
    if (entries.length === 0) {
      const note = document.createElement('p');
      note.className = 'spectral-hint';
      note.style.fontSize = '0.85em';
      note.textContent = '(empty breakdown)';
      _bodyEl.appendChild(note);
      return;
    }
    // Sort by absolute magnitude descending so the dominant contributors
    // are at top of the list.
    entries.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    const maxAbs = Math.max(...entries.map((e) => Math.abs(e[1])));
    for (const [name, val] of entries) {
      const row = document.createElement('div');
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = '6px';
      row.style.marginBottom = '2px';
      row.style.fontSize = '0.78em';
      row.style.fontFamily = 'monospace';

      const label = document.createElement('span');
      label.textContent = name;
      label.style.minWidth = '70px';
      label.style.flexShrink = '0';
      row.appendChild(label);

      const barWrap = document.createElement('div');
      barWrap.style.flex = '1';
      barWrap.style.background = '#1a1a1a';
      barWrap.style.height = '10px';
      barWrap.style.position = 'relative';
      barWrap.style.borderRadius = '2px';

      const bar = document.createElement('div');
      const widthPct = (Math.abs(val) / Math.max(1e-9, maxAbs)) * 100;
      bar.style.width = `${widthPct}%`;
      bar.style.height = '100%';
      bar.style.background = _normalizedColor(val, maxAbs);
      bar.style.borderRadius = '2px';
      barWrap.appendChild(bar);
      row.appendChild(barWrap);

      const num = document.createElement('span');
      num.textContent = val >= 0 ? `+${val.toFixed(2)}` : val.toFixed(2);
      num.style.minWidth = '52px';
      num.style.textAlign = 'right';
      num.style.color = val >= 0 ? '#7fdc7f' : '#dc7f7f';
      row.appendChild(num);

      _bodyEl.appendChild(row);
    }
  }

  let _refreshRetries = 0;
  async function refresh() {
    if (!_enabled || !_panel) return;
    if (typeof window === 'undefined' || !window.SpectralBridge) return;
    if (typeof window.SpectralBridge.evaluatePosition !== 'function') {
      if (_statusEl) _statusEl.textContent = '(bridge.evaluatePosition unavailable)';
      return;
    }
    if (!window.__SPECTRAL_INFO__) {
      if (_refreshRetries < 30) {
        _refreshRetries++;
        setTimeout(() => { refresh(); }, 200);
      }
      return;
    }
    _refreshRetries = 0;
    try {
      const r = await window.SpectralBridge.evaluatePosition({ evaluator: _evaluator });
      if (!r || !r.ok) {
        if (_statusEl) _statusEl.textContent = `(eval failed: ${r && r.error ? r.error : '?'})`;
        return;
      }
      if (_statusEl) {
        const v = (r.value != null) ? r.value : 0;
        _statusEl.textContent =
          `${r.evaluator}  total=${v >= 0 ? '+' : ''}${v.toFixed(3)}` +
          (r.breakdown ? ` (${Object.keys(r.breakdown).length} components)` : '');
      }
      _drawBars(r.value, r.breakdown);
    } catch (err) {
      console.warn('[m14.6/eval-breakdown] refresh error:', err);
    }
  }

  window.SpectralEvalBreakdown = {
    init() {
      if (_initRequested) return;
      _initRequested = true;
      _panel = document.getElementById('eval-breakdown-panel');
      _bodyEl = document.getElementById('eval-breakdown-bars');
      _statusEl = document.getElementById('eval-breakdown-status');
      if (!_panel) return;
      // Default visibility: hidden until the checkbox flips it on.
      _panel.style.display = _enabled ? '' : 'none';
    },
    setEnabled(en) {
      if (_enabled === en) return;
      _enabled = en;
      if (_panel) _panel.style.display = en ? '' : 'none';
      if (en) refresh();
    },
    setEvaluator(name) {
      if (typeof name !== 'string' || name === _evaluator) return;
      if (!['material', 'qm', 'spectral'].includes(name)) return;
      _evaluator = name;
      if (_enabled) refresh();
    },
    refresh,
    isEnabled() { return _enabled; },
    getEvaluator() { return _evaluator; },
  };
})();
