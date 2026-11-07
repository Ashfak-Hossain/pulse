import { assertRestrictedRole } from '@pulse/db';
import { topics } from '@pulse/events';
import { validateEnv } from './config/env.js';
import { createKafkaConsumer, createKafkaProducer } from './kafka/client.js';
import { createMissingTopics } from './kafka/topics.js';
import {
  closeAll,
  exitOnUncaughtErrors,
  exitWithError,
  stopOnSignals,
  type Closer,
} from './lifecycle.js';
import { NOTIFIER } from './notifier/campus-created.js';
import { createNotifierDb, runNotifier } from './notifier/run.js';
import { connectRabbit } from './rabbit/client.js';
import { JobPublisher } from './rabbit/publish.js';
import { setupRabbit } from './rabbit/setup.js';
import { runRelay } from './relay/run.js';
import { createWorkerDb } from './shared/db.js';
import { createLogger } from './shared/logger.js';
import { runSideBySide } from './side-by-side.js';

const logger = createLogger();

exitOnUncaughtErrors(logger);

await main().catch((error: unknown) => exitWithError(logger, error, 'Worker failed'));

async function main(): Promise<void> {
  const env = validateEnv(process.env);
  const kafka = { brokers: env.KAFKA_BROKERS, clientId: env.KAFKA_CLIENT_ID };
  const relayDb = createWorkerDb(env.RELAY_DATABASE_URL, logger);
  const notifierDb = createNotifierDb(env.NOTIFIER_DATABASE_URL, logger);
  const producer = createKafkaProducer(kafka);
  const consumer = createKafkaConsumer(kafka, NOTIFIER);
  const publisher = new JobPublisher({
    onChannelError: (error) => exitWithError(logger, error, 'RabbitMQ closed the job channel'),
  });
  const controller = new AbortController();
  stopOnSignals(controller, logger);
  const closers: Closer[] = [
    () => producer.close(),
    // true: closes a stream that is still open, or leaving the group fails
    () => consumer.close(true),
    () => relayDb.$client.end(),
    () => notifierDb.$client.end(),
  ];

  try {
    await Promise.all([assertRestrictedRole(relayDb), assertRestrictedRole(notifierDb)]);
    const created = await createMissingTopics(kafka, Object.values(topics), {
      replicationFactor: env.KAFKA_REPLICATION_FACTOR,
      minInsyncReplicas: env.KAFKA_MIN_INSYNC_REPLICAS,
    });
    logger.info({ created }, 'Topics ready');
    const rabbit = await connectRabbit(
      env.AMQP_URL,
      logger,
      (model) => setupRabbit(model, publisher, logger),
      { onFatal: (error) => exitWithError(logger, error, 'RabbitMQ refused the worker') },
    );
    closers.push(() => rabbit.close());

    const { signal } = controller;
    await runSideBySide(controller, [
      () => runRelay({ db: relayDb, producer, env, signal, logger }),
      () =>
        runNotifier({
          consumer,
          db: notifierDb,
          publish: (job) => publisher.publish(job),
          topicNames: [topics.campuses.name],
          signal,
          logger,
        }),
    ]);
  } finally {
    await closeAll(closers, logger);
  }
  logger.info({}, 'Worker stopped');
}
