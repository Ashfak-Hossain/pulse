import { tokenise } from './tokenise.js';

export type TimeRef =
  { kind: 'clock'; time: string } | { kind: 'after_class'; course?: string } | { kind: 'now' };

export interface FoundTimes {
  /** The time the request is about: a clock time first, then "after class", then "now" */
  chosen?: TimeRef;
  /** More than one different time was named */
  clash: boolean;
  afterClass: boolean;
}

type Course = { code: string; title: string };
type Period = 'am' | 'pm';

/** Finds every time the tokens name and picks the most specific one. */
export function findTimes(
  tokens: readonly string[],
  inPlace: ReadonlySet<number>,
  courses: readonly Course[],
): FoundTimes {
  const clocks = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const clock = clockAt(tokens, i, inPlace);
    if (clock) clocks.add(clock);
  }
  const afterClass = findAfterClass(tokens, courses);
  const now = tokens.includes('ekhon');

  const refs: TimeRef[] = [...clocks].map((time) => ({ kind: 'clock' as const, time }));
  if (afterClass) refs.push(afterClass);
  if (now) refs.push({ kind: 'now' });
  const chosen = refs[0];
  return { ...(chosen && { chosen }), clash: refs.length > 1, afterClass: !!afterClass };
}

// Clock patterns, at token i:
//   "5:30" · "5 pm" · "at 5" / "by 5" / "around 5" · "5 tay" / "5 ta baje" ·
//   "sare 5 tay" (5:30) · "poune 6 tay" (5:45) · "dera tay" (1:30) · "arai tay" (2:30)
function clockAt(
  tokens: readonly string[],
  i: number,
  inPlace: ReadonlySet<number>,
): string | undefined {
  const word = tokens[i] ?? '';
  const prev = tokens[i - 1];
  const next = tokens[i + 1];
  const markedAt = (j: number) =>
    tokens[j] === 'tay' || (tokens[j] === 'ta' && tokens[j + 1] === 'tay');

  if ((word === 'dera' || word === 'arai') && markedAt(i + 1)) {
    return toClock(word === 'dera' ? 1 : 2, 30, periodNear(tokens, i, i + 2));
  }
  if (inPlace.has(i)) return undefined;
  const hhmm = /^(\d{1,2}):(\d{2})$/.exec(word);
  if (hhmm) return toClock(Number(hhmm[1]), Number(hhmm[2]), periodNear(tokens, i, i + 1));
  if (!/^\d{1,2}$/.test(word)) return undefined;

  const hour = Number(word);
  const period = periodNear(tokens, i, i + 1);
  const notAnAmount = next !== 'min' && next !== 'hour';
  const marked = markedAt(i + 1);
  if (prev === 'sare' && marked) return toClock(hour, 30, period);
  // "poune 8" is a quarter to 8: read 8 first, so the am/pm rule sees the hour that was said
  if (prev === 'poune' && marked) return quarterBefore(toClock(hour, 0, period));
  if (marked || next === 'am' || next === 'pm') return toClock(hour, 0, period);
  if ((prev === 'at' || prev === 'by' || prev === 'around') && notAnAmount) {
    return toClock(hour, 0, period);
  }
  return undefined;
}

// "pm", "bikal" or "raat" right after the time or up to two words before it
function periodNear(tokens: readonly string[], start: number, end: number): Period | undefined {
  const words = [tokens[end], tokens[start - 1], tokens[start - 2]];
  for (const word of words) {
    if (word === 'pm' || word === 'raat') return 'pm';
    if (word === 'am') return 'am';
  }
  return undefined;
}

// Classes run from about 08:00 to 20:00, so with no am/pm a bare hour from 1 to 7 means the
// afternoon or evening ("5 tay" is 17:00) and 8 to 12 is taken as written.
function toClock(hour: number, minute: number, period: Period | undefined): string | undefined {
  if (hour < 0 || hour > 23 || minute > 59) return undefined;
  let h = hour;
  if (hour <= 12 && period === 'pm' && hour !== 12) h = hour + 12;
  else if (hour === 12 && period === 'am') h = 0;
  else if (hour >= 1 && hour <= 7 && period === undefined) h = hour + 12;
  return `${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function quarterBefore(clock: string | undefined): string | undefined {
  if (!clock) return undefined;
  const minutes = (Number(clock.slice(0, 2)) * 60 + 24 * 60 - 15) % (24 * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

// "class er por", "class sheshe", "after ML class": the words just before "class" (or between
// "after" and "class") may name the course
function findAfterClass(
  tokens: readonly string[],
  courses: readonly Course[],
): { kind: 'after_class'; course?: string } | undefined {
  for (let i = 0; i < tokens.length; i++) {
    let named: readonly string[] | undefined;
    if (tokens[i] === 'class') {
      const following = tokens.slice(i + 1, i + 4);
      if (following.includes('por') || following.includes('shesh')) {
        named = tokens.slice(Math.max(0, i - 3), i);
      }
    } else if (tokens[i] === 'after') {
      const classAt = tokens.slice(i + 1, i + 5).indexOf('class');
      if (classAt >= 0) named = tokens.slice(i + 1, i + 1 + classAt);
    }
    if (!named) continue;
    const course = findCourse(named, courses);
    return { kind: 'after_class', ...(course && { course }) };
  }
  return undefined;
}

const notInShortForm = new Set(['and', 'of', 'the', 'to', 'in', 'for', 'with', 'on', 'a', 'an']);

// A course is named by its code ("csc 4233"), a short form of its title ("ML" for Machine
// Learning, "OOP" for Object Oriented Programming 1) or one long title word ("algorithms").
// A word that fits two of today's courses says nothing, so only words that fit one count.
function findCourse(words: readonly string[], courses: readonly Course[]): string | undefined {
  const codesByKey = new Map<string, Set<string>>();
  for (const course of courses) {
    const title = tokenise(course.title).filter(
      (w) => /^\p{L}+$/u.test(w) && !/^[ivx]+$/.test(w) && w !== 'lab',
    );
    // Students say both "TC" and "TOC" for Theory of Computation
    const initials = (words: string[]) => words.map((w) => w[0]).join('');
    const shortForms = [initials(title.filter((w) => !notInShortForm.has(w))), initials(title)];
    const keys = [
      tokenise(course.code).join(' '),
      ...shortForms.filter((form) => form.length >= 2),
      ...title.filter((w) => w.length >= 4 && !notInShortForm.has(w)),
    ];
    for (const key of new Set(keys)) {
      const codes = codesByKey.get(key) ?? new Set<string>();
      codes.add(course.code);
      codesByKey.set(key, codes);
    }
  }
  const candidates = [...words, ...words.slice(1).map((w, i) => `${words[i]} ${w}`)];
  const found = new Set<string>();
  for (const candidate of candidates) {
    const codes = codesByKey.get(candidate);
    if (codes?.size === 1) found.add([...codes][0]!);
  }
  return found.size === 1 ? [...found][0] : undefined;
}
