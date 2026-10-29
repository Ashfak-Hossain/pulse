import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe.js';

// Test-only schema; real ones live in @pulse/contracts (S13) and are strict the same way
const schema = z.strictObject({
  name: z.string().min(1),
  seats: z.coerce.number().int().positive().default(4),
  stop: z.strictObject({ lat: z.number(), lng: z.number() }).optional(),
});

const pipe = new ZodValidationPipe(schema);

// Runs the pipe and returns the 400 response body it threw
function rejection(value: unknown): unknown {
  try {
    pipe.transform(value);
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return (error as BadRequestException).getResponse();
  }
  throw new Error('expected the pipe to throw');
}

describe('ZodValidationPipe', () => {
  it('returns the parsed value, with defaults and coercion applied', () => {
    expect(pipe.transform({ name: 'Kuril' })).toEqual({ name: 'Kuril', seats: 4 });
    expect(pipe.transform({ name: 'Kuril', seats: '3' })).toEqual({
      name: 'Kuril',
      seats: 3,
    });
  });

  it('rejects invalid input with 400 and lists every issue with its path', () => {
    const response = rejection({ name: '', seats: -1 }) as {
      issues: { path: string; code: string; message: string }[];
    };
    expect(response).toMatchObject({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Validation failed',
    });
    expect(response.issues.map(({ path, code }) => ({ path, code }))).toEqual([
      { path: 'name', code: 'too_small' },
      { path: 'seats', code: 'too_small' },
    ]);
    expect(response.issues.every((issue) => issue.message.length > 0)).toBe(true);
  });

  it('joins nested paths with dots', () => {
    expect(rejection({ name: 'Kuril', stop: { lat: 'north', lng: 90.4 } })).toMatchObject({
      issues: [{ path: 'stop.lat', code: 'invalid_type' }],
    });
  });

  it('rejects unknown fields (rule 11)', () => {
    expect(rejection({ name: 'Kuril', isAdmin: true })).toMatchObject({
      issues: [{ path: '', code: 'unrecognized_keys' }],
    });
  });

  it('rejects a body that is not an object', () => {
    for (const value of [undefined, null, 'Kuril', 42, []]) {
      expect(rejection(value)).toMatchObject({ statusCode: 400, message: 'Validation failed' });
    }
  });
});
