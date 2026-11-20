import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { cellCenter, cellsWithin, haversineMetres, toCell } from '../src/index.js';

const aiub = { lat: 23.8223, lng: 90.4274 };
// Greater Dhaka, where every rider lives
const dhakaPoint = fc.record({
  lat: fc.double({ min: 23.6, max: 24.0, noNaN: true }),
  lng: fc.double({ min: 90.2, max: 90.6, noNaN: true }),
});

describe('cells', () => {
  it('puts AIUB in its resolution-8 cell', () => {
    expect(toCell(aiub)).toBe('883cf13b03fffff');
  });

  // The centre is the only point we ever show for a home, so it must stay inside the same cell
  // and close to the real point (a resolution-8 hexagon is about 530 m from centre to corner)
  it('maps any point to a cell whose centre is nearby and maps back to that cell', () => {
    fc.assert(
      fc.property(dhakaPoint, (point) => {
        const cell = toCell(point);
        const centre = cellCenter(cell);
        expect(toCell(centre)).toBe(cell);
        expect(haversineMetres(point, centre)).toBeLessThan(600);
      }),
    );
  });

  it('grows rings of 1, 7 and 19 cells, always including the cell itself', () => {
    const cell = toCell(aiub);
    expect([0, 1, 2].map((k) => cellsWithin(cell, k).length)).toEqual([1, 7, 19]);
    expect(cellsWithin(cell, 2)).toContain(cell);
  });
});
