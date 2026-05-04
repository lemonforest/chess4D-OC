// spectral_sheet_panel.js — M19.1, chess-spectral 1.9.0 SheetState panel.
//
// Surfaces the non-Markovian position context that the base 45056-dim
// encoder cannot distinguish: castling rights (4 bools), en-passant
// target, side-to-move, halfmove clock, fullmove number, repetition count.
//
// Why this matters: two positions with identical piece placement but different
// castling rights (e.g., you've moved your rook and back) are functionally
// DIFFERENT chess positions — White has lost kingside castling rights — but
// the base spectral encoder maps them to the SAME 45056-dim vector. With
// ?useSheets=1, encode_4d(pos4, sheets=SheetState) → 45067-dim, and those
// positions now have DIFFERENT spectral signatures.
//
// This is "representation completeness" per the §19 formulation: the full
// position vector is the chess state, not just the board snapshot.
//
// Future (bit-serialized resonant HDC instrument, ALU-only): the 11-dim
// sheet aux block will be bundled into the hypervector at the same layer
// as the base 45056-dim encoding. No changes needed here — ENCODING_DIM
// will update and the panel will reflect the new dimension automatically.
//
// API:
//   SpectralSheetPanel.init()
//   SpectralSheetPanel.setEnabled(bool)
//   SpectralSheetPanel.refresh()    — called after each move
//   SpectralSheetPanel.isEnabled()
//
// The ?useSheets=1 URL flag routes bridge.getBoardEncoding through
// getBoardEncodingWithSheets, making the 45067-dim encoding active for
// all viz modules that use getBoardEncoding (heatmap, board tint, filaments).

(function () {
  'use strict';

  let enabled = false;
  let _initRequested = false;

  // DOM refs (bound in init())
  let _panel = null;
  let _castlingEl = null;
  let _epEl = null;
  let _halfmoveEl = null;
  let _repEl = null;
  let _encDimEl = null;
  let _dimNoteEl = null;

  // Cached encoding dim from the bridge (fetched once at init).
  let _encDimBase = 45056;
  let _encDimWithSheets = 45067;

  function _fmtCastling(c) {
    if (!c || typeof c !== 'object') return '—';
    const rights = [];
    if (c.white_kingside)  rights.push('WK');
    if (c.white_queenside) rights.push('WQ');
    if (c.black_kingside)  rights.push('BK');
    if (c.black_queenside) rights.push('BQ');
    return rights.length ? rights.join(' ') : 'none';
  }

  function _fmtEp(ep) {
    if (ep === null || ep === undefined) return '—';
    if (ep === 0 || ep === false) return '—';
    return String(ep);
  }

  // DOM refs for BIP draw-predicates (added in M20 — SheetStateBIP 1.10.0)
  let _drawStatusEl = null;

  function _fmtDrawStatus(r) {
    // SheetStateBIP predicates: castling_alive, ep_target_active,
    // fifty_move_rule_triggered, threefold_claimable.
    if (r.type !== 'bip') return null;
    const parts = [];
    if (r.fifty_move_rule_triggered)  parts.push('⚠ 50-move');
    if (r.threefold_claimable)        parts.push('⚠ 3-fold');
    if (!r.castling_alive)            parts.push('no castling');
    if (r.ep_target_active)           parts.push('EP available');
    return parts.length ? parts.join(' · ') : 'no draw claims';
  }

  async function refresh() {
    if (!enabled || !_panel) return;
    if (typeof window === 'undefined' || !window.SpectralBridge ||
        typeof window.SpectralBridge.getSheetState !== 'function') return;
    if (!window.__SPECTRAL_INFO__) return; // bridge not ready

    try {
      const r = await window.SpectralBridge.getSheetState();
      if (!r || !r.ok) {
        console.warn('[m19.1/sheet-panel] getSheetState failed:', r && r.error);
        return;
      }

      // M20: SheetStateBIP branch (1.10.0 — compact, ALU-queryable predicates)
      if (r.type === 'bip') {
        if (_halfmoveEl) _halfmoveEl.textContent = String(r.halfmove_clock ?? '—');
        if (_castlingEl) _castlingEl.textContent = r.castling_alive ? 'available' : 'none';
        if (_epEl)       _epEl.textContent = r.ep_target_active ? 'yes' : 'none';
        if (_repEl)      _repEl.textContent = r.threefold_claimable ? '3-fold claimable' : '—';
        const drawStatus = _fmtDrawStatus(r);
        if (_drawStatusEl) _drawStatusEl.textContent = drawStatus || '';
        if (_drawStatusEl) _drawStatusEl.style.color = (r.fifty_move_rule_triggered || r.threefold_claimable) ? '#ffaa33' : '#7fdc7f';
      } else {
        // Float SheetState fallback (1.9.0)
        if (_castlingEl) _castlingEl.textContent = _fmtCastling(r.castling);
        if (_epEl)       _epEl.textContent = _fmtEp(r.en_passant);
        if (_halfmoveEl) {
          const hm = r.halfmove_clock;
          _halfmoveEl.textContent = (hm !== null && hm !== undefined) ? String(Math.round(hm)) : '—';
        }
        if (_repEl) {
          const rc = r.repetition_count;
          _repEl.textContent = (rc !== null && rc !== undefined) ? String(Math.round(rc)) : '—';
        }
        if (_drawStatusEl) _drawStatusEl.textContent = '';
      }

      // Encoding dim line
      const useSheets = window.__USE_SHEETS__;
      const activeDim = useSheets ? _encDimWithSheets : _encDimBase;
      if (_encDimEl) _encDimEl.textContent = String(activeDim);
      if (_dimNoteEl) {
        _dimNoteEl.textContent = useSheets
          ? `(sheets active — base ${_encDimBase} + 11)`
          : `(base — add ?useSheets=1 for ${_encDimWithSheets})`;
      }
    } catch (err) {
      console.warn('[m19.1/sheet-panel] refresh error:', err);
    }
  }

  window.SpectralSheetPanel = {
    init() {
      if (_initRequested) return;
      _initRequested = true;

      _panel        = document.getElementById('sheet-info-panel');
      _castlingEl   = document.getElementById('sheet-castling');
      _epEl         = document.getElementById('sheet-ep');
      _halfmoveEl   = document.getElementById('sheet-halfmove');
      _repEl        = document.getElementById('sheet-rep');
      _encDimEl     = document.getElementById('sheet-enc-dim');
      _dimNoteEl    = document.getElementById('sheet-dim-note');
      _drawStatusEl = document.getElementById('sheet-draw-status');

      if (!_panel) return;
      _panel.hidden = !enabled;

      // Wire the toggle checkbox (already in the DOM).
      const toggle = document.getElementById('sheet-panel-toggle');
      if (toggle) {
        const KEY = 'chess4d-oc.sheet-panel';
        try {
          const saved = localStorage.getItem(KEY);
          if (saved === 'true') { toggle.checked = true; this.setEnabled(true); }
        } catch (_) {}
        toggle.addEventListener('change', () => {
          this.setEnabled(toggle.checked);
          try { localStorage.setItem(KEY, toggle.checked); } catch (_) {}
        });
      }

      // Fetch encoding dimensions from the bridge once it's ready.
      if (window.SpectralBridge && typeof window.SpectralBridge.getEncodingDim === 'function') {
        window.SpectralBridge.getEncodingDim().then((r) => {
          if (r && r.ok !== false) {
            if (r.base)       _encDimBase       = r.base;
            if (r.withSheets) _encDimWithSheets = r.withSheets;
          }
        }).catch(() => {});
      }
    },

    setEnabled(en) {
      if (enabled === en) return;
      enabled = en;
      if (_panel) _panel.hidden = !en;
      if (en) refresh();
    },

    refresh,
    isEnabled() { return enabled; },
  };
})();
