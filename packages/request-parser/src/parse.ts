import { findPlaces, type GazetteerPlace, type PlaceMatch } from './gazetteer.js';
import { hasRun, range, tokenise } from './tokenise.js';
import { findTimes, type TimeRef } from './time.js';

// Same shape as parsedRequestSchema in @pulse/contracts. This package stays pure, so it declares
// the type itself; the tests check every result against the shared schema.
export type TravelMode =
  'cng' | 'rickshaw' | 'ride_hail_car' | 'own_car' | 'own_bike' | 'bus' | 'shuttle';
export interface ParsedRequest {
  direction?: 'to_campus' | 'from_campus';
  place?: { name: string; cell: string };
  timeRef?: TimeRef;
  genderPref?: 'any' | 'same_gender';
  maxWaitMin?: number;
  modes?: TravelMode[];
  /** Share of direction, place and time found, lowered when two places or two times match */
  confidence: number;
}

export interface ParseContext {
  /** The user's sections today, so "ML class" can become a course code */
  courses?: readonly { code: string; title: string }[];
  /** The caller's campus places (gazetteerFor(slug)); AIUB's when left out */
  gazetteer?: readonly GazetteerPlace[];
}

/**
 * Reads a ride request written the way students talk, in English or Banglish:
 * "ML class er por Mirpur 10 jabo, shudhu meye rider" → direction, place, time and preferences.
 * Rule-based, so every answer can be explained; the trained model (wave 3) must beat it.
 * Pure: it never reads the clock, so times come back as references the API resolves.
 */
export function parseRequest(text: string, context: ParseContext = {}): ParsedRequest {
  const tokens = tokenise(text);
  const places = findPlaces(tokens, context.gazetteer);
  // A number inside a place name ("mirpur 10") is never a time or a wait
  const inPlace = new Set(places.flatMap((m) => range(m.start, m.end)));
  const times = findTimes(tokens, inPlace, context.courses ?? []);

  const result: Omit<ParsedRequest, 'confidence'> = {};
  const direction = findDirection(tokens, places, times.afterClass);
  if (direction) result.direction = direction;
  const place = places[0]?.place;
  if (place) result.place = { name: place.name, cell: place.cell };
  if (times.chosen) result.timeRef = times.chosen;
  const genderPref = findGenderPref(tokens);
  if (genderPref) result.genderPref = genderPref;
  const maxWaitMin = findMaxWait(tokens, inPlace);
  if (maxWaitMin !== undefined) result.maxWaitMin = maxWaitMin;
  const modes = findModes(tokens);
  if (modes.length > 0) result.modes = modes;

  // Each of the three fields a ride needs is worth a third; each clash costs a sixth
  const found = [result.direction, result.place, result.timeRef].filter(Boolean).length;
  const placeClash = new Set(places.map((m) => m.place.name)).size > 1;
  const score = found / 3 - (placeClash ? 1 / 6 : 0) - (times.clash ? 1 / 6 : 0);
  const confidence = Math.round(Math.min(1, Math.max(0, score)) * 100) / 100;
  return { ...result, confidence };
}

// The first rule that fits wins, most specific first: "campus theke" and "to campus" say the
// direction outright, a bare "jabo" or "ashbo" only hints at it.
function findDirection(
  tokens: readonly string[],
  places: readonly PlaceMatch[],
  afterClass: boolean,
): ParsedRequest['direction'] {
  const at = (i: number) => tokens[i];
  const indexes = (word: string) => range(0, tokens.length).filter((i) => tokens[i] === word);
  const has = (word: string) => tokens.includes(word);
  const campus = indexes('campus');
  const home = indexes('home');

  if (campus.some((i) => at(i + 1) === 'theke' || at(i - 1) === 'from')) return 'from_campus';
  const toCampus = ['e', 'tay', 'a', 'y', 'jabo', 'going'];
  if (campus.some((i) => at(i - 1) === 'to' || toCampus.includes(at(i + 1) ?? ''))) {
    return 'to_campus';
  }
  if (campus.length > 0 && (has('ashbo') || has('coming'))) return 'to_campus';
  if (home.some((i) => at(i + 1) === 'theke' || at(i - 1) === 'from')) return 'to_campus';
  if (home.length > 0) return 'from_campus';
  if (places.some((m) => at(m.end) === 'theke' || at(m.start - 1) === 'from')) return 'to_campus';
  if (has('ashbo') || has('coming')) return 'to_campus';
  if (has('jabo') || has('going')) return 'from_campus';
  // "class er por Mirpur 10": after class, students leave campus
  return afterClass ? 'from_campus' : undefined;
}

function findGenderPref(tokens: readonly string[]): ParsedRequest['genderPref'] {
  const near = (i: number, word: string) => tokens.slice(Math.max(0, i - 2), i + 3).includes(word);
  const gendered = tokens.some((w, i) => (w === 'female' || w === 'male') && near(i, 'only'));
  if (gendered || hasRun(tokens, ['same', 'gender'])) return 'same_gender';
  // Not "anyone": "anyone going to Banani?" asks for riders, not about gender
  const anyGender = hasRun(tokens, ['any', 'gender']) || hasRun(tokens, ['gender', 'any']);
  return anyGender || tokens.includes('mixed') ? 'any' : undefined;
}

// "10 min wait", "wait 15 minute", "adha ghonta opekkha": an amount of time with a wait word
// within three words of it. "No wait" means 0. Longer than an hour is capped at 60.
function findMaxWait(tokens: readonly string[], inPlace: ReadonlySet<number>): number | undefined {
  if (hasRun(tokens, ['no', 'wait']) || hasRun(tokens, ['cant', 'wait'])) return 0;
  if (hasRun(tokens, ['can', 't', 'wait'])) return 0;
  for (let i = 0; i < tokens.length; i++) {
    const amount = amountAt(tokens, i, inPlace);
    if (amount === undefined) continue;
    const around = tokens.slice(Math.max(0, i - 3), i + 2 + 3);
    if (around.includes('wait')) return Math.min(60, amount);
  }
  return undefined;
}

function amountAt(
  tokens: readonly string[],
  i: number,
  inPlace: ReadonlySet<number>,
): number | undefined {
  const word = tokens[i] ?? '';
  const next = tokens[i + 1];
  if (word === 'half' && next === 'hour') return 30;
  if (!/^\d{1,3}$/.test(word) || inPlace.has(i)) return undefined;
  if (next === 'min') return Number(word);
  if (next === 'hour') return Number(word) * 60;
  return undefined;
}

function findModes(tokens: readonly string[]): TravelMode[] {
  const modes = new Set<TravelMode>();
  tokens.forEach((word, i) => {
    const mine = tokens[i - 1] === 'mine';
    if (word === 'cng') modes.add('cng');
    else if (word === 'rickshaw') modes.add('rickshaw');
    else if (word === 'uber') modes.add('ride_hail_car');
    else if (word === 'bus') modes.add('bus');
    else if (word === 'shuttle') modes.add('shuttle');
    else if (word === 'car') modes.add(mine ? 'own_car' : 'ride_hail_car');
    else if (word === 'bike' && mine) modes.add('own_bike');
  });
  return [...modes];
}
