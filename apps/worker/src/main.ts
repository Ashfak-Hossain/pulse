import { topics } from '@pulse/events';
import { validateEnv } from './config/env.js';
import { createAdmin } from './kafka/client.js';
import { ensureTopics } from './kafka/topics.js';

const env = validateEnv(process.env);
const admin = createAdmin({ brokers: env.KAFKA_BROKERS, clientId: env.KAFKA_CLIENT_ID });

try {
  const created = await ensureTopics(admin, Object.values(topics), {
    replicationFactor: env.KAFKA_REPLICATION_FACTOR,
    minInsyncReplicas: env.KAFKA_MIN_INSYNC_REPLICAS,
  });
  console.log(
    created.length > 0 ? `Created topics: ${created.join(', ')}` : 'All topics already exist',
  );
} finally {
  // A failed close must not hide the real error from ensureTopics
  await admin.close().catch((error: unknown) => console.error('Closing the admin failed', error));
}
