// topology4d.js — M11.2 Morse-Smale topology extraction on the 8^4 lattice.
//
// Replaces stride-seeded streamline integration ("seed everywhere, watch
// everything converge") with topology-driven seeding ("seed on the
// critical-point skeleton, render the 1-manifolds connecting them").
//
// Source: Hofmann, Rieck, Sadlo, "Visualization of 4D Vector Field
// Topology," EuroVis 2018 (https://bastian.rieck.me/research/EuroVis2018_4D.pdf).
// Adapted from vector-field topology to scalar-field Morse theory: where
// the paper uses ∇u (Jacobian of a vector field), we use the **Hessian
// H(φ)** of a scalar field at critical points of ∇φ.
//
// What we extract:
//   - Local maxima (peaks):    Hessian is negative-definite. All 4
//                              eigenvalues < 0. Descending manifolds
//                              flow OUT of the max along each eigenvector.
//   - Local minima (pits):     Hessian is positive-definite. All 4
//                              eigenvalues > 0. Ascending manifolds flow
//                              IN to the min along each eigenvector.
//   - Saddles (in-between):    Hessian is indefinite. Mixed signs of λ.
//                              Each eigenvector gives a 1-manifold;
//                              positive-λ → ascending, negative-λ →
//                              descending. Saddles are the connectors
//                              between max/min in the Morse-Smale complex.
//
// API:
//   Topology4D.findCriticalPoints(arr) → array of CriticalPoint
//
//   CriticalPoint = {
//     idx:     int           // lattice index x*512 + y*64 + z*8 + w
//     x,y,z,w: int           // unpacked lattice coords
//     type:    'max' | 'min' | 'saddle'
//     gradMag: number        // |∇φ| at the cell (for sanity checking)
//     eigvals: Float64Array  // 4 eigenvalues, ascending
//     eigvecs: Float64Array  // 4×4, eigenvectors as ROWS (eigvecs[i*4..(i+1)*4]
//                            //   = vector for eigvals[i])
//     index:   int           // Morse index (count of negative eigenvalues)
//   }
//
// Cost notes:
//   - Local-extremum detection: ~32k comparisons (already fast in M11.1).
//   - Saddle detection: a cell is a saddle candidate if |∇φ| is in the
//     lowest 1% of cells AND it isn't a local max/min. ~50 candidates
//     per channel typically.
//   - Hessian eigendecomp via Jacobi rotations on 4×4 symmetric matrices:
//     converges in ~10 sweeps × 6 (i,j) pairs = ~60 ops per critical
//     point. Negligible.
//
// On boundary cells: cells on the lattice boundary (x=0, x=7, etc.) have
// incomplete neighbor sets, so central differences and the Hessian aren't
// well-defined. We skip them — the resulting topology covers the
// 6×6×6×6 = 1296 interior cells. The full 8^4 lattice is small enough
// that boundary effects don't materially harm the visualization.

(function () {
  'use strict';

  const N = 8;
  const STRIDE_X = 512;
  const STRIDE_Y = 64;
  const STRIDE_Z = 8;
  const STRIDE_W = 1;

  function _idx(x, y, z, w) {
    return x * STRIDE_X + y * STRIDE_Y + z * STRIDE_Z + w * STRIDE_W;
  }
  function _idxToXYZW(i) {
    return [(i >> 9) & 7, (i >> 6) & 7, (i >> 3) & 7, i & 7];
  }

  // ---------- gradient (central differences, interior cells only) -----------
  // Returns [gx, gy, gz, gw] at integer lattice point (x,y,z,w). At a
  // boundary axis, the central difference reduces to a one-sided forward
  // or backward step. Always defined on the closed lattice.
  function _gradientAt(arr, x, y, z, w) {
    const i = _idx(x, y, z, w);
    let gx, gy, gz, gw;
    gx = (x === 0)   ? (arr[i + STRIDE_X] - arr[i])
       : (x === N-1) ? (arr[i] - arr[i - STRIDE_X])
                     : (arr[i + STRIDE_X] - arr[i - STRIDE_X]) * 0.5;
    gy = (y === 0)   ? (arr[i + STRIDE_Y] - arr[i])
       : (y === N-1) ? (arr[i] - arr[i - STRIDE_Y])
                     : (arr[i + STRIDE_Y] - arr[i - STRIDE_Y]) * 0.5;
    gz = (z === 0)   ? (arr[i + STRIDE_Z] - arr[i])
       : (z === N-1) ? (arr[i] - arr[i - STRIDE_Z])
                     : (arr[i + STRIDE_Z] - arr[i - STRIDE_Z]) * 0.5;
    gw = (w === 0)   ? (arr[i + STRIDE_W] - arr[i])
       : (w === N-1) ? (arr[i] - arr[i - STRIDE_W])
                     : (arr[i + STRIDE_W] - arr[i - STRIDE_W]) * 0.5;
    return [gx, gy, gz, gw];
  }

  // ---------- 4×4 symmetric Hessian via central differences ------------------
  // Returns Float64Array(16) row-major. Diagonal entries are 1D second
  // derivatives; off-diagonal are 2D mixed second derivatives.
  // Skips boundary cells (returns null) since the mixed-partial stencil
  // needs both neighbors in two directions.
  function _hessianAt(arr, x, y, z, w) {
    if (x < 1 || x > N - 2 || y < 1 || y > N - 2 ||
        z < 1 || z > N - 2 || w < 1 || w > N - 2) {
      return null;
    }
    const i = _idx(x, y, z, w);
    const phi = arr[i];
    // Diagonal: ∂²φ/∂x² ≈ φ[c+e] - 2φ[c] + φ[c-e]
    const Hxx = arr[i + STRIDE_X] - 2 * phi + arr[i - STRIDE_X];
    const Hyy = arr[i + STRIDE_Y] - 2 * phi + arr[i - STRIDE_Y];
    const Hzz = arr[i + STRIDE_Z] - 2 * phi + arr[i - STRIDE_Z];
    const Hww = arr[i + STRIDE_W] - 2 * phi + arr[i - STRIDE_W];
    // Mixed partial: ∂²φ/(∂x ∂y) ≈ ¼ (φ[c+ex+ey] - φ[c+ex-ey] - φ[c-ex+ey] + φ[c-ex-ey])
    function mixed(stride1, stride2) {
      return 0.25 * (
        arr[i + stride1 + stride2] -
        arr[i + stride1 - stride2] -
        arr[i - stride1 + stride2] +
        arr[i - stride1 - stride2]
      );
    }
    const Hxy = mixed(STRIDE_X, STRIDE_Y);
    const Hxz = mixed(STRIDE_X, STRIDE_Z);
    const Hxw = mixed(STRIDE_X, STRIDE_W);
    const Hyz = mixed(STRIDE_Y, STRIDE_Z);
    const Hyw = mixed(STRIDE_Y, STRIDE_W);
    const Hzw = mixed(STRIDE_Z, STRIDE_W);
    const H = new Float64Array(16);
    H[0]  = Hxx; H[1]  = Hxy; H[2]  = Hxz; H[3]  = Hxw;
    H[4]  = Hxy; H[5]  = Hyy; H[6]  = Hyz; H[7]  = Hyw;
    H[8]  = Hxz; H[9]  = Hyz; H[10] = Hzz; H[11] = Hzw;
    H[12] = Hxw; H[13] = Hyw; H[14] = Hzw; H[15] = Hww;
    return H;
  }

  // ---------- Jacobi eigendecomposition for 4×4 symmetric M ------------------
  // Standard cyclic-Jacobi rotations. Sweeps until off-diagonal Frobenius
  // norm is negligible. Returns { eigvals: Float64Array(4), eigvecs:
  // Float64Array(16) }, eigvals sorted ASCENDING. eigvecs[i*4..(i+1)*4] is
  // the eigenvector for eigvals[i].
  function _eigJacobi4x4(M_in) {
    const M = new Float64Array(M_in); // mutable working copy
    const V = new Float64Array(16);
    V[0] = V[5] = V[10] = V[15] = 1;  // identity
    const MAX_SWEEPS = 60;
    for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
      // Frobenius off-diagonal norm
      let off = 0;
      for (let i = 0; i < 4; i++) {
        for (let j = i + 1; j < 4; j++) {
          const v = M[i * 4 + j];
          off += 2 * v * v;
        }
      }
      if (off < 1e-24) break;
      // Sweep all (i, j) pairs
      for (let p = 0; p < 4; p++) {
        for (let q = p + 1; q < 4; q++) {
          const apq = M[p * 4 + q];
          if (Math.abs(apq) < 1e-14) continue;
          const app = M[p * 4 + p];
          const aqq = M[q * 4 + q];
          // Compute rotation angle (Givens rotation parameters)
          const theta = (aqq - app) / (2 * apq);
          let t;
          if (Math.abs(theta) > 1e16) {
            t = 1 / (2 * theta);
          } else {
            const sgn = theta >= 0 ? 1 : -1;
            t = sgn / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
          }
          const c = 1 / Math.sqrt(t * t + 1);
          const s = t * c;
          // Apply rotation to M (rows + cols p, q)
          const newApp = c * c * app - 2 * s * c * apq + s * s * aqq;
          const newAqq = s * s * app + 2 * s * c * apq + c * c * aqq;
          M[p * 4 + p] = newApp;
          M[q * 4 + q] = newAqq;
          M[p * 4 + q] = 0;
          M[q * 4 + p] = 0;
          for (let r = 0; r < 4; r++) {
            if (r === p || r === q) continue;
            const arp = M[r * 4 + p];
            const arq = M[r * 4 + q];
            M[r * 4 + p] = c * arp - s * arq;
            M[p * 4 + r] = M[r * 4 + p];
            M[r * 4 + q] = s * arp + c * arq;
            M[q * 4 + r] = M[r * 4 + q];
          }
          // Apply rotation to V (cols p, q)
          for (let r = 0; r < 4; r++) {
            const vrp = V[r * 4 + p];
            const vrq = V[r * 4 + q];
            V[r * 4 + p] = c * vrp - s * vrq;
            V[r * 4 + q] = s * vrp + c * vrq;
          }
        }
      }
    }
    // Extract diagonal as eigenvalues; sort with eigenvectors.
    const lambdas = [
      [M[0],  0],
      [M[5],  1],
      [M[10], 2],
      [M[15], 3],
    ];
    lambdas.sort((a, b) => a[0] - b[0]);
    const eigvals = new Float64Array(4);
    const eigvecs = new Float64Array(16);
    for (let i = 0; i < 4; i++) {
      const [lam, col] = lambdas[i];
      eigvals[i] = lam;
      // Eigenvector for column `col` of V → row i of eigvecs.
      eigvecs[i * 4 + 0] = V[0 * 4 + col];
      eigvecs[i * 4 + 1] = V[1 * 4 + col];
      eigvecs[i * 4 + 2] = V[2 * 4 + col];
      eigvecs[i * 4 + 3] = V[3 * 4 + col];
    }
    return { eigvals, eigvecs };
  }

  // ---------- local-extremum detection ---------------------------------------
  // A face-neighbor strict-greater (or strict-less) test. Boundary cells use
  // whatever neighbors exist; stricter than M11.1 in that we require at
  // least 4 valid neighbors (all 4 axes have at least one direction available).
  function _localExtrema(arr, mode) {
    // mode: 'max' or 'min'
    const out = [];
    const cmp = mode === 'max' ? (a, b) => a > b : (a, b) => a < b;
    for (let x = 0; x < N; x++) {
      for (let y = 0; y < N; y++) {
        for (let z = 0; z < N; z++) {
          for (let w = 0; w < N; w++) {
            const i = _idx(x, y, z, w);
            const v = arr[i];
            let isExt = true;
            if (x > 0     && !cmp(v, arr[i - STRIDE_X])) isExt = false;
            if (isExt && x < N - 1 && !cmp(v, arr[i + STRIDE_X])) isExt = false;
            if (isExt && y > 0     && !cmp(v, arr[i - STRIDE_Y])) isExt = false;
            if (isExt && y < N - 1 && !cmp(v, arr[i + STRIDE_Y])) isExt = false;
            if (isExt && z > 0     && !cmp(v, arr[i - STRIDE_Z])) isExt = false;
            if (isExt && z < N - 1 && !cmp(v, arr[i + STRIDE_Z])) isExt = false;
            if (isExt && w > 0     && !cmp(v, arr[i - STRIDE_W])) isExt = false;
            if (isExt && w < N - 1 && !cmp(v, arr[i + STRIDE_W])) isExt = false;
            if (isExt) out.push(i);
          }
        }
      }
    }
    return out;
  }

  // ---------- saddle detection -----------------------------------------------
  // We classify by the SIGN of the Hessian eigenvalues at the cell.
  // Local max: all 4 eigenvalues < 0
  // Local min: all 4 eigenvalues > 0
  // Saddle:    mixed signs.
  // We find saddles as cells with small |∇φ| that are NOT extrema and
  // whose Hessian has mixed-sign eigenvalues. The "small |∇φ|" filter
  // is approximate (∇φ is exactly zero only at exact critical points,
  // which generically don't fall on lattice integers); we accept
  // candidates with |∇φ| in the lowest few percent of cells.
  function _findSaddles(arr, extrema) {
    const extremaSet = new Set(extrema);
    // Compute gradient magnitudes for all interior cells.
    const gradMags = [];
    for (let x = 1; x < N - 1; x++) {
      for (let y = 1; y < N - 1; y++) {
        for (let z = 1; z < N - 1; z++) {
          for (let w = 1; w < N - 1; w++) {
            const i = _idx(x, y, z, w);
            if (extremaSet.has(i)) continue;
            const g = _gradientAt(arr, x, y, z, w);
            const m = Math.hypot(g[0], g[1], g[2], g[3]);
            gradMags.push([m, i, x, y, z, w]);
          }
        }
      }
    }
    // Sort by magnitude ascending and take bottom 5%.
    gradMags.sort((a, b) => a[0] - b[0]);
    const cutoff = Math.max(8, Math.floor(gradMags.length * 0.05));
    const candidates = gradMags.slice(0, cutoff);
    // Filter to cells whose Hessian has mixed-sign eigenvalues.
    const saddles = [];
    for (const [m, i, x, y, z, w] of candidates) {
      const H = _hessianAt(arr, x, y, z, w);
      if (!H) continue;
      const { eigvals, eigvecs } = _eigJacobi4x4(H);
      // Mixed signs?
      let hasPos = false, hasNeg = false;
      for (let k = 0; k < 4; k++) {
        if (eigvals[k] >  1e-12) hasPos = true;
        if (eigvals[k] < -1e-12) hasNeg = true;
      }
      if (hasPos && hasNeg) {
        saddles.push({ idx: i, x, y, z, w, type: 'saddle', gradMag: m, eigvals, eigvecs });
      }
    }
    return saddles;
  }

  // ---------- public API ------------------------------------------------------
  function findCriticalPoints(arr) {
    if (!arr || arr.length !== 4096) {
      console.warn('[topology4d] expected 4096-length array, got', arr && arr.length);
      return [];
    }
    const t0 = (typeof performance !== 'undefined') ? performance.now() : 0;
    const result = [];
    const maxima = _localExtrema(arr, 'max');
    const minima = _localExtrema(arr, 'min');
    for (const i of maxima) {
      const [x, y, z, w] = _idxToXYZW(i);
      const H = _hessianAt(arr, x, y, z, w);
      if (!H) continue;
      const { eigvals, eigvecs } = _eigJacobi4x4(H);
      // Morse index = number of negative eigenvalues; for a true max it's 4.
      let neg = 0;
      for (let k = 0; k < 4; k++) if (eigvals[k] < 0) neg++;
      const g = _gradientAt(arr, x, y, z, w);
      result.push({
        idx: i, x, y, z, w, type: 'max',
        gradMag: Math.hypot(g[0], g[1], g[2], g[3]),
        eigvals, eigvecs, index: neg,
      });
    }
    for (const i of minima) {
      const [x, y, z, w] = _idxToXYZW(i);
      const H = _hessianAt(arr, x, y, z, w);
      if (!H) continue;
      const { eigvals, eigvecs } = _eigJacobi4x4(H);
      let neg = 0;
      for (let k = 0; k < 4; k++) if (eigvals[k] < 0) neg++;
      const g = _gradientAt(arr, x, y, z, w);
      result.push({
        idx: i, x, y, z, w, type: 'min',
        gradMag: Math.hypot(g[0], g[1], g[2], g[3]),
        eigvals, eigvecs, index: neg,
      });
    }
    const extremaIdxs = result.map(c => c.idx);
    const saddles = _findSaddles(arr, extremaIdxs);
    for (const s of saddles) {
      let neg = 0;
      for (let k = 0; k < 4; k++) if (s.eigvals[k] < 0) neg++;
      s.index = neg;
      result.push(s);
    }
    const dt = (typeof performance !== 'undefined') ? (performance.now() - t0) : 0;
    console.log(
      `[topology4d] critical points: ${result.length} ` +
        `(maxima=${maxima.length}, minima=${minima.length}, saddles=${saddles.length}) ` +
        `in ${dt.toFixed(2)}ms`
    );
    return result;
  }

  window.Topology4D = {
    findCriticalPoints,
    // Exposed for testing only — internal helpers callers should not rely on.
    _hessianAt,
    _eigJacobi4x4,
    _gradientAt,
  };
})();
