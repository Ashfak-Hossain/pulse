import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  appUser,
  authSession,
  campus,
  createDb,
  type Transaction,
  withCampus,
} from '../src/index.js';
import { newCampus, pgErrorCode } from './support/fixtures.js';

const hash = (char: string) => char.repeat(64);
const DAY_MS = 24 * 60 * 60_000;
const FAR_FUTURE = new Date('2100-01-01T00:00:00Z');

describe('auth_session', () => {
  const owner = createDb(inject('ownerUrl'));
  const app = createDb(inject('appUrl'), { max: 1 });
  const a = newCampus();
  const b = newCampus();
  const userA = { id: randomUUID(), campusId: a.id, email: `sa-${a.id}@aiub.edu` };
  const userB = { id: randomUUID(), campusId: b.id, email: `sb-${b.id}@aiub.edu` };
  // A unique token hash per row: the column is unique across all campuses
  const row = (user: { id: string; campusId: string }) => ({
    campusId: user.campusId,
    userId: user.id,
    familyId: randomUUID(),
    tokenHash: randomUUID().replaceAll('-', '').repeat(2),
    ipHash: hash('b'),
    userAgent: 'Mozilla/5.0',
    expiresAt: new Date(Date.now() + 30 * DAY_MS - 60_000),
  });
  const inA = (work: (tx: Transaction) => Promise<unknown>) =>
    pgErrorCode(withCampus(app, a.id, work));
  // A session of its own per test, so one test's updates never leak into another
  const freshSession = async () => {
    const [created] = await owner
      .insert(authSession)
      .values(row(userA))
      .returning({ id: authSession.id });
    if (!created) throw new Error('insert returned no row');
    return created.id;
  };
  const read = async (id: string) => {
    const [found] = await owner.select().from(authSession).where(eq(authSession.id, id));
    if (!found) throw new Error(`session ${id} not found`);
    return found;
  };

  beforeAll(async () => {
    await owner.insert(campus).values([a, b]);
    await owner.insert(appUser).values([userA, userB]);
    await owner.insert(authSession).values([row(userA), row(userB)]);
  });
  afterAll(async () => {
    await owner.delete(authSession).where(inArray(authSession.campusId, [a.id, b.id]));
    await owner.delete(appUser).where(inArray(appUser.campusId, [a.id, b.id]));
    await Promise.all([owner.$client.end(), app.$client.end()]);
  });

  it('shows the app nothing without a campus scope, and only its own campus inside one', async () => {
    expect(await app.select().from(authSession)).toEqual([]);

    const seen = await withCampus(app, a.id, (tx) =>
      tx.select({ userId: authSession.userId }).from(authSession),
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.userId === userA.id)).toBe(true);
  });

  it('lets the app start a session in its campus, but never in another campus', async () => {
    await withCampus(app, a.id, (tx) => tx.insert(authSession).values(row(userA)));
    expect(await inA((tx) => tx.insert(authSession).values(row(userB)))).toBe('42501');

    // Scoped to A, a revoke aimed at B's sessions finds nothing to change
    await withCampus(app, a.id, (tx) =>
      tx
        .update(authSession)
        .set({ revokedAt: new Date(), revokeReason: 'sign_out' })
        .where(eq(authSession.campusId, b.id)),
    );
    const bRows = await owner.select().from(authSession).where(eq(authSession.campusId, b.id));
    expect(bRows.every((s) => s.revokedAt === null)).toBe(true);
  });

  it('refuses a session whose user belongs to another campus', async () => {
    expect(
      await pgErrorCode(owner.insert(authSession).values({ ...row(userB), campusId: a.id })),
    ).toBe('23503');
  });

  it('never lets the app delete a session, even inside its campus', async () => {
    expect(await inA((tx) => tx.delete(authSession))).toBe('42501');
  });

  it('lets the app rotate and revoke, and change nothing else', async () => {
    const id = await freshSession();
    await withCampus(app, a.id, async (tx) => {
      // Refresh locks the row first, and FOR UPDATE needs UPDATE on at least one column
      await tx
        .select({ id: authSession.id })
        .from(authSession)
        .where(eq(authSession.id, id))
        .for('update');
      await tx
        .update(authSession)
        .set({ rotatedAt: new Date(), revokedAt: new Date(), revokeReason: 'reuse_detected' })
        .where(eq(authSession.id, id));
    });
    // Read back as the owner: an update that RLS hid would change 0 rows without an error
    const changed = await read(id);
    expect(changed.rotatedAt).not.toBeNull();
    expect(changed.revokedAt).not.toBeNull();
    expect(changed.revokeReason).toBe('reuse_detected');

    for (const change of [
      { tokenHash: hash('c') },
      { expiresAt: new Date(Date.now() + DAY_MS) },
      { userId: userA.id },
      { familyId: randomUUID() },
      { campusId: a.id },
      { userAgent: 'curl/8' },
    ])
      expect(
        await inA((tx) => tx.update(authSession).set(change).where(eq(authSession.id, id))),
      ).toBe('42501');
  });

  it('never un-rotates, un-revokes or rewrites a reason, so reuse detection and the audit trail hold', async () => {
    const id = await freshSession();
    const change = (set: Partial<typeof authSession.$inferInsert>) =>
      inA((tx) => tx.update(authSession).set(set).where(eq(authSession.id, id)));

    expect(await change({ rotatedAt: new Date() })).toBeUndefined();
    expect(await change({ rotatedAt: null })).toBe('23514');
    expect(await change({ rotatedAt: new Date(Date.now() + 60_000) })).toBe('23514');

    expect(await change({ revokedAt: new Date(), revokeReason: 'reuse_detected' })).toBeUndefined();
    expect(await change({ revokedAt: null, revokeReason: null })).toBe('23514');
    expect(await change({ revokeReason: 'sign_out' })).toBe('23514');
    expect((await read(id)).revokeReason).toBe('reuse_detected');
  });

  it('stamps rotation and revocation with the database clock, whatever time the app sends', async () => {
    const id = await freshSession();
    await withCampus(app, a.id, (tx) =>
      tx
        .update(authSession)
        .set({ rotatedAt: FAR_FUTURE, revokedAt: FAR_FUTURE, revokeReason: 'sign_out' })
        .where(eq(authSession.id, id)),
    );
    // A future rotated_at would keep the 10 s reuse grace open forever. The database compares
    // against its own clock, so no timestamp parsing or host clock drift is involved
    const [stamped] = await owner
      .select({
        inThePast: sql<boolean>`${authSession.rotatedAt} <= now() and ${authSession.revokedAt} <= now()`,
      })
      .from(authSession)
      .where(eq(authSession.id, id));
    expect(stamped?.inThePast).toBe(true);
  });

  it('sets created_at itself, so the 30-day limit cannot be stretched', async () => {
    // The app's created_at is ignored: the row starts now and still expires within 30 days
    const values = { ...row(userA), createdAt: FAR_FUTURE };
    const [created] = await withCampus(app, a.id, (tx) =>
      tx.insert(authSession).values(values).returning({ id: authSession.id }),
    );
    if (!created) throw new Error('insert returned no row');
    expect((await read(created.id)).createdAt.getTime()).toBeLessThan(FAR_FUTURE.getTime());

    // Measured from the real created_at, an expiry 29 days after 2100 is far past 30 days
    const stretched = {
      ...row(userA),
      createdAt: FAR_FUTURE,
      expiresAt: new Date(FAR_FUTURE.getTime() + 29 * DAY_MS),
    };
    expect(await inA((tx) => tx.insert(authSession).values(stretched))).toBe('23514');
  });

  it('starts every session live: never already rotated or revoked', async () => {
    // Both columns set, so the CHECK alone would let these through; the trigger refuses them
    for (const values of [
      { ...row(userA), rotatedAt: FAR_FUTURE },
      { ...row(userA), revokedAt: FAR_FUTURE, revokeReason: 'sign_out' as const },
    ])
      expect(await inA((tx) => tx.insert(authSession).values(values))).toBe('23514');
  });

  it('accepts an expiry of exactly 30 days set by the database clock', async () => {
    // The API sets expires_at in SQL, so it lands on the boundary that created_at uses
    const values = row(userA);
    expect(
      await pgErrorCode(
        owner.execute(sql`insert into auth_session
          (campus_id, user_id, family_id, token_hash, ip_hash, expires_at)
          values (${a.id}, ${userA.id}, ${values.familyId}, ${values.tokenHash}, ${values.ipHash},
            now() + interval '30 days')`),
      ),
    ).toBeUndefined();
  });

  it('keeps every token hash unique across campuses', async () => {
    const taken = row(userA);
    await owner.insert(authSession).values(taken);
    expect(
      await pgErrorCode(
        owner.insert(authSession).values({ ...row(userB), tokenHash: taken.tokenHash }),
      ),
    ).toBe('23505');
  });

  it('refuses a plain token or IP, a bad expiry, a long user agent and a half-done revoke', async () => {
    const base = row(userA);
    const bad = [
      { ...base, tokenHash: 'plain-refresh-token' },
      { ...base, tokenHash: hash('G') },
      { ...base, ipHash: '203.0.113.7' },
      { ...base, expiresAt: new Date(Date.now() - 60_000) },
      { ...base, expiresAt: new Date(Date.now() + 31 * DAY_MS) },
      { ...base, userAgent: 'x'.repeat(201) },
      { ...base, revokedAt: new Date() },
      { ...base, revokeReason: 'sign_out' as const },
    ];
    for (const values of bad)
      expect(await pgErrorCode(owner.insert(authSession).values(values))).toBe('23514');
  });

  it('refuses a revoke reason outside the list', async () => {
    // Raw SQL, so the database CHECK is tested rather than the TypeScript enum
    const values = row(userA);
    expect(
      await pgErrorCode(
        owner.execute(sql`insert into auth_session
          (campus_id, user_id, family_id, token_hash, ip_hash, expires_at, revoked_at, revoke_reason)
          values (${a.id}, ${userA.id}, ${values.familyId}, ${values.tokenHash}, ${values.ipHash},
            ${values.expiresAt.toISOString()}, now(), 'expired')`),
      ),
    ).toBe('23514');
  });
});
