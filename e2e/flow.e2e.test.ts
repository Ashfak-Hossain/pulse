import { randomUUID } from 'node:crypto';
import {
  and,
  createDb,
  emailDelivery,
  eq,
  outboxEvent,
  processedEvent,
  sql,
  type Database,
} from '@pulse/db';
import { inject, vi } from 'vitest';
import { emailsWithSubject } from './support/mailpit.js';
import { freePort, startApp, type LogLine, type RunningApp } from './support/processes.js';

// The whole backbone with the real programs: POST /admin/campuses on the built API → outbox →
// relay → Kafka → notifier → RabbitMQ → mailer → Mailpit. Then two crashes are replayed by
// putting the database back the way the crash would have left it, and the email still goes out
// once. The cases run in order and share one campus.

const adminToken = 'e2e-admin-token-not-a-secret-0123456789abcdef';
const opsMailTo = 'ops@pulse.test';
const run = randomUUID().slice(0, 8);
const newCampus = {
  name: `Flow ${run}`,
  slug: `flow-${run}`,
  emailDomains: [`flow-${run}.pulse.test`],
  timezone: 'Asia/Dhaka',
  location: { lat: 23.8223, lng: 90.4274 },
};
const subject = `New campus on Pulse: ${newCampus.name}`;

let owner: Database;
let api: RunningApp;
let worker: RunningApp;
let apiUrl: string;
// Filled by the first case
let campusId: string;
let eventId: string;
let jobId: unknown;

const hasMessage =
  (message: string) =>
  (line: LogLine): boolean =>
    line.msg === message;

beforeAll(async () => {
  owner = createDb(inject('ownerUrl'));
  worker = startApp('worker', {
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    KAFKA_BROKERS: inject('kafkaBrokers').join(','),
    KAFKA_REPLICATION_FACTOR: '1',
    KAFKA_MIN_INSYNC_REPLICAS: '1',
    RELAY_DATABASE_URL: inject('relayUrl'),
    RELAY_POLL_MS: '100',
    NOTIFIER_DATABASE_URL: inject('notifierUrl'),
    MAILER_DATABASE_URL: inject('mailerUrl'),
    AMQP_URL: inject('amqpUrl'),
    SMTP_URL: inject('smtpUrl'),
    MAIL_FROM: 'noreply@pulse.test',
    OPS_MAIL_TO: opsMailTo,
  });
  const port = await freePort();
  apiUrl = `http://127.0.0.1:${port}`;
  api = startApp('api', {
    HOST: '127.0.0.1',
    PORT: String(port),
    DATABASE_URL: inject('appUrl'),
    ADMIN_TOKEN: adminToken,
  });
  // The worker starts the notifier after Kafka topics and RabbitMQ are ready, so it is "ready"
  await Promise.all([
    worker.waitForLine(hasMessage('Notifier started')),
    api.waitForHttp(`${apiUrl}/health/ready`),
  ]);
});

afterAll(async () => {
  await Promise.allSettled([api?.stop(), worker?.stop()]);
  await owner?.$client.end();
});

// Back to how the row looked before the relay marked it: the relay sends the event again
async function unpublishOutboxRow(): Promise<void> {
  await owner.update(outboxEvent).set({ publishedAt: null }).where(eq(outboxEvent.id, eventId));
}

/**
 * Where every case must end: the row published again (or the relay would resend it forever),
 * the event recorded once, one sent delivery for the first job, and one email in Mailpit.
 */
async function expectHandledOnce(): Promise<void> {
  await vi.waitFor(async () => {
    const [row] = await owner
      .select({ publishedAt: outboxEvent.publishedAt })
      .from(outboxEvent)
      .where(eq(outboxEvent.id, eventId));
    expect(row?.publishedAt).toBeInstanceOf(Date);
  });
  const processed = await owner
    .select()
    .from(processedEvent)
    .where(eq(processedEvent.eventId, eventId));
  expect(processed).toHaveLength(1);
  const deliveries = await owner
    .select({ status: emailDelivery.status, jobId: emailDelivery.jobId })
    .from(emailDelivery)
    .where(eq(emailDelivery.dedupeKey, `campus-created:${campusId}`));
  expect(deliveries).toEqual([{ status: 'sent', jobId }]);
  const emails = await emailsWithSubject(subject);
  expect(emails).toHaveLength(1);
  expect(emails[0]?.To.map((to) => to.Address)).toEqual([opsMailTo]);
}

describe('a new campus, from the API to one email', () => {
  it('sends exactly one email for a campus created through the API', async () => {
    const response = await fetch(`${apiUrl}/admin/campuses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(newCampus),
    });
    expect(response.status).toBe(201);
    campusId = ((await response.json()) as { id: string }).id;

    const sent = await worker.waitForLine(hasMessage('Email sent'));
    jobId = sent.jobId;
    // The outbox row's id is the event id (the relay sends it as eventId)
    const [row] = await owner
      .select({ id: outboxEvent.id })
      .from(outboxEvent)
      .where(sql`${outboxEvent.payload}->>'campusId' = ${campusId}`);
    eventId = row?.id ?? '';
    expect(eventId).not.toBe('');
    await expectHandledOnce();
  });

  // The relay crashed after Kafka took the record but before it marked the row published
  it('skips the event when the relay sends it again', async () => {
    const from = worker.lines.length;
    await unpublishOutboxRow();

    const skipped = await worker.waitForLine(hasMessage('Skipped an event already handled'), from);
    expect(skipped).toMatchObject({ eventId, type: 'CampusCreated', result: 'duplicate' });
    await expectHandledOnce();
  });

  // The notifier crashed after RabbitMQ confirmed the job but before its transaction committed:
  // no processed_event row, so the event counts as new and the same job is queued again. The copy
  // comes back through the relay here, not a Kafka redelivery; the handler sees the same event
  // either way, and the redelivery itself is covered in apps/worker/test/notifier.int.test.ts
  it('drops the job when the notifier queues it again', async () => {
    const from = worker.lines.length;
    await owner
      .delete(processedEvent)
      .where(and(eq(processedEvent.consumer, 'notifier'), eq(processedEvent.eventId, eventId)));
    await unpublishOutboxRow();

    const dropped = await worker.waitForLine(
      hasMessage('Email was already sent, dropped this copy'),
      from,
    );
    expect(dropped).toMatchObject({ jobId, result: 'duplicate' });
    await expectHandledOnce();
  });

  it('stops both programs cleanly on SIGTERM', async () => {
    expect(await worker.stop()).toEqual({ code: 0, signal: null });
    expect(worker.lines.some(hasMessage('Worker stopped'))).toBe(true);
    // Nest runs its shutdown hooks, then sends the signal to itself again, so the API ends by
    // SIGTERM rather than exit code 0, with or without hooks: the log line shows they ran
    expect(await api.stop()).toEqual({ code: null, signal: 'SIGTERM' });
    expect(api.lines.some((line) => line.text.includes('Database pool closed'))).toBe(true);
  });
});
