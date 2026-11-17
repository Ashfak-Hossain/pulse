import { Body, Controller, Headers, HttpCode, Ip, Post, Res } from '@nestjs/common';
import {
  otpRequestBodySchema,
  type OtpRequestAccepted,
  type OtpRequestBody,
  otpVerifyBodySchema,
  type OtpVerifyBody,
  type OtpVerifyResult,
} from '@pulse/contracts';
import type { Response } from 'express';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { AuthCookies } from './auth-cookies.js';
import { Public } from './auth.guard.js';
import { OtpService } from './otp.service.js';

// HTTP only: validate, pass the caller's IP for the rate limits, set the session cookies.
// Public: signing in cannot need a session
@Public()
@Controller('auth/otp')
export class OtpController {
  constructor(
    private readonly otp: OtpService,
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
    // passthrough: Nest still sends the returned body; this only adds the cookies
    @Res({ passthrough: true }) res: Response,
  ): Promise<OtpVerifyResult> {
    const signedIn = await this.otp.verify(body.email, body.code, ip, userAgent);
    this.cookies.set(res, signedIn.tokens);
    return signedIn.body;
  }
}
