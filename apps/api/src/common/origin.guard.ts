import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { Env } from '../config/env.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Global: a request that changes something must come from our own web app (stops CSRF). */
@Injectable()
export class OriginGuard implements CanActivate {
  private readonly appOrigin: string;

  constructor(config: ConfigService<Env, true>) {
    this.appOrigin = config.get('APP_ORIGIN', { infer: true });
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    if (SAFE_METHODS.has(request.method) || request.headers.origin === this.appOrigin) {
      return true;
    }

    throw new ForbiddenException('Cross-site request refused');
  }
}
