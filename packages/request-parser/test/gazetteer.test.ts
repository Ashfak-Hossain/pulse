import { latLngToCell } from 'h3-js';
import { describe, expect, it } from 'vitest';
import { aiubGazetteer, findPlaces } from '../src/gazetteer.js';
import { tokenise } from '../src/tokenise.js';

describe('aiubGazetteer', () => {
  it('lists at least 30 places', () => {
    expect(aiubGazetteer.length).toBeGreaterThanOrEqual(30);
  });

  it.each(aiubGazetteer.map((place) => [place.name, place] as const))(
    'stores the resolution 8 cell of %s',
    (_, place) => {
      expect(place.cell).toBe(latLngToCell(place.lat, place.lng, 8));
    },
  );

  it('gives every alias to one place only', () => {
    const aliases = aiubGazetteer.flatMap((place) =>
      place.aliases.map((a) => tokenise(a).join(' ')),
    );
    expect(new Set(aliases).size).toBe(aliases.length);
  });

  it('keeps every place within 15 km of AIUB', () => {
    // A typo in lat/lng would put a place in another city
    for (const { lat, lng } of aiubGazetteer) {
      expect(Math.abs(lat - 23.8213)).toBeLessThan(0.14);
      expect(Math.abs(lng - 90.4271)).toBeLessThan(0.14);
    }
  });
});

describe('findPlaces', () => {
  const names = (text: string) => findPlaces(tokenise(text)).map((m) => m.place.name);

  it('prefers the longest name: mirpur 10 over mirpur', () => {
    expect(names('mirpur 10 jabo')).toEqual(['Mirpur 10']);
    expect(names('mirpur jabo')).toEqual(['Mirpur']);
  });

  it.each(['Mirpur-10', 'mirpur10', 'MIRPUR TEN', 'mirpur section 10'])(
    'reads %s as Mirpur 10',
    (text) => {
      expect(names(text)).toEqual(['Mirpur 10']);
    },
  );

  it('finds places left to right', () => {
    expect(names('banani theke uttara sector 10')).toEqual(['Banani', 'Uttara Sector 10']);
  });

  it('matches whole words only', () => {
    expect(names('bananis')).toEqual([]);
  });
});
