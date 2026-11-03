import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { retryStep, retryTiers } from '../src/index.js';

describe('retryStep', () => {
  it.each([
    [1, { kind: 'retry', tier: '10s' }],
    [2, { kind: 'retry', tier: '1m' }],
    [3, { kind: 'retry', tier: '10m' }],
    [4, { kind: 'dead' }],
  ])('after failure %i → %o', (failures, step) => {
    expect(retryStep(failures)).toEqual(step);
  });

  it('never retries after the third failure', () => {
    fc.assert(
      fc.property(fc.integer({ min: 4, max: 1_000_000 }), (failures) => {
        expect(retryStep(failures)).toEqual({ kind: 'dead' });
      }),
    );
  });

  // A shorter wait after a later failure would hammer a service that is already down
  it('never waits less after a later failure', () => {
    const delays = retryTiers.map((tier) => tier.delayMs);
    expect(delays).toEqual(delays.toSorted((a, b) => a - b));
    expect(new Set(delays).size).toBe(delays.length);
  });

  // Called with 0 means the handler counted wrong; failing loudly beats retrying forever
  it.each([0, -1, 1.5, Number.NaN])('throws on %d failures', (failures) => {
    expect(() => retryStep(failures)).toThrow(RangeError);
  });
});
