import { jobTopology } from '@pulse/jobs';
import type { ChannelModel } from 'amqplib';
import type { Logger } from 'pino';
import type { JobConsumer } from './consume.js';
import type { JobPublisher } from './publish.js';
import { ensureTopology } from './topology.js';

/**
 * Runs on every RabbitMQ connect: a queue deleted by hand comes back, and the publisher gets a
 * new channel and every consumer starts again (amqplib brings back the connection, not its
 * channels). Queues come first, so nothing sends to or reads from a queue that does not exist.
 */
export async function setupRabbit(
  model: ChannelModel,
  publisher: JobPublisher,
  logger: Logger,
  consumers: readonly JobConsumer[],
): Promise<void> {
  await ensureTopology(model, jobTopology());
  await publisher.attach(model);
  for (const consumer of consumers) await consumer.start(model);
  logger.info({}, 'Job topology ready');
}
