import type { Topology } from '@pulse/jobs';
import type { ChannelModel } from 'amqplib';

// A plain connection and a recovering one both open channels this way
export type ChannelOpener = Pick<ChannelModel, 'createChannel'>;

/**
 * Declares every exchange, queue and binding in the topology. Declaring one that exists with
 * the same arguments changes nothing, so this runs on every connect.
 */

export async function ensureTopology(opener: ChannelOpener, topology: Topology): Promise<void> {
  const channel = await opener.createChannel();

  // A refused declare closes the channel and rejects the await below, which reports it. With no
  // listener, the channel's error event would throw inside amqplib and crash the worker
  channel.on('error', () => {});

  // Exchanges first: queues and bindings name them. One call at a time, as a channel needs
  for (const exchange of topology.exchanges) {
    await channel.assertExchange(exchange.name, exchange.type, {
      durable: exchange.durable,
      arguments: exchange.arguments,
    });
  }
  for (const queue of topology.queues) {
    await channel.assertQueue(queue.name, {
      durable: queue.durable,
      arguments: queue.arguments,
    });
  }
  for (const binding of topology.bindings) {
    await channel.bindQueue(binding.queue, binding.exchange, binding.routingKey, binding.arguments);
  }
  // Only on success: after a refused declare the broker has closed the channel already
  await channel.close();
}
