import { Body, Controller, type INestApplication, Logger, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { z } from 'zod';
import { AppModule } from '../src/app.module.js';
import { ZodValidationPipe } from '../src/common/zod-validation.pipe.js';
import { DATABASE } from '../src/db/db.module.js';

// Test-only endpoint, so the pipe is checked through real HTTP before any real endpoint uses it
const echoSchema = z.strictObject({ name: z.string().min(1) });

@Controller('echo')
class EchoController {
  @Post()
  echo(@Body(new ZodValidationPipe(echoSchema)) input: z.infer<typeof echoSchema>) {
    return input;
  }
}

describe('API over HTTP', () => {
  let app: INestApplication<App>;
  // Stands in for the real pool, so these tests need no PostgreSQL; @pulse/db tests the real one
  const db = { execute: vi.fn(), $client: { end: vi.fn() } };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [EchoController],
    })
      .overrideProvider(DATABASE)
      .useValue(db)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    // DbModule closes the pool on shutdown, so a stopped API holds no connections
    expect(db.$client.end).toHaveBeenCalledTimes(1);
  });

  // Puts back any Logger spy, even when a test fails before its last line
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('GET /health answers 200 with JSON', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /health/ready answers 200 when the database answers', async () => {
    db.execute.mockResolvedValueOnce({ rows: [] });
    const res = await request(app.getHttpServer()).get('/health/ready').expect(200);
    expect(res.body).toEqual({ status: 'ok', checks: { database: 'up' } });
  });

  it('GET /health/ready answers 503 when the database is down', async () => {
    db.execute.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:5432'));
    // Expected failure: keep its log line out of the test output
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const res = await request(app.getHttpServer()).get('/health/ready').expect(503);
    expect(res.body).toEqual({ status: 'error', checks: { database: 'down' } });
  });

  it('an unknown route answers 404', async () => {
    await request(app.getHttpServer()).get('/nope').expect(404);
  });

  it('a valid body passes the pipe', async () => {
    const res = await request(app.getHttpServer())
      .post('/echo')
      .send({ name: 'Kuril' })
      .expect(201);
    expect(res.body).toEqual({ name: 'Kuril' });
  });

  it('an invalid body gets 400 with the issues', async () => {
    const res = await request(app.getHttpServer())
      .post('/echo')
      .send({ name: '', extra: 1 })
      .expect(400);
    const body = res.body as { message: string; issues: { path: string; code: string }[] };
    expect(body.message).toBe('Validation failed');
    expect(body.issues.map((issue) => issue.path)).toContain('name');
    expect(body.issues.map((issue) => issue.code)).toContain('unrecognized_keys');
  });
});
