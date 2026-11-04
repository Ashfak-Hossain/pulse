import { randomUUID } from 'node:crypto';
import { createEvent, type CampusCreatedEvent } from '@pulse/events';
import { notifyEmailJobSchema } from '@pulse/jobs';
import { campusCreatedEmail } from './campus-created.js';

const createdAt = new Date('2026-11-05T10:00:00Z');

function campusCreatedEvent(campusId = randomUUID()): CampusCreatedEvent {
  return createEvent(
    'CampusCreated',
    { campusId, name: 'AIUB', slug: 'aiub', timezone: 'Asia/Dhaka' },
    { eventId: randomUUID(), occurredAt: createdAt },
  );
}

describe('campusCreatedEmail', () => {
  it('asks for the campus-created email by id, never with names or addresses', () => {
    const event = campusCreatedEvent();
    const job = campusCreatedEmail(event, createdAt);
    expect(notifyEmailJobSchema.parse(job)).toEqual(job);
    expect(job).toMatchObject({
      type: 'notify.email',
      dedupeKey: `campus-created:${event.payload.campusId}`,
      createdAt: createdAt.toISOString(),
      payload: { template: 'campus-created', campusId: event.payload.campusId },
    });
    expect(JSON.stringify(job)).not.toContain('AIUB');
  });

  // A redelivered event makes the same job, so logs and the email worker's dedupe line up
  it('makes the same job id from the same event, every time', () => {
    const event = campusCreatedEvent();
    const later = new Date('2026-11-06T10:00:00Z');
    expect(campusCreatedEmail(event, later).jobId).toBe(campusCreatedEmail(event, createdAt).jobId);
    expect(campusCreatedEmail(event, createdAt).jobId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5/);
  });

  it('makes a different job id for a different event, even for the same campus', () => {
    const campusId = randomUUID();
    const first = campusCreatedEmail(campusCreatedEvent(campusId), createdAt);
    const second = campusCreatedEmail(campusCreatedEvent(campusId), createdAt);
    expect(first.jobId).not.toBe(second.jobId);
    expect(first.dedupeKey).toBe(second.dedupeKey);
  });
});
