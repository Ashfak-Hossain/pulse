import { randomUUID } from 'node:crypto';
import { createJob, jobExchanges, jobTopology, queueFor, type PulseJob } from '@pulse/jobs';
import { connect, type Channel, type ChannelModel } from 'amqplib';
import { vi } from 'vitest';
import { connectRabbit } from '../src/rabbit/client.js';
import { JobPublisher } from '../src/rabbit/publish.js';
import { ensureTopology } from '../src/rabbit/topology.js';
import { createLogger } from '../src/shared/logger.js';
import { createVhost, dropAllConnections, rabbitApi } from './support/rabbit.js';

const vhost = 'test-publish';
const workQueue = queueFor('notify.email');
const capPolicy = `/policies/${vhost}/test-cap`;

let model: ChannelModel;
let reader: Channel;
let publisher: JobPublisher;

beforeAll(async () => {
  model = await connect(await createVhost(vhost));
  model.on('error', () => {});
  await ensureTopology(model, jobTopology());
  publisher = new JobPublisher({ onChannelError: () => {} });
  await publisher.attach(model);
  reader = await model.createChannel();
});

afterAll(async () => {
  await model.close();
});

beforeEach(async () => {
  await reader.purgeQueue(workQueue);
});

function newJob(): PulseJob {
  const campusId = randomUUID();
  return createJob(
    'notify.email',
    { template: 'campus-created', campusId },
    { jobId: randomUUID(), dedupeKey: `campus-created:${campusId}`, createdAt: new Date() },
  );
}

describe('JobPublisher against RabbitMQ 4.4', () => {
  it('resolves once the broker has the job, which then waits in its queue', async () => {
    const job = newJob();
    await publisher.publish(job);
    const message = await reader.get(workQueue, { noAck: true });
    expect(message).not.toBe(false);
    if (message === false) return;
    expect(JSON.parse(message.content.toString())).toEqual(job);
    expect(message.properties).toMatchObject({
      deliveryMode: 2,
      messageId: job.jobId,
      contentType: 'application/json',
    });
  });

  // reject-publish on a full queue: the publisher hears no, so the job is never dropped silently
  describe('with its queue full', () => {
    beforeEach(async () => {
      await rabbitApi(capPolicy, 'PUT', {
        pattern: `^${workQueue.replaceAll('.', '\\.')}$`,
        definition: { 'max-length': 0 },
        'apply-to': 'queues',
      });
      await vi.waitFor(
        async () => {
          const queue = (await (
            await rabbitApi(`/queues/${vhost}/${encodeURIComponent(workQueue)}`)
          ).json()) as { policy?: string };
          expect(queue.policy).toBe('test-cap');
        },
        { timeout: 10_000, interval: 250 },
      );
      // A quorum queue takes one job past its cap before it refuses (measured on 4.4)
      await publisher.publish(newJob());
    });

    afterEach(async () => {
      await rabbitApi(capPolicy, 'DELETE').catch(() => undefined);
    });

    it('rejects the publish', async () => {
      await expect(publisher.publish(newJob())).rejects.toThrow(/nacked/);
    });
  });
});

// Their own vhosts: one drops every connection to it, the other deletes the jobs exchange
describe('JobPublisher when RabbitMQ breaks the channel', () => {
  // amqplib brings back the connection, not its channels: the worker's setup attaches a new one
  it('publishes again after the connection drops, without reporting a channel error', async () => {
    const reconnectVhost = 'test-publish-reconnect';
    const url = await createVhost(reconnectVhost);
    const onChannelError = vi.fn();
    const reconnecting = new JobPublisher({ onChannelError });
    const connection = await connectRabbit(
      url,
      createLogger({ level: 'silent' }),
      async (m) => {
        await ensureTopology(m, jobTopology());
        await reconnecting.attach(m);
      },
      { onFatal: () => {} },
    );
    try {
      await reconnecting.publish(newJob());
      await dropAllConnections(1, reconnectVhost);
      // Refused while the connection is down, confirmed once setup has attached a new channel
      await vi.waitFor(() => reconnecting.publish(newJob()), { timeout: 15_000, interval: 200 });
      expect(onChannelError).not.toHaveBeenCalled();
      const channel = await connection.createChannel();
      expect((await channel.checkQueue(workQueue)).messageCount).toBe(2);
    } finally {
      await connection.close();
    }
  });

  // The connection stays up, so no reconnect will ever replace this channel: the worker has to
  // hear about it, or every retry would fail until someone restarts it
  it('reports a channel the broker closes, with the reason', async () => {
    const brokenVhost = 'test-publish-broken';
    const broken = await connect(await createVhost(brokenVhost));
    broken.on('error', () => {});
    const onChannelError = vi.fn();
    const breaking = new JobPublisher({ onChannelError });
    try {
      await ensureTopology(broken, jobTopology());
      await breaking.attach(broken);
      await rabbitApi(`/exchanges/${brokenVhost}/${jobExchanges.jobs}`, 'DELETE');

      await expect(breaking.publish(newJob())).rejects.toThrow();
      await vi.waitFor(() => expect(onChannelError).toHaveBeenCalledOnce());
      expect(onChannelError).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('NOT_FOUND') as string }),
      );
      await expect(breaking.publish(newJob())).rejects.toThrow(/no RabbitMQ channel/i);
    } finally {
      await broken.close();
    }
  });
});
