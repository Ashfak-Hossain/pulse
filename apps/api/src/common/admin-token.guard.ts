import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Env } from '../config/env.js';

const BEARER = 'Bearer ';

/** Lets a request through only with `Authorization: Bearer <ADMIN_TOKEN>`. Stand-in for the platform_admin role until sign-in exists. */
@Injectable()
export class AdminTokenGuard implements CanActivate {
  // Hashed once at boot. Comparing two hashes keeps the lengths equal, so timingSafeEqual never
  // throws and the time taken says nothing about the token
  private readonly expected: Buffer | undefined;

  constructor(config: ConfigService<Env, true>) {
    const token = config.get('ADMIN_TOKEN', { infer: true });
    this.expected = token === undefined ? undefined : sha256(token);
  }

  canActivate(context: ExecutionContext): boolean {
    const header = context.switchToHttp().getRequest<Request>().headers.authorization;
    if (
      this.expected &&
      header?.startsWith(BEARER) &&
      timingSafeEqual(sha256(header.slice(BEARER.length)), this.expected)
    ) {
      return true;
    }

    // One answer for every failure: no hint whether the header, the scheme or the token was wrong
    throw new UnauthorizedException();
  }
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
