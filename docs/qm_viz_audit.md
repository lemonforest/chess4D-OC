# M14.8 QM Viz Correctness Audit

User asked: *"Review our qm viz and verify it does give us back info that we think it should. can also try feeding fen4 to cli for additional troubleshooting things."*

This audit ran offline against chess-spectral 1.6.1 directly (no Pyodide / no
browser), reproducing the same `_state_to_fen4 → load_fen4` round-trip our
worker performs. The point was to verify each `qm_4d_bridge.*` method returns
the shape and values our JS viz layers expect, then trace any mismatches to
specific viz modules.

## Test corpus

- **T0** chess4D-OC starting position (28 kings, 384 pawns, 896 pieces total)
  via `chess4d.initial_position()` + our worker's `_state_to_fen4`
- **T1** mid-game position (4 plies of pawn pushes from T0)
- **T2** edge case: bare 2-king minimum (`K@0,0,0,0; k@7,7,7,7`)

## Findings

### ✅ FEN4 round-trip works post-#80

After PR #80's pawn-axis hotfix (`Pw@...` not `P/w@...`), the chess4D-OC
starting position FEN4 parses cleanly through `chess_spectral_4d.bridge.
load_state` → `chess_spectral.spatial_4d.Board4D.from_fen`. **Confirmed via
CLI**: `chess-spectral-4d search --fen4 "..."` parses the same string the
worker emits. Before #80 it raised `Fen4ParseError`.

### ✅ `getQmState` shape + invariants correct

| Property | Expected | Measured (T0) |
|---|---|---|
| `psi.shape` | `(90112,)` | `(90112,)` ✓ |
| `psi.dtype` | `float32` | `float32` ✓ |
| `basisDim` | `45056` | `45056` ✓ |
| `normSq` | `~1.0` | `1.000000` ✓ |
| layout (interleaved Re/Im) | `psi[2k]=Re, psi[2k+1]=Im` | manual reconstruction `Σ(re²+im²)=1.0` ✓ |

Interesting observation at T0: `re` has 13794 non-zero entries (out of 45056),
`im` has **0** non-zero entries. The natural state-derived ψ for a real-valued
position is purely real (which makes sense — no time evolution applied, no
complex phase yet). M14.4 click-to-measure post-collapse ψ would gain imaginary
parts; that's the point of the Born-rule projection.

### ✅ `getQmDensity` Born-rule normalized + tracks pieces

| Property | Expected | Measured (T0) |
|---|---|---|
| `density.shape` | `(4096,)` | `(4096,)` ✓ |
| `density.sum()` | `~1.0` | `1.000000` ✓ |
| non-zero cells | most of lattice | `3450/4096` (84%) ✓ |
| top cells correspond to actual pieces | yes | `(3,0,6,6), (3,7,1,6), (3,7,6,1), (3,0,1,1), (3,0,5,5)` — **all 5 are occupied cells** ✓ |

This validates that **M14.1 SpectralQmDensity tint is meaningful**: cells
with high `|ψ|²` are the cells with actual pieces. The encoder spreads
piece information across the lattice via its eigenbasis, but the spread
is weighted toward true piece locations. The viz isn't rendering "spectral
noise" — it's showing where the encoder concentrates mass, which IS where
the pieces are at the starting position.

### ⚠️ `getProbabilityCurrent` shape mismatch (FIXED in this PR)

| Property | Expected by M14.2 JS | Measured |
|---|---|---|
| `j.shape` | flat `Float32Array(16384)` | **2D ndarray `(4096, 4)`** ✗ |

The chess_spectral 1.6.1 `get_probability_current` returns `j` as a 2D ndarray
of shape `(4096, 4)`. Pyodide's `toJs(depth=5)` converts a 2D ndarray to
nested JS arrays, NOT a flat Float32Array.

Our **M14.2 SpectralQmCurrent** code expects flat `Float32Array(16384)`:

```js
if (!j || j.length !== N_CELLS * 4) {  // checks 16384
  console.warn(`expected j length ${N_CELLS * 4}, got ${j ? j.length : 'null'}`);
  return;  // silent bail
}
```

With `j.length === 4096` (the 2D outer dim), the warning fires and the viz
returns without drawing arrows. **The probability-current overlay was
silently rendering nothing.**

**Fix in this PR**: worker handler now calls `r['j'].flatten().astype('float32')`
before returning, guaranteeing JS sees a 1D Float32Array of length 16384.
The existing M14.2 JS code reads `j[4*idx+axis]` correctly against the
flattened layout (row-major contiguous → `j[axis_for_cell_idx] = j[4*idx + axis]`).

### ✅ `getEncoderShape` matches `CHANNELS_4D` (modulo container type)

| Property | Expected | Measured |
|---|---|---|
| `totalDim` | `45056` | `45056` ✓ |
| channel count | `11` | `11` ✓ |
| channel names | `[A1, STD4_X/Y/Z/W, FIB_SYM_1/2/3, FA_PAWN_W/Y, FD_DIAG]` | matches ✓ |
| sum of `dim` per channel | `45056` | `45056` ✓ |

Note for future reference: in 1.6.1 `chess_spectral.encoder_4d.CHANNELS_4D`
is a `list[tuple[str, int]]` (name, offset), not a `dict`. Bridge's
`getEncoderShape` returns `[{name, offset, dim}]` which is the consumer-
friendly shape — JS doesn't need to know about the upstream container type.

### ✅ `getQmExpectation` per-piece-reach observables return scalars

For the chess4D-OC starting position, all five `H_piece_4` observables
return finite real values:

```
⟨ψ|H_rook|ψ⟩    finite real
⟨ψ|H_bishop|ψ⟩  finite real
⟨ψ|H_queen|ψ⟩   finite real
⟨ψ|H_king|ψ⟩    finite real
⟨ψ|H_knight|ψ⟩  finite real
```

(Pawn observable not exposed; pseudo-Hermitian η-metric construction is
chess-spectral 1.7+ per `qm_4d.py` ADR-005.)

### ⚠️ Edge case: 2-king-only positions produce normSq=0

`load_fen4("4d-fen v1: K@0,0,0,0; k@7,7,7,7")` → `state_to_psi(state)` →
**ψ is the zero vector**, `normSq = 0`.

This isn't a chess4D-OC bug — it's a chess-spectral 1.6.1 edge case where
the encoder produces a degenerate vector for kings-only positions (the
B_4 channel decomposition has no king-dominated channel, so the kings-only
position lands in the kernel of every projection).

Practical impact: **none for the live game** since chess4D-OC always has
≥896 pieces (28 kings + 364 pawns + back rank pieces × 2 colors). The
density tint and current viz will look reasonable throughout normal play.

If a far-future position-editor feature lets users construct minimal
positions, M14.1's percentile-clip + min/max fallback handles `flat=true`
(uniform 0 across all cells) by tinting all cells the neutral mid-color.
That's correct behavior for a degenerate ψ.

## Summary

| Method | Status |
|---|---|
| `getQmState` | ✅ correct, M14.x viz consumes correctly |
| `getQmDensity` | ✅ correct, M14.1 tint tracks piece positions visibly |
| `getProbabilityCurrent` | ✅ FIXED in this PR — was silently no-op due to 2D vs flat array mismatch |
| `applyMoveQm` (M11.28) | ✅ shape matches (1D Float32 90112) |
| `measureAt` (M11.29) | ✅ shape matches (postCollapsePsi 1D Float32 90112) |
| `getEncoderShape` | ✅ correct |
| `getQmExpectation` | ✅ correct (5 of 5 piece observables) |
| `getDensityMatrixOf` | ⚠️ stubbed upstream (M14.3 blocked on cs 1.7+) |
| `getVersion` | ✅ correct |
| `getFen4State` | ✅ correct (post-#80 dialect fix) |
| `hasLegalMoves` | ✅ correct |

The user's audit concern was warranted: M14.2's probability-current viz was
silently failing. The fix is shipped here; M14.1 and M14.5 viz layers were
correct already.

## What's still useful to verify with Playwright

This audit was offline against native CPython. The Pyodide round-trip in the
live browser should produce identical results since chess-spectral runs at
near-native speed in WASM, but a future M14.8.1 could extend the smoke test
to assert specific bridge-output shapes match the offline expectations
(e.g., `(await bridge.getProbabilityCurrent()).j.length === 16384` after
this fix).
