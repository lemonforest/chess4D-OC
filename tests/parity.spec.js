// M3.5 parity harness Playwright spec.
//
// Loads tests/parity.html?auto=1, waits for window.__PARITY_DONE__ = true,
// then asserts no diffs. Skipped-js / skipped-py are surfaced as warnings
// but do NOT fail the test on their own — they typically reflect API gaps
// in the JS chain that we'll wire up in M4a, not real legality bugs.
//
// To turn skipped into a failure once M4a wires JS legality through the
// bridge, change SKIPPED_FAILS_TEST to true.

import { test, expect } from '@playwright/test';
import { getPreviewUrl } from './smoke-helpers.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const PARITY_TIMEOUT = 5 * 60_000; // 5 min — Pyodide cold-boot + 896 piece comparisons.
const SKIPPED_FAILS_TEST = false;

test.describe('Parity', () => {
  test.setTimeout(PARITY_TIMEOUT);

  test('JS Piece chain agrees with chess-spectral phase ops on initial position', async ({ page }) => {
    const baseUrl = getPreviewUrl();
    const url = `${baseUrl.replace(/\/$/, '')}/tests/parity.html?auto=1`;

    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(`[pageerror] ${err.message}`));

    await page.goto(url, { waitUntil: 'load', timeout: 60_000 });

    await page.waitForFunction(() => window.__PARITY_DONE__ === true, null, {
      timeout: PARITY_TIMEOUT - 30_000,
    });

    const results = await page.evaluate(() => window.__PARITY_RESULTS__);
    expect(results, 'window.__PARITY_RESULTS__ should be populated').toBeTruthy();

    // Persist the diff JSON as a CI artifact so reviewers can inspect.
    try {
      const out = path.resolve('test-results', 'parity-diff.json');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify(results, null, 2));
      console.log(`[parity] diff JSON written to ${out}`);
    } catch (err) {
      console.warn(`[parity] failed to write diff JSON: ${err.message}`);
    }

    console.log(
      `[parity] ${results.match}/${results.total} match, ` +
        `${results.diff} diff, ${results.skipped_js} skipped(js), ${results.skipped_py} skipped(py)`
    );

    // Top 5 diffs by piece — surfaced in CI logs even when running headless.
    if (results.diff > 0) {
      const diffs = results.results.filter((r) => r.verdict === 'diff').slice(0, 5);
      console.log('[parity] first 5 disagreements:');
      for (const d of diffs) {
        console.log(
          `  ${d.piece.type} at (${d.origin.x},${d.origin.y},${d.origin.z},${d.origin.w}): ` +
            `JS-only=${d.diff.onlyA.length}, Py-only=${d.diff.onlyB.length}`
        );
      }
    }

    expect(pageErrors, `Uncaught JS exceptions:\n${pageErrors.join('\n')}`).toEqual([]);
    expect(results.diff, 'JS-vs-Python diff count must be 0').toBe(0);

    if (SKIPPED_FAILS_TEST) {
      expect(
        results.skipped_js + results.skipped_py,
        'No piece should be skipped once M4a wires JS legality through the bridge'
      ).toBe(0);
    }
  });
});
