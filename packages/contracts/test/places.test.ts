import { describe, expect, it } from 'vitest';
import {
  createGateSchema,
  createMeetingPointSchema,
  createZoneSchema,
  meetingPointQuerySchema,
  updateGateSchema,
  updateZoneSchema,
} from '../src/index.js';

const square = [
  [90.36, 23.8],
  [90.375, 23.8],
  [90.375, 23.815],
  [90.36, 23.815],
  [90.36, 23.8],
];
const zone = { name: 'Mirpur 10', area: { type: 'MultiPolygon', coordinates: [[square]] } };
const gate = { name: 'Main gate', location: { lat: 23.8223, lng: 90.4274 } };

describe('createGateSchema', () => {
  it('accepts a gate and makes it a plain gate unless it says primary', () => {
    expect(createGateSchema.parse(gate)).toEqual({ ...gate, isPrimary: false });
  });

  it.each([
    ['an unknown key', { ...gate, cell: '883cf13b03fffff' }],
    ['a blank name', { ...gate, name: '   ' }],
    ['a hidden character', { ...gate, name: 'Main‮gate' }],
    ['a latitude off the globe', { ...gate, location: { lat: 91, lng: 90 } }],
    ['a longitude off the globe', { ...gate, location: { lat: 23, lng: -181 } }],
  ])('rejects %s', (_, body) => {
    expect(createGateSchema.safeParse(body).success).toBe(false);
  });
});

describe('updateGateSchema', () => {
  it('accepts any one field, and rejects an empty change', () => {
    expect(updateGateSchema.parse({ isPrimary: true })).toEqual({ isPrimary: true });
    expect(updateGateSchema.safeParse({}).success).toBe(false);
  });
});

describe('createZoneSchema', () => {
  it('accepts a closed MultiPolygon', () => {
    expect(createZoneSchema.parse(zone)).toEqual(zone);
  });

  it.each([
    ['a ring that does not close', [[square.slice(0, 4).concat([[90.36, 23.81]])]]],
    ['a ring with three positions', [[[square[0], square[1], square[0]]]]],
    ['a latitude off the globe', [[square.map(([lng]) => [lng, 95])]]],
    ['a longitude off the globe', [[square.map(([, lat]) => [190, lat])]]],
    ['a position with three numbers', [[square.map(([lng, lat]) => [lng, lat, 0])]]],
    ['no polygons', []],
  ])('rejects %s', (_, coordinates) => {
    expect(
      createZoneSchema.safeParse({ ...zone, area: { ...zone.area, coordinates } }).success,
    ).toBe(false);
  });

  it('rejects another geometry type and unknown keys', () => {
    expect(
      createZoneSchema.safeParse({ ...zone, area: { ...zone.area, type: 'Polygon' } }).success,
    ).toBe(false);
    expect(createZoneSchema.safeParse({ ...zone, area: { ...zone.area, crs: 4326 } }).success).toBe(
      false,
    );
    expect(createZoneSchema.safeParse({ ...zone, campusId: 'x' }).success).toBe(false);
    expect(updateZoneSchema.safeParse({}).success).toBe(false);
  });
});

describe('createMeetingPointSchema', () => {
  const point = { name: 'Kuril flyover', kind: 'junction', location: gate.location };

  it('stores a point with no zone unless one is given', () => {
    expect(createMeetingPointSchema.parse(point)).toEqual({ ...point, zoneId: null });
  });

  it('rejects an unknown kind, a zone id that is not a UUID and unknown keys', () => {
    expect(createMeetingPointSchema.safeParse({ ...point, kind: 'parking' }).success).toBe(false);
    expect(createMeetingPointSchema.safeParse({ ...point, zoneId: '12' }).success).toBe(false);
    expect(createMeetingPointSchema.safeParse({ ...point, isActive: false }).success).toBe(false);
  });

  it('filters the list by a zone id only', () => {
    expect(meetingPointQuerySchema.safeParse({ zoneId: 'nope' }).success).toBe(false);
    expect(meetingPointQuerySchema.safeParse({ zone: 'x' }).success).toBe(false);
  });
});
