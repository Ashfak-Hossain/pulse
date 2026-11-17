import { Controller, HttpCode, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AuthCookies } from './auth-cookies.js';
import { CurrentUser } from './auth.guard.js';
import { SessionService, type SignedInUser } from './session.service.js';

@Controller('auth')
export class SessionController {
  constructor(
    private readonly sessions: SessionService,
    private readonly cookies: AuthCookies,
  ) {}

  @Post('sign-out')
  @HttpCode(204)
  async signOut(
    @CurrentUser() user: SignedInUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.sessions.signOut(user);
    this.cookies.clear(res);
  }
}
