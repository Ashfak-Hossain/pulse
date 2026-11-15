import { Logger, type OnApplicationShutdown, ServiceUnavailableException } from '@nestjs/common';
import { Redis } from 'ioredis';
import { RateLimitedException } from '../common/rate-limited.exception.js';

const REDIS_TIMEOUT_MS = 1000;

/** One fixed-window limit: at most `max` hits per subject in each `windowSec`. */
export type RateLimit = {
  readonly name: string;
  readonly max: number;
  readonly windowSec: number;
};

/**
 * Counts hits per subject in Redis. Fails closed: when Redis cannot answer, the caller gets 503,
 * because without counts a guesser would have unlimited tries. Callers pass hashed subjects, so
 * Redis never holds an email or an IP.
 */
export class RateLimiter implements OnApplicationShutdown {
  private readonly logger = new Logger(RateLimiter.name);
  private readonly redis: Redis;

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl, {
      lazyConnect: true,
      connectTimeout: REDIS_TIMEOUT_MS,
      commandTimeout: REDIS_TIMEOUT_MS,
      maxRetriesPerRequest: 1,
    });

    this.redis.on('error', (error: Error) => this.logger.warn(`Redis: ${error.message}`));
  }

  /**
   * Counts one hit. Over the limit → 429 with the seconds left in the window. Counting and
   * deciding are one atomic INCR, so parallel requests cannot all slip in under the limit.
   */
  async hit(limit: RateLimit, subject: string): Promise<void> {
    const key = `rl:${limit.name}:${subject}`;
    let count: unknown;
    let ttl: unknown;

    try {
      // One round trip: count, start the window on the first hit only (NX), read the time left
      const replies = await this.redis
        .multi()
        .incr(key)
        .expire(key, limit.windowSec, 'NX')
        .ttl(key)
        .exec();
      [count, , ttl] = unwrap(replies);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.error(`Rate limit unavailable: ${reason}`);
      throw new ServiceUnavailableException('Sign-in is unavailable; try again shortly');
    }

    if (typeof count !== 'number' || count < 1) {
      this.logger.error(`Rate limit unavailable: unexpected INCR reply ${String(count)}`);
      throw new ServiceUnavailableException('Sign-in is unavailable; try again shortly');
    }
    if (count > limit.max) {
      throw new RateLimitedException(typeof ttl === 'number' && ttl > 0 ? ttl : limit.windowSec);
    }
  }

  onApplicationShutdown(): void {
    // Counts live in Redis, nothing to flush.
    this.redis.disconnect();
  }
}

/** MULTI answers one [error, reply] pair per command, or null when the transaction was dropped. */
function unwrap(replies: [Error | null, unknown][] | null): unknown[] {
  if (!replies) {
    throw new Error('Redis dropped the transaction');
  }

  return replies.map(([error, reply]) => {
    if (error) {
      throw error;
    }
    return reply;
  });
}
