import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  bestMeetingPoint,
  cellCenter,
  haversineMetres,
  toCell,
  type Distance,
  type MeetingPoint,
} from '../src/index.js';

interface TestPoint extends MeetingPoint {
  name: string;
}

// Driving metres to the destination by the point's cell label, so each point can cost anything
function driveTable(metresByCell: Readonly<Record<string, number>>): Distance {
  return {
    between: (from) => ({ metres: metresByCell[from] ?? 0, seconds: 0 }),
    misses: () => 0,
  };
}

const homeCell = toCell({ lat: 23.8223, lng: 90.4274 });
const home = cellCenter(homeCell);
// 0.0018° of latitude is about 200 m
const north = (degrees: number) => ({ lat: home.lat + degrees, lng: home.lng });

describe('bestMeetingPoint', () => {
  const atHome: TestPoint = { name: 'at home', location: home, cell: 'p1' };
  const shortWalk: TestPoint = { name: 'short walk', location: north(0.0018), cell: 'p2' };
  const tooFar: TestPoint = { name: 'too far', location: north(0.009), cell: 'p3' };
  const dist = driveTable({ p1: 5_400, p2: 5_000, p3: 0 });

  it('walks 200 m to save 400 m of driving, but never past the walk limit', () => {
    const best = bestMeetingPoint([homeCell], [atHome, shortWalk, tooFar], 'gate', dist);
    expect(best?.name).toBe('short walk');
  });

  it('picks the earlier of two points that cost the same', () => {
    const twin: TestPoint = { name: 'twin', location: shortWalk.location, cell: 'p4' };
    const tied = driveTable({ p2: 5_000, p4: 5_000 });

    expect(bestMeetingPoint([homeCell], [shortWalk, twin], 'gate', tied)?.name).toBe('short walk');
    expect(bestMeetingPoint([homeCell], [twin, shortWalk], 'gate', tied)?.name).toBe('twin');
  });

  it('returns undefined when no point is within walking reach', () => {
    expect(bestMeetingPoint([homeCell], [tooFar], 'gate', dist)).toBeUndefined();
    expect(bestMeetingPoint([homeCell], [], 'gate', dist)).toBeUndefined();
  });

  // A box of about 2 km near AIUB, so some points are walkable for everyone and some are not
  const nearAiub = fc.record({
    lat: fc.double({ min: 23.81, max: 23.83, noNaN: true }),
    lng: fc.double({ min: 90.41, max: 90.43, noNaN: true }),
  });
  const pointsWithDrives = fc.array(fc.tuple(nearAiub, fc.nat(3_000)), { maxLength: 8 });

  it('matches brute force and keeps every member within the walk limit', () => {
    fc.assert(
      fc.property(fc.array(nearAiub, { maxLength: 4 }), pointsWithDrives, (homes, drives) => {
        const memberCells = homes.map((point) => toCell(point));
        const points = drives.map(([location], i) => ({ location, cell: `p${i}` }));
        const dist = driveTable(
          Object.fromEntries(drives.map(([, metres], i) => [`p${i}`, metres])),
        );

        const walksTo = (point: MeetingPoint) =>
          memberCells.map((cell) => haversineMetres(cellCenter(cell), point.location));
        const reachable = points.filter((point) => walksTo(point).every((walk) => walk <= 600));
        const cost = (point: MeetingPoint) =>
          walksTo(point).reduce((sum, walk) => sum + walk, 0) +
          dist.between(point.cell, 'gate').metres;
        const cheapest = Math.min(...reachable.map(cost));
        const expected = reachable.find((point) => cost(point) === cheapest);

        const best = bestMeetingPoint(memberCells, points, 'gate', dist);
        expect(best).toBe(expected);
        if (best) expect(walksTo(best).every((walk) => walk <= 600)).toBe(true);
      }),
    );
  });
});
