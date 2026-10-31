import { describe, expect, it } from 'vitest';
import { eventEnvelopeSchema } from '../src/index.js';
import { meta } from './fixtures.js';

const valid = {
  eventId: meta.eventId,
  type: 'SomethingHappened',
  version: 1,
  occurredAt: '2026-10-31T08:30:00.000Z',
  payload: { anything: true },
};

describe('eventEnvelopeSchema', () => {
  it('accepts a well-formed envelope', () => {
    expect(eventEnvelopeSchema.parse(valid)).toEqual(valid);
  });

  it('accepts a time with an offset', () => {
    const local = { ...valid, occurredAt: '2026-10-31T14:30:00+06:00' };
    expect(eventEnvelopeSchema.safeParse(local).success).toBe(true);
  });

  it.each([
    ['eventId is not a uuid', { eventId: 'not-a-uuid' }],
    ['type is empty', { type: '' }],
    ['version is 0', { version: 0 }],
    ['version is a fraction', { version: 1.5 }],
    ['occurredAt is not ISO 8601', { occurredAt: '31/10/2026 08:30' }],
    ['occurredAt has no zone', { occurredAt: '2026-10-31T08:30:00' }],
  ])('rejects an envelope whose %s', (_case, change) => {
    expect(eventEnvelopeSchema.safeParse({ ...valid, ...change }).success).toBe(false);
  });

  it.each(['eventId', 'type', 'version', 'occurredAt', 'payload'])('requires %s', (field) => {
    const rest: Record<string, unknown> = { ...valid };
    delete rest[field];
    expect(eventEnvelopeSchema.safeParse(rest).success).toBe(false);
  });

  // Tolerant reader: a newer producer may add envelope fields an older consumer does not know
  it('ignores unknown fields instead of rejecting them', () => {
    const result = eventEnvelopeSchema.safeParse({ ...valid, traceId: 'abc' });
    expect(result.success).toBe(true);
  });
});
