import { randomUUID } from 'node:crypto';
import type { Admin, Producer } from '@platformatic/kafka';
import { createDb, eq, processedEvent, sql } from '@pulse/db';
import { createEvent, type CampusCreatedEvent } from '@pulse/events';
import { jobTopology, queueFor } from '@pulse/jobs';
import { connect, type Channel, type ChannelModel } from 'amqplib';
import { inject, vi } from 'vitest';
import {
  createKafkaAdmin,
  createKafkaConsumer,
  createKafkaProducer,
  type KafkaConnection,
} from '../src/kafka/client.js';
import { campusCreatedEmail } from '../src/notifier/campus-created.js';
import { createNotifierDb, runNotifier } from '../src/notifier/run.js';
import { JobPublisher } from '../src/rabbit/publish.js';
import { ensureTopology } from '../src/rabbit/topology.js';
import { createLogger, type BasicLogger } from '../src/shared/logger.js';
import { createVhost, rabbitApi } from './support/rabbit.js';

// Its own vhost, and a new topic and consumer group per test: a new group reads from the start,
// so a shared topic would hand each test the records of the ones before it
let topic: string;
const vhost = 'test-notifier';
const workQueue = queueFor('notify.email');
const capPolicy = `/policies/${vhost}/test-cap`;
const silent = createLogger({ level: 'silent' });

let kafka: KafkaConnection;
let admin: Admin;
let producer: Producer<string, string, string, string>;
let model: ChannelModel;
let reader: Channel;
let publisher: JobPublisher;
const notifierDb = createNotifierDb(inject('notifierUrl'), silent);
const owner = createDb(inject('ownerUrl'));

beforeAll(async () => {
  kafka = { brokers: inject('kafkaBrokers'), clientId: 'notifier-test' };
  admin = createKafkaAdmin(kafka);
  producer = createKafkaProducer(kafka);

  model = await connect(await createVhost(vhost));
  model.on('error', () => {});
  await ensureTopology(model, jobTopology());
  publisher = new JobPublisher({ onChannelError: () => {} });
  await publisher.attach(model);
  reader = await model.createChannel();
});

afterAll(async () => {
  await Promise.all([producer.close(), admin.close(), model.close()]);
  await Promise.all([notifierDb.$client.end(), owner.$client.end()]);
});

beforeEach(async () => {
  topic = `notifier-${randomUUID()}`;
  await admin.createTopics({ topics: [topic], partitions: 1, replicas: 1 });
  await reader.purgeQueue(workQueue);
});

function campusCreatedEvent(): CampusCreatedEvent {
  return createEvent(
    'CampusCreated',
    { campusId: randomUUID(), name: 'AIUB', slug: 'aiub', timezone: 'Asia/Dhaka' },
    { eventId: randomUUID(), occurredAt: new Date() },
  );
}

async function produce(...values: unknown[]): Promise<void> {
  await producer.send({
    messages: values.map((value) => ({
      topic,
      key: 'campus',
      value: typeof value === 'string' ? value : JSON.stringify(value),
    })),
  });
}

// Every publish the notifier tried that RabbitMQ refused
let refusedPublishes = 0;

/** The notifier exactly as the worker runs it, in its own consumer group, until stop(). */
function startNotifier(
  groupId: string,
  logger: BasicLogger = silent,
): { stop: () => Promise<void> } {
  const consumer = createKafkaConsumer(kafka, groupId);
  const controller = new AbortController();
  const running = runNotifier({
    consumer,
    db: notifierDb,
    publish: (job) =>
      publisher.publish(job).catch((error: unknown) => {
        refusedPublishes += 1;
        throw error;
      }),
    topicNames: [topic],
    signal: controller.signal,
    logger,
    retryDelay: () => 100,
  });
  return {
    stop: async () => {
      controller.abort();
      await running;
      await consumer.close(true);
    },
  };
}

// The next offset the group will read (Kafka stores "next", not "last read"); -1 for none
async function committedOffset(groupId: string): Promise<bigint | undefined> {
  const consumer = createKafkaConsumer(kafka, groupId);
  try {
    const offsets = await consumer.listCommittedOffsets({ topics: [{ topic, partitions: [0] }] });
    return offsets.get(topic)?.[0];
  } finally {
    await consumer.close();
  }
}

// Where a group that has read every record written so far stands
async function endOffset(): Promise<bigint> {
  const consumer = createKafkaConsumer(kafka, `offsets-${randomUUID()}`);
  try {
    const offset = (await consumer.listOffsets({ topics: [topic] })).get(topic)?.[0];
    if (offset === undefined) throw new Error(`no offsets for ${topic}`);
    return offset;
  } finally {
    await consumer.close();
  }
}

async function jobsInQueue(): Promise<{ campusId: string }[]> {
  const payloads: { campusId: string }[] = [];
  for (;;) {
    const message = await reader.get(workQueue, { noAck: true });
    if (message === false) return payloads;
    payloads.push(
      (JSON.parse(message.content.toString()) as { payload: { campusId: string } }).payload,
    );
  }
}

async function isRecorded(event: CampusCreatedEvent): Promise<boolean> {
  const rows = await owner
    .select()
    .from(processedEvent)
    .where(eq(processedEvent.eventId, event.eventId));
  return rows.length === 1;
}

const settle = { timeout: 15_000, interval: 200 };

describe('notifier: Kafka → PostgreSQL + RabbitMQ', () => {
  // Written before the group existed: a new group reads from the start of the topic
  it('turns each CampusCreated into one notify.email job and commits past it', async () => {
    const event = campusCreatedEvent();
    await produce(event);
    const end = await endOffset();
    const groupId = `notifier-${randomUUID()}`;
    const notifier = startNotifier(groupId);
    try {
      await vi.waitFor(async () => expect(await committedOffset(groupId)).toBe(end), settle);
    } finally {
      await notifier.stop();
    }
    const jobs = await jobsInQueue();
    expect(jobs).toContainEqual(expect.objectContaining({ campusId: event.payload.campusId }));
    expect(await isRecorded(event)).toBe(true);
  });

  it('queues one job for an event Kafka delivers twice, and logs the skipped copy', async () => {
    const event = campusCreatedEvent();
    await produce(event, event);
    const end = await endOffset();
    const groupId = `notifier-${randomUUID()}`;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const notifier = startNotifier(groupId, logger);
    try {
      await vi.waitFor(async () => expect(await committedOffset(groupId)).toBe(end), settle);
    } finally {
      await notifier.stop();
    }
    const mine = (await jobsInQueue()).filter((job) => job.campusId === event.payload.campusId);
    expect(mine).toHaveLength(1);
    const skipped = logger.info.mock.calls.filter(
      ([, message]) => message === 'Skipped an event already handled',
    );
    expect(skipped).toEqual([
      [
        expect.objectContaining({ eventId: event.eventId, type: 'CampusCreated' }),
        expect.any(String),
      ],
    ]);
  });

  it('skips records it cannot read and goes on to the next', async () => {
    const event = campusCreatedEvent();
    await produce('not json', { ...event, eventId: randomUUID(), type: 'CampusRenamed' }, event);
    const end = await endOffset();
    const groupId = `notifier-${randomUUID()}`;
    const notifier = startNotifier(groupId);
    try {
      await vi.waitFor(async () => expect(await committedOffset(groupId)).toBe(end), settle);
    } finally {
      await notifier.stop();
    }
    expect(await isRecorded(event)).toBe(true);
  });

  // A hung database must fail the try, or the loop neither retries nor logs. The transaction limit
  // stays above the 5 s confirm wait, which happens inside the transaction
  it('runs with limits on how long PostgreSQL may hold it up', async () => {
    const setting = async (name: string): Promise<unknown> =>
      (await notifierDb.execute(sql.raw(`show ${name}`))).rows[0]?.[name];
    expect(await setting('statement_timeout')).toBe('10s');
    expect(await setting('idle_in_transaction_session_timeout')).toBe('15s');
  });

  // A refused job: the event stays unhandled and its offset unmoved, and nothing is lost
  it('holds the event while RabbitMQ refuses its job, then queues it', async () => {
    await rabbitApi(capPolicy, 'PUT', {
      pattern: `^${workQueue.replaceAll('.', '\\.')}$`,
      definition: { 'max-length': 0 },
      'apply-to': 'queues',
    });
    const groupId = `notifier-${randomUUID()}`;
    let notifier: { stop: () => Promise<void> } | undefined;
    try {
      await vi.waitFor(async () => {
        const queue = (await (
          await rabbitApi(`/queues/${vhost}/${encodeURIComponent(workQueue)}`)
        ).json()) as { policy?: string };
        expect(queue.policy).toBe('test-cap');
      }, settle);
      // A quorum queue takes one job past its cap before it refuses (measured on 4.4)
      await publisher.publish(campusCreatedEmail(campusCreatedEvent(), new Date()));

      const event = campusCreatedEvent();
      const before = await committedOffset(groupId);
      await produce(event);
      refusedPublishes = 0;
      notifier = startNotifier(groupId);

      // Several refused tries go by: nothing recorded, offset not moved
      await vi.waitFor(() => expect(refusedPublishes).toBeGreaterThanOrEqual(3), settle);
      expect(await isRecorded(event)).toBe(false);
      expect(await committedOffset(groupId)).toBe(before);

      await rabbitApi(capPolicy, 'DELETE');
      await vi.waitFor(async () => expect(await isRecorded(event)).toBe(true), settle);
      const end = await endOffset();
      await vi.waitFor(async () => expect(await committedOffset(groupId)).toBe(end), settle);
      const jobs = await jobsInQueue();
      expect(jobs).toContainEqual(expect.objectContaining({ campusId: event.payload.campusId }));
    } finally {
      await rabbitApi(capPolicy, 'DELETE').catch(() => undefined);
      await notifier?.stop();
    }
  });
});
