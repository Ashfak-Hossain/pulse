import type { CreateTopicsOptions } from '@platformatic/kafka';
import { MultipleErrors, ProtocolError } from '@platformatic/kafka';
import { topics, type TopicSpec } from '@pulse/events';
import { ensureTopics, type TopicAdmin } from './topics.js';

const options = { replicationFactor: 1, minInsyncReplicas: 1 };

// Records every createTopics request; `existing` is what listTopics reports
function fakeAdmin(existing: string[], createError?: Error) {
  const requests: CreateTopicsOptions[] = [];
  const admin: TopicAdmin = {
    listTopics: () => Promise.resolve([...existing]),
    createTopics: (request) => {
      requests.push(request);
      return createError === undefined ? Promise.resolve([]) : Promise.reject(createError);
    },
  };
  return { admin, requests };
}

const campuses: TopicSpec = topics.campuses;
const profiles: TopicSpec = topics.profiles;

describe('ensureTopics', () => {
  it('creates every topic that is missing and returns their names', async () => {
    const { admin, requests } = fakeAdmin([]);
    const created = await ensureTopics(admin, Object.values(topics), options);
    expect(created.toSorted()).toEqual(
      Object.values(topics)
        .map((t) => t.name)
        .toSorted(),
    );
    expect(requests).toHaveLength(Object.values(topics).length);
  });

  it('leaves existing topics alone', async () => {
    const { admin, requests } = fakeAdmin(['campuses', '__consumer_offsets']);
    const created = await ensureTopics(admin, [campuses, profiles], options);
    expect(created).toEqual(['profiles']);
    expect(requests.map((r) => r.topics)).toEqual([['profiles']]);
  });

  it('does nothing when all topics exist', async () => {
    const { admin, requests } = fakeAdmin(['campuses', 'profiles']);
    expect(await ensureTopics(admin, [campuses, profiles], options)).toEqual([]);
    expect(requests).toEqual([]);
  });

  // configs apply to the whole request, so topics with different configs need their own
  it('sends one request per topic with its partitions, replicas and config', async () => {
    const { admin, requests } = fakeAdmin([]);
    await ensureTopics(admin, [profiles], { replicationFactor: 3, minInsyncReplicas: 2 });
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request).toMatchObject({ topics: ['profiles'], partitions: 3, replicas: 3 });
    expect(request?.configs).toEqual(
      expect.arrayContaining([
        { name: 'cleanup.policy', value: 'compact' },
        { name: 'min.insync.replicas', value: '2' },
      ]),
    );
    expect(request?.configs).toHaveLength(2);
  });

  it('sets min.insync.replicas on a topic with no config of its own', async () => {
    const { admin, requests } = fakeAdmin([]);
    await ensureTopics(admin, [campuses], options);
    expect(requests[0]?.configs).toEqual([{ name: 'min.insync.replicas', value: '1' }]);
  });

  // Two workers starting together both see the topic missing; the second create must not fail
  it('treats "topic already exists" from Kafka as done', async () => {
    const raced = new MultipleErrors('Creating topics failed.', [
      new ProtocolError('TOPIC_ALREADY_EXISTS'),
    ]);
    const { admin } = fakeAdmin([], raced);
    await expect(ensureTopics(admin, [campuses], options)).resolves.toEqual([]);
  });

  it('fails on any other error', async () => {
    const { admin } = fakeAdmin([], new ProtocolError('INVALID_REPLICATION_FACTOR'));
    await expect(ensureTopics(admin, [campuses], options)).rejects.toThrow();
  });
});
