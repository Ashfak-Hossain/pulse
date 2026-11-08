import { assertRestrictedRole } from '@pulse/db';
import { topics } from '@pulse/events';
import { validateEnv } from './config/env.js';
import { createKafkaConsumer, createKafkaProducer } from './kafka/client.js';
import { connectAndEnsureTopics } from './kafka/topics.js';
import {
  closeAll,
  exitIfStopHangs,
  exitOnUncaughtErrors,
  exitWithError,
  stopOnSignals,
  type Closer,
} from './lifecycle.js';
import { createMailer, createMailerDb } from './mailer/run.js';
import { createSmtpSender } from './mailer/smtp.js';
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
  const kafkaSettings = { brokers: env.KAFKA_BROKERS, clientId: env.KAFKA_CLIENT_ID };
  // The relay's pool has no time limits: it holds a transaction while Kafka answers
  const relayDb = createWorkerDb(env.RELAY_DATABASE_URL, logger);
  const notifierDb = createNotifierDb(env.NOTIFIER_DATABASE_URL, logger);
  const mailerDb = createMailerDb(env.MAILER_DATABASE_URL, logger);
  const smtp = createSmtpSender(env.SMTP_URL, env.MAIL_FROM);
  const producer = createKafkaProducer(kafkaSettings);
  const consumer = createKafkaConsumer(kafkaSettings, NOTIFIER);
  const publisher = new JobPublisher({
    onChannelError: (error) => exitWithError(logger, error, 'RabbitMQ closed the job channel'),
  });
  const mailer = createMailer({
    deps: { db: mailerDb, sendMail: smtp.send, opsMailTo: env.OPS_MAIL_TO },
    logger,
    onChannelError: (error) => exitWithError(logger, error, 'RabbitMQ closed the mail channel'),
  });
  const controller = new AbortController();
  stopOnSignals(controller, logger);
  exitIfStopHangs(controller, logger);
  const closers: Closer[] = [
    () => producer.close(),
    // true: closes a stream that is still open, or leaving the group fails
    () => consumer.close(true),
    () => relayDb.$client.end(),
    () => notifierDb.$client.end(),
    () => mailerDb.$client.end(),
    () => Promise.resolve(smtp.close()),
  ];

  try {
    await Promise.all([
      assertRestrictedRole(relayDb),
      assertRestrictedRole(notifierDb),
      assertRestrictedRole(mailerDb),
    ]);
    const created = await connectAndEnsureTopics(kafkaSettings, Object.values(topics), {
      replicationFactor: env.KAFKA_REPLICATION_FACTOR,
      minInsyncReplicas: env.KAFKA_MIN_INSYNC_REPLICAS,
    });
    logger.info({ created }, 'Topics ready');
    const rabbit = await connectRabbit(
      env.AMQP_URL,
      logger,
      (model) => setupRabbit(model, publisher, logger, [mailer]),
      { onFatal: (error) => exitWithError(logger, error, 'RabbitMQ refused the worker') },
    );
    closers.push(() => rabbit.close());

    const { signal } = controller;
    await runSideBySide(controller, [
      () =>
        runRelay({
          db: relayDb,
          producer,
          batchSize: env.RELAY_BATCH_SIZE,
          pollMs: env.RELAY_POLL_MS,
          signal,
          logger,
        }),
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
    // Before closeAll, which closes everything at once: emails being sent need RabbitMQ and the pool
    await mailer.stop();
    await closeAll(closers, logger);
  }
  logger.info({}, 'Worker stopped');
}
