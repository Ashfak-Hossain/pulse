import { HttpException, HttpStatus } from '@nestjs/common';

/** 429 that says when to try again. HttpErrorFilter sends retryAfterSec as Retry-After. */
export class RateLimitedException extends HttpException {
  constructor(readonly retryAfterSec: number) {
    super('Too many requests; try again later', HttpStatus.TOO_MANY_REQUESTS);
  }
}
