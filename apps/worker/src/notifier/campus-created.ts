import { processedEvent, type Database } from '@pulse/db';
import type { CampusCreatedEvent } from '@pulse/events';
import { createJob, type NotifyEmailJob, type PulseJob } from '@pulse/jobs';
import { v5 as uuidV5 } from 'uuid';

// The consumer name in processed_event, and the Kafka consumer group
export const NOTIFIER = 'notifier';

// Job ids are UUID v5 of "<job type>:<event id>" in this namespace, so one event always makes
// the same job id. Any fixed UUID works; changing it would give old events new job ids
const JOB_ID_NAMESPACE = '04a385b8-ebe4-46e4-93c4-c6adcf584a14';

export interface NotifierDeps {
  // Connected as pulse_notifier
  db: Database;
  // Resolves only once RabbitMQ confirmed the job
  publish: (job: PulseJob) => Promise<void>;
  now: () => Date;
}

export type HandleResult = 'queued' | 'duplicate';

/** The email job for a new campus. Ids only: the email worker loads names when it sends. */
export function campusCreatedEmail(event: CampusCreatedEvent, createdAt: Date): NotifyEmailJob {
  const { campusId } = event.payload;
  return createJob(
    'notify.email',
    { template: 'campus-created', campusId },
    {
      jobId: uuidV5(`notify.email:${event.eventId}`, JOB_ID_NAMESPACE),
      dedupeKey: `campus-created:${campusId}`,
      createdAt,
    },
  );
}

/**
 * Queues the campus-created email once per event. The job is confirmed before the transaction
 * commits (D19): a crash in between sends it again on redelivery, never loses it.
 */
export async function handleCampusCreated(
  deps: NotifierDeps,
  event: CampusCreatedEvent,
): Promise<HandleResult> {
  return deps.db.transaction(async (tx) => {
    // No row back: another delivery of this event got here first. Never catch a 23505 inside a
    // transaction instead; the failed statement would abort the rest of it
    const recorded = await tx
      .insert(processedEvent)
      .values({ consumer: NOTIFIER, eventId: event.eventId })
      .onConflictDoNothing()
      .returning({ eventId: processedEvent.eventId });
    if (recorded.length === 0) return 'duplicate';

    // A throw here rolls the record back, so the event is tried again
    await deps.publish(campusCreatedEmail(event, deps.now()));
    return 'queued';
  });
}
