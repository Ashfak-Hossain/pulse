import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { OtpController } from './otp.controller.js';
import { LogOtpMailer, OTP_MAILER } from './otp-mailer.js';
import { OtpService } from './otp.service.js';
import { RateLimiter } from './rate-limiter.js';

@Module({
  controllers: [OtpController],
  providers: [
    OtpService,
    {
      provide: RateLimiter,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new RateLimiter(config.get('REDIS_URL', { infer: true })),
    },
    // The only mailer so far; env validation refuses production and requires NODE_ENV
    { provide: OTP_MAILER, useClass: LogOtpMailer },
  ],
})
export class AuthModule {}
