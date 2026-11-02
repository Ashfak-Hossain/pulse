import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { apiErrorSchema, fareSplitPreviewSchema } from '@pulse/contracts';
import { createDb } from '@pulse/db';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { inject } from 'vitest';
import { configureApp } from '../src/app.setup.js';
import { AppModule } from '../src/app.module.js';
import { DATABASE } from '../src/db/db.module.js';

describe('Fare split previews over HTTP', () => {
  let app: INestApplication<App>;
  beforeAll(async () => {
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
  });

  it.each([
    { totalPaisa: 10000, weights: [1, 1, 1], shares: [3334, 3333, 3333] },
    { totalPaisa: 10000, weights: [2, 1], shares: [6667, 3333] },
    { totalPaisa: 0, weights: [1, 1], shares: [0, 0] },
    { totalPaisa: 100, weights: [0, 1], shares: [0, 100] },
    {
      totalPaisa: 10_000_000,
      weights: Array<number>(8).fill(100),
      shares: Array<number>(8).fill(1_250_000),
    },
  ])('returns 200 and exact paisa shares: %o', async ({ totalPaisa, weights, shares }) => {
    const res = await request(app.getHttpServer())
      .post('/fares/split-preview')
      .send({ totalPaisa, weights })
      .expect(200);
    const body = fareSplitPreviewSchema.parse(res.body);
    expect(body).toEqual({ totalPaisa, shares });
    expect(body.shares.reduce((sum, share) => sum + share, 0)).toBe(totalPaisa);
  });

  it.each([
    { totalPaisa: -1, weights: [1] },
    { totalPaisa: 10_000_001, weights: [1] },
    { totalPaisa: 100.5, weights: [1] },
    { totalPaisa: '100', weights: [1] },
    { totalPaisa: 100, weights: [] },
    { totalPaisa: 100, weights: Array<number>(9).fill(1) },
    { totalPaisa: 100, weights: [0, 0] },
    { totalPaisa: 100, weights: [-1, 1] },
    { totalPaisa: 100, weights: [101] },
    { totalPaisa: 100, weights: [0.5] },
    { totalPaisa: 100, weights: ['1'] },
    { totalPaisa: 100 },
    { weights: [1] },
    { totalPaisa: 100, weights: [1], extra: 'unexpected' },
  ])('returns 400 with issues, never 500, for %o', async (body) => {
    const res = await request(app.getHttpServer())
      .post('/fares/split-preview')
      .send(body)
      .expect(400);
    const error = apiErrorSchema.parse(res.body);
    expect(error.message).toBe('Validation failed');
    expect(error.issues?.length).toBeGreaterThan(0);
  });

  it('returns the same split on repeated requests', async () => {
    const body = { totalPaisa: 2, weights: [1, 1, 1] };
    const first = await request(app.getHttpServer())
      .post('/fares/split-preview')
      .send(body)
      .expect(200);
    const second = await request(app.getHttpServer())
      .post('/fares/split-preview')
      .send(body)
      .expect(200);
    expect(fareSplitPreviewSchema.parse(first.body)).toEqual({ totalPaisa: 2, shares: [1, 1, 0] });
    expect(second.body).toEqual(first.body);
  });
});
