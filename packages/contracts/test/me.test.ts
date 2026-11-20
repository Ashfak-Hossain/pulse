import { describe, expect, it } from 'vitest';
import {
  apiErrorSchema,
  createTrustedContactSchema,
  createVehicleSchema,
  putPreferencesSchema,
  updateMeSchema,
  updateVehicleSchema,
} from '../src/index.js';

const preferences = {
  home: { lat: 23.8183, lng: 90.4209 },
  genderPref: 'same_gender',
  modes: ['cng', 'bus'],
  maxWaitMin: 10,
  maxDetourPct: 30,
  autopilotOn: false,
  dailyNotifyBudget: 6,
  shareTextForTraining: false,
};

describe('updateMeSchema', () => {
  it('accepts any one field, trims names and clears a phone with null', () => {
    expect(updateMeSchema.parse({ firstName: ' Nusrat ' })).toEqual({ firstName: 'Nusrat' });
    expect(updateMeSchema.parse({ phone: null })).toEqual({ phone: null });
  });

  it.each([
    ['an empty change', {}],
    ['a phone without the country code', { phone: '01711223344' }],
    ['a phone with spaces', { phone: '+880 1711 223344' }],
    ['a country code starting with 0', { phone: '+0123456789' }],
    ['an unknown gender', { gender: 'other' }],
    ['a cleared first name', { firstName: null }],
    ['a name with a hidden character', { firstName: 'Nus‮rat' }],
    ['an unknown key', { email: 'x@aiub.edu' }],
    ['a role', { role: 'campus_admin' }],
  ])('rejects %s', (_, body) => {
    expect(updateMeSchema.safeParse(body).success).toBe(false);
  });
});

describe('putPreferencesSchema', () => {
  it('accepts the whole set and has no quiet hours unless given', () => {
    expect(putPreferencesSchema.parse(preferences)).toEqual({ ...preferences, quietHours: null });
  });

  it.each([
    ['a wait over 60 minutes', { maxWaitMin: 61 }],
    ['a negative wait', { maxWaitMin: -1 }],
    ['a fractional wait', { maxWaitMin: 5.5 }],
    ['a detour over 50%', { maxDetourPct: 51 }],
    ['empty modes', { modes: [] }],
    ['an unknown mode', { modes: ['helicopter'] }],
    ['a repeated mode', { modes: ['cng', 'cng'] }],
    ['a notification budget of 0', { dailyNotifyBudget: 0 }],
    ['quiet hours in another format', { quietHours: { start: '10pm', end: '07:00' } }],
    ['a home off the globe', { home: { lat: 95, lng: 90 } }],
    ['an unknown key', { homeCell: '883cf13b03fffff' }],
  ])('rejects %s', (_, change) => {
    expect(putPreferencesSchema.safeParse({ ...preferences, ...change }).success).toBe(false);
  });

  it('rejects a body without every field', () => {
    for (const field of Object.keys(preferences)) {
      const partial: Record<string, unknown> = { ...preferences };
      delete partial[field];
      expect(putPreferencesSchema.safeParse(partial).success).toBe(false);
    }
  });
});

describe('vehicles and trusted contacts', () => {
  const car = { type: 'car', seats: 3, plate: 'DHAKA METRO GA 11-2233', color: 'White' };

  it('accepts a car and a bike with one seat, and refuses a bike with two', () => {
    expect(createVehicleSchema.safeParse(car).success).toBe(true);
    expect(createVehicleSchema.safeParse({ ...car, type: 'bike', seats: 1 }).success).toBe(true);
    expect(createVehicleSchema.safeParse({ ...car, type: 'bike', seats: 2 }).success).toBe(false);
    expect(createVehicleSchema.safeParse({ ...car, seats: 7 }).success).toBe(false);
    expect(updateVehicleSchema.safeParse({ type: 'bike', seats: 3 }).success).toBe(false);
    expect(updateVehicleSchema.safeParse({}).success).toBe(false);
  });

  it('accepts a contact in E.164 and refuses a long relation or an unknown key', () => {
    const contact = { name: 'Ayesha', phone: '+8801711000000', relation: 'mother' };
    expect(createTrustedContactSchema.parse(contact)).toEqual(contact);
    expect(
      createTrustedContactSchema.safeParse({ ...contact, relation: 'x'.repeat(41) }).success,
    ).toBe(false);
    expect(createTrustedContactSchema.safeParse({ ...contact, slot: 2 }).success).toBe(false);
  });
});

describe('apiErrorSchema code', () => {
  it('allows an upper-case code and nothing else', () => {
    const base = { statusCode: 422, error: 'Unprocessable Entity', message: 'At most three' };
    expect(apiErrorSchema.safeParse({ ...base, code: 'TRUSTED_CONTACT_LIMIT' }).success).toBe(true);
    expect(apiErrorSchema.safeParse({ ...base, code: 'limit reached' }).success).toBe(false);
  });
});
