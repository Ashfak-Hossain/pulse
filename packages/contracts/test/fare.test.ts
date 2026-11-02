import { describe, expect, it } from 'vitest';
import { fareSplitPreviewSchema, fareSplitRequestSchema } from '../src/index.js';

describe('fareSplitRequestSchema', () => {
  it.each([
    { totalPaisa: 0, weights: [1] },
    { totalPaisa: 10_000_000, weights: Array<number>(8).fill(100) },
    { totalPaisa: 10000, weights: [0, 1] },
  ])('accepts values at the limits: %o', (body) => {
    expect(fareSplitRequestSchema.parse(body)).toEqual(body);
  });

  it.each([
    { totalPaisa: -1, weights: [1] },
    { totalPaisa: 10_000_001, weights: [1] },
    { totalPaisa: 100.5, weights: [1] },
    { totalPaisa: '100', weights: [1] },
    { totalPaisa: 100, weights: [] },
    { totalPaisa: 100, weights: Array<number>(9).fill(1) },
    { totalPaisa: 100, weights: [0, 0] },
    { totalPaisa: 100, weights: [-1, 1] },
    { totalPaisa: 100, weights: [101] },
    { totalPaisa: 100, weights: [0.5] },
    { totalPaisa: 100, weights: ['1'] },
    { totalPaisa: 100 },
    { weights: [1] },
    { totalPaisa: 100, weights: [1], extra: 'unexpected' },
  ])('rejects invalid input before the money function runs: %o', (body) => {
    expect(fareSplitRequestSchema.safeParse(body).success).toBe(false);
  });
});

describe('fareSplitPreviewSchema', () => {
  it('accepts exact paisa shares', () => {
    const preview = { totalPaisa: 10000, shares: [3334, 3333, 3333] };
    expect(fareSplitPreviewSchema.parse(preview)).toEqual(preview);
  });

  it.each([
    { totalPaisa: 100, shares: [99] },
    { totalPaisa: 100, shares: [100.5] },
    { totalPaisa: 100, shares: [-1, 101] },
    { totalPaisa: 0, shares: [] },
    { totalPaisa: 0, shares: Array<number>(9).fill(0) },
    { totalPaisa: 100, shares: [100], extra: 'unexpected' },
  ])('rejects a response that breaks the public contract: %o', (body) => {
    expect(fareSplitPreviewSchema.safeParse(body).success).toBe(false);
  });
});
