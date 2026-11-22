import { describe, expect, it } from 'vitest';
import { parseRequest } from '../src/index.js';

const clock = (text: string) => {
  const ref = parseRequest(text).timeRef;
  return ref?.kind === 'clock' ? ref.time : undefined;
};

describe('parseRequest time', () => {
  it.each([
    ['5 tay', '17:00'], // a bare 1 to 7 is afternoon or evening
    ['7 tay', '19:00'],
    ['8 tay', '08:00'], // 8 to 12 is taken as written
    ['12 tay', '12:00'],
    ['sokal 7 tay', '07:00'], // am overrides the rule
    ['raat 10 tay', '22:00'],
    ['at 12 am', '00:00'],
    ['5 ta baje', '17:00'],
    ['sare 4 tay', '16:30'],
    ['poune 8 tay', '07:45'], // a quarter to 8, not to 20
    ['poune 6 tay', '17:45'],
    ['arai tay', '14:30'],
    ['at 18:20', '18:20'],
    ['5.30', '17:30'],
  ])('reads %s as %s', (text, time) => {
    expect(clock(text)).toBe(time);
  });

  it.each(['at 25', '24:00', '5:75', '10 min', 'at 10 min', 'mirpur 10', '2 jon', '5'])(
    'finds no clock time in %s',
    (text) => {
      expect(clock(text)).toBeUndefined();
    },
  );

  it('picks a clock time over "after class" and lowers confidence for the clash', () => {
    const parsed = parseRequest('class er por 5 tay mirpur jabo');
    expect(parsed.timeRef).toEqual({ kind: 'clock', time: '17:00' });
    expect(parsed.confidence).toBe(0.83);
  });

  it("only names a course that fits one of today's courses", () => {
    const courses = [
      { code: 'CSC1', title: 'Programming Language 1' },
      { code: 'CSC2', title: 'Programming Language 2' },
    ];
    expect(parseRequest('programming class er por jabo', { courses }).timeRef).toEqual({
      kind: 'after_class',
    });
  });
});

describe('parseRequest direction', () => {
  it.each([
    ['campus theke mirpur', 'from_campus'],
    ['from campus to mirpur', 'from_campus'],
    ['mirpur theke campus jabo', 'to_campus'], // "campus jabo" wins over a bare jabo
    ['going to campus', 'to_campus'],
    ['basa theke ashbo', 'to_campus'],
    ['basay jabo', 'from_campus'],
    ['banani theke', 'to_campus'],
    ['ashbo', 'to_campus'],
    ['jabo', 'from_campus'],
    ['after class banani', 'from_campus'],
  ] as const)('reads %s as %s', (text, direction) => {
    expect(parseRequest(text).direction).toBe(direction);
  });

  it('leaves the direction out when nothing names it', () => {
    expect(parseRequest('banani 5 tay').direction).toBeUndefined();
  });
});

describe('parseRequest preferences', () => {
  it.each([
    ['shudhu meye rider', 'same_gender'],
    ['meye rider only', 'same_gender'],
    ['only male', 'same_gender'],
    ['any gender', 'any'],
    ['anyone going to banani', undefined],
    ['i am a girl', undefined],
  ] as const)('reads %s as %s', (text, genderPref) => {
    expect(parseRequest(text).genderPref).toBe(genderPref);
  });

  it.each([
    ['10 min wait', 10],
    ['wait 15 minute', 15],
    ['adha ghonta opekkha', 30],
    ['1 hour wait', 60],
    ['2 hour wait', 60], // capped
    ['no wait', 0],
    ["can't wait", 0],
    ['10 min lagbe', undefined],
  ] as const)('reads %s as a %s minute wait', (text, wait) => {
    expect(parseRequest(text).maxWaitMin).toBe(wait);
  });

  it('lists modes once each, in the order written', () => {
    expect(parseRequest('rickshaw or cng or riksha, uber, pathao, bus').modes).toEqual([
      'rickshaw',
      'cng',
      'ride_hail_car',
      'bus',
    ]);
  });

  it('tells an own car from a ride-hail car', () => {
    expect(parseRequest('amar car').modes).toEqual(['own_car']);
    expect(parseRequest('car nibo').modes).toEqual(['ride_hail_car']);
  });
});
