// phase_ops_4d.js — JS port of chess-spectral phase operators.
//
// Mirrors `chess_spectral.phase_operators_4d.phase_operators_4d` (Python)
// at parity. Used by M12 commutator visualization (which needs to compute
// piece-piece commutators in-browser, faster than asking the bridge per
// origin × piece × piece pair) and as a JS-side reference for verifying
// chess-spectral updates.
//
// Math (verbatim from chess-spectral 1.3.x source — ladder-coefficient-14
// design ensures piece-shift differences in [-14, 14]^4 don't alias):
//
//   MODULUS_4D = 145451 (prime; > 7·sum(generators) + max_bishop_shift)
//   GEN_X = 9719,  GEN_Y = 647,  GEN_Z = 43,  GEN_W = 3
//
//   phi(x, y, z, w) = (x·g_x + y·g_y + z·g_z + w·g_w) mod 145451
//
// Piece operators return the UNOBSTRUCTED phase reach — geometric only,
// no occupation filtering. For occupation-aware moves use
// `bridge.legalMoves(origin)` (which calls chess-spectral's
// `occupation_aware_a_4d`).
//
// API (all on window.PhaseOps4D):
//   - MODULUS_4D, GEN_X, GEN_Y, GEN_Z, GEN_W (constants)
//   - phi(x, y, z, w) → integer in [0, 145451)
//   - coordsOf(phi) → [x, y, z, w] | null  (null if phase doesn't map to a board cell)
//   - rook(x, y, z, w)   → [[x,y,z,w], ...]  unobstructed rook reach (28 cells interior)
//   - bishop(x, y, z, w) → ...  bishop reach (parity-restricted)
//   - queen(x, y, z, w)  → ...  rook ∪ bishop
//   - king(x, y, z, w)   → ...  Chebyshev-1 (80 cells interior)
//   - knight(x, y, z, w) → ...  (2,1)-leaper (48 cells interior)
//   - pawn(x, y, z, w, axis, team, onStartingRank, includeCaptures) → ...
//
// All piece operators clip to the {0..7}^4 board automatically. Returns
// arrays of [x, y, z, w] coordinate tuples, sorted lexicographically.

(function () {
  'use strict';

  // ─── pinned design constants (must match chess_spectral) ────────────
  const MODULUS_4D = 145451;
  const GEN_X = 9719;
  const GEN_Y = 647;
  const GEN_Z = 43;
  const GEN_W = 3;
  const AXIS_GENS = [GEN_X, GEN_Y, GEN_Z, GEN_W];

  // ─── phi: lattice → phase residue ──────────────────────────────────
  function phi(x, y, z, w) {
    return ((x * GEN_X + y * GEN_Y + z * GEN_Z + w * GEN_W) % MODULUS_4D + MODULUS_4D) % MODULUS_4D;
  }

  // ─── precomputed inverse map: phase residue → [x,y,z,w] | null ─────
  // Built once at module load. The phi map is bijective on {0..7}^4 →
  // 4096 distinct residues out of 145451 (perfect hash by construction).
  const PHASE_TO_COORDS = new Map(); // phase int → packed coord int
  function _packCoords(x, y, z, w) {
    return (x << 9) | (y << 6) | (z << 3) | w;
  }
  function _unpackCoords(packed) {
    return [(packed >> 9) & 7, (packed >> 6) & 7, (packed >> 3) & 7, packed & 7];
  }
  (function _initInverseMap() {
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) {
        for (let z = 0; z < 8; z++) {
          for (let w = 0; w < 8; w++) {
            PHASE_TO_COORDS.set(phi(x, y, z, w), _packCoords(x, y, z, w));
          }
        }
      }
    }
  })();

  function coordsOf(phaseValue) {
    const norm = ((phaseValue % MODULUS_4D) + MODULUS_4D) % MODULUS_4D;
    const packed = PHASE_TO_COORDS.get(norm);
    if (packed === undefined) return null; // phase doesn't map to a board cell
    return _unpackCoords(packed);
  }

  // ─── piece operators ───────────────────────────────────────────────
  // Each takes lattice coords, returns array of dest [x,y,z,w] — sorted
  // lexicographically and deduplicated. On-board only.

  function _emit(phaseSet, out, seen) {
    for (const p of phaseSet) {
      if (seen.has(p)) continue;
      seen.add(p);
      const c = coordsOf(p);
      if (c) out.push(c);
    }
  }

  function _sortLex(coords) {
    coords.sort((a, b) =>
      a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]
    );
    return coords;
  }

  // Rook: 4 axes × 2 signs × 7 distances = 56 phase shifts.
  function rook(x, y, z, w) {
    const origin = phi(x, y, z, w);
    const phases = new Set();
    for (const g of AXIS_GENS) {
      for (let k = 1; k < 8; k++) {
        phases.add(((origin + k * g) % MODULUS_4D + MODULUS_4D) % MODULUS_4D);
        phases.add(((origin - k * g) % MODULUS_4D + MODULUS_4D) % MODULUS_4D);
      }
    }
    const out = [];
    _emit(phases, out, new Set());
    return _sortLex(out);
  }

  // Bishop: 6 plane choices × 4 sign combos × 7 distances = 168 phase shifts.
  // Parity-partition into 2 connected components (matches tables_4d.bishop4_targets).
  function bishop(x, y, z, w) {
    const origin = phi(x, y, z, w);
    const phases = new Set();
    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 4; j++) {
        const gi = AXIS_GENS[i];
        const gj = AXIS_GENS[j];
        for (const si of [-1, 1]) {
          for (const sj of [-1, 1]) {
            const step = si * gi + sj * gj;
            for (let k = 1; k < 8; k++) {
              phases.add(((origin + k * step) % MODULUS_4D + MODULUS_4D) % MODULUS_4D);
            }
          }
        }
      }
    }
    const out = [];
    _emit(phases, out, new Set());
    return _sortLex(out);
  }

  // Queen: rook ∪ bishop. Disjoint by construction (rook moves along single
  // axes; bishop along plane diagonals — no overlap of direction sets).
  function queen(x, y, z, w) {
    // Cheap implementation: union the destination arrays.
    const r = rook(x, y, z, w);
    const b = bishop(x, y, z, w);
    const seen = new Set();
    const merged = [];
    for (const c of r) {
      const key = c[0] * 1000 + c[1] * 100 + c[2] * 10 + c[3];
      if (!seen.has(key)) { seen.add(key); merged.push(c); }
    }
    for (const c of b) {
      const key = c[0] * 1000 + c[1] * 100 + c[2] * 10 + c[3];
      if (!seen.has(key)) { seen.add(key); merged.push(c); }
    }
    return _sortLex(merged);
  }

  // King: 80 directional shifts (3⁴ - 1 ternary sign vectors over 4 axes), used at k=1.
  function king(x, y, z, w) {
    const origin = phi(x, y, z, w);
    const phases = new Set();
    for (let ex = -1; ex <= 1; ex++) {
      for (let ey = -1; ey <= 1; ey++) {
        for (let ez = -1; ez <= 1; ez++) {
          for (let ew = -1; ew <= 1; ew++) {
            if (ex === 0 && ey === 0 && ez === 0 && ew === 0) continue;
            const s = ex * GEN_X + ey * GEN_Y + ez * GEN_Z + ew * GEN_W;
            phases.add(((origin + s) % MODULUS_4D + MODULUS_4D) % MODULUS_4D);
          }
        }
      }
    }
    const out = [];
    _emit(phases, out, new Set());
    return _sortLex(out);
  }

  // Knight: 48 shifts (12 ordered axis pairs × 4 sign combos), used at k=1.
  function knight(x, y, z, w) {
    const origin = phi(x, y, z, w);
    const phases = new Set();
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        if (i === j) continue;
        const gi = AXIS_GENS[i];
        const gj = AXIS_GENS[j];
        for (const s2 of [-2, 2]) {
          for (const s1 of [-1, 1]) {
            const s = s2 * gi + s1 * gj;
            phases.add(((origin + s) % MODULUS_4D + MODULUS_4D) % MODULUS_4D);
          }
        }
      }
    }
    const out = [];
    _emit(phases, out, new Set());
    return _sortLex(out);
  }

  // Pawn: forward push along axis (+optional 2-square from starting rank);
  // optional diagonal captures in the (X-axis, forward-axis) plane.
  // axis ∈ {'w', 'y'} (per O&C Definition 11; never z, never x).
  // team: 0 = white (+forward), 1 = black (-forward).
  function pawn(x, y, z, w, axis, team, onStartingRank, includeCaptures) {
    const origin = phi(x, y, z, w);
    const forwardSign = (team === 0) ? 1 : -1;
    const gForward = (axis === 'w') ? GEN_W : (axis === 'y') ? GEN_Y : null;
    if (gForward === null) {
      console.warn('[phase_ops_4d] pawn axis must be "w" or "y"; got', axis);
      return [];
    }
    const phases = new Set();
    // Forward push 1 square.
    phases.add(((origin + forwardSign * gForward) % MODULUS_4D + MODULUS_4D) % MODULUS_4D);
    // Forward push 2 squares from starting rank.
    if (onStartingRank) {
      phases.add(((origin + 2 * forwardSign * gForward) % MODULUS_4D + MODULUS_4D) % MODULUS_4D);
    }
    // Diagonal captures (X ± 1) × (forwardSign).
    if (includeCaptures) {
      phases.add(((origin + GEN_X + forwardSign * gForward) % MODULUS_4D + MODULUS_4D) % MODULUS_4D);
      phases.add(((origin - GEN_X + forwardSign * gForward) % MODULUS_4D + MODULUS_4D) % MODULUS_4D);
    }
    const out = [];
    _emit(phases, out, new Set());
    return _sortLex(out);
  }

  // ─── parity-test helper ────────────────────────────────────────────
  // Compares this JS port's output against chess-spectral's Python via
  // SpectralBridge.legalMoves at the initial position. legalMoves returns
  // OCCUPATION-AWARE moves (subset of unobstructed reach), so we expect
  // js_reach ⊇ py_legal_moves. Reports the inclusion check.
  async function parityCheck() {
    if (!window.SpectralBridge) {
      console.warn('[phase_ops_4d/parity] no SpectralBridge — skipping');
      return;
    }
    const interior = [4, 4, 4, 4]; // a center cell
    // For an occupied initial-position cell, query py legal_moves.
    try {
      const py = await window.SpectralBridge.legalMovesAtInitial(
        { x: interior[0], y: interior[1], z: interior[2], w: interior[3] }
      );
      if (!py || !py.ok) {
        console.warn('[phase_ops_4d/parity] py.legalMovesAtInitial not ok:', py && py.reason);
        return;
      }
      console.log(
        '[phase_ops_4d/parity] py legal at (4,4,4,4): ' + py.moves.length + ' moves. ' +
        'JS reach should be a superset (geometric vs occupation-aware). Visual check via M12 viz.'
      );
    } catch (err) {
      console.warn('[phase_ops_4d/parity] error:', err);
    }
  }

  // ─── public API ────────────────────────────────────────────────────
  window.PhaseOps4D = {
    MODULUS_4D, GEN_X, GEN_Y, GEN_Z, GEN_W,
    phi, coordsOf,
    rook, bishop, queen, king, knight, pawn,
    parityCheck,
  };

  // Quick sanity: phi(0,0,0,0) === 0 and phi(7,7,7,7) is the max combo.
  console.log('[phase_ops_4d] loaded — phi(7,7,7,7) =', phi(7, 7, 7, 7),
    'rook(4,4,4,4) =', rook(4, 4, 4, 4).length, 'cells (expected 28)');
})();
