import { describe, expect, it } from 'vitest';
import { sectionQuerySchema } from '../src/index.js';

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
