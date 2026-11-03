import { describe, expect, it } from 'vitest';
import { courseListSchema, courseSchema } from '../src/index.js';

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
    { ...course, campusId: course.id },
    { ...course, createdAt: '2026-11-03' },
  ])('rejects a response outside the public contract: %o', (body) => {
    expect(courseSchema.safeParse(body).success).toBe(false);
  });
});

describe('courseListSchema', () => {
  it.each([{ items: [] }, { items: [course] }, { items: Array<typeof course>(500).fill(course) }])(
    'accepts a bounded list',
    ({ items }) => {
      expect(courseListSchema.parse({ items })).toEqual({ items });
    },
  );
  it.each([
    [course],
    { items: [course], extra: 'x' },
    { items: Array<typeof course>(501).fill(course) },
  ])('rejects bare arrays, unknown fields and oversized lists', (body) => {
    expect(courseListSchema.safeParse(body).success).toBe(false);
  });
});
