# chess4D-OC — Claude Orientation

## What this is

A fork of [oanaunc/4d_chess](https://github.com/oanaunc/4d_chess) — an interactive 4D chess UI on the discrete hypercubic lattice {1..8}^4 (4096 cells, 896 pieces). This fork adds a **spectral visualization layer**: hover any piece, see the legal destinations colored by the post-move spectral signature using [chess-spectral](https://pypi.org/project/chess-spectral/) v1.3+.

The math is shipped via PyPI packages loaded into Pyodide at runtime. **This is a frontend integration project — do not reimplement piece movement, move legality, or the spectral encoder.**

## Stack

- Vanilla JavaScript (no transpiler, no bundler)
- Three.js r128 (CDN: `cdn.jsdelivr.net/npm/three@0.128.0/`)
- Pyodide (CDN: `cdn.jsdelivr.net/pyodide/v0.26.x/full/`) — added in M3
- Cloudflare Pages (static hosting, native per-PR previews)
- Playwright (CI smoke + parity harness, dev-dep only) — added in M2

No build step. No runtime npm dependencies. The site is the repo root served as static files.

## Architecture (target — fully realized at M5)

```
Three.js (main thread)
   GameBoard.js, Models.js, js/main.js
   - Holds JS-side mirror of the board (rendering only)
   - hover -> bridge.previewMoves(origin)
       |
       v
js/spectral_bridge.js (main thread, hand-rolled postMessage envelope)
       |
       v
js/spectral_worker.js (Web Worker)
   - Boots Pyodide
   - micropip-installs chess-spectral, python-chess4d-oana-chiru
   - Owns the canonical chess4d.GameState
   - Exposes: init / legalMoves / previewEncoding / applyMove /
              undo / getState / getConstants
```

Pyodide is the legality oracle and spectral encoder; JS handles rendering, input, and a thin state mirror. The Worker is non-negotiable — main-thread Pyodide jitters the raycaster on older laptops.

## Locked decisions

- **License**: MIT for this fork; chess-spectral (GPL-3.0-or-later) is loaded at runtime from PyPI by the user's browser, never bundled. See [NOTICE](NOTICE).
- **Pyodide threading**: Web Worker only. Main thread blocks the raycaster.
- **State authority**: Pyodide-canonical. JS holds a thin rendering mirror, not the source of truth.
- **Hosting**: Cloudflare Pages (Git Integration, no build step). PR previews are automatic. `_headers` file at repo root carries COOP/COEP for SharedArrayBuffer readiness.
- **Constants**: `MODULUS_4D`, generators, etc. are pulled from `chess_spectral.phase_operators_4d` at runtime. **Never hardcode them in JS** — the package is the source of truth.
- **Worker library**: hand-rolled `{id, method, args}` postMessage envelope (~30 LOC). No Comlink.
- **Three.js version**: r128 stays. Don't bundle a Three upgrade with this work.

## Where the plan lives

`C:\Users\sckir\.claude\plans\4d-chess-spectral-visualizer-floating-church.md`

Milestones M1 through M9 are defined there with acceptance criteria, file lists, and CI gates. Read it before opening a PR for any milestone.

## Critical files

| File | Role | Notes |
|---|---|---|
| `index.html` | Entry point | Loads Three.js, OBJLoader, OrbitControls, `js/tutorial.js` |
| `GameBoard.js` | Three.js scene + move execution | `move()` line 56, `showPossibleMoves()` line 743, `hidePossibleMoves()` line 844; `hasLegalMoves()` line 156 has a 50-piece cap (removed in M4b) |
| `Models.js` | Materials and OBJ-mesh factory | `createMesh()` line 149; extended in M5 with a glow shader |
| `MoveManager.js` | Move history + turn state | DMoveList branching tree |
| `js/main.js` | Game controller, hover, raycasting | `updatePieceHover()` line 1695, `filterIllegalMoves()` ~line 1789 |
| `js/pieces/*.js` | Per-piece move generation | Eventually deleted in M4b once Pyodide is the legality oracle |
| `js/spectral_bridge.js` | Main-thread bridge to Worker | NEW in M3 |
| `js/spectral_worker.js` | Pyodide host | NEW in M3 |
| `_headers` | Cloudflare COOP/COEP headers | NEW in M2 |
| `.github/workflows/*` | CI: CodeQL, lint, smoke, parity, next-milestone | Added across M1–M3.5 |

## Local development

```bash
python -m http.server 8000
# open http://localhost:8000
```

**Do not** open `index.html` via `file://` — Pyodide's micropip can't fetch from PyPI under a `file://` origin (CORS).

## Testing

After M2: `npx playwright test` runs smoke tests against a configured preview URL.
After M3.5: parity harness runs JS-vs-Python move-set diff for a 30-position corpus.

## Hard rules for contributors

1. **Don't vendor chess-spectral.** Pyodide must fetch it from PyPI at runtime in the user's browser. Bundling triggers GPL-3.0-or-later for the whole project. See [NOTICE](NOTICE).
2. **Don't hardcode `MODULUS_4D`, generators, or any chess-spectral constant in JS.** Always pull from `chess_spectral.phase_operators_4d` at runtime via the bridge.
3. **Don't reimplement move legality.** Use `chess_spectral.phase_operators_4d.occupation_aware_moves_a_4d` via the bridge. The JS legality engine is removed in M4b.
4. **Don't reimplement the encoder.** Use `chess_spectral.encoder_4d.encode_4d` via the bridge.
5. **Performance matters.** This must run on an older laptop. Don't add full-scene re-renders, expensive shaders, or per-frame Pyodide calls.
6. **Memory aux files** at `C:\Users\sckir\.claude\projects\D--GitHub-chess4D-OC\memory\` track per-session context for Claude. Update `milestone-tracker.md` after each merge.

## Lineage and credits

- Upstream: [oanaunc/4d_chess](https://github.com/oanaunc/4d_chess) (MIT)
- Research paper: "A Mathematical Framework for Four-Dimensional Chess" by Rinaldi (Unciuleanu) Oana and Costin-Gabriel Chiru
- chess-spectral: [lemonforest/chess-spectral](https://github.com/lemonforest/chess-spectral) (GPL-3.0-or-later)
- python-chess4d-oana-chiru: PyPI (Unlicense)

See [NOTICE](NOTICE) for the full runtime-aggregation licensing posture.
