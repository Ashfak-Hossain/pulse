import { Body, Controller, HttpCode, Ip, Post } from '@nestjs/common';
import {
  otpRequestBodySchema,
  type OtpRequestAccepted,
  type OtpRequestBody,
  otpVerifyBodySchema,
  type OtpVerifyBody,
  type OtpVerifyResult,
} from '@pulse/contracts';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { OtpService } from './otp.service.js';

// HTTP only: validate, pass the caller's IP for the rate limits, return the service's answer
@Controller('auth/otp')
export class OtpController {
  constructor(private readonly otp: OtpService) {}

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
  verify(
    @Body(new ZodValidationPipe(otpVerifyBodySchema)) body: OtpVerifyBody,
    @Ip() ip: string,
  ): Promise<OtpVerifyResult> {
    return this.otp.verify(body.email, body.code, ip);
  }
}
