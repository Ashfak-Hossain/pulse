import { cellCenter, type Cell, type Point } from './cells.js';

// Road length and driving time between two cells. Table seconds are free-flow; estimated
// seconds assume Dhaka traffic.
export interface Leg {
  readonly metres: number;
  readonly seconds: number;
}

// Road legs by origin then destination cell, as loaded from `cell_distance` by the shell.
export type DistanceTable = ReadonlyMap<Cell, ReadonlyMap<Cell, Leg>>;

// Road distance between cells
export interface Distance {
  between(from: Cell, to: Cell): Leg;
  // How many lookups so far used the straight-line estimate
  misses(): number;
}

// Mean Earth radius (IUGG). Treating the Earth as a sphere keeps haversine within 0.5%.
const EARTH_RADIUS_M = 6_371_008.8;
// road trip is about 1.4 times the straight line.
const ROAD_FACTOR = 1.4;
// Dhaka traffic averages about 15 km/h.
const FALLBACK_METRES_PER_SECOND = 15_000 / 3_600;

const SAME_CELL: Leg = { metres: 0, seconds: 0 };

// Straight-line distance over the Earth's surface in metres (haversine formula). O(1).
export function haversineMetres(a: Point, b: Point): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

  const latA = toRadians(a.lat);
  const latB = toRadians(b.lat);
  const latDelta = toRadians(b.lat - a.lat);
  const lngDelta = toRadians(b.lng - a.lng);

  const latTerm = Math.sin(latDelta / 2) ** 2;
  const lngTerm = Math.cos(latA) * Math.cos(latB) * Math.sin(lngDelta / 2) ** 2;
  const haversine = latTerm + lngTerm;

  // Guard against floating-point rounding pushing haversine above 1.
  const clampedHaversine = Math.min(haversine, 1);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(clampedHaversine));
}

// A `Distance` over a road table, estimating any pair the table lacks. O(1) per lookup.
export function makeDistance(table: DistanceTable): Distance {
  let missCount = 0;

  return {
    between(from, to) {
      if (from === to) return SAME_CELL;

      const leg = table.get(from)?.get(to);
      if (leg) return leg;

      missCount += 1;
      return estimateLeg(from, to);
    },
    misses: () => missCount,
  };
}

// Rounded to whole metres and seconds, like the integer columns of `cell_distance`.
function estimateLeg(from: Cell, to: Cell): Leg {
  const metres = haversineMetres(cellCenter(from), cellCenter(to)) * ROAD_FACTOR;

  return {
    metres: Math.round(metres),
    seconds: Math.round(metres / FALLBACK_METRES_PER_SECOND),
  };
}
