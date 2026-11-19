import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import type { Env } from '../config/env.js';
import { AuthCookies } from './auth-cookies.js';
import { AuthGuard } from './auth.guard.js';
import { OtpController } from './otp.controller.js';
import { LogOtpMailer, OTP_MAILER } from './otp-mailer.js';
import { OtpService } from './otp.service.js';
import { RateLimiter } from './rate-limiter.js';
import { SessionController } from './session.controller.js';
import { SessionService } from './session.service.js';

@Module({
  controllers: [OtpController, SessionController],
  providers: [
    OtpService,
    SessionService,
    AuthCookies,
    {
      provide: RateLimiter,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new RateLimiter(config.get('REDIS_URL', { infer: true })),
    },
    // The only mailer so far; env validation refuses production and requires NODE_ENV
    { provide: OTP_MAILER, useClass: LogOtpMailer },
    // Global: every route in the app needs a session unless it is @Public()
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  // Other modules count their own limits in the same Redis (requests: 30 parses a minute)
  exports: [RateLimiter],
})
export class AuthModule {}
