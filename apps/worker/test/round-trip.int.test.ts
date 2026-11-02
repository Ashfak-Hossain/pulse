import { randomUUID } from 'node:crypto';
import type { Admin, Producer } from '@platformatic/kafka';
import { inject } from 'vitest';
import { createAdmin, createProducer } from '../src/kafka/client.js';
import { readMessages } from './support/consume.js';

// Its own topic, so it never meets the shared names topics.int.test.ts creates
const topic = `round-trip-${randomUUID()}`;
const keys = ['campus-a', 'campus-b', 'campus-c'];

let admin: Admin;
let producer: Producer<string, string, string, string>;

beforeAll(async () => {
  const brokers = inject('kafkaBrokers');
  admin = createAdmin({ brokers, clientId: 'round-trip-admin' });
  producer = createProducer({ brokers, clientId: 'round-trip-producer' });
  await admin.createTopics({ topics: [topic], partitions: 3, replicas: 1 });
});

afterAll(async () => {
  await producer.close();
  await admin.close();
});

describe('producer → Kafka 4.4 → consumer group', () => {
  it('sends keyed records with headers, idempotently with acks=all', async () => {
    // Nine records, three per key, sent in one request
    const messages = Array.from({ length: 9 }, (_, i) => ({
      topic,
      key: keys[i % keys.length] ?? 'never',
      value: JSON.stringify({ n: i }),
      headers: { eventId: randomUUID(), type: 'RoundTrip' },
    }));
    const result = await producer.send({ messages });
    expect(result.offsets?.length).toBeGreaterThan(0);
    // An idempotent producer asks the broker for a producer id before its first write
    expect(producer.producerId).toBeDefined();
  });

  it('reads them back: same key → same partition, in send order', async () => {
    const received = await readMessages(inject('kafkaBrokers'), topic, 9);
    expect(received).toHaveLength(9);

    for (const key of keys) {
      const forKey = received.filter((m) => m.key === key);
      expect(new Set(forKey.map((m) => m.partition)).size, key).toBe(1);
      const order = forKey.map((m) => (JSON.parse(m.value) as { n: number }).n);
      expect(order, key).toEqual(order.toSorted((a, b) => a - b));
      expect(order, key).toHaveLength(3);
    }
    for (const message of received) {
      expect(message.headers.get('type')).toBe('RoundTrip');
      expect(message.headers.get('eventId')).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});
