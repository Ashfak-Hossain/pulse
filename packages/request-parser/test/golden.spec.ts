import { describe, expect, it } from 'vitest';
import { aiubGazetteer, parseRequest } from '../src/index.js';
import golden from './golden.json' with { type: 'json' };

// golden.json names a place by its gazetteer name; the parser's answer carries the cell too
function withCell(expected: Record<string, unknown>) {
  if (typeof expected.place !== 'string') return expected;
  const place = aiubGazetteer.find((p) => p.name === expected.place);
  if (!place) throw new Error(`golden.json names an unknown place: ${expected.place}`);
  return { ...expected, place: { name: place.name, cell: place.cell } };
}

describe('golden sentences', () => {
  it('has at least 60 sentences, at least half of them Banglish', () => {
    const banglish = golden.cases.filter((c) => c.lang === 'banglish').length;
    expect(golden.cases.length).toBeGreaterThanOrEqual(60);
    expect(banglish * 2).toBeGreaterThanOrEqual(golden.cases.length);
  });

  it.each(golden.cases.map((c) => [c.text, c.expected] as const))('%s', (text, expected) => {
    expect(parseRequest(text, { courses: golden.courses })).toEqual(withCell(expected));
  });
});
