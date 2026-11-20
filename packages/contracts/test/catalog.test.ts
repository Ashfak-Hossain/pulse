import { describe, expect, it } from 'vitest';
import { createTermSchema, sectionQuerySchema } from '../src/index.js';

const termId = 'bda3b5fe-4882-4bb9-8f7a-c4b598a9db92';

describe('sectionQuerySchema', () => {
  it('defaults the page size and parses text limits from HTTP', () => {
    expect(sectionQuerySchema.parse({ termId })).toEqual({ termId, limit: 20 });
    expect(sectionQuerySchema.parse({ termId, limit: '100', q: '  LAB  ' })).toEqual({
      termId,
      limit: 100,
      q: 'LAB',
    });
    expect(sectionQuerySchema.parse({ termId, q: '%' }).q).toBe('%');
  });

  it.each([
    {},
    { termId: 'invalid' },
    { termId, limit: '0' },
    { termId, limit: '101' },
    { termId, limit: '1.5' },
    { termId, limit: true },
    { termId, q: 'x' },
    { termId, q: 'a\0b' },
    { termId, q: 'x'.repeat(51) },
    { termId, extra: 'unexpected' },
    { termId, cursor: 'not a token' },
  ])('rejects malformed query %j', (query) => {
    expect(sectionQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe('createTermSchema', () => {
  const spring = { name: 'Spring 2026-2027', startsOn: '2027-01-20', endsOn: '2027-05-30' };

  it('accepts a term and trims its name', () => {
    expect(createTermSchema.parse({ ...spring, name: ' Spring 2026-2027 ' })).toEqual(spring);
  });

  it.each([
    ['an end before the start', { ...spring, endsOn: '2027-01-01' }],
    ['an end on the start day', { ...spring, endsOn: spring.startsOn }],
    ['a date that does not exist', { ...spring, startsOn: '2027-02-30' }],
    ['a date in another format', { ...spring, startsOn: '20/01/2027' }],
    ['a blank name', { ...spring, name: '  ' }],
    ['a status (activation is its own call)', { ...spring, status: 'active' }],
  ])('rejects %s', (_, body) => {
    expect(createTermSchema.safeParse(body).success).toBe(false);
  });
});
