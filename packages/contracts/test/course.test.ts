import { describe, expect, it } from 'vitest';
import { courseListSchema, courseQuerySchema, courseSchema } from '../src/index.js';

const course = {
  id: '6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b',
  code: 'CSC4161',
  title: 'Advanced Programming in Web Technology',
};

describe('courseSchema', () => {
  it('returns the course code separately from its database id', () => {
    expect(courseSchema.parse(course)).toEqual(course);
  });
  it.each([
    { ...course, id: 'CSC4161' },
    { ...course, code: '' },
    { ...course, title: '' },
    { ...course, code: 'C'.repeat(33) },
    { ...course, campusId: course.id },
    { ...course, createdAt: '2026-11-03' },
  ])('rejects a response outside the public contract: %o', (body) => {
    expect(courseSchema.safeParse(body).success).toBe(false);
  });
});

describe('courseListSchema', () => {
  it.each([
    { items: [], nextCursor: null },
    { items: Array<typeof course>(500).fill(course), nextCursor: 'eyJjb2RlIjoiQ1NDNDE2MSJ9' },
  ])('accepts a bounded page', (body) => {
    expect(courseListSchema.parse(body)).toEqual(body);
  });
  it.each([
    [course],
    { items: [course] },
    { items: [course], nextCursor: null, extra: 'x' },
    { items: Array<typeof course>(501).fill(course), nextCursor: null },
  ])('rejects bare arrays, unknown fields and oversized lists', (body) => {
    expect(courseListSchema.safeParse(body).success).toBe(false);
  });
});

describe('courseQuerySchema', () => {
  it('defaults to 100 a page and reads the limit from a query string', () => {
    expect(courseQuerySchema.parse({})).toEqual({ limit: 100 });
    expect(courseQuerySchema.parse({ limit: '500', cursor: 'abc_-' })).toEqual({
      limit: 500,
      cursor: 'abc_-',
    });
  });
  it.each([{ limit: '0' }, { limit: '501' }, { limit: 5 }, { cursor: 'a'.repeat(513) }])(
    'rejects %j',
    (query) => {
      expect(courseQuerySchema.safeParse(query).success).toBe(false);
    },
  );
});
