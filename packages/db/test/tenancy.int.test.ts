import { eq, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { campus, createDb, withCampus } from '../src/index.js';
import * as schema from '../src/schema.js';
import { newCampus, pgErrorCode } from './support/fixtures.js';

describe('campus row-level security (public read, scoped writes), as pulse_app', () => {
  const owner = createDb(inject('ownerUrl'));
  const app = createDb(inject('appUrl'));
  const a = newCampus();
  const b = newCampus();

  beforeAll(async () => {
    // The owner is not limited by RLS, so it seeds both campuses
    await owner.insert(campus).values([a, b]);
  });

  afterAll(async () => {
    await Promise.all([owner.$client.end(), app.$client.end()]);
  });

  it('reads every campus without withCampus (sign-in looks campuses up by email domain)', async () => {
    const rows = await app
      .select({ id: campus.id })
      .from(campus)
      .where(inArray(campus.id, [a.id, b.id]));
    expect(rows).toHaveLength(2);
  });

  it('outside withCampus cannot insert or update any campus', async () => {
    // 42501: new row violates row-level security policy
    expect(await pgErrorCode(app.insert(campus).values(newCampus()))).toBe('42501');

    const updated = await app
      .update(campus)
      .set({ name: 'No campus set' })
      .where(eq(campus.id, a.id))
      .returning({ id: campus.id });
    expect(updated).toEqual([]);
  });

  it('inside withCampus(A) cannot insert another campus', async () => {
    const other = newCampus();
    const code = await pgErrorCode(withCampus(app, a.id, (tx) => tx.insert(campus).values(other)));
    // 42501: new row violates row-level security policy
    expect(code).toBe('42501');
  });

  it('inside withCampus(A) cannot update campus B', async () => {
    const updated = await withCampus(app, a.id, (tx) =>
      tx
        .update(campus)
        .set({ name: 'Hijacked' })
        .where(eq(campus.id, b.id))
        .returning({ id: campus.id }),
    );
    expect(updated).toEqual([]);

    const [row] = await owner.select({ name: campus.name }).from(campus).where(eq(campus.id, b.id));
    expect(row?.name).toBe(b.name);
  });

  it('cannot delete any campus, not even its own (deleting a tenant is an admin job)', async () => {
    // Its own campus, so RLS would allow it: only the missing DELETE privilege stops it
    const own = newCampus();
    await owner.insert(campus).values(own);

    const work = withCampus(app, own.id, (tx) => tx.delete(campus).where(eq(campus.id, own.id)));
    // 42501: permission denied for table campus
    expect(await pgErrorCode(work)).toBe('42501');

    const [row] = await owner.select({ id: campus.id }).from(campus).where(eq(campus.id, own.id));
    expect(row).toEqual({ id: own.id });
  });

  it('rejects a campus id that is not a UUID before touching the database', async () => {
    // Nothing listens on port 1: reaching the database would fail with a connection error instead
    const unreachable = createDb('postgres://pulse_app:pulse_app@127.0.0.1:1/pulse');
    const hostile = "x'; drop table campus; --";
    try {
      const work = withCampus(unreachable, hostile, (tx) => tx.select().from(campus));
      await expect(work).rejects.toThrow(new TypeError('withCampus: campusId must be a UUID'));
    } finally {
      await unreachable.$client.end();
    }
  });

  it('does not leak the campus to the next query on the same connection', async () => {
    // A pool of one, so the second query surely reuses the first one's connection
    const single = drizzle({
      client: new Pool({ connectionString: inject('appUrl'), max: 1 }),
      schema,
    });
    try {
      await withCampus(single, a.id, (tx) => tx.select().from(campus));

      const result = await single.execute<{ setting: string | null }>(
        sql`select current_setting('app.campus_id', true) as setting`,
      );
      expect(result.rows[0]?.setting ?? '').toBe('');
      // Reads are public, so prove "no campus" with a write: it must match no row
      const leaked = await single
        .update(campus)
        .set({ name: 'Leaked' })
        .where(eq(campus.id, a.id))
        .returning({ id: campus.id });
      expect(leaked).toEqual([]);
    } finally {
      await single.$client.end();
    }
  });
});
