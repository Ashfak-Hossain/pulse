import type { Cell } from './cells.js';
import type { Distance } from './distance.js';

// The most stops `bestOrder` searches: 6! = 720 orders. A crew never has more.
export const MAX_STOPS = 6;

// A visiting order as indices into the stop list, and its road length.
export interface StopOrder {
  order: number[];
  metres: number;
}

// Road metres from the gate through every stop in the given order. O(n).
export function routeMetres(gateCell: Cell, stopCells: readonly Cell[], dist: Distance): number {
  let metres = 0;
  let from = gateCell;

  for (const stop of stopCells) {
    metres += dist.between(from, stop).metres;
    from = stop;
  }

  return metres;
}

// The shortest order to visit every stop from the gate, trying every order. Ties go to the order
// that comes first by index. O(n!) for n ≤ MAX_STOPS.
export function bestOrder(gateCell: Cell, stopCells: readonly Cell[], dist: Distance): StopOrder {
  const n = stopCells.length;
  if (n > MAX_STOPS) {
    throw new RangeError(`bestOrder handles at most ${MAX_STOPS} stops, got ${n}`);
  }

  // Each leg is looked up once: the search reuses it hundreds of times, and every fallback
  // lookup would count another miss.
  const legsFromGate = stopCells.map((stop) => dist.between(gateCell, stop).metres);
  const legsFrom = stopCells.map((from) => stopCells.map((to) => dist.between(from, to).metres));

  let best: StopOrder = { order: [], metres: Infinity };
  const path: number[] = [];
  const used = stopCells.map(() => false);

  // Depth first in index order, so the first order found at the best length wins every tie.
  const search = (legsFromLast: readonly number[], metresSoFar: number): void => {
    // Legs are never negative, so a partial route already as long as a complete one can only lose.
    if (best.order.length === n && metresSoFar >= best.metres) return;

    if (path.length === n) {
      best = { order: [...path], metres: metresSoFar };
      return;
    }

    for (const [next, legMetres] of legsFromLast.entries()) {
      const legsFromNext = legsFrom[next];
      // never undefined: the check only satisfies noUncheckedIndexedAccess
      if (used[next] || legsFromNext === undefined) continue;

      used[next] = true;
      path.push(next);
      search(legsFromNext, metresSoFar + legMetres);
      path.pop();
      used[next] = false;
    }
  };

  search(legsFromGate, 0);
  return best;
}
