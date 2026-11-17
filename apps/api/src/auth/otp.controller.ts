import { Body, Controller, Headers, HttpCode, Ip, Logger, Post, Req, Res } from '@nestjs/common';
import {
  otpRequestBodySchema,
  type OtpRequestAccepted,
  type OtpRequestBody,
  otpVerifyBodySchema,
  type OtpVerifyBody,
  type OtpVerifyResult,
} from '@pulse/contracts';
import type { Request, Response } from 'express';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { AuthCookies, readAuthCookies } from './auth-cookies.js';
import { Public } from './auth.guard.js';
import { OtpService } from './otp.service.js';
import { SessionService } from './session.service.js';

// HTTP only: validate, pass the caller's IP for the rate limits, end this browser's old
// session, set the session cookies.
// Public: signing in cannot need a session
@Public()
@Controller('auth/otp')
export class OtpController {
  private readonly logger = new Logger(OtpController.name);

  constructor(
    private readonly otp: OtpService,
    private readonly sessions: SessionService,
    private readonly cookies: AuthCookies,
  ) {}

  // 202: accepted, and the code arrives by the mailer channel
  @Post('request')
  @HttpCode(202)
  request(
    @Body(new ZodValidationPipe(otpRequestBodySchema)) body: OtpRequestBody,
    @Ip() ip: string,
  ): Promise<OtpRequestAccepted> {
    return this.otp.request(body.email, ip);
  }

  @Post('verify')
  @HttpCode(200)
  async verify(
    @Body(new ZodValidationPipe(otpVerifyBodySchema)) body: OtpVerifyBody,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string | undefined,
    @Req() req: Request,
    // passthrough: Nest still sends the returned body; this only adds the cookies
    @Res({ passthrough: true }) res: Response,
  ): Promise<OtpVerifyResult> {
    const signedIn = await this.otp.verify(body.email, body.code, ip, userAgent);
    // Signing in again on this browser replaces its old session instead of leaving it alive.
    // The new session is already committed: a failed cleanup must not fail the sign-in
    await this.sessions.signOut(readAuthCookies(req)).catch((error: unknown) => {
      this.logger.warn(
        `Old session not revoked: ${error instanceof Error ? error.name : 'unknown'}`,
      );
    });
    this.cookies.set(res, signedIn.tokens);
    return signedIn.body;
  }
}
