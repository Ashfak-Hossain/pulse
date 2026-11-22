import { describe, expect, it } from 'vitest';
import { parsedRequestSchema } from '../src/index.js';

describe('parsedRequestSchema', () => {
  it.each([
    { confidence: 0 },
    {
      direction: 'from_campus',
      place: { name: 'Mirpur 10', cell: '883c2a2c6dfffff' },
      timeRef: { kind: 'after_class', course: 'CSC4233' },
      genderPref: 'same_gender',
      maxWaitMin: 60,
      modes: ['cng', 'ride_hail_car'],
      confidence: 1,
    },
    { direction: 'to_campus', timeRef: { kind: 'clock', time: '17:30' }, confidence: 0.5 },
    { timeRef: { kind: 'now' }, genderPref: 'any', maxWaitMin: 0, confidence: 0.33 },
  ])('accepts a parsed request: %o', (parsed) => {
    expect(parsedRequestSchema.parse(parsed)).toEqual(parsed);
  });

  it.each([
    {},
    { confidence: -0.1 },
    { confidence: 1.1 },
    { direction: 'home', confidence: 0.5 },
    { place: { name: 'Mirpur 10', cell: 'not-a-cell' }, confidence: 0.5 },
    { place: { name: '', cell: '883c2a2c6dfffff' }, confidence: 0.5 },
    { timeRef: { kind: 'clock', time: '24:00' }, confidence: 0.5 },
    { timeRef: { kind: 'clock', time: '5:30' }, confidence: 0.5 },
    { timeRef: { kind: 'later' }, confidence: 0.5 },
    { maxWaitMin: 61, confidence: 0.5 },
    { maxWaitMin: 2.5, confidence: 0.5 },
    { modes: [], confidence: 0.5 },
    { modes: ['helicopter'], confidence: 0.5 },
    { confidence: 0.5, text: 'never echoed back' },
  ])('rejects %o', (parsed) => {
    expect(parsedRequestSchema.safeParse(parsed).success).toBe(false);
  });
});
