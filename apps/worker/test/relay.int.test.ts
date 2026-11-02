import { randomUUID } from 'node:crypto';
import type { Admin, Producer } from '@platformatic/kafka';
import { asc, createDb, eq, outboxEvent, sql } from '@pulse/db';
import { inject } from 'vitest';
import { createAdmin, createProducer } from '../src/kafka/client.js';
import { RELAY_LOCK_ID, relayOnce, type RelayProducer } from '../src/relay/relay.js';
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
  admin = createAdmin({ brokers, clientId: 'relay-test-admin' });
  producer = createProducer({ brokers, clientId: 'relay-test-producer' });
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
