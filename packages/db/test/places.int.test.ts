import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  appUser,
  auditLog,
  campus,
  campusGate,
  createDb,
  meetingPoint,
  type Transaction,
  withCampus,
  zone,
} from '../src/index.js';
import { newCampus, pgErrorCode } from './support/fixtures.js';

// A real H3 resolution 8 cell near AIUB; the database only checks its shape
const cell = '883c2a8d2bfffff';
const square = (x: number, y: number) =>
  sql`ST_GeomFromText(${`MULTIPOLYGON(((${x} ${y}, ${x + 0.01} ${y}, ${x + 0.01} ${y + 0.01}, ${x} ${y + 0.01}, ${x} ${y})))`}, 4326)`;
// A bow tie: its edges cross, so ST_IsValid is false
const bowTie = sql`ST_GeomFromText('MULTIPOLYGON(((90 23, 90.01 23.01, 90.01 23, 90 23.01, 90 23)))', 4326)`;

describe('campus gates, zones, meeting points and the audit log', () => {
  const owner = createDb(inject('ownerUrl'));
  const app = createDb(inject('appUrl'), { max: 1 });
  const a = newCampus();
  const b = newCampus();
  const actorA = { id: randomUUID(), campusId: a.id, email: `admin-${a.id}@aiub.edu` };
  const zoneA = randomUUID();
  const zoneB = randomUUID();
  const gate = (campusId: string, name = `Gate ${randomUUID()}`) => ({
    campusId,
    name,
    location: { x: 90.4274, y: 23.8223 },
    cell,
  });
  const point = (campusId: string, zoneId: string | null) => ({
    campusId,
    zoneId,
    name: `Point ${randomUUID()}`,
    kind: 'landmark' as const,
    location: { x: 90.42, y: 23.82 },
    cell,
  });
  const audit = (campusId: string, actorId: string) => ({
    campusId,
    actorId,
    action: 'gate.create',
    entity: 'campus_gate',
    entityId: randomUUID(),
    metadata: { isPrimary: false },
  });
  const inA = (work: (tx: Transaction) => Promise<unknown>) =>
    pgErrorCode(withCampus(app, a.id, work));

  beforeAll(async () => {
    await owner.insert(campus).values([a, b]);
    await owner.insert(appUser).values(actorA);
    await owner.insert(zone).values([
      { id: zoneA, campusId: a.id, name: 'Mirpur 10', area: square(90.36, 23.8) },
      { id: zoneB, campusId: b.id, name: 'Mirpur 10', area: square(90.36, 23.8) },
    ]);
    await owner.insert(campusGate).values([gate(a.id, 'Main gate'), gate(b.id, 'Main gate')]);
    await owner.insert(meetingPoint).values([point(a.id, zoneA), point(b.id, zoneB)]);
    await owner.insert(auditLog).values(audit(a.id, actorA.id));
  });
  afterAll(async () => {
    const campuses = [a.id, b.id];
    await owner.delete(auditLog).where(inArray(auditLog.campusId, campuses));
    await owner.delete(meetingPoint).where(inArray(meetingPoint.campusId, campuses));
    await owner.delete(campusGate).where(inArray(campusGate.campusId, campuses));
    await owner.delete(zone).where(inArray(zone.campusId, campuses));
    await owner.delete(appUser).where(inArray(appUser.campusId, campuses));
    await Promise.all([owner.$client.end(), app.$client.end()]);
  });

  it('shows the app nothing without a campus scope, and only its own campus inside one', async () => {
    expect(await app.select().from(campusGate)).toEqual([]);
    expect(await app.select().from(zone)).toEqual([]);
    expect(await app.select().from(meetingPoint)).toEqual([]);
    expect(await app.select().from(auditLog)).toEqual([]);

    const seen = await withCampus(app, a.id, async (tx) => ({
      gates: await tx.select({ campusId: campusGate.campusId }).from(campusGate),
      zones: await tx.select({ campusId: zone.campusId }).from(zone),
      points: await tx.select({ campusId: meetingPoint.campusId }).from(meetingPoint),
      audit: await tx.select({ campusId: auditLog.campusId }).from(auditLog),
    }));
    const onlyA = [{ campusId: a.id }];
    expect(seen).toEqual({ gates: onlyA, zones: onlyA, points: onlyA, audit: onlyA });
  });

  it('lets the app write the place tables of its campus, but never another campus', async () => {
    await withCampus(app, a.id, async (tx) => {
      await tx.insert(campusGate).values(gate(a.id));
      await tx.insert(zone).values({ campusId: a.id, name: 'Uttara', area: square(90.39, 23.87) });
      await tx.insert(meetingPoint).values(point(a.id, zoneA));
    });

    expect(await inA((tx) => tx.insert(campusGate).values(gate(b.id)))).toBe('42501');
    expect(
      await inA((tx) =>
        tx.insert(zone).values({ campusId: b.id, name: 'Banani', area: square(90.4, 23.79) }),
      ),
    ).toBe('42501');
    expect(await inA((tx) => tx.insert(meetingPoint).values(point(b.id, null)))).toBe('42501');

    // Scoped to A, an update cannot reach B's gate: RLS hides it, so zero rows change
    await withCampus(app, a.id, (tx) =>
      tx.update(campusGate).set({ name: 'Renamed' }).where(eq(campusGate.campusId, b.id)),
    );
    const [gateB] = await owner.select().from(campusGate).where(eq(campusGate.campusId, b.id));
    expect(gateB?.name).toBe('Main gate');
  });

  it('keeps one primary gate per campus, while other campuses have their own', async () => {
    await owner.insert(campusGate).values({ ...gate(a.id), isPrimary: true });
    await owner.insert(campusGate).values({ ...gate(b.id), isPrimary: true });
    expect(
      await pgErrorCode(owner.insert(campusGate).values({ ...gate(a.id), isPrimary: true })),
    ).toBe('23505');
    expect(await pgErrorCode(owner.insert(campusGate).values(gate(a.id, 'Main gate')))).toBe(
      '23505',
    );
  });

  it('refuses a meeting point in another campus’s zone, and stores one with no zone', async () => {
    expect(await pgErrorCode(owner.insert(meetingPoint).values(point(a.id, zoneB)))).toBe('23503');
    expect(await inA((tx) => tx.insert(meetingPoint).values(point(a.id, null)))).toBeUndefined();
  });

  it('refuses a self-crossing zone, a bad cell and an unknown meeting point kind', async () => {
    expect(
      await pgErrorCode(owner.insert(zone).values({ campusId: a.id, name: 'Knot', area: bowTie })),
    ).toBe('23514');
    for (const bad of ['883c2a8d2bffff', '883C2A8D2BFFFFF', '883c2a8d2bffffg', '23.8,90.4'])
      expect(await pgErrorCode(owner.insert(campusGate).values({ ...gate(a.id), cell: bad }))).toBe(
        '23514',
      );
    expect(
      await pgErrorCode(owner.insert(meetingPoint).values({ ...point(a.id, null), cell: 'x' })),
    ).toBe('23514');
    // Raw SQL, so the database CHECK is tested rather than the TypeScript enum
    expect(
      await pgErrorCode(
        owner.execute(sql`insert into meeting_point (campus_id, name, kind, location, cell)
          values (${a.id}, 'Somewhere', 'parking', ST_SetSRID(ST_MakePoint(90.42, 23.82), 4326), ${cell})`),
      ),
    ).toBe('23514');
  });

  it('stores gate and meeting point locations as WGS 84 points (SRID 4326)', async () => {
    const result = await owner.execute(sql`
      select f_table_name as table, type, srid from geometry_columns
      where f_table_name in ('campus_gate', 'meeting_point', 'zone') order by 1`);
    expect(result.rows).toEqual([
      { table: 'campus_gate', type: 'POINT', srid: 4326 },
      { table: 'meeting_point', type: 'POINT', srid: 4326 },
      { table: 'zone', type: 'MULTIPOLYGON', srid: 4326 },
    ]);
  });

  it('lets the app add audit rows of its campus, but never change or delete one', async () => {
    expect(await inA((tx) => tx.insert(auditLog).values(audit(a.id, actorA.id)))).toBeUndefined();
    expect(await inA((tx) => tx.insert(auditLog).values(audit(b.id, actorA.id)))).toBe('42501');
    expect(await inA((tx) => tx.update(auditLog).set({ action: 'gate.delete' }))).toBe('42501');
    expect(await inA((tx) => tx.delete(auditLog))).toBe('42501');
  });

  it('refuses an audit row whose actor is in another campus, or with a bad shape', async () => {
    expect(await pgErrorCode(owner.insert(auditLog).values(audit(b.id, actorA.id)))).toBe('23503');
    const base = audit(a.id, actorA.id);
    for (const row of [
      { ...base, action: 'create' },
      { ...base, action: 'gate create' },
      { ...base, entity: ' campus_gate' },
      { ...base, ipHash: '203.0.113.7' },
    ])
      expect(await pgErrorCode(owner.insert(auditLog).values(row))).toBe('23514');
    expect(
      await pgErrorCode(
        owner.execute(sql`insert into audit_log (campus_id, actor_id, action, entity, entity_id, metadata)
          values (${a.id}, ${actorA.id}, 'gate.create', 'campus_gate', ${randomUUID()}, '[]'::jsonb)`),
      ),
    ).toBe('23514');
  });

  it('moves updated_at when a place row changes', async () => {
    for (const table of [campusGate, zone, meetingPoint]) {
      const [row] = await owner
        .update(table)
        .set({ name: sql`${table.name} || ' (renamed)'` })
        .where(eq(table.campusId, b.id))
        .returning({ createdAt: table.createdAt, updatedAt: table.updatedAt });
      expect(row && row.updatedAt > row.createdAt).toBe(true);
    }
  });
});
