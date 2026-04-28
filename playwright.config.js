// Playwright config for chess4D-OC smoke + parity tests.
// Smoke harness runs against a deployed preview URL (Cloudflare Pages),
// resolved at runtime by tests/smoke-helpers.js. Local dev uses
// `npm run serve` (= python -m http.server 8000) and PREVIEW_URL=http://localhost:8000.

export default {
  testDir: './tests',
  // Pyodide cold-boot (3-8s) + micropip install (5-30s) + page settle.
  // The smoke spec's per-action timeout is 90s for SMOKE_READY; the test-
  // wide timeout has to be larger or the test cuts off mid-init.
  timeout: 180_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
};
