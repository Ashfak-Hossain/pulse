import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { type ApiError, apiIssueSchema } from '@pulse/contracts';
import { DrizzleQueryError } from '@pulse/db';
import type { Request } from 'express';
import { STATUS_CODES } from 'node:http';

// Catches everything an HTTP request throws and answers in the one shape clients rely on (ApiError).
// HTTP only: the WebSocket gateway (later) needs its own filter
@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpErrorFilter.name);

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response: unknown = http.getResponse();
    const { httpAdapter } = this.adapterHost;
    const body = toBody(exception);

    if (body.statusCode >= 500) {
      // Method and path only: the query string can hold personal data
      this.logger.error(`${request.method} ${request.path} failed: ${describe(exception)}`);
    }

    // A stream or a @Res handler already started the answer: too late for a body, just end it
    if (httpAdapter.isHeadersSent(response)) {
      httpAdapter.end(response);
      return;
    }
    httpAdapter.reply(response, body, body.statusCode);
  }
}

function toBody(exception: unknown): ApiError {
  const status = exception instanceof HttpException ? exception.getStatus() : 500;
  // Below 400 is not an error status, so throwing one is our bug
  const statusCode = status >= 400 ? status : 500;
  const error = STATUS_CODES[statusCode] ?? 'Error';

  // 5xx is a bug or a failed dependency: fixed text only, the real reason goes to the log
  if (!(exception instanceof HttpException) || statusCode >= 500) {
    return { statusCode, error, message: error };
  }

  // 4xx messages are written by us (or Nest), never copied from a lower layer's error
  const fields = exception.getResponse();
  const details: object = typeof fields === 'object' && fields !== null ? fields : {};
  const message =
    'message' in details && typeof details.message === 'string'
      ? details.message
      : exception.message;
  // Kept only when they match the contract, so nothing else rides along to the client
  const issues =
    'issues' in details ? apiIssueSchema.array().safeParse(details.issues).data : undefined;
  return { statusCode, error, message, ...(issues && { issues }) };
}

// What a 5xx writes to the log. A failed query's message lists its values ("params: …"), which
// can be personal data, so for those only the SQL text and the PostgreSQL error code are kept
function describe(exception: unknown): string {
  if (exception instanceof DrizzleQueryError) {
    const cause: unknown = exception.cause;
    const code =
      typeof cause === 'object' &&
      cause !== null &&
      'code' in cause &&
      typeof cause.code === 'string'
        ? cause.code
        : 'no code';
    return `query failed (${code}): ${exception.query}`;
  }
  return exception instanceof Error ? (exception.stack ?? exception.message) : String(exception);
}
