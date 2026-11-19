import { ConsoleLogger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { apiErrorSchema, otpVerifyResultSchema, requestParseResultSchema } from '@pulse/contracts';
import { campus, createDb, type Database } from '@pulse/db';
import { aiubGazetteer } from '@pulse/request-parser';
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
// The parser picks places by campus slug, so the AIUB campus here must really be "aiub"
const aiubDomain = `aiub-${run}.test`;
const otherDomain = `other-${run}.test`;
const campusRow = {
  location: { x: 90.4274, y: 23.8223 },
  timezone: 'Asia/Dhaka',
};

// Every line any part of the app logs, to prove the request text never reaches a log
class CapturingLogger extends ConsoleLogger {
  readonly lines: string[] = [];
  protected override printMessages(messages: unknown[], context?: string): void {
    const text = messages.map((m) => (typeof m === 'string' ? m : JSON.stringify(m)));
    this.lines.push(`[${context ?? ''}] ${text.join(' ')}`);
  }
}

describe('Parsing a ride request over HTTP', () => {
  let app: INestApplication<App>;
  let owner: Database;
  let redisContainer: StartedTestContainer;
  let redis: Redis;
  const logger = new CapturingLogger();
  const sent: { email: string; code: string }[] = [];
  const mailer: OtpMailer = {
    send: (email, code) => {
      sent.push({ email, code });
      return Promise.resolve();
    },
  };

  const http = () => request(app.getHttpServer());
  const parse = (cookie: string, body: object) =>
    http().post('/requests/parse').set('Origin', origin).set('Cookie', cookie).send(body);

  // Signs a new student in with an email code; returns the access cookie to send
  async function signIn(domain = aiubDomain): Promise<string> {
    const email = `student-${randomUUID().slice(0, 8)}@${domain}`;
    await http().post('/auth/otp/request').set('Origin', origin).send({ email }).expect(202);
    const code = sent.filter((mail) => mail.email === email).at(-1)?.code ?? '';
    const res = await http()
      .post('/auth/otp/verify')
      .set('Origin', origin)
      .send({ email, code })
      .expect(200);
    otpVerifyResultSchema.parse(res.body);
    const setCookie = [res.headers['set-cookie'] ?? []].flat();
    return setCookie.find((line) => line.startsWith('pulse_at='))?.split(';')[0] ?? '';
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
    await owner.insert(campus).values([
      { ...campusRow, name: 'AIUB', slug: 'aiub', emailDomains: [aiubDomain] },
      { ...campusRow, name: 'Other campus', slug: `other-${run}`, emailDomains: [otherDomain] },
    ]);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE)
      .useFactory({ factory: () => createDb(inject('appUrl')) })
      .overrideProvider(RateLimiter)
      .useFactory({ factory: () => new RateLimiter(redisUrl) })
      .overrideProvider(OTP_MAILER)
      .useValue(mailer)
      .compile();
    app = moduleRef.createNestApplication({ logger });
    configureApp(app);
    await app.init();
  }, 120_000);

  // Each case starts with no counts, so only the limit test reaches 30
  beforeEach(async () => {
    await redis.flushdb();
  });

  afterAll(async () => {
    await app?.close();
    redis?.disconnect();
    await redisContainer?.stop();
    await owner?.$client.end();
  });

  it('reads a Banglish sentence with the AIUB places', async () => {
    const cookie = await signIn();
    const res = await parse(cookie, { text: 'ML class er por Mirpur 10 jabo, shudhu meye rider' });

    const mirpur10 = aiubGazetteer.find((place) => place.name === 'Mirpur 10');
    expect(res.status).toBe(200);
    expect(requestParseResultSchema.parse(res.body)).toEqual({
      direction: 'from_campus',
      place: { name: 'Mirpur 10', cell: mirpur10?.cell },
      // No routine yet (S38), so "ML" is not resolved to a course
      timeRef: { kind: 'after_class' },
      genderPref: 'same_gender',
      confidence: 1,
      parser: 'rule@1',
    });
  });

  it('reads an English sentence', async () => {
    const cookie = await signIn();
    const res = await parse(cookie, { text: 'going home to Uttara at 5:30, 10 min wait' }).expect(
      200,
    );
    expect(requestParseResultSchema.parse(res.body)).toMatchObject({
      direction: 'from_campus',
      place: { name: 'Uttara' },
      timeRef: { kind: 'clock', time: '17:30' },
      maxWaitMin: 10,
    });
  });

  it("uses the caller's campus: a campus with no place list finds no place", async () => {
    const cookie = await signIn(otherDomain);
    const res = await parse(cookie, { text: 'Mirpur 10 jabo 5 tay' }).expect(200);
    const body = requestParseResultSchema.parse(res.body);
    expect(body.place).toBeUndefined();
    expect(body.timeRef).toEqual({ kind: 'clock', time: '17:00' });
  });

  it.each([
    ['text over 280 characters', { text: 'x'.repeat(281) }],
    ['empty text', { text: '' }],
    ['no text', {}],
    ['an unknown key', { text: 'Mirpur 10 jabo', campusId: randomUUID() }],
  ])('answers %s with 400', async (_, body) => {
    const cookie = await signIn();
    const res = await parse(cookie, body).expect(400);
    expect(apiErrorSchema.parse(res.body).statusCode).toBe(400);
  });

  it('answers 401 without a session', async () => {
    const res = await http()
      .post('/requests/parse')
      .set('Origin', origin)
      .send({ text: 'Mirpur 10 jabo' })
      .expect(401);
    expect(apiErrorSchema.parse(res.body).statusCode).toBe(401);
  });

  it('answers the 31st request in a minute with 429 and Retry-After, per user', async () => {
    const cookie = await signIn();
    for (let i = 0; i < 30; i++) {
      await parse(cookie, { text: 'Banani jabo' }).expect(200);
    }
    const res = await parse(cookie, { text: 'Banani jabo' }).expect(429);
    expect(apiErrorSchema.parse(res.body).statusCode).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(60);

    // Someone else on the same campus is not slowed down
    await parse(await signIn(), { text: 'Banani jabo' }).expect(200);
  });

  it('never writes the text to a log, on success, on 400 or on 429', async () => {
    const secret = `secret-${randomUUID()} Mirpur 10 jabo`;
    const cookie = await signIn();
    // The logger really captures: Nest logged the route when the app started
    expect(logger.lines.some((line) => line.includes('/requests/parse'))).toBe(true);
    logger.lines.length = 0;

    await parse(cookie, { text: secret }).expect(200);
    await parse(cookie, { text: secret, extra: true }).expect(400);
    for (let i = 0; i < 29; i++) await parse(cookie, { text: 'Banani jabo' }).expect(200);
    await parse(cookie, { text: secret }).expect(429);

    expect(logger.lines.join('\n')).not.toContain(secret.slice(0, 20));
  });
});
