import { parsedRequestSchema, type ParsedRequest as ContractParsedRequest } from '@pulse/contracts';
import fc from 'fast-check';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { parseRequest, type ParsedRequest } from '../src/index.js';
import { variants } from '../src/variants.js';
import golden from './golden.json' with { type: 'json' };

const courses = golden.courses;

// Any text the API accepts: raw code units (lone surrogates included), emoji and Bangla script
const anyText = fc.oneof(
  fc.string({ maxLength: 280, unit: 'binary' }),
  fc.string({ maxLength: 280, unit: 'grapheme' }),
  fc.string({ maxLength: 280, unit: fc.constantFrom(...'মিরপুর যাবো ক্লাস ৫টায়😀।') }),
);

// Text built from words the parser knows, so the patterns actually fire
const words = [
  ...Object.values(variants).flat(),
  ...['mirpur', 'uttara', 'sector', 'banani', 'kuril', 'to', 'from', 'at', 'by', 'after', 'er'],
  ...['5:30', '17:45', '99:99', '0', '7', '13', '24', 'ml', 'oop', 'campus', 'any', 'gender'],
];
const knownWords = fc
  .array(fc.constantFrom(...words), { maxLength: 40 })
  .map((ws) => ws.join(' ').slice(0, 280));

describe('parseRequest properties', () => {
  it('shares its result type with @pulse/contracts', () => {
    expectTypeOf<ParsedRequest>().toEqualTypeOf<ContractParsedRequest>();
  });

  it('never throws and always fits parsedRequestSchema', () => {
    fc.assert(
      fc.property(fc.oneof(anyText, knownWords), (text) => {
        const parsed = parseRequest(text, { courses });
        expect(parsedRequestSchema.safeParse(parsed).success).toBe(true);
        expect(parsed.confidence).toBeGreaterThanOrEqual(0);
        expect(parsed.confidence).toBeLessThanOrEqual(1);
      }),
      { numRuns: 500 },
    );
  });

  it('ignores upper case, extra spaces and trailing punctuation', () => {
    const sentence = fc.constantFrom(...golden.cases.map((c) => c.text));
    const noise = fc.record({
      upper: fc.array(fc.boolean(), { minLength: 280, maxLength: 280 }),
      gap: fc.constantFrom(' ', '  ', '   ', '\t'),
      lead: fc.constantFrom('', ' ', '  '),
      tail: fc.constantFrom('', '.', '!', '?!', '...', ' !!', ','),
    });
    fc.assert(
      fc.property(sentence, noise, (text, { upper, gap, lead, tail }) => {
        const noisy =
          lead +
          [...text]
            .map((ch, i) => (upper[i] ? ch.toUpperCase() : ch))
            .join('')
            .replaceAll(' ', gap) +
          tail;
        expect(parseRequest(noisy, { courses })).toEqual(parseRequest(text, { courses }));
      }),
    );
  });

  it('works without a course list: "ML class" is just after class', () => {
    expect(parseRequest('ML class er por Mirpur 10 jabo').timeRef).toEqual({ kind: 'after_class' });
  });
});
