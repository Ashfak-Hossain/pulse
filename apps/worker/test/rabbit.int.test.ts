import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { jobExchanges, jobTopology, queueFor } from '@pulse/jobs';
import { connect, type ChannelModel, type ConfirmChannel } from 'amqplib';
import { inject, vi } from 'vitest';
import { createLogger } from '../src/logger.js';
import { connectRabbit } from '../src/rabbit/client.js';
import { ensureTopology } from '../src/rabbit/topology.js';
import { dropAllConnections, rabbitApi } from './support/rabbit.js';

// Short delays so a retry comes back in a test's time. The queue names are fixed, so every
// RabbitMQ test lives in this one file and runs in order
const topology = jobTopology({ delayMs: { '10s': 100, '1m': 100, '10m': 100 } });
const workQueue = queueFor('notify.email');
const silent = createLogger({ level: 'silent' });

let model: ChannelModel;
let channel: ConfirmChannel;

// A dropped connection emits error; with no listener that would crash the test run
async function openTestConnection(): Promise<void> {
  model = await connect(inject('amqpUrl'));
  model.on('error', () => {});
  channel = await model.createConfirmChannel();
}

beforeAll(async () => {
  await openTestConnection();
  await ensureTopology(model, topology);
});

afterAll(async () => {
  await model.close();
});

beforeEach(async () => {
  for (const queue of topology.queues) await channel.purgeQueue(queue.name);
});

// Waits for the broker's confirm, as every real publisher must; a nack rejects
async function publish(
  exchange: string,
  routingKey: string,
  headers: Record<string, string> = {},
): Promise<string> {
  const id = randomUUID();
  channel.publish(exchange, routingKey, Buffer.from(JSON.stringify({ id })), { headers });
  await channel.waitForConfirms();
  return id;
}

async function depth(queue: string): Promise<number> {
  return (await channel.checkQueue(queue)).messageCount;
}

describe('ensureTopology against RabbitMQ 4.4', () => {
  it('gives every queue the arguments from @pulse/jobs', async () => {
    for (const queue of topology.queues) {
      const response = await rabbitApi(`/queues/%2F/${encodeURIComponent(queue.name)}`);
      const declared = (await response.json()) as { durable: boolean; arguments: object };
      expect(declared, queue.name).toMatchObject({
        durable: true,
        arguments: queue.arguments,
      });
    }
  });

  it('changes nothing on a second run, not even the jobs waiting', async () => {
    await publish(jobExchanges.jobs, 'notify.email');
    await ensureTopology(model, topology);
    expect(await depth(workQueue)).toBe(1);
  });

  // Queue arguments are fixed once declared, so a changed topology needs a new queue name
  it('fails, without crashing, when a queue exists with other arguments', async () => {
    await expect(ensureTopology(model, jobTopology())).rejects.toThrow(/PRECONDITION_FAILED/);
  });
});

describe('connectRabbit', () => {
  const url = (): string => inject('amqpUrl');
  const onFatal = vi.fn();

  beforeEach(() => {
    onFatal.mockClear();
  });

  // amqplib brings the connection back, not what was on it: setup re-declares on every connect
  it('declares the topology again after the broker drops the connection', async () => {
    const setup = vi.fn((m: ChannelModel) => ensureTopology(m, topology));
    const connection = await connectRabbit(url(), silent, setup, { onFatal });
    try {
      expect(setup).toHaveBeenCalledTimes(1);
      await channel.deleteQueue(workQueue);
      // This test's connection and connectRabbit's
      await dropAllConnections(2);
      await vi.waitFor(
        () => expect(setup.mock.settledResults[1]).toEqual({ type: 'fulfilled', value: undefined }),
        { timeout: 10_000 },
      );

      await openTestConnection();
      await expect(channel.checkQueue(workQueue)).resolves.toMatchObject({ queue: workQueue });
    } finally {
      await connection.close();
    }
  });

  // Until amqplib adds its own listener, a socket error mid-setup has only ours; without it the
  // worker (here: the test run) would crash. A broker restart closes cleanly and emits no error,
  // so cut the socket, as a network failure would (stream is internal to amqplib)
  it('survives a network cut during setup, and tries again', async () => {
    const setup = vi.fn(async (m: ChannelModel) => {
      if (setup.mock.calls.length === 1) {
        (m.connection as unknown as { stream: Socket }).stream.destroy(new Error('network cut'));
      }
      await ensureTopology(m, topology);
    });
    const connection = await connectRabbit(url(), silent, setup, { onFatal });
    try {
      expect(setup).toHaveBeenCalledTimes(2);
      expect(setup.mock.settledResults[0]?.type).toBe('rejected');
    } finally {
      await connection.close();
    }
  });

  // Retrying forever would leave a worker that looks alive but has no queues or consumers
  it('calls onFatal when a reconnect finds a queue with other arguments', async () => {
    let declared = topology;
    const connection = await connectRabbit(url(), silent, (m) => ensureTopology(m, declared), {
      onFatal,
    });
    try {
      // The real 10 s delays clash with the 100 ms wait queues already there
      declared = jobTopology();
      await dropAllConnections(2);
      await vi.waitFor(
        () => expect(onFatal).toHaveBeenCalledWith(expect.objectContaining({ code: 406 })),
        { timeout: 15_000 },
      );
    } finally {
      await connection.close();
      await openTestConnection();
    }
  });

  // A wrong password must fail the deploy, not retry quietly forever
  it('gives up at startup when the broker refuses the login', async () => {
    const wrong = new URL(url());
    wrong.password = 'wrong';
    await expect(
      connectRabbit(wrong.href, silent, () => Promise.resolve(), { onFatal, startupRetries: 0 }),
    ).rejects.toThrow(/ACCESS.REFUSED/);
    expect(onFatal).not.toHaveBeenCalled();
  });
});
