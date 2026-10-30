import { describe, expect, it } from 'vitest';
import { apiErrorSchema } from '../src/index.js';

describe('apiErrorSchema', () => {
  it('accepts a plain error', () => {
    const error = { statusCode: 404, error: 'Not Found', message: 'Campus not found' };
    expect(apiErrorSchema.parse(error)).toEqual(error);
  });

  it('accepts a validation error with its issues', () => {
    const error = {
      statusCode: 400,
      error: 'Bad Request',
      message: 'Validation failed',
      issues: [{ path: 'name', code: 'too_small', message: 'Too small' }],
    };
    expect(apiErrorSchema.parse(error)).toEqual(error);
  });

  it('rejects unknown keys, so a leaked field fails the e2e tests', () => {
    const error = { statusCode: 500, error: 'Internal Server Error', message: 'x', stack: 'at …' };
    expect(apiErrorSchema.safeParse(error).success).toBe(false);
  });

  it.each([200, 302, 600])('rejects statusCode %i (errors are 4xx or 5xx)', (statusCode) => {
    const error = { statusCode, error: 'x', message: 'x' };
    expect(apiErrorSchema.safeParse(error).success).toBe(false);
  });
});
