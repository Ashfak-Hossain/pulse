import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { apiErrorSchema, otpRequestAcceptedSchema, otpVerifyResultSchema } from '@pulse/contracts';
import { appUser, campus, createDb, emailOtp, eq, sql, withCampus, type Database } from '@pulse/db';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { inject } from 'vitest';
import { configureApp } from '../src/app.setup.js';
import { AppModule } from '../src/app.module.js';
import { OTP_MAILER, type OtpMailer } from '../src/auth/otp-mailer.js';
import { RateLimiter } from '../src/auth/rate-limiter.js';
import { DATABASE } from '../src/db/db.module.js';

// Every state-changing request must come from the app's own origin (OriginGuard)
const origin = process.env.APP_ORIGIN ?? '';

const run = randomUUID().slice(0, 8);
const domain = `auth-${run}.test`;
const ambiguousDomain = `shared-auth-${run}.test`;
const unknownDomain = `unknown-auth-${run}.test`;
const campusData = {
  name: 'Auth campus',
  slug: `auth-${run}`,
  emailDomains: [domain, ambiguousDomain],
  location: { x: 90.4274, y: 23.8223 },
  timezone: 'Asia/Dhaka',
};

// Every verify failure must look the same, so none tells a guesser that a code exists
const genericFailure = {
  statusCode: 400,
  error: 'Bad Request',
  message: 'Invalid or expired code',
};

describe('Sign-in with an email code over HTTP', () => {
  let app: INestApplication<App>;
  let owner: Database;
  let redisContainer: StartedTestContainer;
  let redis: Redis;
  let campusId: string;
  // What the mailer was asked to send, newest last
  const sent: { email: string; code: string }[] = [];

  const mailer: OtpMailer = {
    send: (email, code) => {
      sent.push({ email, code });
      return Promise.resolve();
    },
  };

  const http = () => request(app.getHttpServer());
  const requestCode = (email: string) =>
    http().post('/auth/otp/request').set('Origin', origin).send({ email });
  const verify = (email: string, code: string) =>
    http().post('/auth/otp/verify').set('Origin', origin).send({ email, code });
  // A fresh address per test: rows and Redis counts never leak between cases
  const newEmail = (host = domain) => `student-${randomUUID().slice(0, 8)}@${host}`;
  const wrong = (code: string) => (code === '000000' ? '000001' : '000000');

  async function codeFor(email: string): Promise<string> {
    await requestCode(email).expect(202);
    const code = sent.filter((mail) => mail.email === email).at(-1)?.code;
    if (!code) throw new Error('no code was sent');
    return code;
  }

  // Resets one limit for every subject (keys hold hashes, so a test cannot name one)
  async function clearCounts(limitName: string): Promise<void> {
    const keys = await redis.keys(`rl:${limitName}:*`);
    if (keys.length > 0) await redis.del(...keys);
  }

  // A fresh CI runner pulls the Redis image here first, which can take a minute
  beforeAll(async () => {
    redisContainer = await new GenericContainer('redis:8.10-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
      .start();
    const redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
    redis = new Redis(redisUrl);

    owner = createDb(inject('ownerUrl'));
    const [created] = await owner
      .insert(campus)
      .values([
        campusData,
        { ...campusData, slug: `auth-shared-${run}`, emailDomains: [ambiguousDomain] },
      ])
      .returning({ id: campus.id, slug: campus.slug });
    if (!created || created.slug !== campusData.slug) throw new Error('campus not created');
    campusId = created.id;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE)
      .useFactory({ factory: () => createDb(inject('appUrl')) })
      .overrideProvider(RateLimiter)
      .useFactory({ factory: () => new RateLimiter(redisUrl) })
      .overrideProvider(OTP_MAILER)
      .useValue(mailer)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  }, 120_000);

  // Each case starts with no counts, so the per-IP limits (every request here comes from
  // 127.0.0.1) only trip in the tests about them
  beforeEach(async () => {
    await redis.flushdb();
    sent.length = 0;
  });

  afterAll(async () => {
    await app?.close();
    redis?.disconnect();
    await redisContainer?.stop();
    await owner?.$client.end();
  });

  describe('POST /auth/otp/request', () => {
    it('answers a known, an unknown and an ambiguous domain with the same 202', async () => {
      const known = newEmail();
      const bodies = [];
      for (const email of [known, newEmail(unknownDomain), newEmail(ambiguousDomain)]) {
        const res = await requestCode(email).expect(202);
        bodies.push(otpRequestAcceptedSchema.parse(res.body));
      }
      expect(bodies).toEqual([{ expiresInSec: 600 }, { expiresInSec: 600 }, { expiresInSec: 600 }]);
      // Only the address that can sign in got a code
      expect(sent.map((mail) => mail.email)).toEqual([known]);
    });

    it('stores hashes only, with a 10-minute expiry from the database clock', async () => {
      const email = newEmail();
      const code = await codeFor(email);
      const rows = await owner.select().from(emailOtp).where(eq(emailOtp.email, email));
      expect(rows).toHaveLength(1);
      const [row] = rows;
      expect(row?.campusId).toBe(campusId);
      expect(row?.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row?.codeHash).not.toContain(code);
      expect(row?.ipHash).toMatch(/^[0-9a-f]{64}$/);
      expect(row && row.expiresAt.getTime() - row.createdAt.getTime()).toBe(10 * 60 * 1000);
    });

    it('answers the sixth code for one email in an hour with 429 and Retry-After', async () => {
      const email = newEmail();
      for (let i = 0; i < 5; i++) await requestCode(email).expect(202);
      const res = await requestCode(email).expect(429);
      expect(apiErrorSchema.parse(res.body).statusCode).toBe(429);
      const retryAfter = Number(res.headers['retry-after']);
      expect(Number.isInteger(retryAfter)).toBe(true);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(3600);
      expect(sent).toHaveLength(5);
    });

    // Otherwise a 429 for one address and a 202 for another would tell which can sign in
    it('counts an unknown domain against the same limit', async () => {
      const email = newEmail(unknownDomain);
      for (let i = 0; i < 5; i++) await requestCode(email).expect(202);
      await requestCode(email).expect(429);
    });

    it('answers the 61st request from one IP in an hour with 429', async () => {
      for (let i = 0; i < 60; i++) await requestCode(newEmail(unknownDomain)).expect(202);
      await requestCode(newEmail(unknownDomain)).expect(429);
    });

    // Otherwise one blocked IP could use up the request quota of any address for free
    it('spends no email quota once the IP is over its limit', async () => {
      const victim = newEmail();
      for (let i = 0; i < 60; i++) await requestCode(newEmail(unknownDomain)).expect(202);
      for (let i = 0; i < 5; i++) await requestCode(victim).expect(429);

      await clearCounts('otp-request-ip');
      for (let i = 0; i < 5; i++) await requestCode(victim).expect(202);
    });

    it.each([
      ['an unknown field', { email: 'student@aiub.edu', remember: true }],
      ['a plus address', { email: `student+1@${domain}` }],
    ])('rejects %s with 400 and sends nothing', async (_, body) => {
      await http().post('/auth/otp/request').set('Origin', origin).send(body).expect(400);
      expect(sent).toHaveLength(0);
    });
  });

  describe('POST /auth/otp/verify', () => {
    it('creates the user on the first sign-in and finds it on the next', async () => {
      const email = newEmail();
      const first = await verify(email, await codeFor(email)).expect(200);
      const created = otpVerifyResultSchema.parse(first.body);
      expect(created).toEqual({
        user: { id: created.user.id, campusId, email, role: 'student', status: 'pending_profile' },
        isNew: true,
      });

      const second = await verify(email, await codeFor(email)).expect(200);
      expect(otpVerifyResultSchema.parse(second.body)).toEqual({
        user: created.user,
        isNew: false,
      });
      const users = await owner.select().from(appUser).where(eq(appUser.email, email));
      expect(users).toHaveLength(1);
    });

    it('accepts the email in any letter case', async () => {
      const email = newEmail();
      const code = await codeFor(email);
      await verify(email.toUpperCase(), code).expect(200);
    });

    it('accepts a code only once', async () => {
      const email = newEmail();
      const code = await codeFor(email);
      await verify(email, code).expect(200);
      const res = await verify(email, code).expect(400);
      expect(res.body).toEqual(genericFailure);
    });

    // A second request (by the user or by someone else) must not lock the user out of the first
    it('accepts an older live code, then refuses every other code for that email', async () => {
      const email = newEmail();
      const older = await codeFor(email);
      const newer = await codeFor(email);
      await verify(email, older).expect(200);
      await verify(email, newer).expect(400);
      const rows = await owner.select().from(emailOtp).where(eq(emailOtp.email, email));
      expect(rows.every((row) => row.consumedAt !== null)).toBe(true);
    });

    it('stops accepting a code after five wrong tries', async () => {
      const email = newEmail();
      const code = await codeFor(email);
      for (let i = 0; i < 5; i++) await verify(email, wrong(code)).expect(400);
      // Without the per-email count, so only the code's own attempts decide
      await clearCounts('otp-verify-email');
      const res = await verify(email, code).expect(400);
      expect(res.body).toEqual(genericFailure);
      const [row] = await owner.select().from(emailOtp).where(eq(emailOtp.email, email));
      expect(row?.attempts).toBe(5);
    });

    // Rotating IPs or asking for new codes must not buy more guesses
    it('blocks an email after five verifies, even with a fresh code', async () => {
      const email = newEmail();
      const code = await codeFor(email);
      for (let i = 0; i < 5; i++) await verify(email, wrong(code)).expect(400);
      await verify(email, await codeFor(email)).expect(429);
    });

    // Counting before the guess is one atomic step, so a burst cannot slip past the limit
    it('lets at most five of ten parallel guesses reach the code', async () => {
      const email = newEmail();
      const code = await codeFor(email);
      const results = await Promise.all(
        Array.from({ length: 10 }, () => verify(email, wrong(code))),
      );
      const statuses = results.map((res) => res.status).sort();
      expect(statuses).toEqual([400, 400, 400, 400, 400, 429, 429, 429, 429, 429]);
      const [row] = await owner.select().from(emailOtp).where(eq(emailOtp.email, email));
      expect(row?.attempts).toBe(5);
    });

    it('answers the 121st verify from one IP in an hour with 429', async () => {
      for (let i = 0; i < 120; i++) await verify(newEmail(unknownDomain), '123456').expect(400);
      await verify(newEmail(unknownDomain), '123456').expect(429);
    });

    it('gives the same 400 for every kind of failure', async () => {
      const noCode = newEmail();
      const wrongCode = newEmail();
      const expired = newEmail();
      const wrongCodeValue = wrong(await codeFor(wrongCode));
      const expiredCode = await codeFor(expired);
      // Moved into the past by the owner; the app role cannot change these columns
      await owner
        .update(emailOtp)
        .set({
          createdAt: sql`now() - interval '20 minutes'`,
          expiresAt: sql`now() - interval '10 minutes'`,
        })
        .where(eq(emailOtp.email, expired));

      const failures = [
        [newEmail(unknownDomain), '123456'],
        [newEmail(ambiguousDomain), '123456'],
        [noCode, '123456'],
        [wrongCode, wrongCodeValue],
        [expired, expiredCode],
      ] as const;
      for (const [email, code] of failures) {
        const res = await verify(email, code).expect(400);
        expect(res.body).toEqual(genericFailure);
      }
    });

    it('lets exactly one of two racing verifies with the right code through', async () => {
      const email = newEmail();
      const code = await codeFor(email);
      const results = await Promise.all([verify(email, code), verify(email, code)]);
      expect(results.map((res) => res.status).sort()).toEqual([200, 400]);
      const users = await owner.select().from(appUser).where(eq(appUser.email, email));
      expect(users).toHaveLength(1);
    });

    // The address is taken by a user of another campus (say the domain moved): never a 500,
    // and nothing in the answer about that other account
    it('gives the generic 400 when the email belongs to a user of another campus', async () => {
      const email = newEmail();
      const [other] = await owner
        .insert(campus)
        .values({ ...campusData, slug: `auth-other-${run}`, emailDomains: [`other-${run}.test`] })
        .returning({ id: campus.id });
      if (!other) throw new Error('campus not created');
      await withCampus(owner, other.id, (tx) =>
        tx.insert(appUser).values({ campusId: other.id, email }),
      );

      const res = await verify(email, await codeFor(email)).expect(400);
      expect(res.body).toEqual(genericFailure);
      const users = await owner.select().from(appUser).where(eq(appUser.email, email));
      expect(users.map((user) => user.campusId)).toEqual([other.id]);
    });

    it.each([
      ['an unknown field', { email: 'student@aiub.edu', code: '123456', remember: true }],
      ['a five-digit code', { email: 'student@aiub.edu', code: '12345' }],
    ])('rejects %s with 400', async (_, body) => {
      await http().post('/auth/otp/verify').set('Origin', origin).send(body).expect(400);
    });
  });
});
