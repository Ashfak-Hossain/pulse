import { randomUUID } from 'node:crypto';
import { createDb, eq, processedEvent } from '@pulse/db';
import { createEvent, type CampusCreatedEvent } from '@pulse/events';
import type { PulseJob } from '@pulse/jobs';
import { inject } from 'vitest';
import {
  campusCreatedEmail,
  handleCampusCreated,
  NOTIFIER,
  type NotifierDeps,
} from '../src/notifier/campus-created.js';

const owner = createDb(inject('ownerUrl'));
const notifier = createDb(inject('notifierUrl'));
const now = new Date('2026-11-05T10:00:00Z');

afterAll(async () => {
  await Promise.all([owner.$client.end(), notifier.$client.end()]);
});

function campusCreatedEvent(): CampusCreatedEvent {
  return createEvent(
    'CampusCreated',
    { campusId: randomUUID(), name: 'AIUB', slug: 'aiub', timezone: 'Asia/Dhaka' },
    { eventId: randomUUID(), occurredAt: now },
  );
}

// What the owner (outside the handler's transaction) sees for this event
async function recorded(event: CampusCreatedEvent): Promise<string[]> {
  const rows = await owner
    .select({ consumer: processedEvent.consumer })
    .from(processedEvent)
    .where(eq(processedEvent.eventId, event.eventId));
  return rows.map((row) => row.consumer);
}

function deps(publish: NotifierDeps['publish']): NotifierDeps {
  return { db: notifier, publish, now: () => now };
}

describe('handleCampusCreated, as pulse_notifier', () => {
  it('queues the campus-created email and records the event', async () => {
    const event = campusCreatedEvent();
    const published: PulseJob[] = [];
    const result = await handleCampusCreated(
      deps((job) => {
        published.push(job);
        return Promise.resolve();
      }),
      event,
    );
    expect(result).toBe('queued');
    expect(published).toEqual([campusCreatedEmail(event, now)]);
    expect(await recorded(event)).toEqual([NOTIFIER]);
  });

  it('queues nothing for an event it handled before', async () => {
    const event = campusCreatedEvent();
    const publish = vi.fn(() => Promise.resolve());
    await handleCampusCreated(deps(publish), event);
    expect(await handleCampusCreated(deps(publish), event)).toBe('duplicate');
    expect(publish).toHaveBeenCalledTimes(1);
  });

  // D19: the job is confirmed before the record commits. A crash in between sends the job
  // again on redelivery (the email worker dedupes); the other order could lose it
  it('publishes while the record is not yet committed', async () => {
    const event = campusCreatedEvent();
    let seenDuringPublish: string[] | undefined;
    await handleCampusCreated(
      deps(async () => {
        seenDuringPublish = await recorded(event);
      }),
      event,
    );
    expect(seenDuringPublish).toEqual([]);
    expect(await recorded(event)).toEqual([NOTIFIER]);
  });

  it('records nothing when the publish fails, so the redelivered event runs again', async () => {
    const event = campusCreatedEvent();
    await expect(
      handleCampusCreated(
        deps(() => Promise.reject(new Error('RabbitMQ nacked job notify.email'))),
        event,
      ),
    ).rejects.toThrow(/nacked/);
    expect(await recorded(event)).toEqual([]);

    const publish = vi.fn(() => Promise.resolve());
    expect(await handleCampusCreated(deps(publish), event)).toBe('queued');
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
