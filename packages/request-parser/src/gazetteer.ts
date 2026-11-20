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

// Each alias as canonical tokens, longest first, so "mirpur 10" wins over "mirpur"
const aliasIndex = aiubGazetteer
  .flatMap((place) => place.aliases.map((alias) => ({ place, tokens: tokenise(alias) })))
  .sort((a, b) => b.tokens.length - a.tokens.length);

/** Every place named in the tokens, left to right; overlapping names keep the longest one. */
export function findPlaces(tokens: readonly string[]): PlaceMatch[] {
  const taken = new Array<boolean>(tokens.length).fill(false);
  const matches: PlaceMatch[] = [];
  for (const { place, tokens: alias } of aliasIndex) {
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
