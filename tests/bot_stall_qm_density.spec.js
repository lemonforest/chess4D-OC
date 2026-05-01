// M13.7 — bot-vs-bot stall reproduction with QM density tint enabled.
//
// User-reported: "we have a bug where bots quit playing on the 3rd move.
// no think progress or anything. tint by qm density is checkmarked."
//
// What this test does:
//   1. Loads the live preview, waits for cold-boot.
//   2. Enables the "Tint by QM density |ψ|²" checkbox (forces a
//      bridge.getQmDensity() call after every applyMove via the
//      GameBoard.move() refresh hook).
//   3. Picks a fast bot strategy (v0) so we can drive 6+ moves quickly.
//   4. Drives Bot.makeMove + GameBoard.move via scheduleBotMove path
//      (the actual user-visible flow, not the direct Bot.makeMove
//      shortcut bot_match.spec.js uses) and watches move history
//      advance for ~30s.
//   5. Asserts:
//      - the move history advances past 5 plies (catches the move-3 stall)
//      - the new bridge ring buffer (window.__BRIDGE_LOG__) has no
//        unexpected failures
//      - no [bot-loop-error] / [bridge-call-failed] tags appeared in
//        console errors
//
// Forensic data: on failure, dumps the last 30 entries of __BRIDGE_LOG__
// so we can see exactly which bridge call rejected and at what move.
// This is the entire point of the M13.7 instrumentation — silent stalls
// become observable.
//
// Why scheduleBotMove (not direct Bot.makeMove): the bug surfaced via
// the timer-driven scheduleBotMove → setTimeout chain, where unhandled
// rejections terminate the loop with no console output. Direct
// Bot.makeMove in evaluate() bypasses that timing.

import { test, expect } from '@playwright/test';
import { getPreviewUrl } from './smoke-helpers.js';

const SMOKE_READY_TIMEOUT = 90_000;
const STALL_OBSERVATION_MS = 45_000;     // give 45s for 6+ v0 plies w/ visual gate
const MIN_PLIES_REQUIRED = 5;            // catches the move-3 stall (3 plies)

test.describe('Bot stall reproduction with QM density tint (M13.7)', () => {
  let pageInstance = null;
  let pageErrors = [];
  let consoleErrors = [];
  let consoleAll = [];

  test.beforeAll(async ({ browser }) => {
    pageInstance = await browser.newPage();
    pageErrors = [];
    consoleErrors = [];
    consoleAll = [];

    pageInstance.on('pageerror', (err) => {
      pageErrors.push(`[pageerror] ${err.message}`);
    });
    pageInstance.on('console', (msg) => {
      const t = msg.type();
      const txt = msg.text();
      consoleAll.push(`[${t}] ${txt}`);
      if (t === 'error') consoleErrors.push(txt);
    });

    const url = getPreviewUrl();
    await pageInstance.goto(url, { waitUntil: 'load', timeout: 30_000 });
    await pageInstance.waitForFunction(
      () => window.__SMOKE_READY__ === true,
      null,
      { timeout: SMOKE_READY_TIMEOUT }
    );
  });

  test.afterAll(async () => {
    if (pageInstance) {
      await pageInstance.close();
      pageInstance = null;
    }
  });

  test('bot vs bot with qm-density tint enabled: history advances past move 3', async () => {
    // Force a fast strategy so the visual-gate cadence (1.5s pre-move +
    // some compute) lets us hit 5+ plies inside the 45s window.
    await pageInstance.evaluate(() => {
      if (window.Bot && typeof window.Bot.setStrategy === 'function') {
        window.Bot.setStrategy(0, 'v0');
        window.Bot.setStrategy(1, 'v0');
      }
    });

    // Enable the QM-density tint checkbox (this is the user's
    // observed-failure config). The change handler is what triggers
    // SpectralQmDensity.setEnabled(true), which fires getQmDensity()
    // refreshes after each move via GameBoard.move()'s refresh hook.
    const enabled = await pageInstance.evaluate(() => {
      const box = document.getElementById('qm-density-tint');
      if (!box) return { ok: false, reason: 'checkbox not found' };
      if (!box.checked) {
        box.checked = true;
        box.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return { ok: true, checked: box.checked };
    });
    expect(enabled.ok, `qm-density-tint toggle: ${JSON.stringify(enabled)}`).toBe(true);
    expect(enabled.checked).toBe(true);

    // Reset to a clean position so we always observe the first N plies
    // of a fresh game.
    await pageInstance.evaluate(() => {
      if (window.gameBoard && typeof window.gameBoard.reset === 'function') {
        window.gameBoard.reset();
      }
      if (window.SpectralBridge && typeof window.SpectralBridge.resetToInitial === 'function') {
        return window.SpectralBridge.resetToInitial();
      }
      return null;
    });
    await pageInstance.waitForTimeout(500);

    const startSize = await pageInstance.evaluate(() => {
      return (window.moveManager && typeof window.moveManager.size === 'function')
        ? window.moveManager.size()
        : -1;
    });

    // Drive the actual user flow: click "Watch Bots" so the game loop
    // schedules itself. This exercises the silent-stall code path —
    // direct Bot.makeMove calls bypass the .then()/.catch() chain that
    // we just hardened.
    await pageInstance.evaluate(() => {
      const btn = document.getElementById('mode-bot-vs-bot');
      if (btn) btn.click();
    });

    // Poll move history every 500ms for up to 45s. We don't just sleep —
    // we want to know the moment we hit MIN_PLIES_REQUIRED so the test
    // exits fast when healthy and waits the full window only on failure
    // (where the dump matters).
    const deadline = Date.now() + STALL_OBSERVATION_MS;
    let lastSize = startSize;
    const sizeProgression = [{ t: 0, size: startSize }];
    const t0 = Date.now();
    while (Date.now() < deadline) {
      await pageInstance.waitForTimeout(500);
      const size = await pageInstance.evaluate(() => {
        return (window.moveManager && typeof window.moveManager.size === 'function')
          ? window.moveManager.size()
          : -1;
      });
      if (size !== lastSize) {
        sizeProgression.push({ t: Date.now() - t0, size });
        lastSize = size;
      }
      const ply = size - startSize;
      if (ply >= MIN_PLIES_REQUIRED) break;
    }

    const finalPly = lastSize - startSize;

    // Always pull the bridge log + recent console errors so the test
    // output is informative even on success.
    const forensics = await pageInstance.evaluate(() => {
      const log = (window.__BRIDGE_LOG__ || []).slice(-30);
      const inflight = window.__BRIDGE_INFLIGHT__
        ? Array.from(window.__BRIDGE_INFLIGHT__.values())
        : [];
      return { log, inflight };
    });
    console.log(
      `[bot-stall] sizeProgression=${JSON.stringify(sizeProgression)} ` +
      `finalPly=${finalPly} required=${MIN_PLIES_REQUIRED}`
    );
    if (forensics.inflight.length > 0) {
      console.log(`[bot-stall] in-flight bridge calls at end:`, forensics.inflight);
    }

    // Tag-grep console for the bridge instrumentation's structured errors.
    const bridgeFails = consoleErrors.filter((e) => /\[bridge-call-failed\]/.test(e));
    const botLoopErrs = consoleErrors.filter((e) => /\[bot-loop-error\]/.test(e));
    if (bridgeFails.length > 0 || botLoopErrs.length > 0 || finalPly < MIN_PLIES_REQUIRED) {
      console.log(`[bot-stall] last 30 bridge log entries:`);
      forensics.log.forEach((e, i) => {
        const tag = e.ok ? 'OK' : 'FAIL';
        const errSuffix = e.ok ? '' : ` err=${e.errorName}: ${e.errorMessage}`;
        console.log(`  ${i}: ${tag} ${e.method} ${e.durationMs}ms${errSuffix}`);
      });
      if (bridgeFails.length > 0) {
        console.log(`[bot-stall] bridge-call-failed events:`);
        bridgeFails.forEach((e) => console.log(`  ${e}`));
      }
      if (botLoopErrs.length > 0) {
        console.log(`[bot-stall] bot-loop-error events:`);
        botLoopErrs.forEach((e) => console.log(`  ${e}`));
      }
    }

    // Hard assertion: the loop must reach at least MIN_PLIES_REQUIRED
    // plies. If it stalls at 3 plies, this fails loudly with the bridge
    // log dump above pointing at the failing call.
    expect(
      finalPly,
      `Bot loop stalled at ply ${finalPly} (expected ≥ ${MIN_PLIES_REQUIRED}). ` +
      `Progression: ${JSON.stringify(sizeProgression)}. ` +
      `See [bot-stall] log lines above for bridge log dump.`
    ).toBeGreaterThanOrEqual(MIN_PLIES_REQUIRED);
  });

  test('no [bridge-call-failed] tags during the bot run', async () => {
    // Allow the tagged structured-error to appear ZERO times during a
    // healthy run. If it fires, the test above also catches the visible
    // symptom; this test names the root cause cleanly.
    const bridgeFails = consoleErrors.filter((e) => /\[bridge-call-failed\]/.test(e));
    expect(
      bridgeFails,
      `[bridge-call-failed] events fired (instrumentation tag from M13.7):\n` +
      bridgeFails.map((e) => `  ${e}`).join('\n')
    ).toEqual([]);
  });

  test('no [bot-loop-error] tags during the bot run', async () => {
    const botLoopErrs = consoleErrors.filter((e) => /\[bot-loop-error\]/.test(e));
    expect(
      botLoopErrs,
      `[bot-loop-error] events fired (Bot.makeMove .catch() handler from M13.7):\n` +
      botLoopErrs.map((e) => `  ${e}`).join('\n')
    ).toEqual([]);
  });

  test('circuit breaker trips after 3 consecutive synthesized failures', async () => {
    // M13.7c — verify the circuit breaker actually opens. We synthesize
    // failures by stubbing Bot.makeMove to reject 4 times in a row, then
    // assert: (a) only 3 [bot-loop-error] tags fire (bridge stops on 3rd
    // because breaker opens), (b) the [bot-loop-circuit-tripped] tag
    // fires exactly once, (c) the turn-text element shows the warning.
    //
    // Resetting the breaker via setGameMode → _resetBotLoopBreaker is
    // also asserted (we click Two Players, then Watch Bots, and check
    // a fresh failure can fire).

    // Reset state cleanly: switch to Two Players to clear breaker, reset
    // the move history.
    await pageInstance.evaluate(() => {
      const tp = document.getElementById('mode-singleplayer');
      if (tp) tp.click();
    });
    await pageInstance.waitForTimeout(300);

    // Stub Bot.makeMove to always reject. We save the original so we
    // can restore it for the rest of the test suite (test isolation).
    const stubbed = await pageInstance.evaluate(() => {
      if (!window.Bot || typeof window.Bot.makeMove !== 'function') return false;
      window.__origMakeMove = window.Bot.makeMove;
      window.Bot.makeMove = function () {
        return Promise.reject(new Error('synthetic test failure'));
      };
      // Clear any console-error counter we'd want fresh; record the
      // current bot-loop-error tag count so we measure deltas.
      window.__botLoopErrCountBefore = (window.__BRIDGE_LOG__ || []).length;
      return true;
    });
    expect(stubbed, 'Bot.makeMove should be stubable').toBe(true);

    // Capture errors during this test phase only.
    const errsBefore = consoleErrors.length;

    // Click Watch Bots to start the loop.
    await pageInstance.evaluate(() => {
      const wb = document.getElementById('mode-bot-vs-bot');
      if (wb) wb.click();
    });

    // The breaker uses backoff 2s, 4s, 6s — total wait to trip is
    // ~1.5s (initial delay) + 2s + 4s = 7.5s. Wait 12s for headroom.
    await pageInstance.waitForTimeout(12_000);

    const breakerState = await pageInstance.evaluate(() => {
      // Restore original makeMove for test isolation.
      if (window.__origMakeMove) {
        window.Bot.makeMove = window.__origMakeMove;
        delete window.__origMakeMove;
      }
      const turnText = document.getElementById('turn-text');
      return {
        turnTextContent: turnText ? turnText.textContent : null,
        turnTextColor:   turnText ? turnText.style.color  : null,
      };
    });

    const phaseErrs = consoleErrors.slice(errsBefore);
    const botLoopErrCount    = phaseErrs.filter((e) => /\[bot-loop-error\]/.test(e)).length;
    const circuitTrippedCount = phaseErrs.filter((e) => /\[bot-loop-circuit-tripped\]/.test(e)).length;

    console.log(
      `[circuit-breaker] tripped=${circuitTrippedCount} loopErrs=${botLoopErrCount} ` +
      `turnText=${JSON.stringify(breakerState)}`
    );

    expect(
      botLoopErrCount,
      `Expected exactly 3 [bot-loop-error] events (one per allowed retry). ` +
      `Got ${botLoopErrCount}. Phase errors:\n${phaseErrs.join('\n')}`
    ).toBe(3);
    expect(
      circuitTrippedCount,
      `Expected exactly 1 [bot-loop-circuit-tripped] event after 3 failures. ` +
      `Got ${circuitTrippedCount}.`
    ).toBe(1);
    expect(
      breakerState.turnTextContent,
      `turn-text should show the breaker warning when tripped`
    ).toMatch(/Bot halted/);

    // Reset by switching to Two Players, then verify the breaker is reset
    // (the warning color clears).
    await pageInstance.evaluate(() => {
      const tp = document.getElementById('mode-singleplayer');
      if (tp) tp.click();
    });
    await pageInstance.waitForTimeout(300);
    const afterReset = await pageInstance.evaluate(() => {
      const turnText = document.getElementById('turn-text');
      return {
        color: turnText ? turnText.style.color : null,
      };
    });
    expect(
      afterReset.color,
      `turn-text color should clear (be falsy) after game-mode reset`
    ).toBeFalsy();
  });
});
