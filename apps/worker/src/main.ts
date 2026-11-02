import { assertRestrictedRole, type Database } from '@pulse/db';
import { topics } from '@pulse/events';
import { validateEnv, type Env } from './config/env.js';
import { createAdmin, createProducer, type KafkaConnection } from './kafka/client.js';
import { ensureTopics } from './kafka/topics.js';
import { createLogger } from './logger.js';
import { createRelayDb, currentRole } from './relay/db.js';
import { runRelayLoop } from './relay/loop.js';
import { describeError, oneSendAtATime, relayOnce, type RelayProducer } from './relay/relay.js';

// Docker sends SIGKILL 10 s after SIGTERM, so give up a little before that
const SHUTDOWN_TIMEOUT_MS = 8000;

const logger = createLogger();

process.on('uncaughtException', (error) => exitWithError(error, 'Uncaught exception'));
process.on('unhandledRejection', (reason) => exitWithError(reason, 'Unhandled rejection'));

await main().catch((error: unknown) => exitWithError(error, 'Worker failed'));

async function main(): Promise<void> {
  const env = validateEnv(process.env);
  const connection = { brokers: env.KAFKA_BROKERS, clientId: env.KAFKA_CLIENT_ID };
  const db = createRelayDb(env.RELAY_DATABASE_URL, logger);
  const producer = createProducer(connection);
  const controller = new AbortController();
  stopOnSignals(controller);

  try {
    await assertRestrictedRole(db);
    await createTopics(connection, env);
    await runRelay(db, producer, env, controller.signal);
  } finally {
    await closeAll(db, producer);
  }
  logger.info({}, 'Worker stopped');
}

async function createTopics(connection: KafkaConnection, env: Env): Promise<void> {
  const admin = createAdmin(connection);
  try {
    const created = await ensureTopics(admin, Object.values(topics), {
      replicationFactor: env.KAFKA_REPLICATION_FACTOR,
      minInsyncReplicas: env.KAFKA_MIN_INSYNC_REPLICAS,
    });
    logger.info({ created }, 'Topics ready');
  } finally {
    await admin.close();
  }
}

async function runRelay(
  db: Database,
  producer: RelayProducer,
  env: Env,
  signal: AbortSignal,
): Promise<void> {
  const relayOptions = {
    batchSize: env.RELAY_BATCH_SIZE,
    topics: new Set<string>(Object.values(topics).map((topic) => topic.name)),
    signal,
  };
  const guarded = oneSendAtATime(producer);
  logger.info(
    { role: await currentRole(db), batchSize: env.RELAY_BATCH_SIZE, pollMs: env.RELAY_POLL_MS },
    'Outbox relay started',
  );
  await runRelayLoop(() => relayOnce(db, guarded, relayOptions), {
    batchSize: env.RELAY_BATCH_SIZE,
    pollMs: env.RELAY_POLL_MS,
    signal,
    logger,
  });
}

// First signal: finish the current step, then close. Second signal, or a stop that takes too
// long: exit at once (the outbox keeps any row that was not marked, so nothing is lost)
function stopOnSignals(controller: AbortController): void {
  const stop = (signal: NodeJS.Signals): void => {
    if (controller.signal.aborted) {
      logger.warn({ signal }, 'Second signal, exiting now');
      process.exit(1);
    }
    logger.info({ signal }, 'Stopping');
    controller.abort();
    // unref: this timer alone must not keep the process alive after a clean stop
    setTimeout(() => {
      logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'Stopping took too long, exiting');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

// Both always run: a failed close must not leave the other connection open
async function closeAll(
  db: Database,
  producer: RelayProducer & { close(): Promise<void> },
): Promise<void> {
  const results = await Promise.allSettled([producer.close(), db.$client.end()]);
  for (const result of results) {
    if (result.status === 'rejected') {
      logger.warn({ error: describeError(result.reason) }, 'Closing a connection failed');
    }
  }
}

function exitWithError(error: unknown, message: string): never {
  logger.fatal({ error: describeError(error) }, message);
  process.exit(1);
}
