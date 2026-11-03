import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { apiErrorSchema, campusDistanceSchema } from '@pulse/contracts';
import { campus, createDb, type Database } from '@pulse/db';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { inject } from 'vitest';
import { configureApp } from '../src/app.setup.js';
import { AppModule } from '../src/app.module.js';
import { DATABASE } from '../src/db/db.module.js';

const run = randomUUID().slice(0, 8);
const slug = `distance-${run}`;

describe('Campus distance over HTTP', () => {
  let app: INestApplication<App>;
  let owner: Database;

  beforeAll(async () => {
    owner = createDb(inject('ownerUrl'));
    await owner.insert(campus).values({
      name: 'Equatorial distance fixture',
      slug,
      emailDomains: [`distance-${run}.test`],
      location: { x: 0, y: 0 },
      timezone: 'UTC',
    });
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

  it('answers zero at the campus location', async () => {
    const res = await request(app.getHttpServer())
      .get(`/campuses/${slug}/distance`)
      .query({ lat: '0', lng: '0' })
      .expect(200);
    expect(campusDistanceSchema.parse(res.body)).toEqual({ slug, distanceMetres: 0 });
  });

  // WGS84 distances: a degree east along the equator differs from a degree north.
  // These independent reference values detect swapped coordinates and geometry-in-degrees.
  it.each([
    { lat: '0', lng: '1', metres: 111319 },
    { lat: '1', lng: '0', metres: 110574 },
  ])('measures metres on the globe: %o', async ({ lat, lng, metres }) => {
    const res = await request(app.getHttpServer())
      .get(`/campuses/${slug}/distance`)
      .query({ lat, lng })
      .expect(200);
    const body = campusDistanceSchema.parse(res.body);
    expect(body.slug).toBe(slug);
    expect(Math.abs(body.distanceMetres - metres)).toBeLessThanOrEqual(1);
  });

  it('answers 404 for an unknown campus', async () => {
    const res = await request(app.getHttpServer())
      .get(`/campuses/missing-${run}/distance`)
      .query({ lat: '0', lng: '0' })
      .expect(404);
    expect(apiErrorSchema.parse(res.body)).toEqual({
      statusCode: 404,
      error: 'Not Found',
      message: 'Campus not found',
    });
  });

  it.each([
    { lat: '', lng: '0' },
    { lat: ' ', lng: '0' },
    { lat: '91', lng: '0' },
    { lat: '0', lng: '181' },
    { lat: '0', lng: '' },
    { lat: 'abc', lng: '0' },
    { lng: '0' },
    { lat: '0' },
    { lat: ['0', '1'], lng: '0' },
    { lat: '0', lng: '0', extra: 'unexpected' },
  ])('answers 400 with issues for %o', async (query) => {
    const res = await request(app.getHttpServer())
      .get(`/campuses/${slug}/distance`)
      .query(query)
      .expect(400);
    const body = apiErrorSchema.parse(res.body);
    expect(body.message).toBe('Validation failed');
    expect(body.issues?.length).toBeGreaterThan(0);
  });

  it('validates the slug as well as the query', async () => {
    const res = await request(app.getHttpServer())
      .get('/campuses/INVALID/distance')
      .query({ lat: '0', lng: '0' })
      .expect(400);
    expect(apiErrorSchema.parse(res.body).issues?.map((issue) => issue.path)).toContain('slug');
  });
});
