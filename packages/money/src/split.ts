/**
 * Splits totalPaisa into integer shares proportional to weights that sum exactly to totalPaisa
 * (largest remainder method). Ties go to the lower index.
 * Time: O(n log n) for n weights, from one sort.
 */
export function largestRemainderSplit(totalPaisa: number, weights: readonly number[]): number[] {
  if (!Number.isSafeInteger(totalPaisa) || totalPaisa < 0) {
    throw new RangeError(`totalPaisa must be a non-negative integer, got ${totalPaisa}`);
  }
  // Copying turns gaps ([1, , 1]) into undefined; every/map/reduce would silently skip them
  const ws = [...weights];
  if (ws.length === 0) {
    throw new RangeError('weights must not be empty');
  }
  if (!ws.every((w) => Number.isSafeInteger(w) && w >= 0)) {
    throw new RangeError('weights must be non-negative integers');
  }
  const sum = ws.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(sum)) {
    throw new RangeError('sum of weights is too large to compute exactly');
  }
  if (sum === 0) {
    throw new RangeError('at least one weight must be greater than 0');
  }

  // Integer maths only: a float division could be off by a tiny bit and round the wrong way
  const scaled = ws.map((w) => totalPaisa * w);
  if (!scaled.every(Number.isSafeInteger)) {
    throw new RangeError('totalPaisa × weight is too large to compute exactly');
  }
  const shares = scaled.map((s) => (s - (s % sum)) / sum);
  const remainders = scaled.map((s) => s % sum);

  const left = totalPaisa - shares.reduce((a, b) => a + b, 0);
  // Largest remainder first; equal remainders go to the lower index, so replays are identical
  const byRemainder = shares
    .map((_, i) => i)
    .sort((a, b) => remainders[b]! - remainders[a]! || a - b);
  for (const i of byRemainder.slice(0, left)) {
    shares[i]! += 1;
  }
  return shares;
}
