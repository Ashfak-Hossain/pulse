import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { authSessionListSchema, otpVerifyResultSchema } from '@pulse/contracts';
import { appUser, authSession, campus, createDb, eq, sql, type Database } from '@pulse/db';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { inject } from 'vitest';
import { configureApp } from '../src/app.setup.js';
import { AppModule } from '../src/app.module.js';
import { hashRefreshToken } from '../src/auth/auth-tokens.js';
import { OTP_MAILER, type OtpMailer } from '../src/auth/otp-mailer.js';
import { RateLimiter } from '../src/auth/rate-limiter.js';
import { DATABASE } from '../src/db/db.module.js';

const run = randomUUID().slice(0, 8);
const domain = `refresh-${run}.test`;
const otherDomain = `refresh-other-${run}.test`;
const origin = process.env.APP_ORIGIN ?? '';

/** One signed-in browser: its two cookies as `name=value`, ready for a Cookie header. */
type Device = { userId: string; access: string; refresh: string };

const cookieValue = (setCookie: string[], name: string) =>
  setCookie.find((line) => line.startsWith(`${name}=`))?.split(';')[0] ?? '';
const setCookieOf = (res: request.Response) => [res.headers['set-cookie'] ?? []].flat();

describe('Refresh rotation and session management over HTTP', () => {
  let app: INestApplication<App>;
  let owner: Database;
  const sent: { email: string; code: string }[] = [];
  const mailer: OtpMailer = {
    send: (email, code) => {
      sent.push({ email, code });
      return Promise.resolve();
    },
  };

  const http = () => request(app.getHttpServer());
  const newEmail = (at = domain) => `student-${randomUUID().slice(0, 8)}@${at}`;

  async function signIn(email = newEmail(), browserCookie?: string): Promise<Device> {
    await http().post('/auth/otp/request').set('Origin', origin).send({ email }).expect(202);
    const code = sent.filter((mail) => mail.email === email).at(-1)?.code ?? '';
    const req = http()
      .post('/auth/otp/verify')
      .set('Origin', origin)
      .set('User-Agent', 'e2e-browser/1.0');
    const res = await (browserCookie ? req.set('Cookie', browserCookie) : req)
      .send({ email, code })
      .expect(200);
    const setCookie = setCookieOf(res);
    return {
      userId: otpVerifyResultSchema.parse(res.body).user.id,
      access: cookieValue(setCookie, 'pulse_at'),
      refresh: cookieValue(setCookie, 'pulse_rt'),
    };
  }

  const refresh = (cookie: string) =>
    http().post('/auth/refresh').set('Origin', origin).set('Cookie', cookie);

  /** A successful refresh: the same user on new cookies. */
  async function refreshed(device: Device): Promise<Device> {
    const res = await refresh(device.refresh).expect(204);
    const setCookie = setCookieOf(res);
    return {
      userId: device.userId,
      access: cookieValue(setCookie, 'pulse_at'),
      refresh: cookieValue(setCookie, 'pulse_rt'),
    };
  }

  const listSessions = (access: string) => http().get('/auth/sessions').set('Cookie', access);

  async function sessionsOf(device: Device) {
    const res = await listSessions(device.access).expect(200);
    return authSessionListSchema.parse(res.body).sessions;
  }

  async function rowOf(refreshCookie: string) {
    const token = refreshCookie.slice('pulse_rt='.length);
    const [row] = await owner
      .select()
      .from(authSession)
      .where(eq(authSession.tokenHash, hashRefreshToken(token)));
    if (!row) throw new Error('no auth_session row for this refresh cookie');
    return row;
  }

  const familyRows = (familyId: string) =>
    owner.select().from(authSession).where(eq(authSession.familyId, familyId));

  // The guard trigger stamps rotated_at with now() and refuses to change it. As the superuser
  // owner, replica mode skips the trigger, which is the only way to fake "11 seconds ago"
  async function ageRotation(refreshCookie: string, seconds: number): Promise<void> {
    const { id } = await rowOf(refreshCookie);
    await owner.transaction(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx
        .update(authSession)
        .set({ rotatedAt: sql`now() - make_interval(secs => ${seconds})` })
        .where(eq(authSession.id, id));
    });
  }

  // Makes a race happen for sure: the test holds the row lock, starts the requests one by one
  // (each waits on a lock before the next starts, so they queue in that order), then lets go
  async function whileRowLocked<T>(refreshCookie: string, requests: (() => Promise<T>)[]) {
    const { id } = await rowOf(refreshCookie);
    const started: Promise<T>[] = [];
    await owner.transaction(async (tx) => {
      await tx.execute(sql`select id from auth_session where id = ${id} for update`);
      for (const [index, send] of requests.entries()) {
        started.push(send());
        await waitForLockWaiters(index + 1);
      }
    });
    return Promise.all(started);
  }

  async function waitForLockWaiters(count: number): Promise<void> {
    for (let tries = 0; tries < 400; tries += 1) {
      const { rows } = await owner.execute(
        sql`select count(*)::int as waiting from pg_stat_activity
            where wait_event_type = 'Lock' and datname = current_database()`,
      );
      if (Number(rows[0]?.waiting) >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`fewer than ${count} requests are waiting on a lock`);
  }

  function expectCleared(res: request.Response): void {
    const setCookie = setCookieOf(res);
    expect(setCookie.find((line) => line.startsWith('pulse_at=;'))).toMatch(
      /Expires=Thu, 01 Jan 1970/,
    );
    expect(setCookie.find((line) => line.startsWith('pulse_rt=;'))).toMatch(/Path=\/auth/);
  }

  beforeAll(async () => {
    owner = createDb(inject('ownerUrl'));
    await owner.insert(campus).values([
      {
        name: 'Refresh campus',
        slug: `refresh-${run}`,
        emailDomains: [domain],
        location: { x: 90.4274, y: 23.8223 },
        timezone: 'Asia/Dhaka',
      },
      {
        name: 'Other refresh campus',
        slug: `refresh-other-${run}`,
        emailDomains: [otherDomain],
        location: { x: 90.4, y: 23.8 },
        timezone: 'Asia/Dhaka',
      },
    ]);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE)
      .useFactory({ factory: () => createDb(inject('appUrl')) })
      // Rate limits have their own e2e file; here they would only need a Redis container
      .overrideProvider(RateLimiter)
      .useValue({ hit: () => Promise.resolve() })
      .overrideProvider(OTP_MAILER)
      .useValue(mailer)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await owner?.$client.end();
  });

  describe('POST /auth/refresh', () => {
    it('swaps the refresh cookie for a new pair on the same device', async () => {
      const first = await signIn();
      const res = await refresh(first.refresh).expect(204);
      const setCookie = setCookieOf(res);
      expect(setCookie.find((line) => line.startsWith('pulse_at='))).toMatch(/; Max-Age=900;/);
      expect(setCookie.find((line) => line.startsWith('pulse_rt='))).toMatch(
        /; Max-Age=2592000; Path=\/auth;/,
      );

      const second: Device = {
        userId: first.userId,
        access: cookieValue(setCookie, 'pulse_at'),
        refresh: cookieValue(setCookie, 'pulse_rt'),
      };
      expect(second.refresh).not.toBe(first.refresh);
      await listSessions(second.access).expect(200);

      // The child keeps the family and what the device said at sign-in, and slides 30 days
      const parent = await rowOf(first.refresh);
      const child = await rowOf(second.refresh);
      expect(child.familyId).toBe(parent.familyId);
      expect(child.userAgent).toBe('e2e-browser/1.0');
      expect(child.ipHash).toBe(parent.ipHash);
      expect(parent.rotatedAt).not.toBeNull();
      expect(child.expiresAt.getTime()).toBeGreaterThan(parent.expiresAt.getTime());
    });

    it('answers a just-rotated token with a plain 401 and keeps the device signed in', async () => {
      const first = await signIn();
      const second = await refreshed(first);

      await refresh(first.refresh).expect(401);
      await refreshed(second);
    });

    it('lets one of two tabs refreshing at once win; the other gets 401 and nothing is revoked', async () => {
      const first = await signIn();
      const [winner, loser] = await whileRowLocked(first.refresh, [
        () => refresh(first.refresh).then((res) => res),
        () => refresh(first.refresh).then((res) => res),
      ]);
      expect([winner?.status, loser?.status]).toEqual([204, 401]);

      await refresh(cookieValue(winner ? setCookieOf(winner) : [], 'pulse_rt')).expect(204);
    });

    // Under READ COMMITTED an UPDATE sees only rows committed when it started; the child a
    // refresh inserts while the revoke waits on its lock must not slip through
    it.each([
      ['sign-out', (device: Device) => http().post('/auth/sign-out').set('Cookie', device.access)],
      [
        'sign-out-all',
        (device: Device) => http().post('/auth/sign-out-all').set('Cookie', device.access),
      ],
    ])('a %s that waits on a refresh still ends the row it creates', async (_, signOut) => {
      const first = await signIn();
      const [rotated, signedOut] = await whileRowLocked(first.refresh, [
        () => refresh(first.refresh).then((res) => res),
        () =>
          signOut(first)
            .set('Origin', origin)
            .then((res) => res),
      ]);
      expect([rotated?.status, signedOut?.status]).toEqual([204, 204]);

      const child = cookieValue(rotated ? setCookieOf(rotated) : [], 'pulse_at');
      await listSessions(child).expect(401);
    });

    it('treats an old token after the 10 s grace as stolen and revokes the whole device', async () => {
      const first = await signIn();
      const second = await refreshed(first);
      await ageRotation(first.refresh, 11);

      await refresh(first.refresh).expect(401);
      await refresh(second.refresh).expect(401);
      await listSessions(second.access).expect(401);

      const rows = await familyRows((await rowOf(first.refresh)).familyId);
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.revokeReason === 'reuse_detected')).toBe(true);
    });

    it('refuses a suspended user and issues nothing', async () => {
      const device = await signIn();
      await owner.update(appUser).set({ status: 'suspended' }).where(eq(appUser.id, device.userId));

      const res = await refresh(device.refresh).expect(401);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect((await rowOf(device.refresh)).rotatedAt).toBeNull();
    });

    it.each([
      ['no cookie', ''],
      ['a garbage cookie', 'pulse_rt=not-a-token'],
      ['a well-formed token nobody issued', `pulse_rt=${randomUUID()}.${'A'.repeat(43)}`],
    ])('answers 401 to %s', async (_, cookie) => {
      await refresh(cookie).expect(401);
    });

    it('answers 401 once the device signed out', async () => {
      const device = await signIn();
      await http()
        .post('/auth/sign-out')
        .set('Origin', origin)
        .set('Cookie', `${device.access}; ${device.refresh}`)
        .expect(204);
      await refresh(device.refresh).expect(401);
    });
  });

  describe('GET /auth/sessions', () => {
    it('lists one entry per device, marks this one, and keeps its id across refreshes', async () => {
      const email = newEmail();
      const laptop = await signIn(email);
      const phone = await refreshed(await signIn(email));

      const seenFromLaptop = await sessionsOf(laptop);
      expect(seenFromLaptop).toHaveLength(2);
      expect(seenFromLaptop.filter((session) => session.current)).toHaveLength(1);
      expect(seenFromLaptop.every((session) => session.userAgent === 'e2e-browser/1.0')).toBe(true);

      const phoneEntry = seenFromLaptop.find((session) => !session.current);
      const phoneAgain = await refreshed(phone);
      const seenFromPhone = await sessionsOf(phoneAgain);
      expect(seenFromPhone.find((session) => session.current)?.id).toBe(phoneEntry?.id);
    });
  });

  describe('DELETE /auth/sessions/:id', () => {
    it('signs out another device of mine and nothing else', async () => {
      const email = newEmail();
      const laptop = await signIn(email);
      const phone = await signIn(email);
      const phoneId = (await sessionsOf(laptop)).find((session) => !session.current)?.id;

      await http()
        .delete(`/auth/sessions/${phoneId}`)
        .set('Origin', origin)
        .set('Cookie', laptop.access)
        .expect(204);

      await listSessions(phone.access).expect(401);
      await refresh(phone.refresh).expect(401);
      expect(await sessionsOf(laptop)).toHaveLength(1);
    });

    it('works like sign-out for this device: cookies cleared, token dead', async () => {
      const device = await signIn();
      const [mine] = await sessionsOf(device);

      const res = await http()
        .delete(`/auth/sessions/${mine?.id}`)
        .set('Origin', origin)
        .set('Cookie', device.access)
        .expect(204);
      expectCleared(res);
      await listSessions(device.access).expect(401);
    });

    it("answers 404 for someone else's device, on this campus or another, and leaves it alive", async () => {
      const alice = await signIn();
      const bob = await signIn();
      const carol = await signIn(newEmail(otherDomain));
      const [aliceSession] = await sessionsOf(alice);

      for (const intruder of [bob, carol]) {
        await http()
          .delete(`/auth/sessions/${aliceSession?.id}`)
          .set('Origin', origin)
          .set('Cookie', intruder.access)
          .expect(404);
      }
      await listSessions(alice.access).expect(200);
    });

    it('answers 404 for a device already signed out, and 400 for an id that is not a UUID', async () => {
      const email = newEmail();
      const laptop = await signIn(email);
      const phone = await signIn(email);
      const phoneId = (await sessionsOf(laptop)).find((session) => !session.current)?.id;
      await http()
        .post('/auth/sign-out')
        .set('Origin', origin)
        .set('Cookie', phone.access)
        .expect(204);

      const del = (id: string) =>
        http().delete(`/auth/sessions/${id}`).set('Origin', origin).set('Cookie', laptop.access);
      await del(phoneId ?? '').expect(404);
      await del('not-a-uuid').expect(400);
    });
  });

  describe('POST /auth/sign-out-all', () => {
    it('signs out every device of the user, refreshed-away rows included', async () => {
      const email = newEmail();
      const laptop = await signIn(email);
      const phone = await refreshed(await signIn(email));

      const res = await http()
        .post('/auth/sign-out-all')
        .set('Origin', origin)
        .set('Cookie', laptop.access)
        .expect(204);
      expectCleared(res);

      for (const device of [laptop, phone]) {
        await listSessions(device.access).expect(401);
        await refresh(device.refresh).expect(401);
      }
      const rows = await owner
        .select()
        .from(authSession)
        .where(eq(authSession.userId, laptop.userId));
      expect(rows).toHaveLength(3);
      expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
    });

    it('leaves other users signed in', async () => {
      const mine = await signIn();
      const theirs = await signIn();
      await http()
        .post('/auth/sign-out-all')
        .set('Origin', origin)
        .set('Cookie', mine.access)
        .expect(204);
      await listSessions(theirs.access).expect(200);
    });
  });

  describe('POST /auth/sign-out without a live access token', () => {
    it('signs out with only the refresh cookie, as after the access token expired', async () => {
      const device = await signIn();
      const res = await http()
        .post('/auth/sign-out')
        .set('Origin', origin)
        .set('Cookie', device.refresh)
        .expect(204);
      expectCleared(res);

      await listSessions(device.access).expect(401);
      await refresh(device.refresh).expect(401);
    });

    it('ends the whole device, including an access token from before the last refresh', async () => {
      const first = await signIn();
      const second = await refreshed(first);
      await listSessions(first.access).expect(200);

      await http()
        .post('/auth/sign-out')
        .set('Origin', origin)
        .set('Cookie', `${second.access}; ${second.refresh}`)
        .expect(204);
      await listSessions(first.access).expect(401);
    });

    it('ends both devices if the two cookies ever name different ones', async () => {
      const email = newEmail();
      const laptop = await signIn(email);
      const phone = await signIn(email);

      await http()
        .post('/auth/sign-out')
        .set('Origin', origin)
        .set('Cookie', `${laptop.access}; ${phone.refresh}`)
        .expect(204);
      await listSessions(laptop.access).expect(401);
      await listSessions(phone.access).expect(401);
    });
  });

  describe('POST /auth/otp/verify on a browser that is already signed in', () => {
    it('ends the old session of that browser', async () => {
      const email = newEmail();
      const before = await signIn(email);
      const after = await signIn(email, `${before.access}; ${before.refresh}`);

      await listSessions(before.access).expect(401);
      await refresh(before.refresh).expect(401);
      await listSessions(after.access).expect(200);
    });

    it('keeps the old session when the new code is wrong', async () => {
      const email = newEmail();
      const before = await signIn(email);
      await http().post('/auth/otp/request').set('Origin', origin).send({ email }).expect(202);
      await http()
        .post('/auth/otp/verify')
        .set('Origin', origin)
        .set('Cookie', before.refresh)
        .send({ email, code: '000000' })
        .expect(400);

      await listSessions(before.access).expect(200);
    });
  });
});
