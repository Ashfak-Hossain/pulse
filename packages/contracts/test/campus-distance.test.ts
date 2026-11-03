import { describe, expect, it } from 'vitest';
import { campusDistanceQuerySchema, campusDistanceSchema } from '../src/index.js';

describe('campusDistanceQuerySchema', () => {
  it.each([
    { lat: '90', lng: '180' },
    { lat: '-90', lng: '-180' },
    { lat: '0', lng: '0' },
    { lat: '23.8223', lng: '90.4274' },
  ])('coerces valid coordinates: %o', (query) => {
    expect(campusDistanceQuerySchema.parse(query)).toEqual({
      lat: Number(query.lat),
      lng: Number(query.lng),
    });
  });
  it.each([
    { lat: '90.1', lng: '0' },
    { lat: '-90.1', lng: '0' },
    { lat: '0', lng: '180.1' },
    { lat: '0', lng: '-180.1' },
    { lat: '', lng: '0' },
    { lat: ' ', lng: '0' },
    { lat: '0', lng: '' },
    { lat: 'abc', lng: '0' },
    { lat: 'Infinity', lng: '0' },
    { lat: 'NaN', lng: '0' },
    { lat: '0' },
    { lng: '0' },
    { lat: ['0', '1'], lng: '0' },
    { lat: '0', lng: '0', extra: 'x' },
  ])('rejects invalid input: %o', (query) => {
    expect(campusDistanceQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe('campusDistanceSchema', () => {
  it('accepts whole, non-negative metres', () => {
    expect(campusDistanceSchema.parse({ slug: 'aiub', distanceMetres: 0 })).toEqual({
      slug: 'aiub',
      distanceMetres: 0,
    });
  });
  it.each([
    { slug: 'aiub', distanceMetres: -1 },
    { slug: 'aiub', distanceMetres: 0.5 },
    { slug: 'AIUB', distanceMetres: 0 },
    { slug: 'aiub', distanceMetres: 0, extra: 'x' },
  ])('rejects an invalid response: %o', (body) => {
    expect(campusDistanceSchema.safeParse(body).success).toBe(false);
  });
});
