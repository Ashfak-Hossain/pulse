import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { appUser, campus, createDb, emailOtp, type Transaction, withCampus } from '../src/index.js';
import { newCampus, pgErrorCode } from './support/fixtures.js';

const hash = (char: string) => char.repeat(64);

describe('app_user and email_otp', () => {
  const owner = createDb(inject('ownerUrl'));
  const app = createDb(inject('appUrl'), { max: 1 });
  const a = newCampus();
  const b = newCampus();
  const userA = { id: randomUUID(), campusId: a.id, email: `a-${a.id}@aiub.edu` };
  const userB = { id: randomUUID(), campusId: b.id, email: `b-${b.id}@aiub.edu` };
  const otp = (campusId: string, email: string) => ({
    campusId,
    email,
    codeHash: hash('a'),
    ipHash: hash('b'),
    expiresAt: new Date(Date.now() + 10 * 60_000),
  });
  const inA = (work: (tx: Transaction) => Promise<unknown>) =>
    pgErrorCode(withCampus(app, a.id, work));
  // A code of its own per test, so one test's updates never leak into another
  const freshCode = async () => {
    const [row] = await owner
      .insert(emailOtp)
      .values(otp(a.id, userA.email))
      .returning({ id: emailOtp.id });
    if (!row) throw new Error('insert returned no row');
    return row.id;
  };

  beforeAll(async () => {
    await owner.insert(campus).values([a, b]);
    await owner.insert(appUser).values([userA, userB]);
    await owner.insert(emailOtp).values([otp(a.id, userA.email), otp(b.id, userB.email)]);
  });
  afterAll(async () => {
    await owner.delete(emailOtp).where(inArray(emailOtp.campusId, [a.id, b.id]));
    await owner.delete(appUser).where(inArray(appUser.campusId, [a.id, b.id]));
    await Promise.all([owner.$client.end(), app.$client.end()]);
  });

  it('shows the app nothing without a campus scope, and only its own campus inside one', async () => {
    expect(await app.select().from(appUser)).toEqual([]);
    expect(await app.select().from(emailOtp)).toEqual([]);

    const seen = await withCampus(app, a.id, async (tx) => ({
      users: await tx.select({ email: appUser.email }).from(appUser),
      codes: await tx.select({ email: emailOtp.email }).from(emailOtp),
    }));
    expect(seen).toEqual({ users: [{ email: userA.email }], codes: [{ email: userA.email }] });
  });

  it('lets the app add and change rows of its campus, but never another campus', async () => {
    const email = `new-${randomUUID()}@aiub.edu`;
    await withCampus(app, a.id, (tx) => tx.insert(appUser).values({ campusId: a.id, email }));
    expect(
      await inA((tx) => tx.insert(appUser).values({ campusId: b.id, email: `x${email}` })),
    ).toBe('42501');
    expect(await inA((tx) => tx.insert(emailOtp).values(otp(b.id, email)))).toBe('42501');

    // An update scoped to A cannot reach B's code: RLS hides it, so zero rows change
    await withCampus(app, a.id, (tx) =>
      tx.update(emailOtp).set({ attempts: 1 }).where(eq(emailOtp.campusId, b.id)),
    );
    const [b1] = await owner.select().from(emailOtp).where(eq(emailOtp.campusId, b.id));
    expect(b1?.attempts).toBe(0);
  });

  it('never lets the app delete a user or a code, even inside its campus', async () => {
    expect(await inA((tx) => tx.delete(appUser))).toBe('42501');
    expect(await inA((tx) => tx.delete(emailOtp))).toBe('42501');
  });

  it('lets the app change only attempts and consumed_at, and nothing on a user', async () => {
    const id = await freshCode();
    await withCampus(app, a.id, async (tx) => {
      // Verify locks the newest code, and FOR UPDATE needs UPDATE on at least one column
      await tx.select({ id: emailOtp.id }).from(emailOtp).where(eq(emailOtp.id, id)).for('update');
      await tx
        .update(emailOtp)
        .set({ attempts: 1, consumedAt: new Date() })
        .where(eq(emailOtp.id, id));
    });

    expect(await inA((tx) => tx.update(emailOtp).set({ codeHash: hash('c') }))).toBe('42501');
    expect(await inA((tx) => tx.update(emailOtp).set({ expiresAt: new Date() }))).toBe('42501');
    // Sign-in only inserts users. Later slices grant the column they change
    for (const change of [{ status: 'active' }, { role: 'faculty' }, { campusId: a.id }] as const)
      expect(await inA((tx) => tx.update(appUser).set(change))).toBe('42501');
  });

  it('never lowers attempts or un-uses a code, so guessing and reuse stay blocked', async () => {
    const id = await freshCode();
    const change = (set: { attempts?: number; consumedAt?: Date | null }) =>
      inA((tx) => tx.update(emailOtp).set(set).where(eq(emailOtp.id, id)));

    expect(await change({ attempts: 2 })).toBeUndefined();
    expect(await change({ attempts: 1 })).toBe('23514');
    expect(await change({ consumedAt: new Date() })).toBeUndefined();
    expect(await change({ consumedAt: null })).toBe('23514');
    expect(await change({ consumedAt: new Date(Date.now() + 60_000) })).toBe('23514');
  });

  it('keeps one user per address across campuses, stored in lowercase', async () => {
    expect(
      await pgErrorCode(owner.insert(appUser).values({ campusId: b.id, email: userA.email })),
    ).toBe('23505');
    expect(
      await pgErrorCode(owner.insert(appUser).values({ campusId: a.id, email: 'Upper@aiub.edu' })),
    ).toBe('23514');
    expect(await pgErrorCode(owner.insert(emailOtp).values(otp(a.id, 'Upper@aiub.edu')))).toBe(
      '23514',
    );
  });

  it('refuses a plain or non-hex hash, a sixth attempt and a bad expiry', async () => {
    const base = otp(a.id, userA.email);
    const bad = [
      { ...base, codeHash: '042917' },
      { ...base, codeHash: hash('g') },
      { ...base, ipHash: '203.0.113.7' },
      { ...base, ipHash: hash('Z') },
      { ...base, attempts: 6 },
      { ...base, expiresAt: new Date(Date.now() - 60_000) },
      { ...base, expiresAt: new Date(Date.now() + 16 * 60_000) },
    ];
    for (const row of bad)
      expect(await pgErrorCode(owner.insert(emailOtp).values(row))).toBe('23514');
  });

  it('refuses a role or status outside the lists, and a deleted row that keeps its email', async () => {
    // Raw SQL, so the database CHECK is tested rather than the TypeScript enum
    const insert = (role: string, status: string, email = `r-${randomUUID()}@aiub.edu`) =>
      owner.execute(sql`insert into app_user (campus_id, email, role, status)
        values (${a.id}, ${email}, ${role}, ${status})`);
    for (const [role, status] of [
      ['platform_admin', 'active'],
      ['root', 'active'],
      ['student', 'banned'],
      ['student', 'deleted'],
    ] as const)
      expect(await pgErrorCode(insert(role, status))).toBe('23514');
    // A live account can never take the placeholder shape either
    expect(await pgErrorCode(insert('student', 'active', `deleted+${randomUUID()}@invalid`))).toBe(
      '23514',
    );
  });

  it('frees the address for a new sign-up once a deleted account wipes its email', async () => {
    const email = `gone-${randomUUID()}@aiub.edu`;
    const [gone] = await owner
      .insert(appUser)
      .values({ campusId: a.id, email })
      .returning({ id: appUser.id });
    if (!gone) throw new Error('insert returned no row');
    await owner
      .update(appUser)
      .set({ status: 'deleted', email: `deleted+${gone.id}@invalid` })
      .where(eq(appUser.id, gone.id));

    await withCampus(app, a.id, (tx) => tx.insert(appUser).values({ campusId: a.id, email }));
    const rows = await owner.select().from(appUser).where(eq(appUser.email, email));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).not.toBe(gone.id);
  });

  it('moves updated_at when a user row changes', async () => {
    await owner.update(appUser).set({ role: 'faculty' }).where(eq(appUser.id, userA.id));
    const [row] = await owner.select().from(appUser).where(eq(appUser.id, userA.id));
    expect(row && row.updatedAt > row.createdAt).toBe(true);
  });
});
