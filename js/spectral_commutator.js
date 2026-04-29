// spectral_commutator.js — M12 phase-operator commutator visualization.
//
// Visualizes the **non-commutativity** of two phase operators as a
// "curvature 2-form" cell layer. For piece operators P_A, P_B and a
// chosen origin o, the commutator
//
//   [P_A, P_B](o)  =  (A∘B)(o)  Δ  (B∘A)(o)
//
// is the symmetric difference of "apply B then A" vs "apply A then B"
// destination sets. Cells in this set are exactly where the ORDER of
// piece composition matters — the field's "curvature" relative to the
// chosen piece pair. Mathematically analogous to the field-strength
// tensor F_μν = [D_μ, D_ν] in gauge theory, restricted to the discrete
// chess phase group.
//
// Set-valued composition (operators are int → frozenset[int]):
//   (A∘B)(o)  =  ⋃_{c ∈ B(o)}  A(c)
//   (B∘A)(o)  =  ⋃_{c ∈ A(o)}  B(c)
//
// For chess piece pairs:
//   - rook ∘ bishop ≠ bishop ∘ rook (large symmetric difference)
//   - king ∘ knight ≠ knight ∘ king
//   - same-piece commutator like rook ∘ rook is empty (idempotent
//     under union, no curvature)
//
// Computation uses the JS phase-ops port (M12.0) so it's all in-browser:
// 4096 cells × 25 piece pairs × ~50 dest each = ~5M ops max, sub-100ms.
// No bridge round-trips per origin.
//
// API:
//   SpectralCommutator.init(scene, gameBoard)
//   SpectralCommutator.setEnabled(bool)
//   SpectralCommutator.setPiecePair(pieceA, pieceB)
//       pieceA, pieceB ∈ {'rook', 'bishop', 'queen', 'king', 'knight'}
//   SpectralCommutator.refreshFor(origin)  // called on piece select
//   SpectralCommutator.refresh()           // re-fire at last origin

(function () {
  'use strict';

  let im = null;
  let _scene = null;
  let _gameBoard = null;
  let enabled = false;
  let pieceA = 'rook';
  let pieceB = 'bishop';
  let _initRequested = false;
  let _lastOrigin = null;

  const PIECE_FNS = {
    rook:   (x, y, z, w) => window.PhaseOps4D && window.PhaseOps4D.rook(x, y, z, w),
    bishop: (x, y, z, w) => window.PhaseOps4D && window.PhaseOps4D.bishop(x, y, z, w),
    queen:  (x, y, z, w) => window.PhaseOps4D && window.PhaseOps4D.queen(x, y, z, w),
    king:   (x, y, z, w) => window.PhaseOps4D && window.PhaseOps4D.king(x, y, z, w),
    knight: (x, y, z, w) => window.PhaseOps4D && window.PhaseOps4D.knight(x, y, z, w),
  };

  // Pre-allocated per-cell base-position cache (same pattern as other
  // overlay modules — write boardCoordinates once at init, compose
  // scale × translation per refresh).
  const _basePos = new Float32Array(4096 * 3);

  function buildMesh() {
    if (im) return im;
    if (!_scene || !_gameBoard || !_gameBoard.graphics) return null;
    const gfx = _gameBoard.graphics;
    const square = gfx.squareSize || 50;
    // Tetrahedron (4 vertices, 4 faces) — distinct shape from the cloud
    // boxes / dotplot spheres / iso shells / max-marker spheres so the
    // user can read commutator cells at a glance. Yellow-orange color
    // (curvature/heat connotation, distinct from viridis or RdBu).
    const geom = new THREE.TetrahedronGeometry(square * 0.18, 0);
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(1.0, 0.65, 0.10),
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    im = new THREE.InstancedMesh(geom, mat, 4096);
    im.frustumCulled = false;
    im.renderOrder = 6; // above filaments (5)
    im.count = 0; // start with no cells highlighted
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Cache base positions — same approach as other modules.
    const matrix = new THREE.Matrix4();
    for (let x = 0; x < 8; x++) {
      for (let y = 0; y < 8; y++) {
        for (let z = 0; z < 8; z++) {
          for (let w = 0; w < 8; w++) {
            const pos = gfx.boardCoordinates(x, y, z, w);
            const idx = (x << 9) | (y << 6) | (z << 3) | w;
            // Float a bit above the board surface (above tint quads at
            // +3.0 and pieces at ~+5; commutator markers at +12 sit on
            // top of all of it).
            _basePos[idx * 3 + 0] = pos.x;
            _basePos[idx * 3 + 1] = pos.y + 12;
            _basePos[idx * 3 + 2] = pos.z;
            matrix.makeTranslation(pos.x, pos.y + 12, pos.z);
            im.setMatrixAt(idx, matrix);
          }
        }
      }
    }
    im.visible = false;
    _scene.add(im);
    return im;
  }

  function _writeMatrix(idx, slot, s) {
    // Write into instance slot `slot` (not idx — count compaction).
    const e = im.instanceMatrix.array;
    const o = slot * 16;
    const tx = _basePos[idx * 3];
    const ty = _basePos[idx * 3 + 1];
    const tz = _basePos[idx * 3 + 2];
    e[o + 0] = s; e[o + 1] = 0; e[o + 2] = 0; e[o + 3] = 0;
    e[o + 4] = 0; e[o + 5] = s; e[o + 6] = 0; e[o + 7] = 0;
    e[o + 8] = 0; e[o + 9] = 0; e[o + 10] = s; e[o + 11] = 0;
    e[o + 12] = tx; e[o + 13] = ty; e[o + 14] = tz; e[o + 15] = 1;
  }

  // Compute [P_A, P_B](origin). Returns array of cell indices in the
  // symmetric difference. Coordinates and lookups are integer-keyed for
  // O(1) set ops.
  function computeCommutator(originX, originY, originZ, originW, fnA, fnB) {
    const aSet = fnA(originX, originY, originZ, originW); // [[x,y,z,w], ...]
    const bSet = fnB(originX, originY, originZ, originW);
    function packCell([x, y, z, w]) {
      return (x << 9) | (y << 6) | (z << 3) | w;
    }
    // (A ∘ B)(o) = ⋃_{c ∈ B(o)} A(c)
    const ABset = new Set();
    for (const c of bSet) {
      const dests = fnA(c[0], c[1], c[2], c[3]);
      for (const d of dests) ABset.add(packCell(d));
    }
    // (B ∘ A)(o) = ⋃_{c ∈ A(o)} B(c)
    const BAset = new Set();
    for (const c of aSet) {
      const dests = fnB(c[0], c[1], c[2], c[3]);
      for (const d of dests) BAset.add(packCell(d));
    }
    // Symmetric difference: in exactly one of ABset / BAset.
    const commutator = [];
    for (const k of ABset) if (!BAset.has(k)) commutator.push(k);
    for (const k of BAset) if (!ABset.has(k)) commutator.push(k);
    return commutator;
  }

  function refresh() {
    if (!enabled || !im) return;
    if (!_lastOrigin) return;
    if (!window.PhaseOps4D) {
      console.warn('[m12/commutator] PhaseOps4D not loaded yet');
      return;
    }
    const fnA = PIECE_FNS[pieceA];
    const fnB = PIECE_FNS[pieceB];
    if (!fnA || !fnB) {
      console.warn('[m12/commutator] unknown piece type:', pieceA, pieceB);
      return;
    }
    const t0 = (typeof performance !== 'undefined') ? performance.now() : 0;
    const cells = computeCommutator(
      _lastOrigin.x, _lastOrigin.y, _lastOrigin.z, _lastOrigin.w,
      fnA, fnB
    );
    // Write up to 4096 instances; compact slots to the active count.
    const maxCells = Math.min(cells.length, 4096);
    for (let slot = 0; slot < maxCells; slot++) {
      _writeMatrix(cells[slot], slot, 1.0);
    }
    im.count = maxCells;
    im.instanceMatrix.needsUpdate = true;
    if (typeof window !== 'undefined') window.__GAME_DIRTY__ = true;
    const dt = (typeof performance !== 'undefined') ? (performance.now() - t0) : 0;
    console.log(
      `[m12/commutator] [P_${pieceA}, P_${pieceB}] at (${_lastOrigin.x},` +
        `${_lastOrigin.y},${_lastOrigin.z},${_lastOrigin.w}) → ` +
        `${cells.length} curvature cells in ${dt.toFixed(2)}ms`
    );
  }

  function refreshFor(origin) {
    if (!origin || !Number.isFinite(origin.x)) return;
    _lastOrigin = { x: origin.x, y: origin.y, z: origin.z, w: origin.w };
    if (enabled) refresh();
  }

  window.SpectralCommutator = {
    init(scene, gameBoard) {
      if (_initRequested) return;
      _initRequested = true;
      _scene = scene;
      _gameBoard = gameBoard;
      buildMesh();
      try {
        const params = new URLSearchParams(location.search);
        const flag = params.get('commutator');
        if (flag === '1' || flag === 'on') {
          enabled = true;
          if (im) im.visible = true;
        }
        const pa = params.get('commutatorA');
        const pb = params.get('commutatorB');
        if (pa && PIECE_FNS[pa]) pieceA = pa;
        if (pb && PIECE_FNS[pb]) pieceB = pb;
      } catch (_) { /* not in browser */ }
    },
    setEnabled(en) {
      if (enabled === en) return;
      enabled = en;
      if (im) im.visible = en;
      if (en && _lastOrigin) refresh();
      if (typeof window !== 'undefined') window.__GAME_DIRTY__ = true;
    },
    setPiecePair(a, b) {
      let dirty = false;
      if (a && PIECE_FNS[a] && a !== pieceA) { pieceA = a; dirty = true; }
      if (b && PIECE_FNS[b] && b !== pieceB) { pieceB = b; dirty = true; }
      if (dirty && enabled) refresh();
    },
    /** M11.3.5 stack-scale hook — keep markers aligned with boards. */
    setStackScale(s) {
      if (!Number.isFinite(s) || s <= 0) return;
      if (im) im.scale.y = s;
      if (typeof window !== 'undefined') window.__GAME_DIRTY__ = true;
    },
    refresh,
    refreshFor,
    isEnabled() { return enabled; },
    getPiecePair() { return { a: pieceA, b: pieceB }; },
  };
})();
