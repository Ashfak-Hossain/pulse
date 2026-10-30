import { Body, Controller, Get, type INestApplication, Logger, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { apiErrorSchema } from '@pulse/contracts';
import { z } from 'zod';
import { configureApp } from '../src/app.setup.js';
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

  // Stands in for a bug or a failed dependency whose message must never reach the client
  @Get('crash')
  crash(): never {
    throw new Error('connect ECONNREFUSED 10.0.0.5:5432 as pulse_app');
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
    configureApp(app);
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

  describe('every error has the shared shape', () => {
    it('malformed JSON answers 400', async () => {
      const res = await request(app.getHttpServer())
        .post('/echo')
        .set('Content-Type', 'application/json')
        .send('{"name":')
        .expect(400);
      expect(apiErrorSchema.parse(res.body)).toMatchObject({ error: 'Bad Request' });
    });

    it('a body over the 100 kB limit answers 413', async () => {
      const res = await request(app.getHttpServer())
        .post('/echo')
        .send({ name: 'x'.repeat(200_000) })
        .expect(413);
      expect(apiErrorSchema.parse(res.body)).toMatchObject({ error: 'Payload Too Large' });
    });

    it('an unknown route answers 404', async () => {
      const res = await request(app.getHttpServer()).get('/nope').expect(404);
      expect(apiErrorSchema.parse(res.body)).toMatchObject({ error: 'Not Found' });
    });

    it('a validation error keeps its issues', async () => {
      const res = await request(app.getHttpServer()).post('/echo').send({}).expect(400);
      expect(apiErrorSchema.parse(res.body).issues).toBeDefined();
    });

    it('a crash answers 500 and hides what went wrong', async () => {
      // Expected failure: keep its log line out of the test output
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const res = await request(app.getHttpServer()).get('/echo/crash').expect(500);
      expect(apiErrorSchema.parse(res.body)).toEqual({
        statusCode: 500,
        error: 'Internal Server Error',
        message: 'Internal Server Error',
      });
      expect(res.text).not.toContain('10.0.0.5');
    });
  });

  describe('security headers (helmet)', () => {
    it('does not say the server runs Express', async () => {
      const res = await request(app.getHttpServer()).get('/health').expect(200);
      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('stops browsers guessing the content type', async () => {
      const res = await request(app.getHttpServer()).get('/health').expect(200);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });
  });
});
