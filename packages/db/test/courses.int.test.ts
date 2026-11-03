import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { campus, course, createDb, withCampus } from '../src/index.js';
import { newCampus, pgErrorCode } from './support/fixtures.js';

describe('course tenancy and read-only app privileges', () => {
  const owner = createDb(inject('ownerUrl'));
  const app = createDb(inject('appUrl'), { max: 1 });
  const a = newCampus();
  const b = newCampus();
  const courseA = { id: randomUUID(), campusId: a.id, code: 'CSC4161', title: 'Web Technology' };
  const courseB = {
    id: randomUUID(),
    campusId: b.id,
    code: 'CSC4161',
    title: 'Other campus course',
  };
  const ids = [courseA.id, courseB.id];

  beforeAll(async () => {
    await owner.insert(campus).values([a, b]);
    await owner.insert(course).values([courseA, courseB]);
  });
  afterAll(async () => {
    await Promise.all([owner.$client.end(), app.$client.end()]);
  });

  it('reads no courses without a campus scope', async () => {
    expect(await app.select().from(course)).toEqual([]);
  });
  it.each([
    ['A', a, courseA],
    ['B', b, courseB],
  ] as const)(
    'reads only campus %s even without a campus WHERE condition',
    async (_name, tenant, expected) => {
      const rows = await withCampus(app, tenant.id, (tx) =>
        tx.select({ id: course.id }).from(course).where(inArray(course.id, ids)),
      );
      expect(rows).toEqual([{ id: expected.id }]);
    },
  );
  it('does not retain scope when the same pooled connection is reused', async () => {
    await withCampus(app, a.id, (tx) => tx.select().from(course));
    expect(await app.select().from(course)).toEqual([]);
  });
  it('does not permit inserts, updates or deletes, even inside the right scope', async () => {
    const actions = [
      () =>
        withCampus(app, a.id, (tx) =>
          tx.insert(course).values({ campusId: a.id, code: 'NEW', title: 'New' }),
        ),
      () => withCampus(app, a.id, (tx) => tx.update(course).set({ title: 'Changed' })),
      () => withCampus(app, a.id, (tx) => tx.delete(course)),
    ];
    for (const action of actions) expect(await pgErrorCode(action())).toBe('42501');
    const rows = await owner
      .select({ title: course.title })
      .from(course)
      .where(inArray(course.id, ids));
    expect(rows.map((row) => row.title).sort()).toEqual([courseA.title, courseB.title].sort());
  });
  it('rejects duplicate course codes within one campus', async () => {
    expect(
      await pgErrorCode(
        owner.insert(course).values({ campusId: a.id, code: courseA.code, title: 'Duplicate' }),
      ),
    ).toBe('23505');
  });
  it('requires an existing parent campus', async () => {
    expect(
      await pgErrorCode(
        owner.insert(course).values({ campusId: randomUUID(), code: 'ORPHAN', title: 'Orphan' }),
      ),
    ).toBe('23503');
  });
});
