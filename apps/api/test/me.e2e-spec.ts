import { type INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { meSchema, otpVerifyResultSchema, preferencesSchema } from '@pulse/contracts';
import {
  and,
  appUser,
  campus,
  createDb,
  eq,
  outboxEvent,
  preference,
  sql,
  zone,
  type Database,
} from '@pulse/db';
import { latLngToCell } from 'h3-js';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { inject } from 'vitest';
import { configureApp } from '../src/app.setup.js';
import { AppModule } from '../src/app.module.js';
import { OTP_MAILER, type OtpMailer } from '../src/auth/otp-mailer.js';
import { RateLimiter } from '../src/auth/rate-limiter.js';
import { DATABASE } from '../src/db/db.module.js';

const run = randomUUID().slice(0, 8);
const origin = process.env.APP_ORIGIN ?? '';
const domain = `me-${run}.test`;
// A home pin in Kuril, with digits that would stand out anywhere they were stored or logged
const home = { lat: 23.8183417, lng: 90.4209731 };
const preferences = {
  home,
  genderPref: 'same_gender',
  modes: ['cng', 'bus'],
  maxWaitMin: 10,
  maxDetourPct: 30,
  autopilotOn: true,
  quietHours: { start: '22:00', end: '07:00' },
  dailyNotifyBudget: 6,
  shareTextForTraining: false,
};

describe('/me and /me/preferences over HTTP', () => {
  let app: INestApplication<App>;
  let owner: Database;
  const campusId = randomUUID();
  const kurilId = randomUUID();
  const sent: { email: string; code: string }[] = [];
  const mailer: OtpMailer = {
    send: (email, code) => {
      sent.push({ email, code });
      return Promise.resolve();
    },
  };
  // Every line the app logs during the run, to prove the home pin never reaches the log
  const logged: string[] = [];

  const http = () => request(app.getHttpServer());
  const profileEvents = (userId: string) =>
    owner
      .select()
      .from(outboxEvent)
      .where(and(eq(outboxEvent.aggregateId, userId), eq(outboxEvent.type, 'ProfileChanged')));

  async function signIn(): Promise<{ userId: string; cookie: string }> {
    const email = `rider-${randomUUID().slice(0, 8)}@${domain}`;
    await http().post('/auth/otp/request').set('Origin', origin).send({ email }).expect(202);
    const code = sent.filter((mail) => mail.email === email).at(-1)?.code ?? '';
    const res = await http()
      .post('/auth/otp/verify')
      .set('Origin', origin)
      .send({ email, code })
      .expect(200);
    const setCookie = [res.headers['set-cookie'] ?? []].flat();
    const cookie = setCookie.find((line) => line.startsWith('pulse_at='))?.split(';')[0] ?? '';
    return { userId: otpVerifyResultSchema.parse(res.body).user.id, cookie };
  }

  beforeAll(async () => {
    owner = createDb(inject('ownerUrl'));
    await owner.insert(campus).values({
      id: campusId,
      name: 'Me campus',
      slug: `me-${run}`,
      emailDomains: [domain],
      location: { x: 90.4274, y: 23.8223 },
      timezone: 'Asia/Dhaka',
    });
    await owner.insert(zone).values({
      id: kurilId,
      campusId,
      name: 'Kuril',
      area: sql`ST_GeomFromText('MULTIPOLYGON(((90.41 23.81, 90.435 23.81, 90.435 23.83, 90.41 23.83, 90.41 23.81)))', 4326)`,
    });

    for (const level of ['log', 'error', 'warn', 'debug', 'verbose'] as const)
      vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logged.push(JSON.stringify(args));
      });

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
    vi.restoreAllMocks();
    await app?.close();
    await owner?.$client.end();
  });

  it('answers 401 without a session', async () => {
    await http().get('/me').expect(401);
    await http().patch('/me').set('Origin', origin).send({ firstName: 'X' }).expect(401);
    await http().get('/me/preferences').expect(401);
    await http().put('/me/preferences').set('Origin', origin).send(preferences).expect(401);
  });

  it('flips a new user to active once the profile is complete, with one ProfileChanged row each time', async () => {
    const { userId, cookie } = await signIn();
    const patch = (body: object) =>
      http().patch('/me').set('Origin', origin).set('Cookie', cookie).send(body);

    const before = meSchema.parse((await http().get('/me').set('Cookie', cookie).expect(200)).body);
    expect(before).toMatchObject({ id: userId, status: 'pending_profile', firstName: null });
    expect(before.campus).toEqual({ id: campusId, slug: `me-${run}`, name: 'Me campus' });

    const half = meSchema.parse((await patch({ firstName: 'Nusrat' }).expect(200)).body);
    expect(half.status).toBe('pending_profile');
    const done = meSchema.parse(
      (await patch({ lastName: 'Jahan', gender: 'female', phone: '+8801711223344' }).expect(200))
        .body,
    );
    expect(done).toMatchObject({ status: 'active', lastName: 'Jahan', phone: '+8801711223344' });

    const events = await profileEvents(userId);
    expect(events).toHaveLength(2);
    // The snapshot never carries a name or a phone number
    expect(JSON.stringify(events)).not.toMatch(/Nusrat|Jahan|8801711223344/);
    expect(events.at(-1)?.payload).toMatchObject({
      campusId,
      userId,
      status: 'active',
      zoneId: null,
      homeCell: null,
    });
    await patch({ role: 'campus_admin' }).expect(400);
    await patch({ phone: '01711223344' }).expect(400);
  });

  it('stores the H3 cell and zone of the home pin, never the pin itself', async () => {
    const { userId, cookie } = await signIn();
    await http().get('/me/preferences').set('Cookie', cookie).expect(404);

    const res = await http()
      .put('/me/preferences')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send(preferences)
      .expect(200);
    const saved = preferencesSchema.parse(res.body);
    expect(saved).toMatchObject({
      homeZone: { id: kurilId, name: 'Kuril' },
      quietHours: { start: '22:00', end: '07:00' },
      modes: ['cng', 'bus'],
    });
    expect(JSON.stringify(res.body)).not.toMatch(/23\.818|90\.420/);

    const [row] = await owner.select().from(preference).where(eq(preference.userId, userId));
    expect(row?.homeCell).toBe(latLngToCell(home.lat, home.lng, 8));
    expect(row?.zoneId).toBe(kurilId);
    expect(JSON.stringify(row)).not.toMatch(/23\.818|90\.420/);

    const events = await profileEvents(userId);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      zoneId: kurilId,
      homeCell: row?.homeCell,
      genderPref: 'same_gender',
      modes: ['cng', 'bus'],
      autopilotOn: true,
    });
    expect(JSON.stringify(events)).not.toMatch(/23\.818|90\.420/);
    expect(logged.join('\n')).not.toMatch(/23\.818|90\.420/);

    // A second PUT replaces the set; a home outside every zone has no zone
    const far = await http()
      .put('/me/preferences')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send({ ...preferences, home: { lat: 23.75, lng: 90.39 }, quietHours: null })
      .expect(200);
    expect(preferencesSchema.parse(far.body)).toMatchObject({ homeZone: null, quietHours: null });
    expect(await profileEvents(userId)).toHaveLength(2);
  });

  it('refuses a bad preference body and leaves the stored set alone', async () => {
    const { cookie } = await signIn();
    const put = (body: object) =>
      http().put('/me/preferences').set('Origin', origin).set('Cookie', cookie).send(body);
    await put({ ...preferences, maxWaitMin: 61 }).expect(400);
    await put({ ...preferences, modes: [] }).expect(400);
    await put({ ...preferences, homeCell: '883cf13b03fffff' }).expect(400);
    await http().get('/me/preferences').set('Cookie', cookie).expect(404);
  });

  it('keeps a zone that is someone’s home zone from being deleted (409)', async () => {
    const { userId, cookie } = await signIn();
    await http()
      .put('/me/preferences')
      .set('Origin', origin)
      .set('Cookie', cookie)
      .send(preferences)
      .expect(200);
    await owner.update(appUser).set({ role: 'campus_admin' }).where(eq(appUser.id, userId));
    await http()
      .delete(`/admin/zones/${kurilId}`)
      .set('Origin', origin)
      .set('Cookie', cookie)
      .expect(409);
  });
});
