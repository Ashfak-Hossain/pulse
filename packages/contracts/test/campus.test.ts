import { describe, expect, it } from 'vitest';
import {
  campusListSchema,
  campusParamsSchema,
  campusSchema,
  campusSlugSchema,
} from '../src/index.js';

const aiub = {
  id: '6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b',
  name: 'American International University-Bangladesh',
  slug: 'aiub',
  emailDomains: ['aiub.edu', 'student.aiub.edu'],
  timezone: 'Asia/Dhaka',
  location: { lat: 23.8223, lng: 90.4274 },
};

describe('campusSlugSchema', () => {
  it.each(['aiub', 'north-south', 'campus-2', 'x'.repeat(64)])('accepts %s', (slug) => {
    expect(campusSlugSchema.safeParse(slug).success).toBe(true);
  });

  it.each(['', 'AIUB', 'a_b', 'a b', '-aiub', 'aiub-', 'a--b', 'x'.repeat(65)])(
    'rejects "%s"',
    (slug) => {
      expect(campusSlugSchema.safeParse(slug).success).toBe(false);
    },
  );
});

describe('campusParamsSchema', () => {
  it('reads the slug from the route', () => {
    expect(campusParamsSchema.parse({ slug: 'aiub' })).toEqual({ slug: 'aiub' });
  });

  it('rejects unknown keys', () => {
    expect(campusParamsSchema.safeParse({ slug: 'aiub', id: '1' }).success).toBe(false);
  });
});

describe('campusSchema', () => {
  it('accepts a campus as clients see it', () => {
    expect(campusSchema.parse(aiub)).toEqual(aiub);
  });

  // The database row has more (created_at); the contract must not let it through
  it('rejects fields that are not in the contract', () => {
    expect(campusSchema.safeParse({ ...aiub, createdAt: '2026-10-31' }).success).toBe(false);
  });

  it.each([
    { lat: 91, lng: 90 },
    { lat: 23, lng: 181 },
    { lat: -91, lng: 90 },
  ])('rejects a location off the globe: %o', (location) => {
    expect(campusSchema.safeParse({ ...aiub, location }).success).toBe(false);
  });

  it('rejects an id that is not a UUID', () => {
    expect(campusSchema.safeParse({ ...aiub, id: '42' }).success).toBe(false);
  });
});

describe('campusListSchema', () => {
  it('wraps the campuses in items', () => {
    expect(campusListSchema.parse({ items: [aiub] })).toEqual({ items: [aiub] });
  });

  it('rejects a bare array (the wrapper leaves room for a page cursor later)', () => {
    expect(campusListSchema.safeParse([aiub]).success).toBe(false);
  });
});
