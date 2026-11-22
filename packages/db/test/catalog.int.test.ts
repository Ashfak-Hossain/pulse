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

  it.each(['section', 'section_meeting'])('revokes writes on %s from pulse_app', async (table) => {
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
  });

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
          // Another weekday, so the slot key (meetingB holds this slot) cannot answer first
          .values({ ...meetingA, id: randomUUID(), sectionId: sectionB.id, weekday: 5 }),
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

  it('rejects a second meeting of the same kind at the same slot', async () => {
    expect(
      await pgErrorCode(
        owner.insert(sectionMeeting).values({ ...meetingA, id: randomUUID(), endTime: '16:00' }),
      ),
    ).toBe('23505');
  });

  // Edge spaces, empty and over-long values: what the parser never sends must not get in by psql
  it.each([
    [
      'course code',
      () => owner.insert(course).values({ ...courseA, id: randomUUID(), code: ' X' }),
    ],
    [
      'course title',
      () =>
        owner
          .insert(course)
          .values({ ...courseA, id: randomUUID(), code: 'T1', title: 'x'.repeat(201) }),
    ],
    [
      'term name',
      () => owner.insert(term).values({ ...termA, id: randomUUID(), status: 'draft', name: '' }),
    ],
    [
      'class id',
      () =>
        owner
          .insert(section)
          .values({ ...sectionA, id: randomUUID(), externalClassId: '1'.repeat(33) }),
    ],
    [
      'section label',
      () =>
        owner
          .insert(section)
          .values({ ...sectionA, id: randomUUID(), externalClassId: 'L1', sectionLabel: 'A ' }),
    ],
    [
      'section title',
      () =>
        owner
          .insert(section)
          .values({ ...sectionA, id: randomUUID(), externalClassId: 'T1', title: ' ' }),
    ],
    [
      'instructor',
      () =>
        owner
          .insert(section)
          .values({ ...sectionA, id: randomUUID(), externalClassId: 'I1', instructorName: '' }),
    ],
    [
      'room',
      () =>
        owner
          .insert(sectionMeeting)
          .values({ ...meetingA, id: randomUUID(), weekday: 3, room: 'r'.repeat(65) }),
    ],
  ])('rejects unclean text in %s', async (_name, insert) => {
    expect(await pgErrorCode(insert())).toBe('23514');
  });

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

  it('lets pulse_app add a term and change only its status, inside its own campus', async () => {
    const draft = { campusId: a.id, startsOn: '2027-01-20', endsOn: '2027-05-30' };
    const inA = (work: Parameters<typeof withCampus>[2]) =>
      pgErrorCode(withCampus(app, a.id, work));
    const id = randomUUID();

    expect(
      await inA((tx) => tx.insert(term).values({ ...draft, id, name: `Spring ${id}` })),
    ).toBeUndefined();
    // A new term is always a draft, and a draft cannot skip activation straight to archived
    expect(
      await inA((tx) =>
        tx
          .insert(term)
          .values({ ...draft, id: randomUUID(), name: `Live ${id}`, status: 'active' }),
      ),
    ).toBe('42501');
    expect(
      await inA((tx) => tx.update(term).set({ status: 'archived' }).where(eq(term.id, id))),
    ).toBe('23514');
    // Another campus's term is out of reach, and so are a term's name, dates and deletion
    expect(
      await inA((tx) => tx.insert(term).values({ ...draft, campusId: b.id, name: 'Spring' })),
    ).toBe('42501');
    expect(await inA((tx) => tx.update(term).set({ name: 'Renamed' }))).toBe('42501');
    expect(await inA((tx) => tx.update(term).set({ endsOn: '2027-06-30' }))).toBe('42501');
    expect(await inA((tx) => tx.delete(term))).toBe('42501');

    // Scoped to A, a status change cannot reach B's term: RLS hides it, so zero rows change
    await withCampus(app, a.id, (tx) =>
      tx.update(term).set({ status: 'archived' }).where(eq(term.id, termB.id)),
    );
    const [b1] = await owner.select().from(term).where(eq(term.id, termB.id));
    expect(b1?.status).toBe('active');
  });

  it('moves a term status only forward, for every writer', async () => {
    const id = randomUUID();
    await owner.insert(term).values({
      id,
      campusId: b.id,
      name: `Old ${id}`,
      startsOn: '2025-01-20',
      endsOn: '2025-05-30',
      status: 'archived',
    });
    for (const status of ['active', 'draft'] as const)
      expect(await pgErrorCode(owner.update(term).set({ status }).where(eq(term.id, id)))).toBe(
        '23514',
      );
  });

  it('moves updated_at on a real change and keeps it on an unchanged rewrite', async () => {
    await owner
      .transaction(async (tx) => {
        // now() is this transaction's start, so "= now()" means "written here", to the microsecond
        const touched = async () => {
          const [sectionRow] = await tx
            .select({ section: sql<boolean>`${section.updatedAt} = now()` })
            .from(section)
            .where(eq(section.id, sectionA.id));
          const [termRow] = await tx
            .select({ term: sql<boolean>`${term.updatedAt} = now()` })
            .from(term)
            .where(eq(term.id, termA.id));
          return { ...sectionRow, ...termRow };
        };
        await tx.update(section).set({ title: sectionA.title }).where(eq(section.id, sectionA.id));
        await tx.update(term).set({ name: termA.name }).where(eq(term.id, termA.id));
        expect(await touched()).toEqual({ section: false, term: false });

        await tx
          .update(section)
          .set({ enrolled: sql`${section.enrolled} + 1` })
          .where(eq(section.id, sectionA.id));
        await tx.update(term).set({ name: 'Fall renamed' }).where(eq(term.id, termA.id));
        expect(await touched()).toEqual({ section: true, term: true });
        tx.rollback();
      })
      .catch((error: unknown) => {
        if (!(error instanceof Error) || error.message !== 'Rollback') throw error;
      });
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
