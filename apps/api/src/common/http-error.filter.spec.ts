import {
  type ArgumentsHost,
  BadRequestException,
  HttpException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { HttpAdapterHost } from '@nestjs/core';
import type { MockInstance } from 'vitest';
import { apiErrorSchema } from '@pulse/contracts';
import { DrizzleQueryError } from '@pulse/db';
import { HttpErrorFilter } from './http-error.filter.js';

// A fake request context: GET /campuses/aiub, answer not started unless headersSent is true
function fakeHost(headersSent = false) {
  const reply = vi.fn();
  const end = vi.fn();
  const adapterHost = {
    httpAdapter: { reply, end, isHeadersSent: () => headersSent },
  } as unknown as HttpAdapterHost;
  const response = {};
  const host = {
    switchToHttp: () => ({
      getRequest: () => ({ method: 'GET', path: '/campuses/aiub' }),
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
  return { adapterHost, host, reply, end, response };
}

// Runs the filter on one exception and returns what it sent: the body and the status
function send(exception: unknown): { body: unknown; status: number } {
  const { adapterHost, host, reply, response } = fakeHost();

  new HttpErrorFilter(adapterHost).catch(exception, host);

  expect(reply).toHaveBeenCalledTimes(1);
  const [sentTo, body, status] = reply.mock.calls[0] as [unknown, unknown, number];
  expect(sentTo).toBe(response);
  return { body, status };
}

describe('HttpErrorFilter', () => {
  let logError: MockInstance<Logger['error']>;

  beforeEach(() => {
    logError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('turns a 4xx HttpException into the shared shape, keeping its message', () => {
    const { body, status } = send(new NotFoundException('Campus not found'));
    expect(status).toBe(404);
    expect(body).toEqual({ statusCode: 404, error: 'Not Found', message: 'Campus not found' });
    expect(apiErrorSchema.safeParse(body).success).toBe(true);
  });

  it('keeps the issues of a validation error', () => {
    const issues = [{ path: 'name', code: 'too_small', message: 'Too small' }];
    const { body } = send(
      new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: 'Validation failed',
        issues,
      }),
    );
    expect(body).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Validation failed',
      issues,
    });
  });

  // Nest turns body-parser's "too large" error into a plain HttpException with no error text
  it('fills error from the status when the exception has none', () => {
    const { body, status } = send(new HttpException('request entity too large', 413));
    expect(status).toBe(413);
    expect(body).toEqual({
      statusCode: 413,
      error: 'Payload Too Large',
      message: 'request entity too large',
    });
  });

  it('never sends the message of a 5xx HttpException, and logs it', () => {
    const { body, status } = send(new ServiceUnavailableException('db at 10.0.0.5 is down'));
    expect(status).toBe(503);
    expect(body).toEqual({
      statusCode: 503,
      error: 'Service Unavailable',
      message: 'Service Unavailable',
    });
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('10.0.0.5'));
  });

  it('answers 500 with fixed text for an unknown error, and logs the real one', () => {
    const { body, status } = send(new Error('password authentication failed for user pulse'));
    expect(status).toBe(500);
    expect(body).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Internal Server Error',
    });
    expect(JSON.stringify(body)).not.toContain('pulse');
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('password authentication'));
  });

  it('handles a thrown value that is not an Error', () => {
    const { body, status } = send('just a string');
    expect(status).toBe(500);
    expect(apiErrorSchema.safeParse(body).success).toBe(true);
  });

  it('logs the method and path of a failed request, never its query string', () => {
    send(new Error('boom'));
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('GET /campuses/aiub'));
  });

  // Drizzle's message lists the query's values ("params: …"): personal data must not reach the log
  it('logs a failed query by its SQL and PostgreSQL code, never its values', () => {
    const cause = Object.assign(new Error('duplicate key value'), { code: '23505' });
    const { body } = send(
      new DrizzleQueryError('insert into campus (slug) values ($1)', ['rahim@aiub.edu'], cause),
    );
    expect(body).toMatchObject({ statusCode: 500, message: 'Internal Server Error' });
    const logged = logError.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('insert into campus');
    expect(logged).toContain('23505');
    expect(logged).not.toContain('rahim@aiub.edu');
  });

  it('only ends the response when an answer has already started, and still logs', () => {
    const { adapterHost, host, reply, end, response } = fakeHost(true);
    new HttpErrorFilter(adapterHost).catch(new Error('stream broke'), host);
    expect(reply).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledWith(response);
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('stream broke'));
  });

  it('treats a status below 400 as a server bug (500)', () => {
    const { body, status } = send(new HttpException('Found', 302));
    expect(status).toBe(500);
    expect(apiErrorSchema.safeParse(body).success).toBe(true);
  });

  it('drops issues that are not in the issue shape', () => {
    const { body } = send(
      new BadRequestException({ message: 'Validation failed', issues: [{ sql: 'select 1' }] }),
    );
    expect(body).toEqual({ statusCode: 400, error: 'Bad Request', message: 'Validation failed' });
  });

  it('copes with an exception whose response is null', () => {
    const { body, status } = send(new HttpException(null as unknown as string, 400));
    expect(status).toBe(400);
    expect(apiErrorSchema.safeParse(body).success).toBe(true);
  });
});
