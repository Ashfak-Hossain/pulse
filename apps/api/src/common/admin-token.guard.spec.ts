import { type ExecutionContext, UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { AdminTokenGuard } from './admin-token.guard.js';

const token = 'test-admin-token-0123456789abcdef';

function guardWith(adminToken: string | undefined): AdminTokenGuard {
  const config = { get: () => adminToken } as unknown as ConfigService<Env, true>;
  return new AdminTokenGuard(config);
}

function requestWith(authorization: string | undefined): ExecutionContext {
  const request = { headers: authorization === undefined ? {} : { authorization } };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('AdminTokenGuard', () => {
  it('lets the right bearer token through', () => {
    expect(guardWith(token).canActivate(requestWith(`Bearer ${token}`))).toBe(true);
  });

  it.each([
    ['no header', undefined],
    ['a wrong token', 'Bearer wrong-token-0123456789abcdef-xx'],
    ['a prefix of the token', `Bearer ${token.slice(0, 10)}`],
    ['the token with no scheme', token],
    ['another scheme', `Basic ${token}`],
    ['an empty bearer', 'Bearer '],
  ])('answers 401 for %s', (_, authorization) => {
    expect(() => guardWith(token).canActivate(requestWith(authorization))).toThrow(
      UnauthorizedException,
    );
  });

  // Fails closed: a server started without ADMIN_TOKEN has no admin routes at all
  it('answers 401 to every request when ADMIN_TOKEN is not set', () => {
    expect(() => guardWith(undefined).canActivate(requestWith(`Bearer ${token}`))).toThrow(
      UnauthorizedException,
    );
  });
});
