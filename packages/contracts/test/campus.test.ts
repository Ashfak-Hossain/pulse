import { describe, expect, it } from 'vitest';
import {
  campusListSchema,
  campusParamsSchema,
  campusSchema,
  campusSlugSchema,
  createCampusSchema,
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

describe('createCampusSchema', () => {
  const body = {
    name: 'American International University-Bangladesh',
    slug: 'aiub',
    emailDomains: ['aiub.edu', 'student.aiub.edu'],
    timezone: 'Asia/Dhaka',
    location: { lat: 23.8223, lng: 90.4274 },
  };

  it('accepts a new campus and trims the name', () => {
    expect(createCampusSchema.parse({ ...body, name: '  AIUB  ' })).toEqual({
      ...body,
      name: 'AIUB',
    });
  });

  // Intl's own list misses these (it holds older aliases), so the check must not rely on it
  it.each(['UTC', 'Asia/Kolkata', 'Europe/Kyiv', 'America/Argentina/Buenos_Aires', 'Etc/GMT+6'])(
    'accepts the time zone %s',
    (timezone) => {
      expect(createCampusSchema.safeParse({ ...body, timezone }).success).toBe(true);
    },
  );

  // The server makes the id; a client-chosen one must never get through
  it.each([
    ['a client-chosen id', { id: '6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b' }],
    ['a blank name', { name: '   ' }],
    ['a name over 200 characters', { name: 'x'.repeat(201) }],
    ['a newline in the name', { name: 'AIUB\nAdmin' }],
    ['a right-to-left override in the name', { name: 'AIUB\u202Etxt.exe' }],
    ['a bad slug', { slug: 'AIUB' }],
    ['an unknown timezone', { timezone: 'Mars/Olympus' }],
    ['a timezone in the wrong case', { timezone: 'asia/dhaka' }],
    ['no email domains', { emailDomains: [] }],
    ['an uppercase domain', { emailDomains: ['AIUB.edu'] }],
    ['a domain without a dot', { emailDomains: ['aiub'] }],
    ['an email instead of a domain', { emailDomains: ['admin@aiub.edu'] }],
    ['a repeated domain', { emailDomains: ['aiub.edu', 'aiub.edu'] }],
    ['more than 10 domains', { emailDomains: Array.from({ length: 11 }, (_, i) => `d${i}.edu`) }],
    ['a latitude off the globe', { location: { lat: 91, lng: 90 } }],
    ['an extra location field', { location: { lat: 23, lng: 90, alt: 5 } }],
  ])('rejects %s', (_, change) => {
    expect(createCampusSchema.safeParse({ ...body, ...change }).success).toBe(false);
  });
});
