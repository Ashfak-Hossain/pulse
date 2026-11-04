import { randomUUID } from 'node:crypto';
import { createEvent } from '@pulse/events';
import { decodeRecord, MAX_RECORD_BYTES } from './decode.js';

const event = createEvent(
  'CampusCreated',
  { campusId: randomUUID(), name: 'AIUB', slug: 'aiub', timezone: 'Asia/Dhaka' },
  { eventId: randomUUID(), occurredAt: new Date('2026-11-05T10:00:00Z') },
);
const bytes = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));

describe('decodeRecord', () => {
  it('reads a valid event', () => {
    expect(decodeRecord(bytes(event))).toEqual({ kind: 'ok', event });
  });

  // A newer producer may know events this worker does not: skip them, never crash
  it('reports an event type or version it does not know', () => {
    expect(decodeRecord(bytes({ ...event, type: 'CampusRenamed' }))).toEqual({
      kind: 'unknown',
      type: 'CampusRenamed',
      version: 1,
    });
    expect(decodeRecord(bytes({ ...event, version: 2 }))).toMatchObject({ kind: 'unknown' });
  });

  it.each([
    ['an empty record', Buffer.alloc(0)],
    ['a tombstone (no value)', null],
    ['text that is not JSON', Buffer.from('{"eventId":')],
    ['JSON that is not an event', bytes([1, 2, 3])],
    ['a known event with a bad payload', bytes({ ...event, payload: { campusId: 'x' } })],
  ])('rejects %s', (_case, value) => {
    expect(decodeRecord(value)).toMatchObject({ kind: 'invalid' });
  });

  // Checked before JSON.parse, so a huge record costs no parse time
  it('rejects a record over the size limit without reading it', () => {
    const parse = vi.spyOn(JSON, 'parse');
    expect(decodeRecord(Buffer.alloc(MAX_RECORD_BYTES + 1, 0x20))).toEqual({
      kind: 'invalid',
      reason: `larger than ${MAX_RECORD_BYTES} bytes`,
    });
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });

  // The reason goes into logs, which must never hold event data (names, ids of people)
  it('gives a reason with field paths and rule codes, never the values', () => {
    const secret = 'Secret Campus Name';
    const result = decodeRecord(
      bytes({ ...event, payload: { ...event.payload, name: secret, slug: 7 } }),
    );
    expect(result).toEqual({ kind: 'invalid', reason: 'payload.slug: invalid_type' });
    expect(JSON.stringify(decodeRecord(Buffer.from(`{"name":"${secret}"`)))).not.toContain(secret);
  });
});
