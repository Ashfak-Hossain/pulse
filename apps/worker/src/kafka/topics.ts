import { findErrorBy, type CreateTopicsOptions } from '@platformatic/kafka';
import type { TopicSpec } from '@pulse/events';

// Only the two admin calls we use, so unit tests can pass a fake instead of a real Kafka
export interface TopicAdmin {
  listTopics(): Promise<string[]>;
  createTopics(request: CreateTopicsOptions): Promise<unknown>;
}

export interface TopicOptions {
  replicationFactor: number;
  minInsyncReplicas: number;
}

/**
 * Creates the topics that are missing and returns their names. Existing topics are never
 * changed: adding partitions would move keys and break their order.
 */
export async function ensureTopics(
  admin: TopicAdmin,
  specs: readonly TopicSpec[],
  options: TopicOptions,
): Promise<string[]> {
  const existing = new Set(await admin.listTopics());
  const created: string[] = [];
  for (const spec of specs) {
    if (existing.has(spec.name)) continue;
    if (await createTopic(admin, spec, options)) {
      created.push(spec.name);
    }
  }
  return created;
}

// One request per topic, because configs apply to every topic in a request
async function createTopic(
  admin: TopicAdmin,
  spec: TopicSpec,
  { replicationFactor, minInsyncReplicas }: TopicOptions,
): Promise<boolean> {
  try {
    await admin.createTopics({
      topics: [spec.name],
      partitions: spec.partitions,
      replicas: replicationFactor,
      configs: [
        ...Object.entries(spec.config).map(([name, value]) => ({ name, value })),
        { name: 'min.insync.replicas', value: String(minInsyncReplicas) },
      ],
    });
    return true;
  } catch (error) {
    // Another worker created it first, which is fine
    if (isTopicAlreadyExists(error)) return false;
    throw error;
  }
}

function isTopicAlreadyExists(error: unknown): boolean {
  return error instanceof Error && findErrorBy(error, 'apiId', 'TOPIC_ALREADY_EXISTS') !== null;
}
