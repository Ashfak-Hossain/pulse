import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { adminTermSchema, otpVerifyResultSchema } from '@pulse/contracts';
import {
  and,
  appUser,
  auditLog,
  campus,
  createDb,
  eq,
  outboxEvent,
  term,
  type Database,
} from '@pulse/db';
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
const domainA = `terms-a-${run}.test`;
const domainB = `terms-b-${run}.test`;

describe('Creating and activating terms over HTTP', () => {
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
  const as = { adminA: '', adminB: '', studentA: '' };

  const http = () => request(app.getHttpServer());
  const post = (path: string, cookie: string, body: object = {}) =>
    http().post(path).set('Origin', origin).set('Cookie', cookie).send(body);
  let names = 0;
  const createTerm = async (cookie = as.adminA) => {
    names += 1;
    const res = await post('/admin/terms', cookie, {
      name: `Term ${names} ${run}`,
      startsOn: '2027-01-20',
      endsOn: '2027-05-30',
    }).expect(201);
    return adminTermSchema.parse(res.body);
  };
  const statusOf = async (id: string) =>
    (await owner.select({ status: term.status }).from(term).where(eq(term.id, id)))[0]?.status;
  const outboxFor = (termId: string) =>
    owner
      .select()
      .from(outboxEvent)
      .where(and(eq(outboxEvent.aggregateId, termId), eq(outboxEvent.type, 'TermActivated')));
  const auditFor = (termId: string) =>
    owner
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, termId), eq(auditLog.action, 'term.activate')));

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
  async function signInAdmin(email: string): Promise<string> {
    const signedIn = await signIn(email);
    await owner
      .update(appUser)
      .set({ role: 'campus_admin' })
      .where(eq(appUser.id, signedIn.userId));
    return signedIn.cookie;
  }

  beforeAll(async () => {
    owner = createDb(inject('ownerUrl'));
    await owner.insert(campus).values(
      [
        [campusA, domainA],
        [campusB, domainB],
      ].map(([id = '', domain = '']) => ({
        id,
        name: `Terms campus ${domain}`,
        slug: domain.replace('.test', ''),
        emailDomains: [domain],
        location: { x: 90.4274, y: 23.8223 },
        timezone: 'Asia/Dhaka',
      })),
    );

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

    as.adminA = await signInAdmin(`admin@${domainA}`);
    as.adminB = await signInAdmin(`admin@${domainB}`);
    as.studentA = (await signIn(`student@${domainA}`)).cookie;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await owner?.$client.end();
  });

  it('answers 401 without a session and 403 to a student, before reading the body', async () => {
    await http().post('/admin/terms').set('Origin', origin).send({}).expect(401);
    await post('/admin/terms', as.studentA).expect(403);
    await post(`/admin/terms/${randomUUID()}/activate`, as.studentA).expect(403);
  });

  it('creates a draft term, and answers 409 to the same name twice', async () => {
    const draft = await createTerm();
    expect(draft).toMatchObject({ startsOn: '2027-01-20', endsOn: '2027-05-30', status: 'draft' });
    await post('/admin/terms', as.adminA, {
      name: draft.name,
      startsOn: '2027-06-01',
      endsOn: '2027-09-30',
    }).expect(409);
    await post('/admin/terms', as.adminA, {
      name: 'Backwards',
      startsOn: '2027-06-01',
      endsOn: '2027-05-01',
    }).expect(400);
  });

  it('activates a draft, archives the old active term, and writes one outbox and one audit row', async () => {
    const first = await createTerm();
    const second = await createTerm();
    await post(`/admin/terms/${first.id}/activate`, as.adminA).expect(200);

    const res = await post(`/admin/terms/${second.id}/activate`, as.adminA).expect(200);
    expect(adminTermSchema.parse(res.body)).toMatchObject({ id: second.id, status: 'active' });
    expect(await statusOf(first.id)).toBe('archived');

    const events = await outboxFor(second.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      aggregate: 'term',
      topic: 'campuses',
      key: campusA,
      version: 1,
      payload: {
        campusId: campusA,
        termId: second.id,
        name: second.name,
        startsOn: '2027-01-20',
        endsOn: '2027-05-30',
      },
    });
    const audits = await auditFor(second.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.metadata).toEqual({ archivedTermIds: [first.id] });
  });

  it('answers 409 to activating an active or archived term, and writes nothing', async () => {
    const old = await createTerm();
    const current = await createTerm();
    await post(`/admin/terms/${old.id}/activate`, as.adminA).expect(200);
    await post(`/admin/terms/${current.id}/activate`, as.adminA).expect(200);

    await post(`/admin/terms/${current.id}/activate`, as.adminA).expect(409);
    await post(`/admin/terms/${old.id}/activate`, as.adminA).expect(409);
    expect(await outboxFor(current.id)).toHaveLength(1);
    expect(await outboxFor(old.id)).toHaveLength(1);
    expect(await statusOf(current.id)).toBe('active');
  });

  it('never leaves two active terms when two drafts are activated at once', async () => {
    const left = await createTerm();
    const right = await createTerm();
    const results = await Promise.all([
      post(`/admin/terms/${left.id}/activate`, as.adminA),
      post(`/admin/terms/${right.id}/activate`, as.adminA),
    ]);

    // Either both ran one after the other (200, 200) or the index refused the loser (409)
    for (const res of results) expect([200, 409]).toContain(res.status);
    const active = await owner
      .select({ id: term.id })
      .from(term)
      .where(and(eq(term.campusId, campusA), eq(term.status, 'active')));
    expect(active).toHaveLength(1);
  });

  it('answers 404 for another campus’s term', async () => {
    const theirs = await createTerm(as.adminB);
    await post(`/admin/terms/${theirs.id}/activate`, as.adminA).expect(404);
    expect(await statusOf(theirs.id)).toBe('draft');
  });
});
