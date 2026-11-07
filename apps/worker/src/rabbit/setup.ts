import { jobTopology } from '@pulse/jobs';
import type { ChannelModel } from 'amqplib';
import type { Logger } from 'pino';
import type { JobPublisher } from './publish.js';
import { ensureTopology } from './topology.js';

/**
 * Runs on every RabbitMQ connect: a queue deleted by hand comes back, and the publisher gets a
 * new channel (amqplib brings back the connection, not its channels). Queues come first, so the
 * publisher cannot send before they exist.
 */
export async function setupRabbit(
  model: ChannelModel,
  publisher: JobPublisher,
  logger: Logger,
): Promise<void> {
  await ensureTopology(model, jobTopology());
  await publisher.attach(model);
  logger.info({}, 'Job topology ready');
}
