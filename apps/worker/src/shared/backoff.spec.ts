import fc from 'fast-check';
import { backoffDelay } from './backoff.js';

describe('backoffDelay', () => {
  it('doubles from 250 ms and stops growing at 5 s', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((attempt) => backoffDelay(attempt))).toEqual([
      250, 500, 1000, 2000, 4000, 5000, 5000,
    ]);
  });

  it('takes its own base and cap', () => {
    expect(backoffDelay(3, { baseMs: 100, maxMs: 300 })).toBe(300);
    expect(backoffDelay(2, { baseMs: 100, maxMs: 300 })).toBe(200);
  });

  // Kafka's own startup takes ~20 s; the default client retries must wait at least that long
  it('waits more than 30 s in total over the first 10 retries', () => {
    let total = 0;
    for (let attempt = 1; attempt <= 10; attempt++) total += backoffDelay(attempt);
    expect(total).toBeGreaterThan(30_000);
  });

  it('never shrinks and never passes the cap, however many attempts', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000 }), (attempt) => {
        const delay = backoffDelay(attempt);
        expect(delay).toBeLessThanOrEqual(5000);
        expect(delay).toBeGreaterThanOrEqual(backoffDelay(Math.max(1, attempt - 1)));
        expect(Number.isFinite(delay)).toBe(true);
      }),
    );
  });
});
