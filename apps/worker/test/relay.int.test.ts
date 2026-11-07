import { randomUUID } from 'node:crypto';
import type { Admin, Producer } from '@platformatic/kafka';
import { asc, assertRestrictedRole, createDb, eq, outboxEvent, sql } from '@pulse/db';
import { inject } from 'vitest';
import { createKafkaAdmin, createKafkaProducer } from '../src/kafka/client.js';
import type { LoopLogger } from '../src/logger.js';
import { runRelayLoop } from '../src/relay/loop.js';
import {
  oneSendAtATime,
  RELAY_LOCK_ID,
  relayOnce,
  type RelayProducer,
} from '../src/relay/relay.js';
import { createWorkerDb, currentRole } from '../src/shared/db.js';
import { readMessages } from './support/consume.js';

const owner = createDb(inject('ownerUrl'));
const relay = createDb(inject('relayUrl'));
// The partial index already returns rows in seq order. Without it PostgreSQL reads the table in
// storage order, so only ORDER BY seq can pass the order tests
const relayWithoutIndex = createDb(withoutIndexScans(inject('relayUrl')));
let admin: Admin;
let producer: Producer<string, string, string, string>;

beforeAll(() => {
  const brokers = inject('kafkaBrokers');
  admin = createKafkaAdmin({ brokers, clientId: 'relay-test-admin' });
  producer = createKafkaProducer({ brokers, clientId: 'relay-test-producer' });
});

afterAll(async () => {
  await producer.close();
  await admin.close();
  await Promise.all([owner.$client.end(), relay.$client.end(), relayWithoutIndex.$client.end()]);
});

// The relay takes every unpublished row, so each test starts from an empty outbox
beforeEach(async () => {
  await owner.delete(outboxEvent);
});

function withoutIndexScans(url: string): string {
  const withOptions = new URL(url);
  withOptions.searchParams.set('options', '-c enable_indexscan=off -c enable_bitmapscan=off');
  return withOptions.href;
}

// Its own topic per test, so reading from the start sees only this test's records
async function newTopic(): Promise<string> {
  const topic = `relay-${randomUUID()}`;
  await admin.createTopics({ topics: [topic], partitions: 3, replicas: 1 });
  return topic;
}

function options(topic: string, batchSize = 100) {
  return { batchSize, topics: new Set([topic]) };
}

type RowInput = {
  topic: string;
  key: string;
  type?: string;
  payload?: Record<string, unknown>;
};

async function insertRows(rows: RowInput[]): Promise<void> {
  for (const row of rows) {
    await owner.insert(outboxEvent).values({
      aggregate: 'campus',
      aggregateId: randomUUID(),
      type: row.type ?? 'CampusCreated',
      version: 1,
      topic: row.topic,
      key: row.key,
      payload: row.payload ?? { campusId: row.key },
    });
  }
}

function outboxRows() {
  return owner.select().from(outboxEvent).orderBy(asc(outboxEvent.seq));
}

// An update writes a new row version at the end of the table, so a query without ORDER BY seq
// would now return this row last
async function moveToEndOfTable(id: string): Promise<void> {
  await owner.update(outboxEvent).set({ attempts: 0 }).where(eq(outboxEvent.id, id));
}

// Stands in for Kafka: records what it was asked to send, or fails
function fakeProducer(error?: Error) {
  const sent: unknown[] = [];
  const fake: RelayProducer = {
    send: (request) => {
      sent.push(request);
      return error === undefined ? Promise.resolve({}) : Promise.reject(error);
    },
  };
  return { fake, sent };
}

describe('relayOnce', () => {
  it('publishes unpublished rows in seq order, with their key and headers, then marks them', async () => {
    const topic = await newTopic();
    const keys = ['campus-a', 'campus-b'];
    await insertRows(Array.from({ length: 6 }, (_, i) => ({ topic, key: keys[i % 2] ?? '' })));
    const [first] = await outboxRows();
    await moveToEndOfTable(first?.id ?? '');

    expect(await relayOnce(relayWithoutIndex, producer, options(topic))).toEqual({
      status: 'published',
      count: 6,
    });

    const rows = await outboxRows();
    expect(rows.every((row) => row.publishedAt instanceof Date)).toBe(true);

    const received = await readMessages(inject('kafkaBrokers'), topic, 6);
    for (const key of keys) {
      const sentIds = rows.filter((row) => row.key === key).map((row) => row.id);
      const receivedIds = received
        .filter((m) => m.key === key)
        .map((m) => m.headers.get('eventId'));
      expect(receivedIds, key).toEqual(sentIds);
    }
    for (const message of received) {
      const value = JSON.parse(message.value) as { eventId: string; type: string };
      expect(value.eventId).toBe(message.headers.get('eventId'));
      expect(message.headers.get('type')).toBe('CampusCreated');
    }
  });

  it('publishes nothing the second time', async () => {
    const topic = await newTopic();
    await insertRows([{ topic, key: 'campus-a' }]);
    await relayOnce(relay, producer, options(topic));

    const { fake, sent } = fakeProducer();
    expect(await relayOnce(relay, fake, options(topic))).toEqual({
      status: 'published',
      count: 0,
    });
    expect(sent).toHaveLength(0);
  });

  it('takes at most batchSize rows, oldest first', async () => {
    const topic = await newTopic();
    await insertRows([1, 2, 3].map(() => ({ topic, key: 'campus-a' })));
    const [first] = await outboxRows();
    await moveToEndOfTable(first?.id ?? '');

    expect(await relayOnce(relayWithoutIndex, producer, options(topic, 2))).toEqual({
      status: 'published',
      count: 2,
    });
    const rows = await outboxRows();
    expect(rows.map((row) => row.publishedAt !== null)).toEqual([true, true, false]);

    expect(await relayOnce(relay, producer, options(topic, 2))).toEqual({
      status: 'published',
      count: 1,
    });
  });

  it('stands by while another relay holds the lock', async () => {
    const topic = await newTopic();
    await insertRows([{ topic, key: 'campus-a' }]);
    const { fake, sent } = fakeProducer();

    await owner.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${RELAY_LOCK_ID})`);
      expect(await relayOnce(relay, fake, options(topic))).toEqual({ status: 'standby' });
    });
    expect(sent).toHaveLength(0);
    expect((await outboxRows())[0]?.publishedAt).toBeNull();

    // The other relay committed, so the lock is free again
    expect(await relayOnce(relay, fake, options(topic))).toEqual({
      status: 'published',
      count: 1,
    });
  });

  it('keeps rows unpublished when Kafka fails, and records the attempt', async () => {
    const topic = await newTopic();
    await insertRows([
      { topic, key: 'campus-a' },
      { topic, key: 'campus-b' },
    ]);
    const brokerDown = new Error('broker down');
    const { fake } = fakeProducer(brokerDown);

    expect(await relayOnce(relay, fake, options(topic))).toEqual({
      status: 'failed',
      published: 0,
      error: brokerDown,
    });
    await relayOnce(relay, fake, options(topic));

    for (const row of await outboxRows()) {
      expect(row).toMatchObject({
        publishedAt: null,
        attempts: 2,
        lastError: 'Error: broker down',
      });
    }
  });

  it('records the error code when there is one', async () => {
    const topic = await newTopic();
    await insertRows([{ topic, key: 'campus-a' }]);
    const { fake } = fakeProducer(
      Object.assign(new Error('broker down'), { code: 'PLT_KFK_NETWORK' }),
    );

    await relayOnce(relay, fake, options(topic));

    const [row] = await outboxRows();
    expect(row?.lastError).toBe('Error [PLT_KFK_NETWORK]: broker down');
  });

  it('cuts a long error message to 1000 characters', async () => {
    const topic = await newTopic();
    await insertRows([{ topic, key: 'campus-a' }]);
    const { fake } = fakeProducer(new Error('x'.repeat(5000)));

    await relayOnce(relay, fake, options(topic));

    const [row] = await outboxRows();
    expect(row?.lastError).toHaveLength(1000);
  });

  // The transaction (and the advisory lock) stays open while Kafka answers, so a stuck send
  // must not hold it forever
  it('gives up on a send slower than sendTimeoutMs and records it as a failure', async () => {
    const topic = await newTopic();
    await insertRows([{ topic, key: 'campus-a' }]);
    const stuck: RelayProducer = { send: () => new Promise(() => {}) };

    const result = await relayOnce(relay, stuck, { ...options(topic), sendTimeoutMs: 200 });

    expect(result).toMatchObject({ status: 'failed', published: 0 });
    const [row] = await outboxRows();
    expect(row).toMatchObject({ publishedAt: null, attempts: 1 });
    expect(row?.lastError).toMatch(/timed out after 200 ms/);
  });

  it('frees the lock after a timed-out send, so the next step publishes the row', async () => {
    const topic = await newTopic();
    await insertRows([{ topic, key: 'campus-a' }]);
    const stuck: RelayProducer = { send: () => new Promise(() => {}) };
    await relayOnce(relay, stuck, { ...options(topic), sendTimeoutMs: 200 });

    expect(await relayOnce(relay, producer, options(topic))).toEqual({
      status: 'published',
      count: 1,
    });
    expect(await readMessages(inject('kafkaBrokers'), topic, 1)).toHaveLength(1);
  });

  it('sends a row again, with the same eventId, when it was sent but never marked', async () => {
    const topic = await newTopic();
    await insertRows([{ topic, key: 'campus-a' }]);
    // Kafka stores the record, then the relay dies before it can mark the row
    const crashAfterSend: RelayProducer = {
      send: async (request) => {
        await producer.send(request);
        throw new Error('crashed before marking');
      },
    };

    expect(await relayOnce(relay, crashAfterSend, options(topic))).toMatchObject({
      status: 'failed',
    });
    expect((await outboxRows())[0]?.publishedAt).toBeNull();

    expect(await relayOnce(relay, producer, options(topic))).toEqual({
      status: 'published',
      count: 1,
    });
    const [row] = await outboxRows();
    const received = await readMessages(inject('kafkaBrokers'), topic, 2);
    expect(received.map((m) => m.headers.get('eventId'))).toEqual([row?.id, row?.id]);
  });

  it('stops at a row that is not a valid event: earlier rows go out, later ones wait', async () => {
    const topic = await newTopic();
    await insertRows([
      { topic, key: 'campus-a' },
      { topic, key: 'campus-a', type: '', payload: { email: 'test.student@example.edu' } },
      { topic, key: 'campus-a' },
    ]);

    const result = await relayOnce(relay, producer, options(topic));
    expect(result).toMatchObject({ status: 'failed', published: 1 });

    const [first, bad, last] = await outboxRows();
    expect(first?.publishedAt).toBeInstanceOf(Date);
    expect(bad).toMatchObject({ publishedAt: null, attempts: 1 });
    expect(bad?.lastError).toMatch(/not a valid event envelope/);
    expect(bad?.lastError).not.toContain('test.student@example.edu');
    expect(last).toMatchObject({ publishedAt: null, attempts: 0 });

    const received = await readMessages(inject('kafkaBrokers'), topic, 1);
    expect(received.map((m) => m.headers.get('eventId'))).toEqual([first?.id]);
  });

  it('treats a row for a topic outside the list as a bad row', async () => {
    const topic = await newTopic();
    const other = await newTopic();
    await insertRows([
      { topic, key: 'campus-a' },
      { topic: other, key: 'campus-a' },
    ]);

    expect(await relayOnce(relay, producer, options(topic))).toMatchObject({
      status: 'failed',
      published: 1,
    });

    const [, wrong] = await outboxRows();
    expect(wrong).toMatchObject({ publishedAt: null, attempts: 1 });
    expect(wrong?.lastError).toMatch(/unknown topic/);
  });
});

// Here and not in its own file: both suites empty and drain the one outbox table, so they must
// not run in parallel
describe('relayOnce when Kafka is slow', () => {
  // Never answers, like a broker that accepts the connection and then goes quiet
  const stuck: RelayProducer = { send: () => new Promise(() => {}) };

  it('stops waiting for Kafka when the shutdown signal fires, and leaves the rows unpublished', async () => {
    const topic = await newTopic();
    await insertRows([{ topic, key: 'campus-a' }]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const started = performance.now();
    const result = await relayOnce(relay, stuck, { ...options(topic), signal: controller.signal });

    expect(performance.now() - started).toBeLessThan(1000);
    expect(result).toMatchObject({ status: 'failed', published: 0 });
    const [row] = await outboxRows();
    expect(row?.publishedAt).toBeNull();
    expect(row?.lastError).toMatch(/stopped by shutdown/);
  });

  it('does not start a send once the shutdown signal has fired', async () => {
    const topic = await newTopic();
    await insertRows([{ topic, key: 'campus-a' }]);
    const controller = new AbortController();
    controller.abort();
    const { fake, sent } = fakeProducer();

    await relayOnce(relay, fake, { ...options(topic), signal: controller.signal });

    expect(sent).toEqual([]);
    expect((await outboxRows())[0]?.publishedAt).toBeNull();
  });

  // The timed-out send keeps going inside the Kafka client and lands later. With one send at a
  // time, the resend starts only after it, so a copy can never land after a newer event
  it('with oneSendAtATime, a send that lands after its timeout is not overlapped by the next one', async () => {
    const topic = await newTopic();
    await insertRows([
      { topic, key: 'campus-a' },
      { topic, key: 'campus-a' },
    ]);
    let sends = 0;
    let firstSend: Promise<void> | undefined;
    const slow: RelayProducer = {
      send: (request) => {
        sends += 1;
        if (firstSend !== undefined) return producer.send(request);
        firstSend = (async () => {
          await new Promise((resolve) => setTimeout(resolve, 600));
          await producer.send(request);
        })();
        return firstSend;
      },
    };
    const guarded = oneSendAtATime(slow);
    const slowOptions = { ...options(topic), sendTimeoutMs: 200 };

    expect(await relayOnce(relay, guarded, slowOptions)).toMatchObject({ status: 'failed' });
    expect(await relayOnce(relay, guarded, slowOptions)).toMatchObject({ status: 'failed' });
    expect((await outboxRows())[0]?.lastError).toMatch(/still running/);
    expect(sends).toBe(1);

    // The guard waits on this same promise and was first in line, so it is free again after it
    await firstSend;
    expect(await relayOnce(relay, guarded, slowOptions)).toEqual({ status: 'published', count: 2 });

    const rows = await outboxRows();
    const ids = rows.map((row) => row.id);
    const received = await readMessages(inject('kafkaBrokers'), topic, 4);
    // The late send, then the resend: each in seq order, the copy never before the original
    expect(received.map((m) => m.headers.get('eventId'))).toEqual([...ids, ...ids]);
    for (const row of rows) {
      expect(row.publishedAt).not.toBeNull();
    }
  });
});

describe('runRelayLoop with PostgreSQL and Kafka', () => {
  const ignore = (): void => undefined;
  const silent: LoopLogger = { info: ignore, warn: ignore, error: ignore };

  it('connects as pulse_relay, a role that cannot bypass row-level security', async () => {
    await expect(assertRestrictedRole(relay)).resolves.toBeUndefined();
    const { rows } = await relay.execute<{ role: string }>(sql`select current_user as role`);
    expect(rows[0]?.role).toBe('pulse_relay');
  });

  it('publishes rows written while it runs, in seq order, then returns after an abort', async () => {
    const topic = await newTopic();
    const controller = new AbortController();
    // A batch of 2 makes the loop take several steps for the five rows
    const loop = runRelayLoop(() => relayOnce(relay, producer, options(topic, 2)), {
      batchSize: 2,
      pollMs: 50,
      signal: controller.signal,
      logger: silent,
    });

    // One key, so all five land on one partition and Kafka keeps their order
    await insertRows(Array.from({ length: 5 }, () => ({ topic, key: 'campus-a' })));
    const received = await readMessages(inject('kafkaBrokers'), topic, 5);
    controller.abort();
    await loop;

    const rows = await outboxRows();
    expect(received.map((m) => m.headers.get('eventId'))).toEqual(rows.map((row) => row.id));
    for (const row of rows) {
      expect(row.publishedAt).not.toBeNull();
    }
  });

  it('reports the role it connected as, for the start-up log', async () => {
    expect(await currentRole(relay)).toBe('pulse_relay');
  });

  it('stops within a second when a shutdown comes during a stuck send', async () => {
    const topic = await newTopic();
    await insertRows([{ topic, key: 'campus-a' }]);
    const stuck: RelayProducer = { send: () => new Promise(() => {}) };
    const controller = new AbortController();
    const loop = runRelayLoop(
      () => relayOnce(relay, stuck, { ...options(topic), signal: controller.signal }),
      { batchSize: 100, pollMs: 50, signal: controller.signal, logger: silent },
    );

    // Let the first step reach the send
    await new Promise((resolve) => setTimeout(resolve, 200));
    const started = performance.now();
    controller.abort();
    await loop;

    expect(performance.now() - started).toBeLessThan(1000);
    expect((await outboxRows())[0]?.publishedAt).toBeNull();
  });

  // Like a Postgres restart: without error listeners, pg emits 'error' with nobody listening
  // and the process dies
  it('keeps publishing after its database connections are cut', async () => {
    const appName = `relay-cut-${randomUUID()}`;
    const url = new URL(inject('relayUrl'));
    url.searchParams.set('application_name', appName);
    const warnings: string[] = [];
    const logger: LoopLogger = { ...silent, warn: (_fields, message) => warnings.push(message) };
    const db = createWorkerDb(url.href, logger);
    const topic = await newTopic();
    const controller = new AbortController();
    const loop = runRelayLoop(() => relayOnce(db, producer, options(topic)), {
      batchSize: 100,
      pollMs: 50,
      signal: controller.signal,
      logger,
    });

    try {
      await insertRows([{ topic, key: 'campus-a' }]);
      await readMessages(inject('kafkaBrokers'), topic, 1);

      await owner.execute(
        sql`select pg_terminate_backend(pid) from pg_stat_activity where application_name = ${appName}`,
      );
      await insertRows([{ topic, key: 'campus-a' }]);
      const received = await readMessages(inject('kafkaBrokers'), topic, 2);

      expect(received).toHaveLength(2);
      expect(warnings).toContain('Database connection lost');
    } finally {
      controller.abort();
      await loop;
      await db.$client.end();
    }
  });

  it('returns soon after an abort while it sleeps on an empty outbox', async () => {
    const topic = await newTopic();
    const controller = new AbortController();
    const loop = runRelayLoop(() => relayOnce(relay, producer, options(topic)), {
      batchSize: 100,
      pollMs: 60_000,
      signal: controller.signal,
      logger: silent,
    });

    // Let the first step run and the minute-long sleep start
    await new Promise((resolve) => setTimeout(resolve, 200));
    const started = performance.now();
    controller.abort();
    await loop;
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
