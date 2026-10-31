import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { apiErrorSchema, campusListSchema, campusSchema } from '@pulse/contracts';
import { campus, createDb, type Database } from '@pulse/db';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { App } from 'supertest/types.js';
import { inject } from 'vitest';
import { configureApp } from '../src/app.setup.js';
import { AppModule } from '../src/app.module.js';
import { DATABASE } from '../src/db/db.module.js';

// Every e2e file shares one database and files run in parallel, so each file owns rows with
// unique slugs and only ever checks its own rows. Copy this when a test needs campus rows
const run = randomUUID().slice(0, 8);

// Location is longitude (x), latitude (y), as PostGIS stores it
const aiub = {
  name: 'American International University-Bangladesh',
  slug: `aiub-${run}`,
  emailDomains: ['aiub.edu', 'student.aiub.edu'],
  location: { x: 90.4274, y: 23.8223 },
  timezone: 'Asia/Dhaka',
};
const demo = {
  name: 'Pulse Demo Campus',
  slug: `demo-${run}`,
  emailDomains: ['demo.pulse.test'],
  location: { x: 90.4125, y: 23.8103 },
  timezone: 'Asia/Dhaka',
};

describe('Campuses over HTTP, against a real database', () => {
  let app: INestApplication<App>;
  let owner: Database;

  beforeAll(async () => {
    // The owner bypasses row-level security, so it can set up rows for any campus
    owner = createDb(inject('ownerUrl'));
    // Inserted in reverse name order, so the list test proves the API sorts
    await owner.insert(campus).values([demo, aiub]);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // The real pool, on the test container as pulse_app: row-level security applies as in production
      .overrideProvider(DATABASE)
      .useFactory({ factory: () => createDb(inject('appUrl')) })
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    // ?. so a failed beforeAll shows its own error, not a second one from here
    await app?.close();
    await owner?.$client.end();
  });

  it('GET /campuses lists every campus in the contract shape, sorted by name', async () => {
    const res = await request(app.getHttpServer()).get('/campuses').expect(200);
    const body = campusListSchema.parse(res.body);
    const mine = new Set([aiub.slug, demo.slug]);
    const slugs = body.items.map((item) => item.slug).filter((slug) => mine.has(slug));
    expect(slugs).toEqual([aiub.slug, demo.slug]);
  });

  it('GET /campuses/:slug answers one campus, with the PostGIS point as lat/lng', async () => {
    const res = await request(app.getHttpServer()).get(`/campuses/${aiub.slug}`).expect(200);
    expect(campusSchema.parse(res.body)).toEqual({
      id: expect.any(String) as string,
      name: aiub.name,
      slug: aiub.slug,
      emailDomains: aiub.emailDomains,
      timezone: 'Asia/Dhaka',
      location: { lat: 23.8223, lng: 90.4274 },
    });
  });

  it('an unknown slug answers 404 in the error shape', async () => {
    const res = await request(app.getHttpServer()).get('/campuses/nowhere').expect(404);
    expect(apiErrorSchema.parse(res.body)).toEqual({
      statusCode: 404,
      error: 'Not Found',
      message: 'Campus not found',
    });
  });

  it.each(['AIUB', 'a_b', '-aiub', 'x'.repeat(65)])(
    'a malformed slug (%s) answers 400 with the issue',
    async (slug) => {
      const res = await request(app.getHttpServer()).get(`/campuses/${slug}`).expect(400);
      const body = apiErrorSchema.parse(res.body);
      expect(body.issues?.map((issue) => issue.path)).toContain('slug');
    },
  );
});
