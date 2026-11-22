import { variants } from './variants.js';

const canonical = new Map<string, string>(
  Object.entries(variants).flatMap(([word, spellings]) =>
    spellings.map((spelling): [string, string] => [spelling, word]),
  ),
);

// A private-use character: not a letter, digit or punctuation, so nothing below removes it
const CLOCK_MARK = '\uE000';

/**
 * Splits text into canonical words: lower case, punctuation and extra spaces dropped, letters and
 * digits pulled apart ("mirpur10" → mirpur 10) and every known spelling mapped to one form
 * (variants.ts). A clock time keeps its colon: "5.30" and "5:30" both become one token "5:30".
 */
export function tokenise(text: string): string[] {
  const words = text
    .replaceAll(CLOCK_MARK, ' ') // the mark below must not come from the text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/(\d{1,2})[.:](\d{2})(?!\d)/gu, `$1${CLOCK_MARK}$2`) // keep clock times whole
    .replace(/[^\p{L}\p{M}\p{N}\uE000]+/gu, ' ') // \p{M} keeps Bangla vowel signs
    .replace(/(\p{L})(\p{N})/gu, '$1 $2')
    .replace(/(\p{N})(\p{L})/gu, '$1 $2')
    .replaceAll(CLOCK_MARK, ':')
    .split(' ')
    .filter((word) => word !== '');
  return words.map((word) => canonical.get(word) ?? word);
}

/** True when the words appear next to each other, in this order, somewhere in the tokens. */
export function hasRun(tokens: readonly string[], run: readonly string[]): boolean {
  return tokens.some((_, i) => run.every((word, j) => tokens[i + j] === word));
}

/** The integers from start up to, not including, end. */
export function range(start: number, end: number): number[] {
  return Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i);
}
