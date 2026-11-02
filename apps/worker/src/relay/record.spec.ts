import { eventEnvelopeSchema } from '@pulse/events';
import { toRecord, type OutboxRow } from './record.js';

const row: OutboxRow = {
  id: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b',
  type: 'CampusCreated',
  version: 1,
  topic: 'campuses',
  key: '0b1c2d3e-4f50-4a6b-8c7d-8e9f0a1b2c3d',
  payload: { campusId: '0b1c2d3e-4f50-4a6b-8c7d-8e9f0a1b2c3d', name: 'AIUB' },
  createdAt: new Date('2026-11-02T08:30:00.000Z'),
};

const topics = new Set(['campuses']);

describe('toRecord', () => {
  it('sends the row to its own topic and key', () => {
    const record = toRecord(row, topics);
    expect(record.topic).toBe('campuses');
    expect(record.key).toBe(row.key);
  });

  it('wraps the payload in the event envelope, with the row id as eventId', () => {
    const value: unknown = JSON.parse(toRecord(row, topics).value);
    expect(value).toEqual({
      eventId: row.id,
      type: 'CampusCreated',
      version: 1,
      occurredAt: '2026-11-02T08:30:00.000Z',
      payload: row.payload,
    });
    expect(eventEnvelopeSchema.safeParse(value).success).toBe(true);
  });

  it('puts eventId and type in headers, so consumers can skip without parsing the value', () => {
    expect(toRecord(row, topics).headers).toEqual({ eventId: row.id, type: 'CampusCreated' });
  });

  it.each([
    ['an empty type', { type: '' }],
    ['version 0', { version: 0 }],
    ['an id that is not a UUID', { id: 'not-a-uuid' }],
  ])('refuses a row with %s', (_case, change) => {
    expect(() => toRecord({ ...row, ...change }, topics)).toThrow(/not a valid event envelope/);
  });

  it('refuses a topic outside the list', () => {
    expect(() => toRecord({ ...row, topic: 'profiles' }, topics)).toThrow(/unknown topic/);
  });

  it('names the row in the error but never its payload', () => {
    const secret = { ...row, type: '', payload: { email: 'test.student@example.edu' } };
    let message = '';
    try {
      toRecord(secret, topics);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(row.id);
    expect(message).not.toContain('test.student@example.edu');
  });
});
