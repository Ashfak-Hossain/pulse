import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  gateListSchema,
  gateSchema,
  meetingPointListSchema,
  meetingPointSchema,
  otpVerifyResultSchema,
  zoneListSchema,
  zoneSchema,
} from '@pulse/contracts';
import { appUser, auditLog, campus, campusGate, createDb, eq, sql, type Database } from '@pulse/db';
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
const domainA = `places-a-${run}.test`;
const domainB = `places-b-${run}.test`;

const mainGate = { lat: 23.8223, lng: 90.4274 };
// Rounded, so the corners match what PostgreSQL returns (0.01 steps add float noise)
const far = (value: number) => Math.round((value + 0.01) * 1e6) / 1e6;
const square = (lng: number, lat: number) => ({
  type: 'MultiPolygon' as const,
  coordinates: [
    [
      [
        [lng, lat],
        [far(lng), lat],
        [far(lng), far(lat)],
        [lng, far(lat)],
        [lng, lat],
      ],
    ],
  ],
});
// A bow tie: closed, in range, but its edges cross, so only PostgreSQL can refuse it
const bowTie = {
  type: 'MultiPolygon' as const,
  coordinates: [
    [
      [
        [90, 23],
        [90.01, 23.01],
        [90.01, 23],
        [90, 23.01],
        [90, 23],
      ],
    ],
  ],
};

describe('Gates, zones and meeting points over HTTP', () => {
  let app: INestApplication<App>;
  let owner: Database;
  const campusA = randomUUID();
  const campusB = randomUUID();
  const sent: { email: string; code: string }[] = [];
  const mailer: OtpMailer = {
    send: (email, code) => {
      sent.push({ email, code });
      return Promise.resolve();
    },
  };
  // Cookies of the signed-in callers, filled in beforeAll
  const as = { adminA: '', adminB: '', studentA: '' };
  let adminAId = '';

  const http = () => request(app.getHttpServer());
  const get = (path: string, cookie: string) => http().get(path).set('Cookie', cookie);
  const post = (path: string, cookie: string, body: object) =>
    http().post(path).set('Origin', origin).set('Cookie', cookie).send(body);
  const patch = (path: string, cookie: string, body: object) =>
    http().patch(path).set('Origin', origin).set('Cookie', cookie).send(body);
  const del = (path: string, cookie: string) =>
    http().delete(path).set('Origin', origin).set('Cookie', cookie);
  const auditCount = async () => {
    const [row] = await owner
      .select({ n: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(eq(auditLog.actorId, adminAId));
    return row?.n ?? 0;
  };

  async function signIn(email: string): Promise<{ userId: string; cookie: string }> {
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

  // The role is read from the database on every request, so the existing cookie becomes an admin's
  async function signInAdmin(email: string): Promise<{ userId: string; cookie: string }> {
    const signedIn = await signIn(email);
    await owner
      .update(appUser)
      .set({ role: 'campus_admin' })
      .where(eq(appUser.id, signedIn.userId));
    return signedIn;
  }

  beforeAll(async () => {
    owner = createDb(inject('ownerUrl'));
    await owner.insert(campus).values([
      {
        id: campusA,
        name: 'Places campus A',
        slug: `places-a-${run}`,
        emailDomains: [domainA],
        location: { x: mainGate.lng, y: mainGate.lat },
        timezone: 'Asia/Dhaka',
      },
      {
        id: campusB,
        name: 'Places campus B',
        slug: `places-b-${run}`,
        emailDomains: [domainB],
        location: { x: mainGate.lng, y: mainGate.lat },
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

    const adminA = await signInAdmin(`admin@${domainA}`);
    adminAId = adminA.userId;
    as.adminA = adminA.cookie;
    as.adminB = (await signInAdmin(`admin@${domainB}`)).cookie;
    as.studentA = (await signIn(`student@${domainA}`)).cookie;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await owner?.$client.end();
  });

  describe('who may call', () => {
    it('answers 401 without a session, on reads and admin writes alike', async () => {
      for (const path of ['/gates', '/zones', '/meeting-points'])
        await http().get(path).expect(401);
      await http().post('/admin/gates').set('Origin', origin).send({}).expect(401);
    });

    it('answers 403 to a student on every admin route, before reading the body', async () => {
      const id = randomUUID();
      for (const resource of ['gates', 'zones', 'meeting-points']) {
        await post(`/admin/${resource}`, as.studentA, {}).expect(403);
        await patch(`/admin/${resource}/${id}`, as.studentA, {}).expect(403);
        await del(`/admin/${resource}/${id}`, as.studentA).expect(403);
      }
    });

    it('lets a student read the places of their campus', async () => {
      await get('/gates', as.studentA).expect(200);
      await get('/zones', as.studentA).expect(200);
      await get('/meeting-points', as.studentA).expect(200);
    });
  });

  describe('gates', () => {
    it('stores the H3 cell of the location, which the client never sends', async () => {
      const res = await post('/admin/gates', as.adminA, {
        name: 'Main gate',
        location: mainGate,
        isPrimary: true,
      }).expect(201);
      const gate = gateSchema.parse(res.body);
      expect(gate).toMatchObject({ name: 'Main gate', location: mainGate, isPrimary: true });

      const [row] = await owner.select().from(campusGate).where(eq(campusGate.id, gate.id));
      expect(row?.cell).toBe(latLngToCell(mainGate.lat, mainGate.lng, 8));
      await post('/admin/gates', as.adminA, {
        name: 'Side gate',
        location: mainGate,
        cell: '883cf13b03fffff',
      }).expect(400);
    });

    it('moves primary to a new gate, and refuses to delete or unset the primary one', async () => {
      const first = gateSchema.parse(
        (
          await post('/admin/gates', as.adminA, {
            name: 'North gate',
            location: { lat: 23.8232, lng: 90.4262 },
          }).expect(201)
        ).body,
      );
      await patch(`/admin/gates/${first.id}`, as.adminA, { isPrimary: true }).expect(200);

      const gates = gateListSchema.parse((await get('/gates', as.studentA).expect(200)).body);
      expect(gates.items.filter((gate) => gate.isPrimary).map((gate) => gate.id)).toEqual([
        first.id,
      ]);
      await del(`/admin/gates/${first.id}`, as.adminA).expect(409);
      await patch(`/admin/gates/${first.id}`, as.adminA, { isPrimary: false }).expect(409);
    });

    it('answers 409 to a second gate with the same name, and deletes a plain gate', async () => {
      await post('/admin/gates', as.adminA, { name: 'Main gate', location: mainGate }).expect(409);
      const gate = gateSchema.parse(
        (await post('/admin/gates', as.adminA, { name: 'Back gate', location: mainGate })).body,
      );
      await del(`/admin/gates/${gate.id}`, as.adminA).expect(204);
      await del(`/admin/gates/${gate.id}`, as.adminA).expect(404);
    });
  });

  describe('zones and meeting points', () => {
    it('returns the zone area as GeoJSON, and answers 422 to a self-crossing one', async () => {
      const area = square(90.36, 23.8);
      const res = await post('/admin/zones', as.adminA, { name: 'Mirpur 10', area }).expect(201);
      expect(zoneSchema.parse(res.body)).toMatchObject({ name: 'Mirpur 10', area });

      const zones = zoneListSchema.parse((await get('/zones', as.studentA).expect(200)).body);
      expect(zones.items.map((zone) => zone.name)).toEqual(['Mirpur 10']);
      const knot = await post('/admin/zones', as.adminA, { name: 'Knot', area: bowTie });
      expect(knot.status).toBe(422);
      expect(knot.body).toMatchObject({ message: 'The zone area crosses itself' });
    });

    it('lists active points by zone, hides a deleted one, and keeps a zone that has points', async () => {
      const zone = zoneSchema.parse(
        (await post('/admin/zones', as.adminA, { name: 'Kuril', area: square(90.41, 23.81) })).body,
      );
      const inZone = meetingPointSchema.parse(
        (
          await post('/admin/meeting-points', as.adminA, {
            name: 'Kuril flyover',
            kind: 'junction',
            location: { lat: 23.8183, lng: 90.4209 },
            zoneId: zone.id,
          }).expect(201)
        ).body,
      );
      const gateSide = meetingPointSchema.parse(
        (
          await post('/admin/meeting-points', as.adminA, {
            name: 'Main gate stand',
            kind: 'gate',
            location: mainGate,
          }).expect(201)
        ).body,
      );
      expect(gateSide.zoneId).toBeNull();

      const inKuril = meetingPointListSchema.parse(
        (await get(`/meeting-points?zoneId=${zone.id}`, as.studentA).expect(200)).body,
      );
      expect(inKuril.items.map((point) => point.id)).toEqual([inZone.id]);

      await del(`/admin/zones/${zone.id}`, as.adminA).expect(409);
      await del(`/admin/meeting-points/${inZone.id}`, as.adminA).expect(204);
      const all = meetingPointListSchema.parse((await get('/meeting-points', as.studentA)).body);
      expect(all.items.map((point) => point.id)).toEqual([gateSide.id]);
      await patch(`/admin/meeting-points/${inZone.id}`, as.adminA, { name: 'Back' }).expect(404);
    });
  });

  describe('campus walls and the audit log', () => {
    it('answers 404 for another campus’s ids and 422 for its zone', async () => {
      const gateB = gateSchema.parse(
        (await post('/admin/gates', as.adminB, { name: 'B gate', location: mainGate })).body,
      );
      const zoneB = zoneSchema.parse(
        (await post('/admin/zones', as.adminB, { name: 'B zone', area: square(90.4, 23.79) })).body,
      );
      await patch(`/admin/gates/${gateB.id}`, as.adminA, { name: 'Taken' }).expect(404);
      await del(`/admin/gates/${gateB.id}`, as.adminA).expect(404);
      await patch(`/admin/zones/${zoneB.id}`, as.adminA, { name: 'Taken' }).expect(404);
      await del(`/admin/zones/${zoneB.id}`, as.adminA).expect(404);
      await post('/admin/meeting-points', as.adminA, {
        name: 'Over the wall',
        kind: 'landmark',
        location: mainGate,
        zoneId: zoneB.id,
      }).expect(422);

      const gatesA = gateListSchema.parse((await get('/gates', as.adminA)).body);
      expect(gatesA.items.map((gate) => gate.id)).not.toContain(gateB.id);
    });

    it('leaves exactly one audit row per admin write, and none for a refused one', async () => {
      const before = await auditCount();
      const gate = gateSchema.parse(
        (await post('/admin/gates', as.adminA, { name: 'Audit gate', location: mainGate })).body,
      );
      expect(await auditCount()).toBe(before + 1);
      await patch(`/admin/gates/${gate.id}`, as.adminA, { name: 'Audit gate 2' }).expect(200);
      expect(await auditCount()).toBe(before + 2);
      await del(`/admin/gates/${gate.id}`, as.adminA).expect(204);
      expect(await auditCount()).toBe(before + 3);
      await post('/admin/zones', as.adminA, { name: 'Knot 2', area: bowTie }).expect(422);
      expect(await auditCount()).toBe(before + 3);

      const [row] = await owner
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityId, gate.id))
        .orderBy(sql`${auditLog.at} desc, ${auditLog.id} desc`)
        .limit(1);
      expect(row).toMatchObject({
        campusId: campusA,
        actorId: adminAId,
        action: 'gate.delete',
        entity: 'campus_gate',
      });
    });
  });
});
