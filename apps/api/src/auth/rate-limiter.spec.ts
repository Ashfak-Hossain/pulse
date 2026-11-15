import { ServiceUnavailableException } from '@nestjs/common';
import { RateLimiter } from './rate-limiter.js';

const limit = { name: 'test', max: 5, windowSec: 60 };

// Nothing listens on port 1, so every command fails like a Redis that is down
describe('RateLimiter with Redis down', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter('redis://127.0.0.1:1');
  });

  afterEach(() => limiter.onApplicationShutdown());

  // Fail closed: without counts, a guesser would get unlimited tries
  it('answers 503, quickly', async () => {
    const started = performance.now();
    await expect(limiter.hit(limit, 'subject')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(performance.now() - started).toBeLessThan(3000);
  });
});
