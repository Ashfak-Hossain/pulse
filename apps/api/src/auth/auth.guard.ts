import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthUser } from '@pulse/contracts';
import type { Request } from 'express';
import { ACCESS_COOKIE } from './auth-cookies.js';
import { SessionService, type SignedInUser } from './session.service.js';

const PUBLIC = 'auth:public';
const ROLES = 'auth:roles';

// user is set only after AuthGuard let a non-public request through
type SignedInRequest = Request & { user?: SignedInUser };

/** Opens a route, or a whole controller, to callers who are not signed in. */
export const Public = () => SetMetadata(PUBLIC, true);

/** Only these roles may call the route (signing in is implied). */
export const Roles = (...roles: AuthUser['role'][]) => SetMetadata(ROLES, roles);

/** The signed-in user the guard attached to this request. Not for @Public() routes. */
export const CurrentUser = createParamDecorator(
  (_: unknown, context: ExecutionContext): SignedInUser => {
    const user = context.switchToHttp().getRequest<SignedInRequest>().user;
    if (!user) throw new UnauthorizedException();
    return user;
  },
);

/** Global: every route needs a live session unless it is @Public(); @Roles() narrows it. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) {
      return true;
    }

    const request = context.switchToHttp().getRequest<SignedInRequest>();
    const token: unknown = request.cookies[ACCESS_COOKIE];
    const user = typeof token === 'string' ? await this.sessions.authenticate(token) : undefined;

    if (!user) {
      throw new UnauthorizedException();
    }

    request.user = user;

    const roles = this.reflector.getAllAndOverride<AuthUser['role'][] | undefined>(ROLES, targets);

    if (roles && !roles.includes(user.role)) {
      throw new ForbiddenException();
    }

    return true;
  }
}
