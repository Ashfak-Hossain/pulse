import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  apiErrorSchema,
  otpVerifyResultSchema,
  trustedContactListSchema,
  trustedContactSchema,
  vehicleListSchema,
  vehicleSchema,
} from '@pulse/contracts';
import { appUser, campus, createDb, eq, trustedContact, type Database } from '@pulse/db';
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
const domain = `people-${run}.test`;
const car = { type: 'car', seats: 3, plate: 'DHAKA METRO GA 11-2233', color: 'White' };
const contact = (n: number) => ({
  name: `Contact ${n}`,
  phone: '+8801711000000',
  relation: 'friend',
});

describe('/me/vehicles and /me/trusted-contacts over HTTP', () => {
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
  const post = (path: string, cookie: string, body: object) =>
    http().post(path).set('Origin', origin).set('Cookie', cookie).send(body);
  const get = (path: string, cookie: string) => http().get(path).set('Cookie', cookie);

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
      name: 'People campus',
      slug: `people-${run}`,
      emailDomains: [domain],
      location: { x: 90.4274, y: 23.8223 },
      timezone: 'Asia/Dhaka',
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
    await app?.close();
    await owner?.$client.end();
  });

  it('answers 401 without a session and 403 to an operator', async () => {
    await http().get('/me/vehicles').expect(401);
    await http().post('/me/trusted-contacts').set('Origin', origin).send({}).expect(401);
    const operator = await signIn();
    await owner.update(appUser).set({ role: 'operator' }).where(eq(appUser.id, operator.userId));
    await get('/me/vehicles', operator.cookie).expect(403);
    await post('/me/trusted-contacts', operator.cookie, contact(1)).expect(403);
  });

  it('adds, changes and hides a vehicle, and refuses seats that do not fit the type', async () => {
    const { cookie } = await signIn();
    const created = vehicleSchema.parse((await post('/me/vehicles', cookie, car).expect(201)).body);
    expect(created).toMatchObject(car);

    const patch = (body: object) =>
      http()
        .patch(`/me/vehicles/${created.id}`)
        .set('Origin', origin)
        .set('Cookie', cookie)
        .send(body);
    await patch({ seats: 2 }).expect(200);
    // Bike with the stored 2 seats: only the database can see the clash
    await patch({ type: 'bike' }).expect(422);
    await post('/me/vehicles', cookie, { ...car, type: 'bike', seats: 2 }).expect(400);

    await http()
      .delete(`/me/vehicles/${created.id}`)
      .set('Origin', origin)
      .set('Cookie', cookie)
      .expect(204);
    const list = vehicleListSchema.parse((await get('/me/vehicles', cookie).expect(200)).body);
    expect(list.items).toEqual([]);
    await patch({ seats: 1 }).expect(404);
  });

  it('answers 404 for another user’s vehicle or contact, and never lists them', async () => {
    const mine = await signIn();
    const theirs = await signIn();
    const vehicle = vehicleSchema.parse((await post('/me/vehicles', theirs.cookie, car)).body);
    const added = trustedContactSchema.parse(
      (await post('/me/trusted-contacts', theirs.cookie, contact(1))).body,
    );

    await http()
      .patch(`/me/vehicles/${vehicle.id}`)
      .set('Origin', origin)
      .set('Cookie', mine.cookie)
      .send({ seats: 1 })
      .expect(404);
    await http()
      .delete(`/me/vehicles/${vehicle.id}`)
      .set('Origin', origin)
      .set('Cookie', mine.cookie)
      .expect(404);
    await http()
      .delete(`/me/trusted-contacts/${added.id}`)
      .set('Origin', origin)
      .set('Cookie', mine.cookie)
      .expect(404);
    const myVehicles = vehicleListSchema.parse((await get('/me/vehicles', mine.cookie)).body);
    const myContacts = trustedContactListSchema.parse(
      (await get('/me/trusted-contacts', mine.cookie)).body,
    );
    expect(myVehicles.items).toEqual([]);
    expect(myContacts.items).toEqual([]);
  });

  it('answers 422 TRUSTED_CONTACT_LIMIT to a fourth contact, and frees a slot on delete', async () => {
    const { cookie } = await signIn();
    const ids: string[] = [];
    for (const n of [1, 2, 3])
      ids.push(
        trustedContactSchema.parse(
          (await post('/me/trusted-contacts', cookie, contact(n)).expect(201)).body,
        ).id,
      );

    const fourth = await post('/me/trusted-contacts', cookie, contact(4)).expect(422);
    expect(apiErrorSchema.parse(fourth.body)).toMatchObject({ code: 'TRUSTED_CONTACT_LIMIT' });

    await http()
      .delete(`/me/trusted-contacts/${ids[1] ?? ''}`)
      .set('Origin', origin)
      .set('Cookie', cookie)
      .expect(204);
    await post('/me/trusted-contacts', cookie, contact(5)).expect(201);
    const list = trustedContactListSchema.parse((await get('/me/trusted-contacts', cookie)).body);
    expect(list.items.map((c) => c.name)).toEqual(['Contact 1', 'Contact 5', 'Contact 3']);
  });

  it('never stores a fourth contact when requests race', async () => {
    const { userId, cookie } = await signIn();
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => post('/me/trusted-contacts', cookie, contact(n))),
    );
    for (const res of results) expect([201, 422]).toContain(res.status);
    const stored = await owner
      .select({ slot: trustedContact.slot })
      .from(trustedContact)
      .where(eq(trustedContact.userId, userId));
    expect(stored.length).toBeLessThanOrEqual(3);
    expect(results.filter((res) => res.status === 201)).toHaveLength(stored.length);
  });
});
