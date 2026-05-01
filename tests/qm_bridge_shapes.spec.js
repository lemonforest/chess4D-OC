// M14.8 QM bridge-shape regression test. After the audit caught
// SpectralQmCurrent silently failing because get_probability_current's
// 2D ndarray got converted to nested JS arrays (length 4096) when our
// JS expected a flat Float32 (length 16384), this spec asserts the
// shapes our viz layers depend on.
//
// Each assertion describes WHO consumes the shape, so a future
// regression points directly at the broken viz module:
//   psi.length === 90112    → SpectralQmDensity / applyMoveQm consumers
//   density.length === 4096 → SpectralQmDensity (M14.1)
//   j.length === 16384      → SpectralQmCurrent (M14.2)
//   normSq ≈ 1.0            → Born-rule invariant
//   density.sum() ≈ 1.0     → Born-rule invariant

import { test, expect } from '@playwright/test';
import { getPreviewUrl } from './smoke-helpers.js';

const SMOKE_READY_TIMEOUT = 90_000;

test.describe('QM bridge shapes (M14.8)', () => {
  test('bridge returns shapes the viz layers expect', async ({ page }) => {
    const url = getPreviewUrl();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto(url, { waitUntil: 'load', timeout: 30_000 });
    await page.waitForFunction(() => window.__SMOKE_READY__ === true, null, {
      timeout: SMOKE_READY_TIMEOUT,
    });

    const result = await page.evaluate(async () => {
      const bridge = window.SpectralBridge;
      if (!bridge) return { error: 'no SpectralBridge' };
      try {
        const qms = await bridge.getQmState();
        const qd  = await bridge.getQmDensity();
        const pc  = await bridge.getProbabilityCurrent();
        const es  = await bridge.getEncoderShape();
        // Reduce numpy/typed-array proxy info to plain JS for transport.
        let densitySum = 0;
        if (qd && qd.density) {
          for (let i = 0; i < qd.density.length; i++) densitySum += qd.density[i];
        }
        return {
          qm_state: {
            ok: !!(qms && qms.ok),
            psiLength: qms && qms.psi ? qms.psi.length : -1,
            basisDim: qms && qms.basisDim,
            normSq: qms && qms.normSq,
          },
          qm_density: {
            ok: !!(qd && qd.ok),
            densityLength: qd && qd.density ? qd.density.length : -1,
            densitySum: densitySum,
          },
          prob_current: {
            ok: !!(pc && pc.ok),
            jLength: pc && pc.j ? pc.j.length : -1,
            // jShape: report whether it's flat or nested. flat = number;
            // nested = array of arrays (j[0] would be an array)
            jFirstElementType: pc && pc.j && pc.j.length > 0 ? typeof pc.j[0] : 'none',
          },
          encoder_shape: {
            ok: !!(es && es.ok),
            totalDim: es && es.totalDim,
            channelCount: es && es.channels ? es.channels.length : -1,
          },
        };
      } catch (e) {
        return { error: String(e && e.message || e) };
      }
    });

    expect(result.error, `bridge eval threw: ${result.error}`).toBeFalsy();

    // getQmState shape (M11.27 contract)
    expect(result.qm_state.ok).toBe(true);
    expect(result.qm_state.psiLength,
      'psi must be 90112 (real+imag interleaved Float32 for ψ ∈ ℂ^45056). ' +
      'Consumed by M14.1 / M14.5 / applyMoveQm / measureAt postCollapsePsi.'
    ).toBe(90112);
    expect(result.qm_state.basisDim).toBe(45056);
    expect(Math.abs(result.qm_state.normSq - 1.0)).toBeLessThan(1e-3);

    // getQmDensity shape (M14.1 consumer)
    expect(result.qm_density.ok).toBe(true);
    expect(result.qm_density.densityLength,
      'density must be Float32Array(4096). Consumed by SpectralQmDensity (M14.1).'
    ).toBe(4096);
    expect(Math.abs(result.qm_density.densitySum - 1.0),
      'density must sum to 1.0 (Born rule normalization)'
    ).toBeLessThan(1e-3);

    // getProbabilityCurrent shape (M14.2 consumer; this is the audit fix)
    expect(result.prob_current.ok).toBe(true);
    expect(result.prob_current.jLength,
      'j must be flat Float32Array(16384) — 4D flow vector per cell, ' +
      'flattened from upstream (4096, 4) ndarray. Consumed by ' +
      'SpectralQmCurrent (M14.2). Pre-M14.8 fix: j was 2D nested ' +
      '(length 4096), causing the viz to silently no-op.'
    ).toBe(16384);
    expect(result.prob_current.jFirstElementType,
      'j[0] must be a number (flat array), not an array (nested). ' +
      'Symptom of regression: nested layout means SpectralQmCurrent reads ' +
      'undefined when it tries j[4*idx + axis].'
    ).toBe('number');

    // getEncoderShape (utility)
    expect(result.encoder_shape.ok).toBe(true);
    expect(result.encoder_shape.totalDim).toBe(45056);
    expect(result.encoder_shape.channelCount).toBe(11);

    expect(pageErrors, `Uncaught errors during QM bridge tests:\n${pageErrors.join('\n')}`).toEqual([]);
  });
});
