# `SpectralBridge` API surface — what we have, what we use, what's missing

Audited 2026-04-29 ahead of M4b.1 (chess4D-OC async cutover) and chess-spectral 1.5/1.6 engine work. Keep this in sync with `js/spectral_bridge.js` and `js/spectral_worker.js`.

The user said: *"we'll need to see what we opened up api wise and what we find we forgot. we always forget something"*. This is that audit.

**Update 2026-04-29 (afternoon)**: chess-spectral **1.5.0 published to PyPI** at 19:18 UTC. Every `§17.1` QM and `§17.5` dev/debug method enumerated below is **honored** in the upstream `chess_spectral.qm_4d_bridge` and `chess_spectral_4d.bridge` modules. The 1.6 engine module remained an outstanding ask.

**Update 2026-04-30**: chess-spectral **1.6.1 published**. The §16 ship-gate release adds:
- **Engine surface**: `chess_spectral_4d.engine.search.search(board, evaluator, options) → SearchResult` (with `pv: List[Move4D]` principal variation), three evaluators (`material`, `qm`, `spectral`) at both 2D and 4D, plus tournament harness.
- **Bitboard4D**: `chess_spectral.spatial_4d` with attack tables, ray tables, `Board4D` state — the fast move-gen primitive.
- **Third legality oracle**: discrete-Laplacian eigenbasis (the same DCT-style basis the encoder uses, doubling as a legality lookup table).
- **v5 wire format**: `chess_spectral.frame_v5` with three encoding modes (dense / per-channel / XOR-stream) — 7.23× compression over dense gzipped on 4D fixtures.
- **`chess_spectral_4d.bridge.get_move_history`** helper for our M11.6 export feature.

Wire-up tracking (chess4D-OC milestones):

| | | |
|---|---|---|
| **M11.25** ✅ | bump pin → 1.5.0; wire `getVersion`, `getEncoderShape` | merged |
| **M11.26** ✅ | FEN4 round-trip + `getFen4State`, `hasLegalMoves` | merged |
| **M11.27** ✅ | QM kinematics: `getQmState`, `getQmDensity` | merged |
| **M11.28** ✅ | `applyMoveQm` (preview-style ψ_post) | merged |
| **M11.29** ✅ | QM dynamics: `measureAt`, `getDensityMatrixOf`, `getProbabilityCurrent`, `getQmExpectation` | merged |
| **M14.1** ✅ | viz: `\|ψ\|²` density tint (consumes `getQmDensity`) | merged |
| **M14.2** ✅ | viz: probability-current arrow glyphs (consumes `getProbabilityCurrent`) | merged |
| **M11.31** | bump pin → 1.6.1 (canary) | merged |
| **M13.4** | Bot.js → bridge.getBestMove + 3 new engine-* strategies (engine search runs in Pyodide; fixes JS-thread freeze) | this PR |
| **M11.32** | `_legal_moves_bitboard` via `spatial_4d.Board4D` + `?legalityOps=bitboard` | merged |
| **M11.33** | discrete-Laplacian oracle (`spectral_legality_4d.reachable_targets_4d`) + `?legalityOps=laplacian` | this PR |
| **M14.3** | viz: density-matrix entanglement (consumes `getDensityMatrixOf`) | queued |
| **M14.4** | viz: click-to-measure interaction (consumes `measureAt`) | queued |
| **M14.5** (new) | viz: PV ghost-arrow overlay (consumes new `SearchResult.pv`) | queued |
| **M14.6** (new) | viz: eval-breakdown debug bars (consumes `evaluate_breakdown`) | queued |
| **M11.40** | drop chess4d; full migration to chess_spectral_4d state | end-state cleanup |

---

## Currently exposed (24 methods: 13 pre-1.5 + 2 M11.25 + 2 M11.26 + 2 M11.27 + 1 M11.28 + 4 M11.29)

All methods return `Promise`s. The bridge serializes mutations through `applyChain` so move-applying methods don't race.

| Method | Args | Returns | Used by | Notes |
|---|---|---|---|---|
| `init()` | — | `{ status, info }` | bridge auto-boot | Boots Pyodide, micropip-installs chess-spectral + chess4d. Sets `window.__SMOKE_READY__` on success. |
| `getStatus()` | — | `{ status, error }` | debug overlay | Reports ready/booting/error |
| `getConstants()` | — | `{ MODULUS_4D, GEN_X, GEN_Y, GEN_Z, GEN_W }` | debug overlay | Pulled from `chess_spectral.phase_operators_4d` at runtime — not hardcoded in JS |
| `getInitialPositionInfo()` | — | `{ piece_count, ... }` | debug overlay | Smoke-test sanity |
| `applyMove(origin, dest)` | `{x,y,z,w}` × 2 | `{ ok, reason? }` | `GameBoard.move()`, `M11.7 bot auto-select` chain | Mutation; serialized via `applyChain` |
| `undo()` | — | `{ ok }` | `MoveManager.undo()` (currently unused) | Mutation; serialized |
| `resetToInitial()` | — | `{ ok }` | New Game button | Mutation; serialized |
| `legalMoves(origin)` | `{x,y,z,w}` | `{ ok, moves: [{x,y,z,w}, ...] }` | M3.5 parity harness only — **NOT YET on user-click path** | Awaits applyChain to ensure post-move state |
| `setLegalityOps(ops)` | `'spatial' \| 'phase' \| 'bitboard' \| 'laplacian'` | `{ ok }` | URL flag `?legalityOps=` | Four oracles (chess4d baseline + 1.6.1's three lenses): chess4d.pieces / phase_operators_4d / spatial_4d.Board4D.legal_moves / spectral_legality_4d.reachable_targets_4d. All return the same legal-move set; pawns under `laplacian` defer to spatial (oracle doesn't model pawn rules). |
| `previewEncoding(origin)` | `{x,y,z,w}` | `{ ok, previews: [{dest, intensities}] }` | `spectral_overlay.js` (M5 hover) | Coalesced — one in-flight + one queued, replace on new hover |
| `getBoardEncoding(channels)` | `string[]` | `{ ok, channels: { name: Float32Array(4096) } }` | All five spectral overlay modules | Refreshes only when move history advances (cached) |
| `listInitialPieces()` | — | `{ pieces: [...] }` | M3.5 parity harness | Read-only |
| `legalMovesAtInitial(origin)` | `{x,y,z,w}` | `{ ok, moves: [...] }` | M3.5 parity harness | Doesn't depend on current state |
| `getVersion()` *(M11.25)* | — | `{ ok, version, source? }` | (debug panel — wire-up pending) | Calls `chess_spectral.qm_4d_bridge.get_version` |
| `getEncoderShape()` *(M11.25)* | — | `{ ok, totalDim, channels: [{name,offset,dim}] }` | (overlay modules — wire-up pending) | 45,056-dim, 11 channels of 4096 each |
| `hasLegalMoves(team)` *(M11.26)* | `0\|1` | `{ ok, hasMoves: boolean }` | (M11.26.1 cutover pending) | King-first scan in Python; drop-in for `gameBoard.hasLegalMoves` |
| `getFen4State()` *(M11.26)* | — | `{ ok, fen4 }` | (M11.6 export refactor pending) | Best-effort v1 serializer; probes upstream + hand-rolled fallback |
| `getQmState(opts?)` *(M11.27)* | `{ sideToMove?: bool }` | `{ ok, psi: Float32Array(90112), basisDim: 45056, normSq }` | (M14.x viz pending) | ψ as real+imag interleaved Float32; `psi[2k]=Re`, `psi[2k+1]=Im` |
| `getQmDensity()` *(M11.27)* | — | `{ ok, density: Float32Array(4096) }` | `js/spectral_qm_density.js` (M14.1) ✅ | Per-cell `\|ψ\|²` summed over channels; sums to 1.0±1e-6 |
| `applyMoveQm(origin, dest)` *(M11.28)* | `{x,y,z,w}` × 2 | `{ ok, psi: Float32Array(90112), basisDim, normSq }` | (M14.x preview overlays pending) | PREVIEW-style — returns ψ_post, doesn't mutate chess4d state |
| `measureAt(coord, observable?)` *(M11.29)* | `{x,y,z,w}, string?` | `{ ok, sampledOutcome, postCollapsePsi }` | (M14.4 click-to-measure pending) | Born-rule projective measurement; observable defaults to channel-PVM |
| `getDensityMatrixOf(pieceId)` *(M11.29)* | `int` | `{ ok, rho, purity, rank }` | (M14.3 entanglement viz pending) | tr(ρ²)=purity; rank>1 = entangled |
| `getProbabilityCurrent()` *(M11.29)* | — | `{ ok, j: Float32Array }` | `js/spectral_qm_current.js` (M14.2) ✅ | `j_p(c) = Im(ψ* ∇ψ)`; per-cell 4D flow vector |
| `getQmExpectation(observable, weights?)` *(M11.29)* | `string, object?` | `{ ok, value }` | (M13.4 bot eval pending) | `⟨ψ\|H\|ψ⟩` for piece-reach observables; composable via weights |
| `getBestMove(opts)` *(M13.4)* | `{ evaluator, maxDepth?, timeBudgetMs?, useTt?, useMvvLva?, useQuiescence? }` | `{ ok, move, evaluator, score, depth, elapsedMs, nodesSearched, ttHits, ttSize, pv }` | `js/Bot.js` `engine-*` strategies | Iterative-deepening alpha-beta in Pyodide worker; PV is the predicted line |
| `evaluatePosition(opts)` *(M13.4)* | `{ evaluator }` | `{ ok, evaluator, value, breakdown? }` | (M14.6 eval-bar overlay pending) | Static eval; `breakdown` per-piece (qm) or per-channel (spectral) |

## Worker-side handlers (matched 1:1 with bridge methods above)

`js/spectral_worker.js` `handlers` object: `init`, `getStatus`, `getConstants`, `getInitialPositionInfo`, `applyMove`, `undo`, `resetToInitial`, `legalMoves`, `setLegalityOps`, `previewEncoding`, `getBoardEncoding`, `listInitialPieces`, `legalMovesAtInitial`, `getVersion`, `getEncoderShape`, `hasLegalMoves`, `getFen4State`, `getQmState`, `getQmDensity`, `applyMoveQm`, `measureAt`, `getDensityMatrixOf`, `getProbabilityCurrent`, `getQmExpectation`.

---

## Consumer call-site map

| Module | Bridge methods used |
|---|---|
| `js/spectral_overlay.js` (M5) | `previewEncoding` |
| `js/spectral_heatmap.js` (M10/M11) | `getBoardEncoding` |
| `js/spectral_filaments.js` (M10/M11.2) | `getBoardEncoding` |
| `js/spectral_isosurfaces.js` (M11.3.1) | `getBoardEncoding` |
| `js/spectral_board_tint.js` (M11.3.6) | `getBoardEncoding` |
| `js/spectral_dotplot.js` (M11.9) | `getBoardEncoding` |
| `js/spectral_qm_density.js` (M14.1) | `getQmDensity` |
| `js/spectral_qm_current.js` (M14.2) | `getProbabilityCurrent` |
| `GameBoard.js` `move()` | `applyMove` |
| Debug status panel | `getStatus`, `getConstants`, `getInitialPositionInfo` |
| `tests/parity-corpus.json` (M3.5) | `listInitialPieces`, `legalMovesAtInitial` |

**Notably NOT yet using `bridge.legalMoves` on the gameplay path** — that's the M4b.1 cutover work. User-click flow currently uses `Piece.getPossibleMoves` (JS legality classes).

---

## chess-spectral 1.6.1 engine surface — **HONORED**, wire-up via M13.4

The §16 ship-gate release delivered every engine method we asked for, plus the bonus `pv: List[Move4D]` principal variation in `SearchResult`. Bridge wire-up planned for M13.4 (`getBestMove`) and follow-ups:

| Bridge method | Upstream symbol | Wire-up | Notes |
|---|---|---|---|
| `getBestMove(opts)` | `chess_spectral_4d.engine.search.search(board, evaluator, options)` | **Wired in M13.4** ✅ | `evaluator` is one of `chess_spectral_4d.engine.eval.{material, qm, spectral}.evaluate`; `options` is `SearchOptions(max_depth, time_budget_ms, use_tt, use_mvv_lva, use_quiescence, quiescence_max_depth)`. State translation: chess4d.GameState → FEN4 → `Board4D.from_fen(fen4)`. |
| `evaluatePosition(opts)` | `chess_spectral_4d.engine.eval.{type}.evaluate(position, side_to_move, weights?)` | **Wired in M13.4** ✅ | Static eval at current state. Returns `{ok, evaluator, value, breakdown?}`. breakdown is per-piece (qm) or per-channel (spectral); material is scalar only. |
| `runTournament(opts)` | `chess_spectral.engine.tournament.run_round_robin(agents, n_games, max_plies)` | M13.5 (later) | Returns Elo + per-game records. Long-running; not for browser UI. |
| **bonus**: principal variation | `SearchResult.pv: List[Move4D]` | M14.5 | Bot's predicted line. Drives the "ghost arrow" preview overlay. |
| **bonus**: eval breakdown | `evaluate_breakdown(pos, side_to_move, weights?) → Dict[str, float]` | M14.6 | Per-piece (qm) or per-channel (spectral) decomposition. Drives the eval-bar debug overlay. |

**Engine-API design note**: with the engine running in the Pyodide worker, we don't need `applyMoveQuiet` or `getZobristHash` — those are search internals. The bridge surface is `getBestMove` + `evaluatePosition` + `runTournament` + the two bonus consumers above.

**Performance caveat**: the 4D engine docstring flags pure-Python move generation as slow (~250s at the 28-king starting position's 2152-move legal set). Pyodide is 2-5× slower than CPython. Practical search depths in-browser will be 1-2 ply at the starting position, deepening as material thins, with `time_budget_ms` as a hard cap. M11.32 (bitboard4d oracle) plus an internal-bitboard switch in chess-spectral's search is the path to deeper practical depths.

---

## chess-spectral 1.5 §17.1 (QM extension) — **HONORED, wire-up pending**

Tied to the design in `docs/qm_4d_design.md`. Lights up the M14.x visualization tier. All 7 methods land in `chess_spectral.qm_4d_bridge` (verified against the PyPI 1.5.0 README, 2026-04-29):

| Proposed method | Upstream symbol | Wire-up milestone | Notes |
|---|---|---|---|
| `getQmState()` | `qm_4d_bridge.get_qm_state` | **Wired in M11.27** ✅ | Returns `psi` as Float32 length 90112 (real+imag interleaved); `basisDim=45056`; `normSq` |
| `getQmDensity(pieceId?)` | `qm_4d_bridge.get_qm_density` | **Wired in M11.27** ✅ | Returns `density: Float32Array(4096)` summing `\|ψ\|²` over channels |
| `applyMoveQm(origin, dest)` | `qm_4d_bridge.apply_move_qm_full` | **Wired in M11.28** ✅ | PREVIEW-style: returns ψ_post but does NOT mutate chess4d.GameState. The classical advance still happens through applyMove() |
| `measureAt(coords, observable?)` | `qm_4d_bridge.measure_at` | **Wired in M11.29** ✅ | Born-rule projective measurement |
| `getDensityMatrixOf(pieceId)` | `qm_4d_bridge.get_density_matrix_of` | **Wired in M11.29** ✅ | For entanglement viz |
| `getProbabilityCurrent()` | `qm_4d_bridge.get_probability_current` | **Wired in M11.29** ✅ | `j_p(c) = Im(ψ* ∇ψ)` field for QM filaments |
| `getQmExpectation(observable, weights?)` | `qm_4d_bridge.get_qm_expectation` | **Wired in M11.29** ✅ | `⟨ψ\|H\|ψ⟩` for bot eval (composes with engine's `evaluatePosition`) |

**QM-API design call**: 7 read-only methods on the underlying state (the unitary `applyMoveQm` is the only mutation, and it semantically replaces the existing classical `applyMove`). All available in chess-spectral 1.5.0 (PyPI). The `chess_spectral.qm_4d` kinematics module exposes `H_rook_4`, `H_bishop_4`, `H_queen_4`, `H_king_4`, `H_knight_4` Hermitian observables; pawn observables defer to v1.7+ (pseudo-Hermitian η-metric, ADR-005).

**Wire format** (per upstream README §17.1 contract): every ψ return is a 1-D Float32 array of length `2 × 45056 = 90112`, where `psi[2k]` is `Re(ψ_k)` and `psi[2k+1]` is `Im(ψ_k)`. JS-side: `new Float32Array(transferableBuffer)` for shader uploads; complex multiply via `(re*re' - im*im', re*im' + im*re')` per pair.

---

## Things we forgot — open questions / gaps

The user said *"we always forget something"*. Here's the list of things that are gaps in our current API but haven't surfaced yet.

**Status update (2026-04-29)**: chess-spectral 1.5's **kinematic** half is **merged in source but not yet on PyPI**. The `chess_spectral.qm_4d` module exists in the upstream repo with the five non-pawn `H_piece_4` Hermitian observables, refined per-piece spectrum bounds, encoder spectral-identity verified at machine precision. PyPI 1.5 tag-push is pending the user's "immolation-suite" comprehensive smoke-test pass. Until that lands, `js/spectral_worker.js`'s `micropip.install("chess-spectral>=1.3.0")` resolves to 1.3.x — none of the proposed QM bridge methods will work at runtime even if added to the bridge. Track B (full unitary dynamics) still pending in source. The 1.6 engine module is under active design — see notebook §16. **Phase 6 calibration warning**: per the notebook's Othello prior, the engine eval will likely show a "shallow-depth wins, deep-depth vanishes" pattern; tournament tests must run at multiple depths (L4/L8/L16) to not over-fit weights to shallow play.


### Gameplay edge cases not exposed

| Gap | Current state | What to do |
|---|---|---|
| **Promotion choice** | `applyMove(origin, dest)` doesn't take a promotion target — chess4d auto-promotes (probably to queen). | Add optional `promoteTo: 'queen'\|'rook'\|...` arg. |
| **Castling notation** | Castling moves are sent as king-move-2-squares; chess4d figures it out from the king/rook positions. | **Validated** by 2D notebook §11.4.3.1 (P_castle predicate closes the castling gap upstream). chess4d 0.4 handles correctly. |
| **En passant** | Bridge has no special EP method — chess4d handles it as part of `applyMove`. | Verify works correctly with our move-input format. |
| **Threefold repetition** | Not tracked anywhere. UI never declares the draw. | Add `getDrawStatus()` → `'none'\|'threefold'\|'fifty-move'\|'insufficient'`. |
| **Move history JSON** | M11.6 export builds it in JS from `MoveManager.moveHistory.toList()`. Chess-spectral doesn't expose its own history. | Could add `getMoveHistory()` → `[Move4D, ...]` for symmetry. |

### State save / load not exposed

| Gap | What to do |
|---|---|
| **No `loadState(json)` method** — the bridge can't be restored to an arbitrary position. M11.6 export round-trip is one-way. | Add `loadFen4(fen4String)` and/or `loadJsonlFixture(piecesObj)`. Lets users paste an exported game back in. |
| **Save/restore in localStorage** — currently no autosave. Refresh = lose the game. | Out of scope for chess-spectral; chess4D-OC adds. |

### Dev/debug methods — **HONORED in chess-spectral 1.5 §17.5**

| Bridge method | Upstream symbol | Status |
|---|---|---|
| `getEncoderShape()` | `qm_4d_bridge.get_encoder_shape` | **Wired in M11.25** ✅ |
| `getVersion()` | `qm_4d_bridge.get_version` | **Wired in M11.25** ✅ |
| `getFen4State()` | (probed; hand-rolled fallback) | **Wired in M11.26** ✅ — upstream serializer probe path; M11.26.1 swaps to canonical once observed |
| `hasLegalMoves(team)` | (chess4d primitives + king-first scan) | **Wired in M11.26** ✅ — does NOT use upstream `qm_4d_bridge.has_legal_moves` because it operates on chess4d.GameState directly without a state-translation hop |
| `loadFen4(fen4)` | `qm_4d_bridge.load_fen4` | M11.26.1 — needs state-authority decision |
| `loadJsonlFixture(obj)` | `qm_4d_bridge.load_jsonl_fixture` | M11.26.1 |
| `getDrawStatus()` | `chess_spectral_4d.bridge.get_draw_status` | M11.26.1 — threefold/50-move/insufficient/stalemate priority; needs FEN4 round-trip to chess_spectral_4d.GameState4D |
| `listAvailableEvalTypes()` | (chess-spectral 1.6 — pending) | After 1.6 ships |

### FEN4 round-trip

| Gap | What to do |
|---|---|
| chess-spectral has `fen_4d.parse` (FEN4 → pieces dict) but no round-trip serializer. M11.6 hand-rolls FEN4 in JS. | Add `chess_spectral.fen_4d.serialize(pieces)` → string. Then `bridge.getFen4State()` → FEN4 string of current state. |

### Async cutover blockers

| Gap | What to do |
|---|---|
| `selectPiece()` in `js/main.js` is sync — uses `Piece.getPossibleMoves`. M4b.1 converts to async via `bridge.legalMoves`. | Just-in-time work for the M4b.1 PR. |
| `filterIllegalMoves()` — same. | Same. |
| `gameBoard.hasLegalMoves(team)` — currently iterates all pieces synchronously calling `getPossibleMoves`. | Convert to async or replace with `bridge.hasLegalMoves(team)` (new method we'd need to add). |
| `Bot.js` uses `piece.getPossibleMoves` directly. | Per "don't go too deep in M13": Bot.js stays sync, keeps Piece classes for its own use, until chess-spectral 1.6 engine ships and Bot.js becomes a thin wrapper around `bridge.getBestMove`. |

### Need-to-add for chess-spectral 1.6 to be useful

If chess-spectral 1.6 engine module ships, but chess4D-OC's `Bot.js` still uses sync JS legality, we end up with TWO bot engines (JS-side per-strategy + Python-side from chess-spectral). The transition path:

1. M4b.1 async cutover (this PR's predecessor) — user-click goes async
2. chess-spectral 1.6 ships — engine submodule with `getBestMove` + `evaluatePosition` + `runTournament`
3. chess4D-OC M13.4 — Bot.js becomes thin wrapper. `Bot.makeMove` → `await bridge.getBestMove({team})`. M13.2 strategy registry maps to bridge eval-type opts.

After that transition, the JS-side Piece classes can be deleted.

---

## Concrete asks for chess-spectral 1.5/1.6 — **delivery scorecard**

**chess-spectral 1.5 (QM + dev/debug surface)** — **delivered 2026-04-29 ✅**

- §17.1 QM extension (7): `get_qm_state`, `get_qm_density`, `apply_move_qm`, `apply_move_qm_full`, `measure_at`, `get_density_matrix_of`, `get_probability_current`, `get_qm_expectation` — all in `chess_spectral.qm_4d_bridge`
- §17.5 dev/debug (6): `get_version`, `get_encoder_shape`, `get_fen4_state`, `load_fen4`, `load_jsonl_fixture`, `has_legal_moves` — all in `chess_spectral.qm_4d_bridge`
- New `chess_spectral_4d.bridge` module: `load_state(fen4)`, `get_draw_status(state, has_legal_moves)` — priority threefold > 50-move > insufficient > stalemate

**chess-spectral 1.6 (engine module)** — **outstanding ⏳**

- `get_best_move(opts)` — Python-side iterative-deepening alpha-beta search
- `evaluate_position(opts)` — channel-energy weighted sum + classical material
- `run_tournament(opts)` — self-play harness for weight tuning

**Frontend wire-up plan** (the chess4D-OC bridge `chained()` and `call()` plumbing handles dispatch transparently — adding a method to the worker `handlers` object + a one-liner on the `bridge` object is all that's needed per method):

| Milestone | Methods wired | Risk |
|---|---|---|
| M11.25 ✅ | `getVersion`, `getEncoderShape` | Low — pure read-only, no state translation |
| M11.26 | FEN4 round-trip + `getFen4State`, `loadFen4`, `getDrawStatus`, `hasLegalMoves` | Med — `hasLegalMoves` is the async-cutover blocker for `GameBoard.hasLegalMoves` |
| M11.27 | `getQmState`, `getQmDensity` | Low — read-only QM kinematics; Float32Array transferables |
| M11.28+ | `applyMoveQmFull`, `measureAt`, `getDensityMatrixOf`, `getProbabilityCurrent`, `getQmExpectation` | Med — first mutation method requires understanding of unitary-vs-classical state authority |
| M14.x (paused for review per autonomy plan) | Visualization layers consuming the QM API | High — UX work, needs human eyes |
