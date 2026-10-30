import { HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DATABASE } from '../db/db.module.js';
import { HealthController } from './health.controller.js';

describe('HealthController', () => {
  let controller: HealthController;
  // Only the one method ready() uses; the real Drizzle client is tested in @pulse/db
  const db = { execute: vi.fn() };

  // Puts back any Logger spy, even when a test fails before its last line
  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    db.execute.mockReset();
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: DATABASE, useValue: db }],
    }).compile();
    controller = moduleRef.get(HealthController);
  });

  it('reports the process is alive', () => {
    expect(controller.check()).toEqual({ status: 'ok' });
  });

  it('reports ready when the database answers', async () => {
    db.execute.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    await expect(controller.ready()).resolves.toEqual({
      status: 'ok',
      checks: { database: 'up' },
    });
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it('answers 503 when the database fails, without the reason in the body', async () => {
    db.execute.mockRejectedValue(new Error('password authentication failed for user "pulse_app"'));
    const logged = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const error: unknown = await controller.ready().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(HttpException);
    const http = error as HttpException;
    expect(http.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(http.getResponse()).toEqual({ status: 'error', checks: { database: 'down' } });
    expect(JSON.stringify(http.getResponse())).not.toContain('password');
    // The reason is not lost: it goes to the server log for whoever runs the API
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('password authentication failed'));
  });
});
