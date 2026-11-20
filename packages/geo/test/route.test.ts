import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { bestOrder, MAX_STOPS, routeMetres, type Distance } from '../src/index.js';

// Cells are named `c0`…`c6`; c0 is the gate. Metres come from a matrix, so legs can be one-way.
function matrixDistance(metres: readonly (readonly number[])[]): Distance {
  const index = (cell: string) => Number(cell.slice(1));
  return {
    between: (from, to) => ({
      metres: from === to ? 0 : (metres[index(from)]?.[index(to)] ?? 0),
      seconds: 0,
    }),
    misses: () => 0,
  };
}

// Stops on one road at 3, 1 and 2 km from the gate
const roadKm = [0, 3, 1, 2];
const onOneRoad = matrixDistance(roadKm.map((a) => roadKm.map((b) => Math.abs(a - b) * 1000)));

// Every order of 0…n-1, in index order: the brute-force oracle
function allOrders(n: number): number[][] {
  if (n === 0) return [[]];
  return allOrders(n - 1).flatMap((order) =>
    Array.from({ length: n }, (_, at) => [...order.slice(0, at), n - 1, ...order.slice(at)]),
  );
}

describe('routeMetres', () => {
  it('adds the legs from the gate through the stops in the given order', () => {
    expect(routeMetres('c0', ['c1', 'c2', 'c3'], onOneRoad)).toBe(3000 + 2000 + 1000);
    expect(routeMetres('c0', [], onOneRoad)).toBe(0);
  });
});

describe('bestOrder', () => {
  it('drives out along the road, nearest stop first', () => {
    expect(bestOrder('c0', ['c1', 'c2', 'c3'], onOneRoad)).toEqual({
      order: [1, 2, 0],
      metres: 3000,
    });
  });

  it('returns an empty order of length zero when there are no stops', () => {
    expect(bestOrder('c0', [], onOneRoad)).toEqual({ order: [], metres: 0 });
  });

  it('still returns a full order when every leg is unreachable', () => {
    const unreachable = matrixDistance(
      Array.from({ length: 3 }, () => [Infinity, Infinity, Infinity]),
    );
    expect(bestOrder('c0', ['c1', 'c2'], unreachable)).toEqual({ order: [0, 1], metres: Infinity });
  });

  it('refuses more than six stops', () => {
    const seven = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c1'];
    expect(() => bestOrder('c0', seven, onOneRoad)).toThrow(RangeError);
  });

  // Small one-way metres make many ties, so this also proves the first-by-index tie break
  it('matches brute force over every order, ties included', () => {
    const matrix = fc.array(fc.array(fc.nat(20), { minLength: 7, maxLength: 7 }), {
      minLength: 7,
      maxLength: 7,
    });

    fc.assert(
      fc.property(fc.integer({ min: 0, max: MAX_STOPS }), matrix, (n, metres) => {
        const dist = matrixDistance(metres);
        const stops = Array.from({ length: n }, (_, i) => `c${i + 1}`);
        const cost = (order: number[]) =>
          routeMetres(
            'c0',
            order.map((i) => `c${i + 1}`),
            dist,
          );

        const orders = allOrders(n).sort((a, b) => a.join().localeCompare(b.join()));
        const shortest = Math.min(...orders.map(cost));
        const firstShortest = orders.find((order) => cost(order) === shortest);

        expect(bestOrder('c0', stops, dist)).toEqual({ order: firstShortest, metres: shortest });
      }),
    );
  });
});
