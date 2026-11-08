import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { apiErrorSchema, campusLookupResultSchema, campusSchema } from '@pulse/contracts';
import { campus, createDb, type Database } from '@pulse/db';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { inject } from 'vitest';
import { configureApp } from '../src/app.setup.js';
import { AppModule } from '../src/app.module.js';
import { DATABASE } from '../src/db/db.module.js';

const run = randomUUID().slice(0, 8);
const domain = `student.lookup-${run}.test`;
const duplicateDomain = `duplicate.lookup-${run}.test`;
const campusData = {
  name: 'Lookup campus',
  slug: `lookup-${run}`,
  emailDomains: [domain, duplicateDomain],
  location: { x: 90.4274, y: 23.8223 },
  timezone: 'Asia/Dhaka',
};

describe('Campus lookup over HTTP', () => {
  let app: INestApplication<App>;
  let owner: Database;

  beforeAll(async () => {
    owner = createDb(inject('ownerUrl'));
    await owner
      .insert(campus)
      .values([
        campusData,
        { ...campusData, slug: `lookup-duplicate-${run}`, emailDomains: [duplicateDomain] },
      ]);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE)
      .useFactory({ factory: () => createDb(inject('appUrl')) })
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await owner?.$client.end();
  });

  it.each([domain, domain.toUpperCase()])('looks up the exact domain %s', async (emailDomain) => {
    const res = await request(app.getHttpServer())
      .post('/campuses/lookup')
      .send({ email: `name@${emailDomain}` })
      .expect(200);
    expect(campusLookupResultSchema.parse(res.body)).toEqual({
      campus: { name: campusData.name, slug: campusData.slug },
    });
  });

  it.each([`unknown-${run}.test`, `sub.${domain}`, domain.replace('student.', '')])(
    'does not match another domain: %s',
    async (emailDomain) => {
      const email = `name@${emailDomain}`;
      const res = await request(app.getHttpServer())
        .post('/campuses/lookup')
        .send({ email })
        .expect(200);
      expect(campusLookupResultSchema.parse(res.body)).toEqual({ campus: null });
      expect(JSON.stringify(res.body)).not.toContain(email);
    },
  );

  it('answers 409 for an ambiguous email domain without exposing the email', async () => {
    const email = `name@${duplicateDomain}`;
    const res = await request(app.getHttpServer())
      .post('/campuses/lookup')
      .send({ email })
      .expect(409);
    expect(apiErrorSchema.parse(res.body)).toEqual({
      statusCode: 409,
      error: 'Conflict',
      message: 'Email domain belongs to more than one campus',
    });
    expect(JSON.stringify(res.body)).not.toContain(email);
  });

  it.each([
    {},
    { email: '' },
    { email: 'invalid' },
    { email: ['a@b.test', 'c@d.test'] },
    { email: `name@${domain}`, extra: 'unexpected' },
  ])('answers 400 with issues for %o', async (payload) => {
    const res = await request(app.getHttpServer())
      .post('/campuses/lookup')
      .send(payload)
      .expect(400);
    const body = apiErrorSchema.parse(res.body);
    expect(body.message).toBe('Validation failed');
    expect(body.issues?.length).toBeGreaterThan(0);
  });

  it('returns a fixed message for malformed JSON without echoing the submitted email', async () => {
    const res = await request(app.getHttpServer())
      .post('/campuses/lookup')
      .type('json')
      .send('{"email": somebody@example.test}')
      .expect(400);
    expect(apiErrorSchema.parse(res.body)).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Malformed JSON body',
    });
  });

  it('does not echo user input supplied as a field name', async () => {
    const extra = 'somebody@example.test';
    const res = await request(app.getHttpServer())
      .post('/campuses/lookup')
      .send({ email: 'name@' + domain, [extra]: true })
      .expect(400);
    expect(apiErrorSchema.parse(res.body).issues).toEqual([
      { path: '', code: 'unrecognized_keys', message: 'Unrecognized field' },
    ]);
  });

  it('no longer accepts lookup emails in a GET URL', async () => {
    const email = `name@${domain}`;
    const res = await request(app.getHttpServer())
      .get('/campuses/lookup')
      .query({ email })
      .expect(404);
    expect(JSON.stringify(res.body)).not.toContain(email);
  });

  it('still resolves a campus by slug', async () => {
    const res = await request(app.getHttpServer()).get(`/campuses/${campusData.slug}`).expect(200);
    expect(campusSchema.parse(res.body).slug).toBe(campusData.slug);
  });
});
