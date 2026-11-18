import { describe, expect, it } from 'vitest';
import { campusLookupBodySchema } from '../src/index.js';

describe('campusLookupBodySchema', () => {
  it.each(['name@student.aiub.edu', 'NAME@STUDENT.AIUB.EDU'])(
    'accepts %s and lowercases it',
    (email) =>
      expect(campusLookupBodySchema.parse({ email })).toEqual({ email: 'name@student.aiub.edu' }),
  );

  it.each([
    {},
    { email: '' },
    { email: 'invalid' },
    { email: ['a@b.test'] },
    { email: `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}.test` },
    { email: 'name@student.aiub.edu', extra: 'unexpected' },
  ])('rejects malformed input: %o', (body) =>
    expect(campusLookupBodySchema.safeParse(body).success).toBe(false),
  );
});
