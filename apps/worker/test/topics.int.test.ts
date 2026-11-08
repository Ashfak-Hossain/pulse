import { randomUUID } from 'node:crypto';
import { ConfigResourceTypes, type Admin } from '@platformatic/kafka';
import { topics } from '@pulse/events';
import { inject, vi } from 'vitest';
import { createKafkaAdmin } from '../src/kafka/client.js';
import { connectAndEnsureTopics, ensureTopics, type TopicAdmin } from '../src/kafka/topics.js';

const specs = Object.values(topics);
const names = specs.map((spec) => spec.name);
const options = { replicationFactor: 1, minInsyncReplicas: 1 };

let admin: Admin;

beforeAll(() => {
  admin = createKafkaAdmin({ brokers: inject('kafkaBrokers'), clientId: 'topics-int-test' });
});

afterAll(async () => {
  await admin.close();
});

async function topicConfig(topic: string): Promise<Map<string, string | null | undefined>> {
  const [description] = await admin.describeConfigs({
    resources: [{ resourceType: ConfigResourceTypes.TOPIC, resourceName: topic }],
  });
  return new Map((description?.configs ?? []).map((c) => [c.name, c.value]));
}

// One file owns the shared topic names; other files use their own random topics
describe('ensureTopics against Kafka 4.4', () => {
  it('creates every topic in @pulse/events', async () => {
    const created = await ensureTopics(admin, specs, options);
    expect(created.toSorted()).toEqual(names.toSorted());
    // Kafka answers "created" before every broker's metadata lists the topic, so wait for it
    await vi.waitFor(async () => {
      expect(await admin.listTopics()).toEqual(expect.arrayContaining(names));
    });
  });

  it('gives each topic its partitions', async () => {
    await vi.waitFor(async () => {
      const metadata = await admin.metadata({ topics: names, forceUpdate: true });
      for (const spec of specs) {
        expect(metadata.topics.get(spec.name)?.partitionsCount, spec.name).toBe(spec.partitions);
      }
    });
  });

  it('gives each topic its config and min.insync.replicas', async () => {
    for (const spec of specs) {
      const config = await topicConfig(spec.name);
      for (const [name, value] of Object.entries(spec.config)) {
        expect(config.get(name), `${spec.name} ${name}`).toBe(value);
      }
      expect(config.get('min.insync.replicas'), spec.name).toBe('1');
    }
  });

  it('creates nothing on a second run', async () => {
    expect(await ensureTopics(admin, specs, options)).toEqual([]);
  });

  it('does the same over its own short-lived admin connection', async () => {
    const connection = { brokers: inject('kafkaBrokers'), clientId: 'topics-int-test-own' };
    const name = `topics-int-${randomUUID()}`;
    const spec = { ...topics.campuses, name };

    await expect(connectAndEnsureTopics(connection, [spec], options)).resolves.toEqual([name]);

    expect(await admin.listTopics()).toContain(name);
  });

  // Proves the real "already exists" error is recognised, not only the one the unit test builds
  it('survives a race where another worker created the topic first', async () => {
    const racing: TopicAdmin = {
      listTopics: () => Promise.resolve([]),
      createTopics: (request) => admin.createTopics(request),
    };
    await expect(ensureTopics(racing, [topics.campuses], options)).resolves.toEqual([]);
  });
});
