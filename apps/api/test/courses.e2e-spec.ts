import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { apiErrorSchema, courseListSchema } from '@pulse/contracts';
import { campus, course, createDb, type Database } from '@pulse/db';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { inject } from 'vitest';
import { configureApp } from '../src/app.setup.js';
import { AppModule } from '../src/app.module.js';
import { DATABASE } from '../src/db/db.module.js';

const run = randomUUID().slice(0, 8);
const campuses = ['a', 'b', 'empty', 'large'].map((label) => ({
  id: randomUUID(),
  name: `Course campus ${label}`,
  slug: `courses-${label}-${run}`,
  emailDomains: [`courses-${label}-${run}.test`],
  location: { x: 90.4, y: 23.8 },
  timezone: 'Asia/Dhaka',
}));
const [a, b, empty, large] = campuses as [
  (typeof campuses)[number],
  (typeof campuses)[number],
  (typeof campuses)[number],
  (typeof campuses)[number],
];
const courseA = {
  id: randomUUID(),
  campusId: a.id,
  code: 'CSC1000',
  title: 'Campus A first course',
};
const courseZ = {
  id: randomUUID(),
  campusId: a.id,
  code: 'CSC9000',
  title: 'Campus A last course',
};
const courseB = {
  id: randomUUID(),
  campusId: b.id,
  code: 'CSC1000',
  title: 'Campus B only course',
};

describe('Campus course lists over HTTP', () => {
  let app: INestApplication<App>;
  let owner: Database;
  beforeAll(async () => {
    owner = createDb(inject('ownerUrl'));
    await owner.insert(campus).values(campuses);
    // Reverse order proves the endpoint orders by code, rather than insertion order.
    await owner.insert(course).values([courseZ, courseB, courseA]);
    await owner.insert(course).values(
      Array.from({ length: 501 }, (_, i) => ({
        campusId: large.id,
        code: `CODE${i.toString().padStart(3, '0')}`,
        title: `Course ${i}`,
      })),
    );
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

  it('lists only campus A courses, ordered by their course code', async () => {
    const res = await request(app.getHttpServer()).get(`/campuses/${a.slug}/courses`).expect(200);
    expect(courseListSchema.parse(res.body)).toEqual({
      items: [
        { id: courseA.id, code: courseA.code, title: courseA.title },
        { id: courseZ.id, code: courseZ.code, title: courseZ.title },
      ],
    });
  });
  it('never includes campus A courses in campus B, even when codes repeat', async () => {
    const res = await request(app.getHttpServer()).get(`/campuses/${b.slug}/courses`).expect(200);
    expect(courseListSchema.parse(res.body)).toEqual({
      items: [{ id: courseB.id, code: courseB.code, title: courseB.title }],
    });
  });
  it('returns an empty wrapped list for a campus without courses', async () => {
    const res = await request(app.getHttpServer())
      .get(`/campuses/${empty.slug}/courses`)
      .expect(200);
    expect(courseListSchema.parse(res.body)).toEqual({ items: [] });
  });
  it('caps the ordered result at 500 courses', async () => {
    const res = await request(app.getHttpServer())
      .get(`/campuses/${large.slug}/courses`)
      .expect(200);
    const body = courseListSchema.parse(res.body);
    expect(body.items).toHaveLength(500);
    expect(body.items[0]?.code).toBe('CODE000');
    expect(body.items[499]?.code).toBe('CODE499');
  });
  it('returns 404 for an unknown campus', async () => {
    const res = await request(app.getHttpServer())
      .get(`/campuses/missing-${run}/courses`)
      .expect(404);
    expect(apiErrorSchema.parse(res.body)).toEqual({
      statusCode: 404,
      error: 'Not Found',
      message: 'Campus not found',
    });
  });
  it.each(['INVALID', 'a_b', 'x'.repeat(65)])('returns 400 for malformed slug %s', async (slug) => {
    const res = await request(app.getHttpServer()).get(`/campuses/${slug}/courses`).expect(400);
    expect(apiErrorSchema.parse(res.body).issues?.map((issue) => issue.path)).toContain('slug');
  });
});
