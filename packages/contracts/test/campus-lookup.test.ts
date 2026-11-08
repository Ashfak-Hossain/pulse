import { describe, expect, it } from 'vitest';
import { campusLookupBodySchema, campusLookupResultSchema } from '../src/index.js';

describe('campusLookupBodySchema', () => {
  it.each(['name@student.aiub.edu', 'NAME@STUDENT.AIUB.EDU'])(
    'accepts a valid email: %s',
    (email) => expect(campusLookupBodySchema.parse({ email })).toEqual({ email }),
  );

  it.each([
    {},
    { email: '' },
    { email: 'invalid' },
    { email: ['a@b.test'] },
    { email: 'name@student.aiub.edu', extra: 'unexpected' },
  ])('rejects malformed input: %o', (body) =>
    expect(campusLookupBodySchema.safeParse(body).success).toBe(false),
  );
});

describe('campusLookupResultSchema', () => {
  it('accepts an unrecognized domain as a null campus', () => {
    expect(campusLookupResultSchema.parse({ campus: null })).toEqual({ campus: null });
  });

  it('rejects fields outside the campus summary', () => {
    expect(
      campusLookupResultSchema.safeParse({ campus: { slug: 'aiub', name: 'AIUB', id: 'extra' } })
        .success,
    ).toBe(false);
  });
});
