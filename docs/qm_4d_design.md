# `chess_spectral.qm_4d` — design doc for an optional QM extension

Status (updated 2026-04-29 from chess-maths notebook drift audit): **kinematic shipped, dynamics pending**. The chess-spectral repo now contains `chess_spectral/qm_4d.py` with the five non-pawn `H_piece_4` Hermitian observables and verified spectral-identity / Hermiticity / spectrum-bound results. Track A (kinematic) is unblocked and consumable from chess4D-OC once chess-spectral 1.5 tag-pushes. Track B (full unitary dynamics — `applyMoveQm` + Born-rule sampling + entanglement viz) is still pending.

The rest of this document was written when the QM module was a proposal. The architectural design (indicator basis, normalization choices, observable construction patterns) still applies; the section labels say "proposed" where the math is now real and the corresponding chess-spectral code exists.

## What's in chess-spectral 1.5 today (per 2026-04-29 audit)

Refined per-piece observable spectra (vs the earlier paraphrased `[-4, 28]` that crept in across all pieces):

| Piece | H_piece_4 spectrum bound |
|---|---|
| Rook | `[-4, 28]` |
| Bishop | `[-12, 54.4]` |
| Queen | `[-16, 81.9]` |
| King | `[-22, 67.7]` |
| Knight | `[-36.06, 36.06]` |
| Pawn | (breaks Hermiticity — handled separately, not yet in 1.5) |

Three pre-flight findings that motivate the design:

1. **Encoder injectivity is NOT strict** without side-to-move. There are 8 collision pairs on synthetic corpora, identified as the fixed-point set of (central inversion + color flip). 100% injective on real games. Fix: include side-to-move bit in `state_to_psi(state, side_to_move)`. **Load-bearing**: without it the proposed indicator-basis state vector is ambiguous on certain symmetric positions.

2. **Phase operators are real-symmetric Hermitian**. The five non-pawn `P_piece_4` predicate functions lift to real-symmetric matrices — full Hermiticity, not pseudo-Hermiticity. Spectra are real (the bounds in the table above). Pawn breaks Hermiticity because of the forward/backward asymmetry; needs separate treatment.

3. **Spectral identity holds at machine precision**. The encoder's 4096 modes ARE the simultaneous eigenbasis of (Δ, B_4 commutant). Max measured commutator: 1.6e-13. This is the canonicalness argument that the indicator-basis design relies on.

---

## (Original proposal text follows.)

Belongs in the chess-spectral repo (separate from chess4D-OC). This document records the design so it doesn't drift while we work on other things.

## Why this exists

In the M11.x conversation thread, the user described chess pieces as probability distributions on the lattice, with the piece "appearing" wherever the distribution peaks. That is the **Born rule** — a piece's wavefunction ψ(c) gives a probability amplitude over the 4096-cell hypercube, and `|ψ(c)|²` is the probability of finding the piece at cell `c`.

The 2026-04-29 audit (see `tasks/a5de338c37121bcc8.output` in the agent transcript or the milestone tracker entry for the QM verdict) established that **chess-spectral as currently implemented is NOT a quantum system**:

| QM axiom | chess-spectral 1.3.x state |
|---|---|
| Complex Hilbert space | No — encoder produces `np.float32`, phase ops live on `Z/145451·Z` |
| Normalized state vector (`‖ψ‖² = 1`) | No — channel intensities scale with piece-value magnitudes |
| Hermitian observables | No — phase operators are functions `int → frozenset[int]` |
| Unitary evolution | No — moves are set intersections with a legality oracle |

What chess-spectral IS: a finite-cyclic-group hash (`phi: {0..7}⁴ → Z/145451·Z`) plus a real-valued graph-Laplacian DCT encoder. Mathematically clean; not Hilbert-space-shaped.

The current visualizer (chess4D-OC) renders this honestly as a **graph-spectral signature** — cloud / filaments / topology / shells over the 11-channel real encoding. Calling it "quantum" anywhere user-facing has been removed (M11.5).

But the user — separately — is interested in **building a real QM layer** on top of chess-spectral 1.5+. This document sketches what that would take and what visualizations open up if it ships.

## Scope of `chess_spectral.qm_4d`

A new sibling module to `phase_operators_4d` and `encoder_4d`, parallel in role to how `tables_4d` provides the underlying graph-spectral basis. Does NOT replace existing modules — sits alongside as an optional QM-formalism front-end.

### State space

```python
# State vector: complex amplitude over (piece_type, square) basis.
# 16 piece types (KQRBNP × 2 colors, plus pawn axis variants) × 4096 squares
# = 65,536 basis kets. Normalized: <psi|psi> = 1.
PSI_DIM = 65_536  # Or 11 * 4096 = 45,056 if we keep the 11-channel basis

State = NDArray[complex128]  # shape (PSI_DIM,)
```

Two embedding choices:
- **Indicator basis** (preferred): one ket per `(piece_type, square)` pair. Sparse — at most 896 nonzeros (one per piece). Norm is `sqrt(896)` before normalization. Move operators are permutations, easy to make unitary.
- **11-channel basis**: keep the existing encoder shape, complex-cast it. Fewer basis kets (45k) but moves don't act linearly on this basis, so unitary moves are harder.

Recommendation: go with indicator basis. The 11-channel encoder becomes a NONLINEAR PROJECTION you can apply on top:
```python
def encode_classical(psi: State) -> NDArray[float32]:
    """Reduce a complex state vector to its 11-channel real-valued
    'classical' encoding. Lossy — collapses phase info."""
    psi_real = (psi.conj() * psi).real  # |psi|^2 in indicator basis
    return apply_existing_encoder(psi_real)
```

### Normalization

```python
def normalize(psi: State) -> State:
    n = np.linalg.norm(psi)
    if n < 1e-15:
        raise ValueError("zero-norm state")
    return psi / n
```

`encoder_4d.encode_4d` does NOT call this today (and wouldn't, since it's a real feature vector, not a state). For QM mode, `state_to_psi` always normalizes.

### Move operators

A chess move maps a position to a position. In the indicator basis a move is a **permutation matrix** (1 in row `(piece, dst)`, column `(piece, src)` — moves the piece-ket from `src` to `dst`, leaves all other kets fixed). Permutation matrices are unitary, so `U_move` is unitary by construction.

```python
def move_to_unitary(move: Move4D, *, dim: int = PSI_DIM) -> sp.csr_matrix:
    """Return the unitary U_move acting on indicator-basis state vectors.
    For a non-capturing piece move, U is a permutation that swaps the
    src and dst basis vectors. For a capture, U also annihilates the
    captured piece's ket — which means U is sub-unitary (a partial
    isometry) since dim shrinks. Wrap in a complement to keep U
    unitary if needed for composition."""
    rows, cols = [], []
    src_idx = piece_square_to_basis(move.piece_before, move.src)
    dst_idx = piece_square_to_basis(move.piece_after, move.dst)
    rows.append(dst_idx); cols.append(src_idx)
    if move.captured is not None:
        # Captured piece's ket annihilates — leave its column with no row entry.
        # The resulting matrix is sub-unitary; consumers normalize after apply().
        cap_idx = piece_square_to_basis(move.captured, move.dst)
        rows.append(...); cols.append(cap_idx)  # mapping to a "captured" auxiliary ket
    # Identity on all other basis vectors
    for i in range(dim):
        if i not in {src_idx, cap_idx}:
            rows.append(i); cols.append(i)
    data = np.ones(len(rows), dtype=complex128)
    return sp.csr_matrix((data, (rows, cols)), shape=(dim, dim))

def apply_move(psi: State, U: sp.csr_matrix) -> State:
    return normalize(U @ psi)
```

Promotions: U includes a basis change (pawn ket → queen ket at promotion square).
Castling: U is a product of two permutations (king + rook).
En passant: U includes the captured pawn ket annihilation.

### Hermitian observables

```python
def H_position_x() -> sp.csr_matrix:
    """Hermitian operator whose expectation value on a single-piece psi
    is the X-coordinate of the piece. Diagonal in the indicator basis:
    H[i, i] = x_coord(basis_idx_to_square(i))."""
    diag = np.array([square_to_xyzw(s)[0] for s in range(4096)] * 16, dtype=complex128)
    return sp.diags(diag).tocsr()

def H_orbit_complexity() -> sp.csr_matrix:
    """Hermitian whose eigenvalues are the orbit-projection (A1 channel)
    contributions. Constructable from tables_4d.X_targets eigenvalue
    decomposition."""
    ...
```

### Born rule

```python
def probability(psi: State, basis_idx: int) -> float:
    """Probability of measuring the system in basis state |basis_idx>."""
    return float(abs(psi[basis_idx]) ** 2)

def expectation(psi: State, observable: sp.csr_matrix) -> complex:
    """Expectation value <psi|H|psi>."""
    return complex(psi.conj() @ (observable @ psi))
```

## Visualizations enabled (chess4D-OC follow-ups)

If the QM module ships, several new visualization layers become well-defined:

### Per-piece wavefunction overlay
Today the cloud shows `|ψ_total|²` (collapsed over all pieces). With per-piece psi, hovering a piece could show **its individual `|ψ_p|²` cloud** — the probability distribution of just that piece. Clean spectral overlay, scalar field per piece, viridis-rendered.

### Coherent superposition rendering
A piece in superposition (multiple non-zero amplitudes in its `(piece, square)` row) has a multi-modal `|ψ|²`. Render as a multi-lobed cloud. Move animation = unitary evolution `psi(t) = U(t) @ psi(0)` interpolated between turns.

### Entanglement viz
Compute the reduced density matrix `ρ_p = Tr_{others}(|ψ⟩⟨ψ|)` for piece `p`. Pure state → rank 1 → "no entanglement"; rank > 1 → entanglement with other pieces. Color the piece's spectral overlay by `Tr(ρ²)` (purity) — entangled pieces glow differently.

### Measurement collapse animation
Click a piece → "measure" it → its `|ψ|²` collapses to a delta function at one cell, weighted by Born probabilities. Visually: cloud contracts to a point. Other pieces' wavefunctions update via the projected post-measurement state.

### Probability current
For each pair of moves the bot considers, compute `j_p(c) = Im(ψ* ∇ψ)` — the QM probability current. Render as filaments, similar to topology mode but mathematically grounded in QM rather than Morse theory.

## Cost estimates

| Work | Where | Effort | Risk |
|---|---|---|---|
| `qm_4d.py` module + tests | chess-spectral | ~600 LOC | Medium — needs careful unitary verification |
| chess-spectral 1.5 release | PyPI | trivial after the above | Low |
| `bridge.getQmState()` API | chess4D-OC | ~50 LOC | Low |
| Per-piece-wavefunction overlay | chess4D-OC | ~250 LOC, new module | Low |
| Other QM viz layers (entanglement, collapse, current) | chess4D-OC | ~200 LOC each | Low to medium |

## Open design questions

1. **Indicator basis dim 65,536 vs 45,056 (11-channel) basis** — the indicator basis lets us define moves as permutations cleanly, but the existing encoder is 11-channel. We should make the QM module agnostic to encoder choice and let consumers project as needed.
2. **Capture semantics** — "captured" pieces don't disappear from `(piece_type, square)` indicator space; they go to an out-of-board auxiliary ket. This adds 16 (one per captured-piece-color-type) extra dim → 65,536 + 16. Or use an "off-board" virtual square per piece type.
3. **Multi-king scoring** — chess4D-OC plays with up to 28 kings per side. Per-piece-type wavefunctions need to handle "multiple of one piece type" (sum kets). Indicator basis already does.
4. **Time evolution between moves** — chess is discrete-time. Should we expose a continuous Hamiltonian `H` such that `psi(t) = exp(-i·t·H) @ psi(0)` between turns? Optional, mostly for visualization sweetness.
5. **Game-tree QM** — could moves be in superposition? "The bot considers move A with amplitude α and move B with amplitude β; observe → collapse." That's "Quantum Chess" by Spiros Michalakis (Caltech, 2014) — a real existing game. Could we build it on top? Yes, but it's a separate gameplay mode, not a visualization.

## Sequencing

This is a chess-spectral 1.5 effort, not chess4D-OC scope. The right order:

1. **chess-spectral 1.5**: ship `qm_4d` module + tests + docs.
2. **chess-spectral 1.5.1**: paper-supplement-style verification — confirm `‖ψ‖²=1`, `U†U=I`, expected eigenvalues of position operators on test positions.
3. **chess4D-OC M11.10**: bridge wires up `getQmState()`. New `js/spectral_qm.js` module renders per-piece wavefunctions when chess-spectral 1.5 is detected at runtime.
4. **chess4D-OC M11.11**: entanglement / collapse / current visualizations, layered on the existing display modes.

## Decision needed before any code

Is the goal **physics paper** (rigorous QM, prove axiom satisfaction, write a supplement), **visualization sweetness** (looks neat, axioms approximate), or **gameplay** (true Quantum Chess — moves in superposition, measurement collapses)? Each path has different priorities:

- Paper → indicator basis, full unitary verification, time evolution as `exp(-iHt)`, careful capture handling.
- Visualization → 11-channel basis is fine, normalize empirically, skip the deep observable theory.
- Gameplay → indicator basis, Born-rule sampling on every move, coherent superposition state model.

For now this document records the design without committing to one path. Pick when ready.

---

## What chess-spectral 1.5 unlocks in chess4D-OC (the broader follow-up inventory)

Author: 2026-04-29 conversation thread. The list below is what becomes possible across the chess4D-OC frontend once the QM module ships. Most items are gated on chess-spectral 1.5 actually existing; a few can be partially scoped now.

### Tier 1 — Visualization layers (5–6 new modules)

All gated on chess-spectral 1.5. Each is a sibling to the existing `spectral_*.js` modules and follows the same init/setEnabled/refresh API.

| Slot | Module | What you'd see |
|---|---|---|
| **M14.1** | `js/spectral_qm_piece.js` | Per-piece `\|ψ_p\|²` overlay — hover any piece, see ITS probability cloud. Today the heatmap shows the global encoding; QM gives a per-piece distribution. |
| **M14.2** | `js/spectral_qm_phase.js` | Phase-colored cloud — hue = `arg(ψ)`, saturation = `\|ψ\|²`. Current viridis/RdBu ramps lose phase info entirely. |
| **M14.3** | `js/spectral_qm_evolution.js` | Coherent-superposition multi-lobe rendering + unitary-evolution animation. A move's `U_move` interpolates ψ(t) between turns. |
| **M14.4** | `js/spectral_qm_entangle.js` | Entanglement coloring. Reduced density matrix `ρ_p = Tr_others(\|ψ⟩⟨ψ\|)`; pure ρ (rank 1) = independent, rank > 1 = entangled. Glow entangled pieces. |
| **M14.5** | `js/spectral_qm_collapse.js` | Measurement-collapse animation. Click "measure" → cloud contracts to a delta function at one cell, weighted by Born probabilities. |
| **M14.6** | `js/spectral_qm_current.js` | True QM probability current `j(c) = Im(ψ* ∇ψ)` filaments. Today's filaments are gradient flow of `\|ψ\|²` (semi-classical limit); QM gives the actual quantum current with phase circulation. |

### Tier 2 — Bot AI

Slots into the existing M13.2 strategy registry. New entries:

| Strategy | Idea |
|---|---|
| **`qm-expectation-eval`** | Use `⟨ψ\|H\|ψ⟩` for a chosen Hermitian as eval. Multiple H's available (material, mobility, center, custom). Selectable via UI dropdown alongside the strategy choice. |
| **`quantum-monte-carlo`** | Born-weighted game-tree sampling. Each branch gets probability `\|⟨move\|U_search\|ψ⟩\|²`. Better than uniform-random branching for shallow searches. |

### Tier 3 — Gameplay modes (substantial)

| Slot | Mode | What it is |
|---|---|---|
| **M15.1** | Quantum Chess (4D) | Pieces in superposition; moves are unitary; observation collapses. First 4D version (Caltech / Spiros Michalakis built 2D in 2014). |
| **M15.2** | Measurement game | Players don't make moves — they choose what to MEASURE. The state evolves under a fixed Hamiltonian; you reveal piece positions probabilistically. |
| **M15.3** | Hybrid classical-quantum | Some pieces classical, some quantum, mixed gameplay. |

### Tier 4 — Scientific output

| Output | Path |
|---|---|
| **M16.1 — Physics paper** | "Discrete-lattice QM applied to 4D chess" — provided chess-spectral 1.5 ships with formal axiom verification. Conference fit: APS / SIGGRAPH viz track. |
| **M16.2 — Pedagogy paper** | Chess as a vehicle for teaching finite-dim QM. Every piece = particle on a lattice; moves = unitary evolution; checkmate = collapse. |
| **M16.3 — Conference demo** | Interactive WebGL/WebGPU 4D QM lattice. Free, runs in browser, no install. |

### Tier 5 — Cross-pollination with existing layers

The visualizations already shipped in chess4D-OC don't get replaced — they get **re-grounded** with QM as their underlying theory. No code changes required, just docs that re-explain what each layer represents:

| Existing layer | Today's framing | QM framing |
|---|---|---|
| Heatmap cloud | Real graph-Laplacian DCT signature | `\|⟨x\|ψ⟩\|²` projection of QM state |
| Filaments | Gradient flow of channel intensity | Semi-classical approximation to true QM probability current |
| Topology mode | Morse-Smale on a real scalar field | Morse-Smale on `\|ψ\|²` (same math; cleaner theoretical interpretation) |
| Isosurfaces | Percentile-thresholded shells | `\|ψ\|² = const` quantum density shells |
| Hodge decomposition (M11.4) | Decomposition of STD4 vector field | Decomposition of QM probability current — the harmonic part is the topologically invariant gauge-field circulation |

---

## Architectural decision — engine algorithms belong in chess-spectral, not chess4D-OC

User asked (2026-04-29): "the engine things I brought up a bit ago might should go in chess-spectral or no?" This section records the answer.

### The decision

**Yes**: search algorithms (alpha-beta, iterative deepening, transposition tables, MVV-LVA, killer moves) and position evaluation (material, spectral channel-energy, QM expectation-value) belong in `chess-spectral` — not in `chess4D-OC/Bot.js`.

### Where things live

| Layer | Repo | Why |
|---|---|---|
| Math primitives (phase ops, encoder, channel energies, QM ops) | chess-spectral | Already there; this is the library |
| Search algorithms | chess-spectral (`chess_spectral.engine` submodule) | General algorithms; benefit other consumers (CLI, server-side play, paper benchmarks) |
| Position evaluation functions | chess-spectral | Naturally Python-side; reads channel energies / ψ |
| Self-play tournament harness | chess-spectral | Pure logic; benefits from Python's stats + testing tooling |
| UI Bot.js (animations, visual feedback, async glue) | chess4D-OC | Becomes a thin ~50-LOC wrapper after migration |

### What this means for what's already shipped

**M13.1 (alpha-beta + TT) and M13.2 (multi-strategy framework) are not wasted.** They ship working in-browser engines TODAY without requiring a Python round-trip. They keep working until/unless we migrate to the chess-spectral side. The migration is value-add, not error-correction.

### Performance — search-in-Python is fine

The Pyodide bridge has 10–50 ms round-trip overhead per call. Naive worry: that's per evaluation, search will be slow. **Reality**: the search loop runs INSIDE Pyodide at native Python speed; only ONE bridge round-trip per move (the request-getBestMove call). The 10–50 ms overhead is amortized over the entire search.

### Prerequisite

**M4b.1 (chess4D-OC async cutover) gates everything.** Once all legality + state goes through the bridge, search-in-Python is the natural next step.

### Updated sequencing (combining both repos)

1. **chess-spectral 1.5** — QM kinematics + dynamics (separately scoped per the path decision above)
2. **chess4D-OC M4b.1** — async cutover; delete JS legality, route through bridge.legalMoves
3. **chess-spectral 1.6** — `chess_spectral.engine` submodule. Port alpha-beta + ID + TT + MVV-LVA from M13.1 to Python; bridge exposes `getBestMove(state, opts)`
4. **chess4D-OC M13.4** — Bot.js becomes ~50-LOC thin wrapper around `bridge.getBestMove`
5. **chess-spectral 1.7** — spectral channel-energy eval + self-play tournament harness
6. **chess-spectral 1.8** — QM expectation-value eval (multiple H's: material, mobility, center, custom)
7. **chess4D-OC M14.x** — QM visualization layers (Tier 1)
8. **chess4D-OC M15.x** — Quantum Chess gameplay (Tier 3)
9. **Both** — M16.x scientific output (Tier 4)

Items 2, 4, 7, 8 are chess4D-OC scope (mine). Items 1, 3, 5, 6 are chess-spectral scope (yours). Item 9 is collaborative.
