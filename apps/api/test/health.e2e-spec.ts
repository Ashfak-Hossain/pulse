import { Body, Controller, type INestApplication, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { z } from 'zod';
import { AppModule } from '../src/app.module.js';
import { ZodValidationPipe } from '../src/common/zod-validation.pipe.js';

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

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [EchoController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health answers 200 with JSON', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ status: 'ok' });
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
