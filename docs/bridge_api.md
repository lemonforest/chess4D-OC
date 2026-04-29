# `SpectralBridge` API surface — what we have, what we use, what's missing

Audited 2026-04-29 ahead of M4b.1 (chess4D-OC async cutover) and chess-spectral 1.5/1.6 engine work. Keep this in sync with `js/spectral_bridge.js` and `js/spectral_worker.js`.

The user said: *"we'll need to see what we opened up api wise and what we find we forgot. we always forget something"*. This is that audit.

---

## Currently exposed (13 methods)

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
| `setLegalityOps(ops)` | `'spatial' \| 'phase'` | `{ ok }` | URL flag `?legalityOps=` | Switches between spatial and phase-domain legality engines |
| `previewEncoding(origin)` | `{x,y,z,w}` | `{ ok, previews: [{dest, intensities}] }` | `spectral_overlay.js` (M5 hover) | Coalesced — one in-flight + one queued, replace on new hover |
| `getBoardEncoding(channels)` | `string[]` | `{ ok, channels: { name: Float32Array(4096) } }` | All five spectral overlay modules | Refreshes only when move history advances (cached) |
| `listInitialPieces()` | — | `{ pieces: [...] }` | M3.5 parity harness | Read-only |
| `legalMovesAtInitial(origin)` | `{x,y,z,w}` | `{ ok, moves: [...] }` | M3.5 parity harness | Doesn't depend on current state |

## Worker-side handlers (matched 1:1 with bridge methods above)

`js/spectral_worker.js` `handlers` object: `init`, `getStatus`, `getConstants`, `getInitialPositionInfo`, `applyMove`, `undo`, `resetToInitial`, `legalMoves`, `setLegalityOps`, `previewEncoding`, `getBoardEncoding`, `listInitialPieces`, `legalMovesAtInitial`.

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
| `GameBoard.js` `move()` | `applyMove` |
| Debug status panel | `getStatus`, `getConstants`, `getInitialPositionInfo` |
| `tests/parity-corpus.json` (M3.5) | `listInitialPieces`, `legalMovesAtInitial` |

**Notably NOT yet using `bridge.legalMoves` on the gameplay path** — that's the M4b.1 cutover work. User-click flow currently uses `Piece.getPossibleMoves` (JS legality classes).

---

## Missing for chess-spectral 1.6 (engine submodule)

These methods will need to be added when the engine module ships. Listed with proposed signatures so chess-spectral 1.6 has a contract to ship against:

| Proposed method | Args | Returns | Purpose |
|---|---|---|---|
| `getBestMove(opts)` | `{ team, maxDepth?, timeBudgetMs?, evalType?, weights? }` | `{ ok, move: {x0,y0,z0,w0,x1,y1,z1,w1}, score, depth, elapsedMs }` | Run a Python-side search. Search loop runs at native speed inside Pyodide; one bridge round-trip per move. |
| `evaluatePosition(opts)` | `{ team, evalType, weights? }` | `{ ok, score, breakdown? }` | Get eval score for the current state without searching. Useful for live position-strength readout. |
| `runTournament(opts)` | `{ pairs: [(stratA, stratB)], nGames, maxMovesPerGame? }` | `{ ok, results: [{ stratA, stratB, wins, losses, draws }] }` | Self-play harness for tuning channel-energy / QM-eval weights. |
| `applyMoveQuiet(origin, dest)` | `{x,y,z,w}` × 2 | `{ ok, undoToken }` | Search-only: apply without spectral refresh; return undo token. Or: keep search entirely Python-side and don't expose this. |
| `getZobristHash()` | — | `bigint` | For JS-side TT. **Or skip** — if the engine is Python-side, transposition table is internal to chess-spectral and not exposed. |

**Engine-API design call**: with the engine in Python, we don't actually need `applyMoveQuiet` or `getZobristHash` — those are internals. The bridge surface for engine work is just **`getBestMove`** + **`evaluatePosition`** + **`runTournament`**. Three new methods.

---

## Missing for chess-spectral 1.5 (QM extension)

Tied to the design in `docs/qm_4d_design.md`. These methods light up the M14.x visualization tier:

| Proposed method | Args | Returns | Purpose |
|---|---|---|---|
| `getQmState()` | — | `{ ok, psi: ComplexArray, basisDim, normSq }` | Current ψ as a flat complex array (real+imag interleaved Float32). Used by M14.1 / M14.2 / M14.3. |
| `getQmDensity(pieceId?)` | `int?` | `{ ok, density: Float32Array(4096) }` | `\|ψ_p\|²` per cell. With `pieceId` = single-piece marginal; without = full position density. M14.1 |
| `applyMoveQm(origin, dest)` | `{x,y,z,w}` × 2 | `{ ok, U_move?: ComplexMatrix }` | Apply unitary move; optionally returns the U used (for animation). M14.3 |
| `measureAt(coords, observable?)` | `{x,y,z,w}, string?` | `{ ok, sampledOutcome, postCollapsePsi }` | Born-rule projective measurement. M14.5 |
| `getDensityMatrixOf(pieceId)` | `int` | `{ ok, rho: ComplexMatrix, purity, rank }` | For entanglement viz. M14.4 |
| `getProbabilityCurrent()` | — | `{ ok, j: Float32Array(4096 × 4) }` | `j_p(c) = Im(ψ* ∇ψ)` field for QM filaments. M14.6 |
| `getQmExpectation(observable, weights?)` | `string, dict?` | `{ ok, value }` | `⟨ψ\|H\|ψ⟩` for bot eval. Composes with engine's `evaluatePosition`. |

**QM-API design call**: 7 new methods, all read-only on the underlying state (the unitary `applyMoveQm` is the only mutation, and it semantically replaces the existing classical `applyMove`). All gated on chess-spectral 1.5 actually shipping.

---

## Things we forgot — open questions / gaps

The user said *"we always forget something"*. Here's the list of things that are gaps in our current API but haven't surfaced yet:

### Gameplay edge cases not exposed

| Gap | Current state | What to do |
|---|---|---|
| **Promotion choice** | `applyMove(origin, dest)` doesn't take a promotion target — chess4d auto-promotes (probably to queen). | Add optional `promoteTo: 'queen'\|'rook'\|...` arg. |
| **Castling notation** | Castling moves are sent as king-move-2-squares; chess4d figures it out from the king/rook positions. Doesn't fail loudly if rook moved. | Verify chess4d 0.4 handles this correctly. Add a test in M3.5 corpus. |
| **En passant** | Bridge has no special EP method — chess4d handles it as part of `applyMove`. | Verify works correctly with our move-input format. |
| **Threefold repetition** | Not tracked anywhere. UI never declares the draw. | Add `getDrawStatus()` → `'none'\|'threefold'\|'fifty-move'\|'insufficient'`. |
| **Move history JSON** | M11.6 export builds it in JS from `MoveManager.moveHistory.toList()`. Chess-spectral doesn't expose its own history. | Could add `getMoveHistory()` → `[Move4D, ...]` for symmetry. |

### State save / load not exposed

| Gap | What to do |
|---|---|
| **No `loadState(json)` method** — the bridge can't be restored to an arbitrary position. M11.6 export round-trip is one-way. | Add `loadFen4(fen4String)` and/or `loadJsonlFixture(piecesObj)`. Lets users paste an exported game back in. |
| **Save/restore in localStorage** — currently no autosave. Refresh = lose the game. | Out of scope for chess-spectral; chess4D-OC adds. |

### Dev/debug methods worth exposing

| Gap | What to do |
|---|---|
| **`getEncoderShape()`** — channel names + dim per channel | Useful for the visualizer to validate at startup that chess-spectral version matches expected channel set. |
| **`listAvailableEvalTypes()`** | Once engine ships, lets UI populate the eval-type dropdown dynamically. |
| **`getVersion()`** | We have `getStatus` but no clean version string. |

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

## Concrete asks for chess-spectral 1.5/1.6

If you're scoping the Python work, these are the bridge methods to land:

**chess-spectral 1.5 (QM extension):**
1. `getQmState`, `getQmDensity`, `applyMoveQm`, `measureAt`, `getDensityMatrixOf`, `getProbabilityCurrent`, `getQmExpectation`

**chess-spectral 1.6 (engine module):**
2. `getBestMove`, `evaluatePosition`, `runTournament`

**Either version, low-effort additions worth bundling:**
3. `getDrawStatus`, `loadFen4`, `serializeFen4`, `getEncoderShape`, `listAvailableEvalTypes`, `getVersion`

That's **9 + 6 = 15 new methods** total across both releases. The chess4D-OC frontend has the slot infrastructure for all of them already (the bridge `chained()` and `call()` plumbing handles the worker-side dispatch transparently).
