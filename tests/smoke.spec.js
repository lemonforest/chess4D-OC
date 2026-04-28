// M3 smoke test: verify the preview boots Pyodide via spectral_bridge,
// loads chess-spectral + chess4d, exposes the constants, and doesn't
// throw any uncaught JS exceptions during the cold-boot path.
//
// Failure model:
//   - pageerror (uncaught JS exceptions)            → FAIL
//   - __SMOKE_READY__ never set within 90s          → FAIL (Pyodide stuck)
//   - __SPECTRAL_INFO__.constants.MODULUS_4D wrong  → FAIL (wrong package)
//   - console.error / requestfailed                 → logged, NOT failure
//       (upstream legacy code logs benign errors; local http.server can
//        choke on parallel OBJ fetches; CF Pages won't.)

import { test, expect } from '@playwright/test';
import { getPreviewUrl } from './smoke-helpers.js';

const SMOKE_READY_TIMEOUT = 90_000; // Pyodide cold-boot 3–8s + micropip install 5–30s.

test.describe('Smoke', () => {
  test('preview boots Pyodide, loads packages, no uncaught exceptions', async ({ page }) => {
    const url = getPreviewUrl();

    const pageErrors = [];
    const consoleErrors = [];
    const requestFailures = [];

    page.on('pageerror', (err) => {
      pageErrors.push(`[pageerror] ${err.message}`);
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('requestfailed', (req) => {
      const failureText = req.failure()?.errorText || '';
      if (!req.url().endsWith('/favicon.ico')) {
        requestFailures.push(`${req.url()} — ${failureText}`);
      }
    });

    await page.goto(url, { waitUntil: 'load', timeout: 30_000 });

    // Wait for the bridge to finish init and set the ready signal.
    await page.waitForFunction(() => window.__SMOKE_READY__ === true, null, {
      timeout: SMOKE_READY_TIMEOUT,
    });

    // Pull the diagnostics object the bridge attached to window.
    const info = await page.evaluate(() => window.__SPECTRAL_INFO__);
    expect(info, 'window.__SPECTRAL_INFO__ should be set after init').toBeTruthy();
    expect(info.versions?.chess_spectral, 'chess-spectral version should be reported').toMatch(
      /^\d+\.\d+/
    );
    expect(info.versions?.chess4d, 'chess4d version should be reported').toMatch(/^\d+\.\d+/);

    // The constants are pulled from chess_spectral.phase_operators_4d at
    // runtime. MODULUS_4D = 145451 is documented in the plan; treat any
    // other value as a contract change that needs investigation.
    expect(info.constants?.MODULUS_4D, 'MODULUS_4D should be 145451').toBe(145451);

    // Loading overlay should be hidden after init.
    const overlayHidden = await page.evaluate(() => {
      const el = document.getElementById('engine-loading-overlay');
      return !el || el.classList.contains('engine-loading-overlay--hidden');
    });
    expect(overlayHidden, 'engine loading overlay should hide after init').toBe(true);

    // Visibility logs: not failure-inducing in M3.
    if (consoleErrors.length > 0) {
      console.log(`[smoke] saw ${consoleErrors.length} console.error events (not failing):`);
      consoleErrors.forEach((e) => console.log(`  ${e}`));
    }
    if (requestFailures.length > 0) {
      console.log(`[smoke] saw ${requestFailures.length} request failures (not failing):`);
      requestFailures.forEach((f) => console.log(`  ${f}`));
    }

    expect(pageErrors, `Uncaught JS exceptions:\n${pageErrors.join('\n')}`).toEqual([]);
  });
});
