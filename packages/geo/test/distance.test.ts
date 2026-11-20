import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  cellCenter,
  haversineMetres,
  makeDistance,
  toCell,
  type DistanceTable,
} from '../src/index.js';

const aiubPoint = { lat: 23.8223, lng: 90.4274 };
const mirpur10Point = { lat: 23.8069, lng: 90.3687 };
const aiub = toCell(aiubPoint);
const mirpur10 = toCell(mirpur10Point);
const roadLeg = { metres: 9_100, seconds: 1_500 };
const table: DistanceTable = new Map([[mirpur10, new Map([[aiub, roadLeg]])]]);

// Greater Dhaka, where every rider lives
const dhakaPoint = fc.record({
  lat: fc.double({ min: 23.6, max: 24.0, noNaN: true }),
  lng: fc.double({ min: 90.2, max: 90.6, noNaN: true }),
});

describe('haversineMetres', () => {
  it('measures AIUB to Mirpur 10 as about 6.2 km in a straight line', () => {
    expect(haversineMetres(aiubPoint, mirpur10Point)).toBeCloseTo(6212, -1);
  });

  it('is zero for one point and the same in both directions', () => {
    fc.assert(
      fc.property(dhakaPoint, dhakaPoint, (a, b) => {
        expect(haversineMetres(a, a)).toBe(0);
        expect(haversineMetres(a, b)).toBeCloseTo(haversineMetres(b, a), 6);
      }),
    );
  });
});

describe('makeDistance', () => {
  it('returns the road leg from the table without counting a miss', () => {
    const dist = makeDistance(table);

    expect(dist.between(mirpur10, aiub)).toEqual(roadLeg);
    expect(dist.misses()).toBe(0);
  });

  // The table is directed (one-way streets), so the reverse pair is a separate lookup
  it('estimates a missing pair as 1.4 times the straight line at 15 km/h and counts it', () => {
    const dist = makeDistance(table);
    const straight = haversineMetres(cellCenter(aiub), cellCenter(mirpur10));

    const leg = dist.between(aiub, mirpur10);
    dist.between(aiub, mirpur10);

    expect(leg.metres).toBe(Math.round(straight * 1.4));
    expect(leg.seconds).toBe(Math.round((straight * 1.4) / (15_000 / 3_600)));
    expect(Number.isInteger(leg.metres) && Number.isInteger(leg.seconds)).toBe(true);
    expect(dist.misses()).toBe(2);
  });

  it('is zero inside one cell, even with an empty table', () => {
    const dist = makeDistance(new Map());

    expect(dist.between(aiub, aiub)).toEqual({ metres: 0, seconds: 0 });
    expect(dist.misses()).toBe(0);
  });
});
