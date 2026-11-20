import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import {
  requestParseBodySchema,
  type RequestParseBody,
  type RequestParseResult,
} from '@pulse/contracts';
import { CurrentUser } from '../auth/auth.guard.js';
import type { SignedInUser } from '../auth/session.service.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { RequestService } from './request.service.js';

// Any signed-in user (the global AuthGuard). The campus comes from the session, never the body
@Controller('requests')
export class RequestController {
  constructor(private readonly requests: RequestService) {}

  @Post('parse')
  @HttpCode(200)
  parse(
    @CurrentUser() user: SignedInUser,
    @Body(new ZodValidationPipe(requestParseBodySchema)) body: RequestParseBody,
  ): Promise<RequestParseResult> {
    return this.requests.parse(user, body.text);
  }
}
