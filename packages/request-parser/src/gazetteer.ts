import aiub from './gazetteer/aiub.json' with { type: 'json' };
import { tokenise } from './tokenise.js';

export interface GazetteerPlace {
  name: string;
  aliases: string[];
  lat: number;
  lng: number;
  /** H3 cell at resolution 8, computed once from lat/lng and committed (see the gazetteer test) */
  cell: string;
}

export interface PlaceMatch {
  place: GazetteerPlace;
  /** Index of the alias's first token in the tokenised text */
  start: number;
  end: number;
}

// Public places near AIUB. Other campuses get their own file later.
export const aiubGazetteer: readonly GazetteerPlace[] = aiub;

const byCampusSlug: Readonly<Record<string, readonly GazetteerPlace[]>> = { aiub: aiubGazetteer };

/** The places a campus's students name, by campus slug. A campus with no list yet gets none. */
export function gazetteerFor(campusSlug: string): readonly GazetteerPlace[] {
  return Object.hasOwn(byCampusSlug, campusSlug) ? byCampusSlug[campusSlug]! : [];
}

type AliasIndex = { place: GazetteerPlace; tokens: string[] }[];
const indexes = new WeakMap<readonly GazetteerPlace[], AliasIndex>();

/** Every place named in the tokens, left to right; overlapping names keep the longest one. */
export function findPlaces(
  tokens: readonly string[],
  gazetteer: readonly GazetteerPlace[] = aiubGazetteer,
): PlaceMatch[] {
  const taken = new Array<boolean>(tokens.length).fill(false);
  const matches: PlaceMatch[] = [];
  for (const { place, tokens: alias } of aliasIndexOf(gazetteer)) {
    for (let start = 0; start + alias.length <= tokens.length; start++) {
      const end = start + alias.length;
      const fits = alias.every((word, i) => tokens[start + i] === word && !taken[start + i]);
      if (!fits) continue;
      taken.fill(true, start, end);
      matches.push({ place, start, end });
    }
  }
  return matches.sort((a, b) => a.start - b.start);
}

// Each alias as canonical tokens, longest first, so "mirpur 10" wins over "mirpur". Built once
// per gazetteer and kept while the gazetteer lives
function aliasIndexOf(gazetteer: readonly GazetteerPlace[]): AliasIndex {
  let index = indexes.get(gazetteer);
  if (!index) {
    index = gazetteer
      .flatMap((place) => place.aliases.map((alias) => ({ place, tokens: tokenise(alias) })))
      .sort((a, b) => b.tokens.length - a.tokens.length);
    indexes.set(gazetteer, index);
  }
  return index;
}
