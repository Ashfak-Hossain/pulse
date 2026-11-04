import { assertRestrictedRole, type Database } from '@pulse/db';
import { topics } from '@pulse/events';
import { jobTopology } from '@pulse/jobs';
import type { ChannelModel } from 'amqplib';
import { validateEnv, type Env } from './config/env.js';
import {
  createAdmin,
  createConsumer,
  createProducer,
  type KafkaConnection,
} from './kafka/client.js';
import { ensureTopics } from './kafka/topics.js';
import { createLogger } from './logger.js';
import { NOTIFIER } from './notifier/campus-created.js';
import { createNotifierDb, runNotifier } from './notifier/run.js';
import { connectRabbit } from './rabbit/client.js';
import { JobPublisher } from './rabbit/publish.js';
import { ensureTopology } from './rabbit/topology.js';
import { createWorkerDb, currentRole } from './relay/db.js';
import { runRelayLoop } from './relay/loop.js';
import { describeError, oneSendAtATime, relayOnce, type RelayProducer } from './relay/relay.js';
import { runSideBySide } from './side-by-side.js';

// Docker sends SIGKILL 10 s after SIGTERM, so give up a little before that
const SHUTDOWN_TIMEOUT_MS = 8000;

const logger = createLogger();

process.on('uncaughtException', (error) => exitWithError(error, 'Uncaught exception'));
process.on('unhandledRejection', (reason) => exitWithError(reason, 'Unhandled rejection'));

await main().catch((error: unknown) => exitWithError(error, 'Worker failed'));

async function main(): Promise<void> {
  const env = validateEnv(process.env);
  const connection = { brokers: env.KAFKA_BROKERS, clientId: env.KAFKA_CLIENT_ID };
  const relayDb = createWorkerDb(env.RELAY_DATABASE_URL, logger);
  const notifierDb = createNotifierDb(env.NOTIFIER_DATABASE_URL, logger);
  const producer = createProducer(connection);
  const consumer = createConsumer(connection, NOTIFIER);
  const publisher = new JobPublisher({
    onChannelError: (error) => exitWithError(error, 'RabbitMQ closed the job channel'),
  });
  const controller = new AbortController();
  stopOnSignals(controller);
  const closers: Closer[] = [
    () => producer.close(),
    // true: closes a stream that is still open, or leaving the group fails
    () => consumer.close(true),
    () => relayDb.$client.end(),
    () => notifierDb.$client.end(),
  ];

  try {
    await Promise.all([assertRestrictedRole(relayDb), assertRestrictedRole(notifierDb)]);
    await createTopics(connection, env);
    const rabbit = await connectRabbit(
      env.AMQP_URL,
      logger,
      (model) => setupRabbit(model, publisher),
      {
        onFatal: (error) => exitWithError(error, 'RabbitMQ refused the worker'),
      },
    );
    closers.push(() => rabbit.close());
    await runSideBySide(controller, [
      () => runRelay(relayDb, producer, env, controller.signal),
      () =>
        runNotifier({
          consumer,
          db: notifierDb,
          publish: (job) => publisher.publish(job),
          topicNames: [topics.campuses.name],
          signal: controller.signal,
          logger,
        }),
    ]);
  } finally {
    await closeAll(closers);
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

// Runs on every RabbitMQ connect: a queue deleted by hand comes back, and the publisher gets a
// new channel (amqplib brings back the connection, not its channels)
async function setupRabbit(model: ChannelModel, publisher: JobPublisher): Promise<void> {
  await ensureTopology(model, jobTopology());
  await publisher.attach(model);
  logger.info({}, 'Job topology ready');
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
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  // On every stop, so a part that failed cannot leave a half-stopped worker running either
  controller.signal.addEventListener('abort', () => {
    // unref: this timer alone must not keep the process alive after a clean stop
    setTimeout(() => {
      logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'Stopping took too long, exiting');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
  });
}

type Closer = () => Promise<void>;

// All always run: a failed close must not leave another connection open
async function closeAll(closers: Closer[]): Promise<void> {
  const results = await Promise.allSettled(closers.map((close) => close()));
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
