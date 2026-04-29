// spectral_color.js — M11.23 SSOT for spectral colormaps + percentile clipping.
//
// Why this exists: the same viridis ramp, RdBu ramp, and percentile-bounds
// helper were copy-pasted across four modules (spectral_heatmap.js,
// spectral_board_tint.js, spectral_dotplot.js, and an inline ramp in
// spectral_overlay.js). The dot-plot file even left a TODO comment about
// factoring this out: "Future: factor to a tiny `spectral_colors.js` if
// we add a third copy." We now have four copies. This module is that
// extraction. Modules use `window.SpectralColor.{viridisColor,rdBuColor,
// percentileBounds}` rather than importing — script-mode load order
// (no bundler) makes IIFE-on-window the natural pattern in this codebase.
//
// Function signatures match the existing duplicates verbatim:
//   viridisColor(t)    : t ∈ [0,1] → [r, g, b] each in [0,1]
//   rdBuColor(t)       : t ∈ [0,1] → [r, g, b] each in [0,1] (t=0.5 neutral)
//   percentileBounds(arr, lo=0.05, hi=0.95) → [pLo, pHi]
//
// Notes:
// - The viridis ramp is hand-tuned (not Matplotlib-exact) but reads cleanly
//   on the dark scene background — picked by eye to give dark-blue → cyan
//   → green → yellow → red. Don't "fix" it to match Matplotlib without
//   updating all four call sites and re-checking the screenshot tests.
// - Float32Array.sort() is numeric by default, so percentileBounds doesn't
//   need a comparator.
// - This module is render-only utility, no side effects on load.

(function () {
  'use strict';

  // Unipolar viridis-ish ramp (0..1 → blue → cyan → green → yellow → red).
  function viridisColor(t) {
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

  // Diverging RdBu-style ramp for signed values; t=0.5 is neutral white.
  function rdBuColor(t) {
    if (t < 0.5) {
      const u = t * 2;                 // blue → white
      return [0.20 + u * 0.80, 0.30 + u * 0.70, 0.65 + u * 0.35];
    } else {
      const u = (t - 0.5) * 2;         // white → red
      return [1.00 - u * 0.20, 1.00 - u * 0.80, 1.00 - u * 0.85];
    }
  }

  // Robust percentile-clip bounds. Default 5/95 percentiles are robust to
  // single-cell outliers, which matters because spectral channels routinely
  // have one or two cells orders of magnitude above the bulk distribution.
  function percentileBounds(arr, lo, hi) {
    if (lo === undefined) lo = 0.05;
    if (hi === undefined) hi = 0.95;
    const sorted = new Float32Array(arr).sort();
    const n = sorted.length;
    return [sorted[Math.floor(lo * n)], sorted[Math.min(n - 1, Math.floor(hi * n))]];
  }

  if (typeof window !== 'undefined') {
    window.SpectralColor = { viridisColor, rdBuColor, percentileBounds };
  }
})();
