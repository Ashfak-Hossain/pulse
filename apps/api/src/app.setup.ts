import type { INestApplication } from '@nestjs/common';
import helmet from 'helmet';

// App-wide HTTP setup, shared by main.ts and the e2e tests, so tests run the same app users get.
// Things Nest can inject (like the error filter) are registered in AppModule instead
export function configureApp(app: INestApplication): void {
  // Standard security headers (nosniff, HSTS, no framing…) and no "X-Powered-By: Express"
  app.use(helmet());
}
