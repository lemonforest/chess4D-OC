// M2 smoke test: verify the deployed preview loads, reaches the
// __SMOKE_READY__ signal, and doesn't throw any uncaught JS exceptions.
//
// Failure model:
//   - pageerror (uncaught JS exceptions) → FAIL. These are real bugs.
//   - console.error → logged for visibility, NOT failure. Upstream legacy
//       code logs benign errors (e.g., async OBJ load races).
//   - requestfailed → logged, NOT failure. Local Python http.server can't
//       always handle the 15MB OBJ files in parallel; CF Pages can.
//
// M3 will tighten this to also fail on Pyodide-specific console errors
// once spectral_bridge.init() is the gating signal.

import { test, expect } from '@playwright/test';
import { getPreviewUrl } from './smoke-helpers.js';

test.describe('Smoke', () => {
  test('preview loads, reaches SMOKE_READY, no uncaught exceptions', async ({ page }) => {
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

    // Allow up to 30s for the SMOKE_READY signal. M2 sets it on window.load,
    // so this should resolve quickly. M3 will add Pyodide cold-boot time
    // (3–8s typical, up to 15s on slow connections), still well under 30s.
    await page.waitForFunction(() => window.__SMOKE_READY__ === true, null, {
      timeout: 30_000,
    });

    // Visibility logs: not failure-inducing in M2.
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
