import { describe, expect, it } from 'vitest';
import { campusLookupQuerySchema } from '../src/index.js';

describe('campusLookupQuerySchema', () => {
  it.each(['name@student.aiub.edu', 'NAME@STUDENT.AIUB.EDU'])(
    'accepts a valid email: %s',
    (email) => expect(campusLookupQuerySchema.parse({ email })).toEqual({ email }),
  );

  it.each([
    {},
    { email: '' },
    { email: 'invalid' },
    { email: ['a@b.test'] },
    { email: 'name@student.aiub.edu', extra: 'unexpected' },
  ])('rejects malformed input: %o', (query) =>
    expect(campusLookupQuerySchema.safeParse(query).success).toBe(false),
  );
});
