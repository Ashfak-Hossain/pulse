import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  campus,
  course,
  createDb,
  eq,
  section,
  sectionMeeting,
  sql,
  term,
  withCampus,
} from '../src/index.js';
import { newCampus, pgErrorCode } from './support/fixtures.js';

const owner = createDb(inject('ownerUrl'));
const app = createDb(inject('appUrl'), { max: 1 });
const a = newCampus();
const b = newCampus();
const termA = {
  id: randomUUID(),
  campusId: a.id,
  name: 'Fall',
  startsOn: '2026-09-01',
  endsOn: '2027-01-01',
  status: 'active',
} as const;
const termB = { ...termA, id: randomUUID(), campusId: b.id };
const courseA = { id: randomUUID(), campusId: a.id, code: 'CSC1001', title: 'Computing' };
const courseB = { ...courseA, id: randomUUID(), campusId: b.id };
const sectionA = {
  id: randomUUID(),
  campusId: a.id,
  termId: termA.id,
  courseId: courseA.id,
  externalClassId: '00001',
  sectionLabel: 'A',
  title: 'Computing Lab',
  capacity: 20,
  enrolled: 21,
  status: 'reserved',
} as const;
const sectionB = {
  ...sectionA,
  id: randomUUID(),
  campusId: b.id,
  termId: termB.id,
  courseId: courseB.id,
};
const unscheduled = { ...sectionA, id: randomUUID(), externalClassId: '00002', sectionLabel: 'B' };
const meetingA = {
  id: randomUUID(),
  campusId: a.id,
  sectionId: sectionA.id,
  kind: 'lab',
  weekday: 0,
  startTime: '14:00',
  endTime: '15:20',
} as const;
const meetingB = { ...meetingA, id: randomUUID(), campusId: b.id, sectionId: sectionB.id };

describe('catalog timetable constraints and tenancy', () => {
  beforeAll(async () => {
    await owner.insert(campus).values([a, b]);
    await owner.insert(course).values([courseA, courseB]);
    await owner.insert(term).values([termA, termB]);
    await owner.insert(section).values([sectionA, sectionB, unscheduled]);
    await owner.insert(sectionMeeting).values([meetingA, meetingB]);
  });

  afterAll(async () => {
    await Promise.all([owner.$client.end(), app.$client.end()]);
  });

  it.each([
    ['term', term, [termA.id], [termB.id]],
    ['section', section, [sectionA.id, unscheduled.id], [sectionB.id]],
    ['section_meeting', sectionMeeting, [meetingA.id], [meetingB.id]],
  ] as const)(
    'isolates %s reads by campus and clears pooled scope',
    async (_name, table, aIds, bIds) => {
      expect(await app.select({ id: table.id }).from(table)).toEqual([]);
      for (const [tenant, ids] of [
        [a, aIds],
        [b, bIds],
      ] as const) {
        const rows = await withCampus(app, tenant.id, (tx) =>
          tx.select({ id: table.id }).from(table),
        );
        expect(rows.map(({ id }) => id).sort()).toEqual([...ids].sort());
      }
      expect(await app.select({ id: table.id }).from(table)).toEqual([]);
    },
  );

  it.each(['term', 'section', 'section_meeting'])(
    'revokes writes on %s from pulse_app',
    async (table) => {
      const target = sql.identifier(table);
      const result = await app.execute(sql`select
      has_table_privilege(current_user, ${table}, 'INSERT') as insert_allowed,
      has_table_privilege(current_user, ${table}, 'UPDATE') as update_allowed,
      has_table_privilege(current_user, ${table}, 'DELETE') as delete_allowed`);
      expect(result.rows).toEqual([
        { insert_allowed: false, update_allowed: false, delete_allowed: false },
      ]);
      for (const query of [
        sql`insert into ${target} default values`,
        sql`update ${target} set id = id`,
        sql`delete from ${target}`,
      ]) {
        expect(await pgErrorCode(withCampus(app, a.id, (tx) => tx.execute(query)))).toBe('42501');
      }
    },
  );

  it('allows only one active term per campus', async () => {
    expect(
      await pgErrorCode(
        owner.insert(term).values({ ...termA, id: randomUUID(), name: 'Another active term' }),
      ),
    ).toBe('23505');
  });

  it('rejects a section linked to another campus term or course', async () => {
    const fresh = { ...sectionA, id: randomUUID(), externalClassId: '00003' };
    expect(await pgErrorCode(owner.insert(section).values({ ...fresh, termId: termB.id }))).toBe(
      '23503',
    );
    expect(
      await pgErrorCode(owner.insert(section).values({ ...fresh, courseId: courseB.id })),
    ).toBe('23503');
  });

  it('rejects a meeting linked to a section from another campus', async () => {
    expect(
      await pgErrorCode(
        owner
          .insert(sectionMeeting)
          .values({ ...meetingA, id: randomUUID(), sectionId: sectionB.id }),
      ),
    ).toBe('23503');
  });

  it.each([{ weekday: 7 }, { endTime: meetingA.startTime }, { endTime: '13:59' }])(
    'rejects invalid meeting schedule %j',
    async (change) => {
      expect(
        await pgErrorCode(
          owner.insert(sectionMeeting).values({ ...meetingA, ...change, id: randomUUID() }),
        ),
      ).toBe('23514');
    },
  );

  it('stores unscheduled sections and keeps over-capacity enrollment', async () => {
    const result = await withCampus(app, a.id, async (tx) => ({
      sections: await tx.select().from(section).where(eq(section.id, unscheduled.id)),
      meetings: await tx
        .select()
        .from(sectionMeeting)
        .where(eq(sectionMeeting.sectionId, unscheduled.id)),
    }));
    expect(result.sections).toEqual([
      expect.objectContaining({ id: unscheduled.id, capacity: 20, enrolled: 21 }),
    ]);
    expect(result.meetings).toEqual([]);
  });

  it('cascades meeting deletion when the owner deletes a section', async () => {
    await owner
      .transaction(async (tx) => {
        await tx.delete(section).where(eq(section.id, sectionA.id));
        expect(
          await tx.select().from(sectionMeeting).where(eq(sectionMeeting.id, meetingA.id)),
        ).toEqual([]);
        tx.rollback();
      })
      .catch((error: unknown) => {
        if (!(error instanceof Error) || error.message !== 'Rollback') throw error;
      });
  });
});
