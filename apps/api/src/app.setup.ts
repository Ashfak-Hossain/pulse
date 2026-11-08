import { BadRequestException, type INestApplication } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';

// App-wide HTTP setup, shared by main.ts and the e2e tests, so tests run the same app users get.
// Things Nest can inject (like the error filter) are registered in AppModule instead
export function configureApp(app: INestApplication): void {
  // Standard security headers (nosniff, HSTS, no framing…) and no "X-Powered-By: Express"
  app.use(helmet());

  // Install the same JSON parser before the sanitizer so Nest skips its duplicate.
  // Its default error mapping would expose excerpts from malformed request bodies.
  const adapter = app.getHttpAdapter();
  if (adapter instanceof ExpressAdapter) {
    adapter.useBodyParser('json', false);
    app.use(redactMalformedJson);
  }
}

function redactMalformedJson(
  error: unknown,
  _request: Request,
  _response: Response,
  next: NextFunction,
): void {
  if (error instanceof SyntaxError && 'type' in error && error.type === 'entity.parse.failed') {
    next(new BadRequestException('Malformed JSON body'));
    return;
  }
  next(error);
}
