import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createEvent, parseEvent, routeFor, topics } from '../src/index.js';
import { aiubCreated, meta } from './fixtures.js';

describe('createEvent', () => {
  it('wraps the payload in an envelope with the current version', () => {
    expect(createEvent('CampusCreated', aiubCreated, meta)).toEqual({
      eventId: meta.eventId,
      type: 'CampusCreated',
      version: 1,
      occurredAt: '2026-10-31T08:30:00.000Z',
      payload: aiubCreated,
    });
  });

  // A bad event must fail where it is made, not later in a consumer on another machine
  it('throws on an invalid payload', () => {
    const bad = { ...aiubCreated, campusId: 'not-a-uuid' };
    expect(() => createEvent('CampusCreated', bad, meta)).toThrow();
  });

  it('throws on an invalid event id', () => {
    expect(() => createEvent('CampusCreated', aiubCreated, { ...meta, eventId: 'x' })).toThrow();
  });
});

describe('parseEvent', () => {
  const event = createEvent('CampusCreated', aiubCreated, meta);

  it('reads back an event that went through JSON', () => {
    expect(parseEvent(JSON.parse(JSON.stringify(event)))).toEqual({ kind: 'ok', event });
  });

  // A newer producer on a shared topic: the consumer skips these instead of dead-lettering them
  it('reports a type this code does not know as unknown', () => {
    expect(parseEvent({ ...event, type: 'CampusDeleted' })).toEqual({
      kind: 'unknown',
      type: 'CampusDeleted',
      version: 1,
    });
  });

  it('reports a version this code does not know as unknown', () => {
    expect(parseEvent({ ...event, version: 2 })).toEqual({
      kind: 'unknown',
      type: 'CampusCreated',
      version: 2,
    });
  });

  it.each(['constructor', 'toString', '__proto__'])(
    'treats the Object.prototype name %s as unknown, not known',
    (type) => {
      expect(parseEvent({ ...event, type }).kind).toBe('unknown');
    },
  );

  it('reports a known event with a broken payload as invalid', () => {
    const withoutSlug: Partial<typeof aiubCreated> = { ...aiubCreated };
    delete withoutSlug.slug;
    const result = parseEvent({ ...event, payload: withoutSlug });
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid')
      expect(result.error.issues[0]?.path).toEqual(['payload', 'slug']);
  });

  it('reports an over-long name as invalid', () => {
    const payload = { ...aiubCreated, name: 'x'.repeat(201) };
    expect(parseEvent({ ...event, payload }).kind).toBe('invalid');
  });

  it.each([null, 42, 'CampusCreated', [], { ...event, eventId: 'nope' }])(
    'reports %j as invalid instead of throwing',
    (raw) => {
      expect(parseEvent(raw).kind).toBe('invalid');
    },
  );

  // Logs print error.issues; they must never carry the payload a consumer received
  it('keeps input values out of the error issues', () => {
    const payload = { ...aiubCreated, name: 'secret-'.repeat(40) };
    const result = parseEvent({ ...event, payload });
    expect(result.kind).toBe('invalid');
    if (result.kind === 'invalid')
      expect(JSON.stringify(result.error.issues)).not.toContain('secret-');
  });
});

describe('routeFor', () => {
  it('sends CampusCreated to campuses, keyed by the campus id', () => {
    const event = createEvent('CampusCreated', aiubCreated, meta);
    expect(routeFor(event)).toEqual({ topic: 'campuses', key: aiubCreated.campusId });
  });

  // The key a route uses must be the payload field the topic table names
  it('uses the payload field named by the topic', () => {
    const event = createEvent('CampusCreated', aiubCreated, meta);
    const { topic, key } = routeFor(event);
    const spec = Object.values(topics).find((t) => t.name === topic);
    if (spec === undefined) throw new Error(`routeFor chose ${topic}, which is not in topics`);
    const payload: Record<string, unknown> = event.payload;
    expect(key).toBe(payload[spec.key]);
  });
});

const payloadArb = fc.record({
  campusId: fc.uuid(),
  name: fc.string({ minLength: 1, maxLength: 200 }),
  slug: fc.string({ minLength: 1, maxLength: 64 }),
  timezone: fc.string({ minLength: 1, maxLength: 64 }),
});
const metaArb = fc.record({
  eventId: fc.uuid(),
  occurredAt: fc.date({
    min: new Date('2000-01-01T00:00:00Z'),
    max: new Date('2100-01-01T00:00:00Z'),
    noInvalidDate: true,
  }),
});
// Fields a future producer might add; the x_ prefix keeps them apart from real ones
const extrasArb = fc.dictionary(
  fc.string({ minLength: 1 }).map((k) => `x_${k}`),
  fc.jsonValue(),
);

describe('properties', () => {
  it('any valid event survives JSON and parses back unchanged', () => {
    fc.assert(
      fc.property(payloadArb, metaArb, (payload, m) => {
        const event = createEvent('CampusCreated', payload, m);
        const result = parseEvent(JSON.parse(JSON.stringify(event)));
        expect(result).toEqual({ kind: 'ok', event });
      }),
    );
  });

  // Tolerant reader: today's consumer reads tomorrow's event, which has more fields
  it('fields added by a newer producer are ignored, the known ones still parse', () => {
    fc.assert(
      fc.property(payloadArb, metaArb, extrasArb, extrasArb, (payload, m, outer, inner) => {
        const event = createEvent('CampusCreated', payload, m);
        const newer = { ...outer, ...event, payload: { ...inner, ...event.payload } };
        const result = parseEvent(JSON.parse(JSON.stringify(newer)));
        expect(result).toEqual({ kind: 'ok', event });
      }),
    );
  });
});
