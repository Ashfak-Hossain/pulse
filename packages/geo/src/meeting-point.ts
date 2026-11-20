import { cellCenter, type Cell, type Point } from './cells.js';
import { haversineMetres, type Distance } from './distance.js';

// A place a crew can gather, as stored in `meeting_point`.
export interface MeetingPoint {
  location: Point;
  cell: Cell;
}

// The point every member can walk to that costs least: total walking (straight line from each
// member's cell centre) plus driving from the point to the destination. Ties go to the earlier
// point; `undefined` when no point is within walking reach of everyone. O(m · p).
// Generic so callers get back their own row (with its id), not a bare MeetingPoint.
export function bestMeetingPoint<P extends MeetingPoint>(
  memberCells: readonly Cell[],
  points: readonly P[],
  destinationCell: Cell,
  dist: Distance,
  walkLimitM = 600,
): P | undefined {
  const homes = memberCells.map(cellCenter);
  let best: P | undefined;
  let bestMetres = Infinity;

  for (const point of points) {
    const walks = homes.map((home) => haversineMetres(home, point.location));
    if (walks.some((walk) => walk > walkLimitM)) continue;

    const walking = walks.reduce((sum, walk) => sum + walk, 0);
    const metres = walking + dist.between(point.cell, destinationCell).metres;
    if (metres < bestMetres) {
      best = point;
      bestMetres = metres;
    }
  }

  return best;
}
