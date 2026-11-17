import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Response } from 'express';
import type { Env } from '../config/env.js';
import { ACCESS_TOKEN_TTL_SEC, REFRESH_TOKEN_TTL_SEC } from './auth-tokens.js';
import type { SessionTokens } from './session.service.js';

export const ACCESS_COOKIE = 'pulse_at';
export const REFRESH_COOKIE = 'pulse_rt';

/** Sets and clears the two sign-in cookies. Page scripts can never read them (httpOnly). */
@Injectable()
export class AuthCookies {
  private readonly access: CookieOptions;
  private readonly refresh: CookieOptions;

  constructor(config: ConfigService<Env, true>) {
    const secure = config.get('NODE_ENV', { infer: true }) !== 'development';

    this.access = { httpOnly: true, secure, sameSite: 'lax', path: '/' };
    this.refresh = { httpOnly: true, secure, sameSite: 'strict', path: '/auth' };
  }

  set(res: Response, tokens: SessionTokens): void {
    res.cookie(ACCESS_COOKIE, tokens.accessToken, {
      ...this.access,
      maxAge: ACCESS_TOKEN_TTL_SEC * 1000,
    });

    res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
      ...this.refresh,
      maxAge: REFRESH_TOKEN_TTL_SEC * 1000,
    });
  }

  clear(res: Response): void {
    res.clearCookie(ACCESS_COOKIE, this.access);
    res.clearCookie(REFRESH_COOKIE, this.refresh);
  }
}
