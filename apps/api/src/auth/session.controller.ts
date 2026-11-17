import {
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import {
  authSessionParamsSchema,
  type AuthSessionList,
  type AuthSessionParams,
} from '@pulse/contracts';
import type { Request, Response } from 'express';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { AuthCookies, readAuthCookies } from './auth-cookies.js';
import { CurrentUser, Public } from './auth.guard.js';
import { SessionService, type SignedInUser } from './session.service.js';

@Controller('auth')
export class SessionController {
  constructor(
    private readonly sessions: SessionService,
    private readonly cookies: AuthCookies,
  ) {}

  // Public: it runs exactly when the access token has expired.
  // A 401 leaves the cookies alone: the loser of two tabs refreshing at once must not wipe
  // the new cookies the winner just set
  @Public()
  @Post('refresh')
  @HttpCode(204)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const tokens = await this.sessions.refresh(readAuthCookies(req).refreshToken);

    if (!tokens) {
      throw new UnauthorizedException();
    }

    this.cookies.set(res, tokens);
  }

  // Public: signing out must work after the access token expired, and always clears cookies
  @Public()
  @Post('sign-out')
  @HttpCode(204)
  async signOut(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.sessions.signOut(readAuthCookies(req));
    this.cookies.clear(res);
  }

  @Post('sign-out-all')
  @HttpCode(204)
  async signOutAll(
    @CurrentUser() user: SignedInUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.sessions.signOutAll(user);
    this.cookies.clear(res);
  }

  @Get('sessions')
  list(@CurrentUser() user: SignedInUser): Promise<AuthSessionList> {
    return this.sessions.list(user);
  }

  // 404 for another user's device too, so ids cannot be probed
  @Delete('sessions/:id')
  @HttpCode(204)
  async revokeDevice(
    @CurrentUser() user: SignedInUser,
    @Param(new ZodValidationPipe(authSessionParamsSchema)) params: AuthSessionParams,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    if (!(await this.sessions.revokeDevice(user, params.id))) {
      throw new NotFoundException('Session not found');
    }

    if (params.id === user.familyId) {
      this.cookies.clear(res);
    }
  }
}
