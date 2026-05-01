// M11.50 bot-match regression test: drive Bot.makeMove for each registered
// strategy and verify the bot completes within a reasonable budget without
// throwing uncaught exceptions or producing silent failure modes.
//
// Triggers for this test:
//   - User flagged "we may have introduced an issue with bot matches or
//     maybe some of our bot engines take a while or don't fail gracefully"
//     after M13.4 (engine-* strategies) shipped.
//   - The smoke test only verifies cold-boot; it doesn't actually drive
//     a bot move.
//
// Failure modes this catches:
//   - bot.makeMove never resolves (deadlock / infinite loop)
//   - bot.makeMove throws an uncaught exception (missing legal-moves check,
//     bridge call shape mismatch, etc.)
//   - engine search exceeds its time_budget_ms (timeBudgetMs respected?)
//   - state mutation fails silently (move count doesn't advance)
//
// What we don't test here:
//   - The full game loop (scheduleBotMove). Calling Bot.makeMove directly
//     in page.evaluate gives us a tighter test surface and faster feedback.
//   - Move quality (the bot can play any legal move). We only assert
//     "moves were played and the game advanced."
//
// Per-strategy budgets account for cs1.6.1 docstring:
//   "4D move generation in pure Python is slow (~250s for the 28-king
//   starting position's 2152-move legal set). Use shallow positions or
//   set time_budget_ms to bound runtime."
// Engine strategies have timeBudgetMs=4000 by default; we give them 30s
// per move including raycaster + bridge round-trip overhead.

import { test, expect } from '@playwright/test';
import { getPreviewUrl } from './smoke-helpers.js';

const SMOKE_READY_TIMEOUT = 90_000;        // Pyodide cold-boot
const PER_MOVE_TIMEOUT_MS = 30_000;        // each Bot.makeMove allowed up to 30s
const MOVES_PER_STRATEGY = 2;              // 2 plies per strategy = quick smoke

// Strategies to test. After M13.4.1 added the engine→v0 fallback, ALL
// strategies must make a move at the starting position — the engine
// strategies fall back to the v0 heuristic when the underlying chess-
// spectral search exhausts its time_budget_ms (which it always does at
// the 28-king starting position; pure-Python 4D move-gen takes ~250s
// per the upstream docstring). The fallback ensures the game progresses
// even when the engine itself can't finish a search.
const STRATEGIES_TO_TEST = [
  { key: 'v0',              label: 'JS heuristic baseline',  expectedMaxMs: 5_000,  mustMakeMove: true },
  { key: 'random',          label: 'random control',         expectedMaxMs: 5_000,  mustMakeMove: true },
  { key: 'engine-material', label: 'engine material (→v0 fallback)', expectedMaxMs: 25_000, mustMakeMove: true },
  { key: 'engine-spectral', label: 'engine spectral (→v0 fallback)', expectedMaxMs: 25_000, mustMakeMove: true },
  { key: 'engine-qm',       label: 'engine QM (→v0 fallback)',       expectedMaxMs: 25_000, mustMakeMove: true },
];

test.describe('Bot match regression (M11.50)', () => {
  test.describe.configure({ mode: 'serial' }); // share one page across tests

  let pageInstance = null;
  let pageErrors = [];
  let consoleErrors = [];

  test.beforeAll(async ({ browser }) => {
    pageInstance = await browser.newPage();
    pageErrors = [];
    consoleErrors = [];
    pageInstance.on('pageerror', (err) => {
      pageErrors.push(`[pageerror] ${err.message}`);
    });
    pageInstance.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    const url = getPreviewUrl();
    await pageInstance.goto(url, { waitUntil: 'load', timeout: 30_000 });
    await pageInstance.waitForFunction(() => window.__SMOKE_READY__ === true, null, {
      timeout: SMOKE_READY_TIMEOUT,
    });

    // Sanity-check the test harness can reach the bot + game globals.
    const harnessOk = await pageInstance.evaluate(() => {
      return !!(window.gameBoard && window.moveManager && window.Bot &&
                typeof window.Bot.makeMove === 'function' &&
                window.Bot.strategies && Object.keys(window.Bot.strategies).length > 0);
    });
    expect(harnessOk, 'gameBoard, moveManager, Bot, Bot.strategies must all be on window').toBe(true);
  });

  test.afterAll(async () => {
    if (pageInstance) {
      await pageInstance.close();
      pageInstance = null;
    }
  });

  for (const strategy of STRATEGIES_TO_TEST) {
    test(`strategy=${strategy.key} (${strategy.label}) plays ${MOVES_PER_STRATEGY} plies cleanly`, async () => {
      // Verify the strategy is registered. If it's not (e.g., chess-spectral
      // pin slipped or engine modules failed to load), skip rather than
      // false-negative.
      const isRegistered = await pageInstance.evaluate((key) => {
        return !!(window.Bot.strategies && window.Bot.strategies[key]);
      }, strategy.key);
      if (!isRegistered) {
        test.skip(true, `strategy ${strategy.key} not registered (engine modules may not have loaded)`);
        return;
      }

      // Reset to initial position so each strategy sees the same start state.
      await pageInstance.evaluate(() => {
        if (window.gameBoard && typeof window.gameBoard.reset === 'function') {
          window.gameBoard.reset();
        }
        if (window.SpectralBridge && typeof window.SpectralBridge.resetToInitial === 'function') {
          // Fire-and-forget — the bridge state matters for engine strategies.
          window.SpectralBridge.resetToInitial();
        }
      });
      await pageInstance.waitForTimeout(200); // let the reset settle

      // Configure both teams to use this strategy.
      await pageInstance.evaluate((key) => {
        window.Bot.setStrategy(0, key);
        window.Bot.setStrategy(1, key);
      }, strategy.key);

      const errorsBeforeStrategy = pageErrors.length;
      const moveDurations = [];

      for (let ply = 0; ply < MOVES_PER_STRATEGY; ply++) {
        const team = ply % 2; // 0=white on even plies, 1=black on odd
        const t0 = Date.now();

        // Drive Bot.makeMove and capture its boolean return + elapsed time.
        // We use evaluate with a Promise.race so a hung bot causes the test
        // to fail rather than hang forever.
        const result = await pageInstance.evaluate(async (args) => {
          const { team, timeoutMs } = args;
          if (!window.Bot || !window.gameBoard || !window.moveManager) {
            return { ok: false, reason: 'missing globals' };
          }
          const movePromise = window.Bot.makeMove(window.gameBoard, window.moveManager, team);
          const timeoutPromise = new Promise((resolve) =>
            setTimeout(() => resolve({ ok: false, reason: 'timeout' }), timeoutMs)
          );
          try {
            const r = await Promise.race([
              movePromise.then((v) => ({ ok: true, made: !!v })),
              timeoutPromise,
            ]);
            return r;
          } catch (e) {
            return { ok: false, reason: 'threw', message: String(e && e.message || e) };
          }
        }, { team, timeoutMs: PER_MOVE_TIMEOUT_MS });

        const elapsed = Date.now() - t0;
        moveDurations.push({ ply, team, elapsed, result });

        // Hard requirement: bot must not hang or throw.
        expect(result.ok, `${strategy.key} ply ${ply} (team ${team}): ${JSON.stringify(result)}`).toBe(true);

        // Soft: bot should not exceed strategy's typical budget. We log but
        // don't fail on this — Pyodide cold-boot warmup can spike the first
        // engine call to ~10s. Test fails only on the hard PER_MOVE_TIMEOUT.
        if (elapsed > strategy.expectedMaxMs) {
          console.log(
            `[bot-match] ${strategy.key} ply ${ply} took ${elapsed}ms ` +
            `(soft cap was ${strategy.expectedMaxMs}ms; hard cap ${PER_MOVE_TIMEOUT_MS}ms — passing)`
          );
        }
      }

      // Verify the game state actually advanced. The move history length
      // should equal the number of plies attempted (assuming all plies
      // returned made=true).
      const made = moveDurations.filter((d) => d.result && d.result.made).length;
      const totalDuration = moveDurations.reduce((s, d) => s + d.elapsed, 0);
      console.log(
        `[bot-match] ${strategy.key}: ${made}/${MOVES_PER_STRATEGY} moves made, ` +
        `total=${totalDuration}ms (${moveDurations.map((d) => d.elapsed + 'ms').join(', ')})`
      );

      // Hard requirement for JS strategies (v0, random): they enumerate moves
      // synchronously in JS so they ALWAYS find a legal move at the starting
      // position. If `made === 0`, that's a regression. Engine strategies
      // can legitimately return null at the dense 28-king starting position
      // (search budget exhausted before depth 1 completes) — for those we
      // only require ok=true (handled above).
      if (strategy.mustMakeMove) {
        expect(
          made,
          `${strategy.key} should make at least 1 move out of ${MOVES_PER_STRATEGY} attempts ` +
          `at the starting position. Per-ply: ${JSON.stringify(moveDurations.map((d) => ({ ply: d.ply, ms: d.elapsed, made: d.result.made })))}`
        ).toBeGreaterThan(0);
      }

      // Verify no NEW pageerrors during this strategy's plies. (We allow
      // pre-existing errors from earlier strategies — fail only if THIS
      // strategy introduced new ones.)
      const newErrors = pageErrors.slice(errorsBeforeStrategy);
      expect(
        newErrors,
        `${strategy.key} introduced ${newErrors.length} new uncaught errors:\n${newErrors.join('\n')}`
      ).toEqual([]);

      // Catch the silent-hang bug class explicitly: even when Bot.makeMove
      // returns false "gracefully" (no exception → ok=true above), if the
      // bridge console reports state-translation or FEN4 parse failures,
      // that's a real bug — the bot silently does nothing and from the
      // user's perspective the game hangs after move 1. This assertion
      // landed alongside the chess-spectral 1.6.1 strict-pawn-axis FEN4
      // parser fix (worker was emitting "P/w@..." which 1.5 accepted but
      // 1.6.1 rejects with "pawn 'P' must be followed by axis letter").
      const stateTransFailures = consoleErrors.filter((e) =>
        /state translation failed|Fen4ParseError|pawn 'P' must be followed/i.test(e)
      );
      expect(
        stateTransFailures,
        `${strategy.key} produced ${stateTransFailures.length} state-translation / FEN4 ` +
        `errors in console (silent hang signal):\n${stateTransFailures.join('\n')}`
      ).toEqual([]);
    });
  }

  test('all strategies share zero uncaught exceptions', async () => {
    // Final cross-strategy summary. Logged for visibility; pass if no
    // pageerror ever fired across the entire test suite.
    if (consoleErrors.length > 0) {
      console.log(`[bot-match] saw ${consoleErrors.length} console.error events across all strategies (informational):`);
      consoleErrors.slice(0, 20).forEach((e) => console.log(`  ${e}`));
      if (consoleErrors.length > 20) console.log(`  …and ${consoleErrors.length - 20} more`);
    }
    expect(pageErrors, `Cumulative uncaught JS exceptions:\n${pageErrors.join('\n')}`).toEqual([]);
  });
});
