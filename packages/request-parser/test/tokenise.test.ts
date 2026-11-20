import { describe, expect, it } from 'vitest';
import { tokenise } from '../src/tokenise.js';
import { variants } from '../src/variants.js';

describe('tokenise', () => {
  it('lowers case and drops punctuation and extra spaces', () => {
    expect(tokenise('  Going   HOME!!  ')).toEqual(['going', 'home']);
  });

  it.each([
    ['mirpur-10', ['mirpur', '10']],
    ['mirpur10', ['mirpur', '10']],
    ['Mirpur ten', ['mirpur', '10']],
    ['10min', ['10', 'min']],
    ['5pm', ['5', 'pm']],
  ])('pulls letters and digits apart: %s', (text, words) => {
    expect(tokenise(text)).toEqual(words);
  });

  it.each(['5:30', '5.30', '05:30'])('keeps a clock time whole: %s', (text) => {
    expect(tokenise(text)).toHaveLength(1);
    expect(tokenise(text)[0]).toMatch(/^\d{1,2}:30$/);
  });

  it.each([
    ['jaabo', 'jabo'],
    ['pore', 'por'],
    ['theika', 'theke'],
    ['asbo', 'ashbo'],
    ['sudhu', 'only'],
    ['opekkha', 'wait'],
    ['riksha', 'rickshaw'],
  ])('maps the Banglish spelling %s to %s', (spelling, word) => {
    expect(tokenise(spelling)).toEqual([word]);
  });

  it('lists each spelling under one word only', () => {
    const spellings = Object.values(variants).flat();
    expect(new Set(spellings).size).toBe(spellings.length);
  });

  it('keeps Bangla script and drops emoji', () => {
    expect(tokenise('মিরপুর যাবো 😀')).toEqual(['মিরপুর', 'যাবো']);
  });
});
