// Resolve the preview URL to test against. The smoke workflow sets
// PREVIEW_URL after polling Cloudflare's deployment status. Local dev passes
// it explicitly: PREVIEW_URL=http://localhost:8000 npx playwright test.

export function getPreviewUrl() {
  const url = process.env.PREVIEW_URL;
  if (!url) {
    throw new Error(
      'PREVIEW_URL env var not set. Set it to the Cloudflare preview URL ' +
        '(or http://localhost:8000 if running locally with `npm run serve`).'
    );
  }
  return url;
}
