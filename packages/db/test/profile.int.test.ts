import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  appUser,
  campus,
  createDb,
  preference,
  trustedContact,
  type Transaction,
  vehicle,
  withCampus,
  zone,
} from '../src/index.js';
import { newCampus, pgErrorCode } from './support/fixtures.js';

// The H3 resolution 8 cell of AIUB's main gate; the database only checks its shape
const cell = '883cf13b03fffff';
const square = sql`ST_GeomFromText('MULTIPOLYGON(((90.41 23.81, 90.435 23.81, 90.435 23.83, 90.41 23.83, 90.41 23.81)))', 4326)`;

// Only error codes and counts are asserted: these rows hold personal data, so no test prints one
describe('user profile, preferences, vehicles and trusted contacts', () => {
  const owner = createDb(inject('ownerUrl'));
  const app = createDb(inject('appUrl'), { max: 1 });
  const a = newCampus();
  const b = newCampus();
  const zoneA = randomUUID();
  const zoneB = randomUUID();
  const newUser = (campusId: string) => ({
    id: randomUUID(),
    campusId,
    email: `u-${randomUUID()}@aiub.edu`,
  });
  const userA = newUser(a.id);
  const userB = newUser(b.id);
  const prefs = (userId: string, campusId: string, zoneId: string | null = null) => ({
    userId,
    campusId,
    homeCell: cell,
    zoneId,
    modes: ['cng', 'bus'],
  });
  const car = (ownerId: string, campusId: string) => ({
    ownerId,
    campusId,
    type: 'car' as const,
    seats: 3,
    plate: 'DHAKA METRO GA 11-2233',
    color: 'White',
  });
  const contact = (userId: string, campusId: string, slot: number) => ({
    userId,
    campusId,
    slot,
    name: 'Contact',
    phoneE164: '+8801711000000',
    relation: 'roommate',
  });
  const inA = (work: (tx: Transaction) => Promise<unknown>) =>
    pgErrorCode(withCampus(app, a.id, work));

  beforeAll(async () => {
    await owner.insert(campus).values([a, b]);
    await owner.insert(appUser).values([userA, userB]);
    await owner.insert(zone).values([
      { id: zoneA, campusId: a.id, name: 'Kuril', area: square },
      { id: zoneB, campusId: b.id, name: 'Kuril', area: square },
    ]);
    await owner
      .insert(preference)
      .values([prefs(userA.id, a.id, zoneA), prefs(userB.id, b.id, zoneB)]);
    await owner.insert(vehicle).values([car(userA.id, a.id), car(userB.id, b.id)]);
    await owner
      .insert(trustedContact)
      .values([contact(userA.id, a.id, 1), contact(userB.id, b.id, 1)]);
  });
  afterAll(async () => {
    const campuses = [a.id, b.id];
    await owner.delete(vehicle).where(inArray(vehicle.campusId, campuses));
    await owner.delete(appUser).where(inArray(appUser.campusId, campuses));
    await owner.delete(zone).where(inArray(zone.campusId, campuses));
    await Promise.all([owner.$client.end(), app.$client.end()]);
  });

  it('lets pulse_app update the profile columns, but not email, role or campus_id', async () => {
    const user = newUser(a.id);
    await owner.insert(appUser).values(user);
    expect(
      await inA((tx) =>
        tx
          .update(appUser)
          .set({
            firstName: 'Nusrat',
            lastName: 'Jahan',
            gender: 'female',
            department: 'CSE',
            phoneE164: '+8801711223344',
            status: 'active',
          })
          .where(eq(appUser.id, user.id)),
      ),
    ).toBeUndefined();
    for (const change of [
      { email: 'x@aiub.edu' },
      { role: 'campus_admin' },
      { campusId: b.id },
    ] as const)
      expect(await inA((tx) => tx.update(appUser).set(change).where(eq(appUser.id, user.id)))).toBe(
        '42501',
      );
  });

  it('refuses an active user without a name or a gender, and a phone that is not E.164', async () => {
    const user = newUser(a.id);
    await owner.insert(appUser).values(user);
    const set = (change: Partial<typeof appUser.$inferInsert>) =>
      pgErrorCode(owner.update(appUser).set(change).where(eq(appUser.id, user.id)));

    expect(await set({ status: 'active' })).toBe('23514');
    expect(await set({ status: 'active', firstName: 'Nusrat', lastName: 'Jahan' })).toBe('23514');
    expect(await set({ status: 'active', firstName: 'Nusrat', gender: 'female' })).toBe('23514');
    for (const phoneE164 of ['01711223344', '+0123456789', '+880 1711 223344', '+8801'])
      expect(await set({ phoneE164 })).toBe('23514');
    expect(await set({ firstName: ' Nusrat' })).toBe('23514');
    expect(
      await pgErrorCode(
        owner.execute(sql`update app_user set gender = 'other' where id = ${user.id}`),
      ),
    ).toBe('23514');
  });

  it('shows each new table only inside withCampus, for its own campus', async () => {
    expect(await app.select().from(preference)).toEqual([]);
    expect(await app.select().from(vehicle)).toEqual([]);
    expect(await app.select().from(trustedContact)).toEqual([]);

    const seen = await withCampus(app, a.id, async (tx) => ({
      preferences: await tx.select({ campusId: preference.campusId }).from(preference),
      vehicles: await tx.select({ campusId: vehicle.campusId }).from(vehicle),
      contacts: await tx.select({ campusId: trustedContact.campusId }).from(trustedContact),
    }));
    const onlyA = [{ campusId: a.id }];
    expect(seen).toEqual({ preferences: onlyA, vehicles: onlyA, contacts: onlyA });

    expect(await inA((tx) => tx.insert(vehicle).values(car(userB.id, b.id)))).toBe('42501');
    expect(await inA((tx) => tx.insert(trustedContact).values(contact(userB.id, b.id, 2)))).toBe(
      '42501',
    );
  });

  it('refuses a preference in another campus’s zone, empty modes and an unknown mode', async () => {
    const user = newUser(a.id);
    await owner.insert(appUser).values(user);
    const insert = (row: ReturnType<typeof prefs> & { modes: string[] }) =>
      pgErrorCode(owner.insert(preference).values(row));

    expect(await insert(prefs(user.id, a.id, zoneB))).toBe('23503');
    expect(await insert({ ...prefs(user.id, a.id), modes: [] })).toBe('23514');
    expect(await insert({ ...prefs(user.id, a.id), modes: ['cng', 'helicopter'] })).toBe('23514');
    expect(await insert({ ...prefs(user.id, a.id), homeCell: '23.81,90.42' })).toBe('23514');
    expect(
      await pgErrorCode(
        owner.insert(preference).values({ ...prefs(user.id, a.id), quietStartTime: '22:00' }),
      ),
    ).toBe('23514');
    expect(
      await pgErrorCode(
        owner.insert(preference).values({ ...prefs(user.id, a.id), maxWaitMin: 61 }),
      ),
    ).toBe('23514');
    // No zone is fine: the home is outside every zone
    expect(await insert(prefs(user.id, a.id))).toBeUndefined();
  });

  it('refuses a bike with two seats, a car with seven, and a fourth trusted contact', async () => {
    const bike = { ...car(userA.id, a.id), type: 'bike' as const };
    expect(await pgErrorCode(owner.insert(vehicle).values({ ...bike, seats: 2 }))).toBe('23514');
    expect(await pgErrorCode(owner.insert(vehicle).values({ ...bike, seats: 1 }))).toBeUndefined();
    expect(
      await pgErrorCode(owner.insert(vehicle).values({ ...car(userA.id, a.id), seats: 7 })),
    ).toBe('23514');

    await owner
      .insert(trustedContact)
      .values([contact(userA.id, a.id, 2), contact(userA.id, a.id, 3)]);
    expect(await pgErrorCode(owner.insert(trustedContact).values(contact(userA.id, a.id, 4)))).toBe(
      '23514',
    );
    expect(await pgErrorCode(owner.insert(trustedContact).values(contact(userA.id, a.id, 2)))).toBe(
      '23505',
    );
    expect(
      await pgErrorCode(
        owner
          .insert(trustedContact)
          .values({ ...contact(userA.id, a.id, 3), relation: 'x'.repeat(41) }),
      ),
    ).toBe('23514');
  });

  it('deletes preferences and contacts with their user, but not vehicles', async () => {
    const user = newUser(a.id);
    await owner.insert(appUser).values(user);
    await owner.insert(preference).values(prefs(user.id, a.id));
    await owner.insert(trustedContact).values(contact(user.id, a.id, 1));
    expect(await pgErrorCode(owner.delete(appUser).where(eq(appUser.id, user.id)))).toBeUndefined();
    expect(await owner.select().from(preference).where(eq(preference.userId, user.id))).toEqual([]);
    expect(
      await owner.select().from(trustedContact).where(eq(trustedContact.userId, user.id)),
    ).toEqual([]);

    const driver = newUser(a.id);
    await owner.insert(appUser).values(driver);
    await owner.insert(vehicle).values(car(driver.id, a.id));
    expect(await pgErrorCode(owner.delete(appUser).where(eq(appUser.id, driver.id)))).toBe('23503');
  });

  it('moves updated_at when a preference or a vehicle changes', async () => {
    const [p] = await owner
      .update(preference)
      .set({ maxWaitMin: 15 })
      .where(eq(preference.userId, userA.id))
      .returning({ updatedAt: preference.updatedAt });
    const [v] = await owner
      .update(vehicle)
      .set({ color: 'Silver' })
      .where(eq(vehicle.ownerId, userB.id))
      .returning({ createdAt: vehicle.createdAt, updatedAt: vehicle.updatedAt });
    expect(p && v && v.updatedAt > v.createdAt).toBe(true);
  });
});
