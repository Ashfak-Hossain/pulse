import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { largestRemainderSplit } from '../src/index.js';

// Kept small enough that total × weight stays a safe integer
const total = fc.integer({ min: 0, max: 1_000_000_000 });
const weights = fc
  .array(fc.integer({ min: 0, max: 10_000 }), { minLength: 1, maxLength: 10 })
  .filter((ws) => ws.some((w) => w > 0));

// Every way to hand out `total` paisa to `n` people, e.g. 2 to 2 people: [0,2] [1,1] [2,0]
function allSplits(total: number, n: number): number[][] {
  if (n === 1) return [[total]];
  const splits: number[][] = [];
  for (let first = 0; first <= total; first++) {
    for (const rest of allSplits(total - first, n - 1)) splits.push([first, ...rest]);
  }
  return splits;
}

describe('largestRemainderSplit', () => {
  it('gives a leftover paisa to the lower index on a tie', () => {
    expect(largestRemainderSplit(100, [1, 1, 1])).toEqual([34, 33, 33]);
  });

  it('gives leftover paisa to the largest remainders, not the first person', () => {
    // Exact shares 133.47, 333.67, 533.87: the two largest fractions get the 2 leftover paisa
    expect(largestRemainderSplit(1001, [2, 5, 8])).toEqual([133, 334, 534]);
  });

  it.each([
    ['a negative total', -1, [1]],
    ['a fractional total', 1.5, [1]],
    ['no people', 100, []],
    ['only zero weights', 100, [0, 0]],
    ['a negative weight', 100, [1, -1]],
    ['a fractional weight', 100, [0.5, 1]],
    ['a gap in the weights', 100, new Array<number>(2).fill(1, 1)], // [<empty>, 1]
    ['an unsafe sum of weights', 0, [Number.MAX_SAFE_INTEGER, 1]],
    ['an unsafe total × weight', Number.MAX_SAFE_INTEGER, [2]],
  ])('rejects %s', (_, totalPaisa, ws) => {
    expect(() => largestRemainderSplit(totalPaisa, ws)).toThrow(RangeError);
  });

  it('always sums exactly to the total', () => {
    fc.assert(
      fc.property(total, weights, (t, ws) => {
        const shares = largestRemainderSplit(t, ws);
        expect(shares.reduce((a, b) => a + b, 0)).toBe(t);
      }),
    );
  });

  it('gives each person their exact share rounded down or up', () => {
    fc.assert(
      fc.property(total, weights, (t, ws) => {
        const sum = ws.reduce((a, b) => a + b, 0);
        largestRemainderSplit(t, ws).forEach((share, i) => {
          // Integer maths only: floor(t × w / sum) without a float division
          const scaled = t * ws[i]!;
          const floor = (scaled - (scaled % sum)) / sum;
          const ceil = scaled % sum === 0 ? floor : floor + 1;
          expect([floor, ceil]).toContain(share);
        });
      }),
    );
  });

  it('is as close to the exact shares as the best split found by brute force', () => {
    const smallWeights = fc
      .array(fc.integer({ min: 0, max: 6 }), { minLength: 1, maxLength: 4 })
      .filter((ws) => ws.some((w) => w > 0));
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 12 }), smallWeights, (t, ws) => {
        const sum = ws.reduce((a, b) => a + b, 0);
        // Squared distance from the exact shares, scaled by sum so it stays an integer
        const error = (shares: number[]) =>
          shares.reduce((e, s, i) => e + (s * sum - t * ws[i]!) ** 2, 0);
        const best = Math.min(...allSplits(t, ws.length).map(error));
        expect(error(largestRemainderSplit(t, ws))).toBe(best);
      }),
    );
  });
});
