import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import {
  jobExchanges,
  jobHeaders,
  jobQueues,
  jobTopology,
  queueFor,
  retryTiers,
  waitQueueFor,
} from '@pulse/jobs';
import { connect, type ChannelModel, type ConfirmChannel, type GetMessage } from 'amqplib';
import { inject, vi } from 'vitest';
import { connectRabbit } from '../src/rabbit/client.js';
import { ensureTopology } from '../src/rabbit/topology.js';
import { createLogger } from '../src/shared/logger.js';
import { dropAllConnections, rabbitApi } from './support/rabbit.js';

// Short delays so a retry comes back in a test's time. The queue names are fixed: this file
// owns the default vhost, and other files make their own (createVhost)
const topology = jobTopology({ delayMs: { '10s': 100, '1m': 100, '10m': 100 } });
const workQueue = queueFor('notify.email');
const silent = createLogger({ level: 'silent' });
const capPolicy = '/policies/%2F/test-cap';

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

// Acked on delivery, unless the test settles it itself (ack: false)
async function takeOne(queue: string, { ack = true } = {}): Promise<GetMessage> {
  return vi.waitFor(
    async () => {
      const message = await channel.get(queue, { noAck: ack });
      if (message === false) throw new Error(`${queue} is empty`);
      return message;
    },
    { timeout: 5000, interval: 50 },
  );
}

const idOf = (message: GetMessage): unknown =>
  (JSON.parse(message.content.toString()) as { id: unknown }).id;

const headerOf = (message: GetMessage, name: string): unknown => message.properties.headers?.[name];

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

describe('job routes', () => {
  it('sends a job to the queue of its type, and nowhere else', async () => {
    const id = await publish(jobExchanges.jobs, 'notify.email');
    expect(idOf(await takeOne(workQueue))).toBe(id);
    expect(await depth(jobQueues.dead)).toBe(0);
  });

  it.each(retryTiers.map((tier) => tier.name))(
    'brings a job back home with its own key after the %s wait',
    async (tier) => {
      const id = await publish(jobExchanges.retry, 'notify.email', {
        [jobHeaders.retryTier]: tier,
      });
      const message = await takeOne(workQueue);
      expect(idOf(message)).toBe(id);
      expect(message.fields.routingKey).toBe('notify.email');
      expect(headerOf(message, 'x-death')).toEqual([
        expect.objectContaining({ queue: waitQueueFor(tier), reason: 'expired' }),
      ]);
    },
  );

  it('sends a job its handler rejects to jobs.dead', async () => {
    const id = await publish(jobExchanges.jobs, 'notify.email');
    channel.nack(await takeOne(workQueue, { ack: false }), false, false);
    const dead = await takeOne(jobQueues.dead);
    expect(idOf(dead)).toBe(id);
    expect(headerOf(dead, 'x-first-death-queue')).toBe(workQueue);
    expect(headerOf(dead, 'x-first-death-reason')).toBe('rejected');
  });

  it.each([
    ['a type with no queue', jobExchanges.jobs, 'notify.sms', {}],
    ['an unknown retry tier', jobExchanges.retry, 'notify.email', { [jobHeaders.retryTier]: '5m' }],
    ['no retry tier', jobExchanges.retry, 'notify.email', {}],
  ])('sends %s to jobs.dead (alternate exchange)', async (_case, exchange, key, headers) => {
    const id = await publish(exchange, key, headers);
    expect(idOf(await takeOne(jobQueues.dead))).toBe(id);
  });

  // Without the alternate exchange, the wait queue would keep trying to send it home forever
  it('sends a retried job with no home queue from its wait queue to jobs.dead', async () => {
    const id = await publish(jobExchanges.retry, 'notify.sms', { [jobHeaders.retryTier]: '10s' });
    expect(idOf(await takeOne(jobQueues.dead))).toBe(id);
    expect(await depth(waitQueueFor('10s'))).toBe(0);
  });

  // A handler that dies mid-job: its channel closes with the job unacked, so the job returns
  async function crashOn(queue: string): Promise<void> {
    const crashing = await model.createChannel();
    await vi.waitFor(
      async () => {
        if ((await crashing.get(queue)) === false) throw new Error(`${queue} is empty`);
      },
      { timeout: 5000, interval: 50 },
    );
    await crashing.close();
  }

  // x-delivery-limit 5: a job that keeps crashing its handler stops after five returns
  it('sends a job to jobs.dead on its 6th crash, not before', async () => {
    const id = await publish(jobExchanges.jobs, 'notify.email');
    for (let crashes = 1; crashes <= 5; crashes++) {
      await crashOn(workQueue);
      expect(await depth(jobQueues.dead), `after crash ${crashes}`).toBe(0);
    }
    await crashOn(workQueue);
    const dead = await takeOne(jobQueues.dead);
    expect(idOf(dead)).toBe(id);
    expect(headerOf(dead, 'x-first-death-reason')).toBe('delivery_limit');
    expect(await depth(workQueue)).toBe(0);
  });

  // RabbitMQ 4 counts only crashes. A handler that requeues a failed job would loop forever,
  // so failures go through the retry tiers instead
  it('never dead-letters a job that is only requeued', async () => {
    await publish(jobExchanges.jobs, 'notify.email');
    for (let requeues = 1; requeues <= 7; requeues++) {
      channel.nack(await takeOne(workQueue, { ack: false }), false, true);
    }
    expect(await takeOne(workQueue)).toBeTruthy();
    expect(await depth(jobQueues.dead)).toBe(0);
  });
});

// A policy lowers the cap of jobs.dead to 0 (the lower of policy and argument wins), so "full"
// needs no 100,000 jobs. The wait queues have the same arguments (checked above); a filler there
// would leave after its 100 ms wait, so they are not filled here
describe('a full jobs.dead', () => {
  // The management API refreshes queue stats about every 5 s
  const statsTimeout = { timeout: 10_000, interval: 250 };

  async function queueStats(queue: string): Promise<unknown> {
    return (await rabbitApi(`/queues/%2F/${encodeURIComponent(queue)}`)).json();
  }

  beforeEach(async () => {
    await rabbitApi(capPolicy, 'PUT', {
      pattern: '^jobs\\.dead$',
      definition: { 'max-length': 0 },
      'apply-to': 'queues',
    });
    await vi.waitFor(async () => {
      expect(await queueStats(jobQueues.dead)).toMatchObject({ policy: 'test-cap' });
    }, statsTimeout);
    // A quorum queue takes one job past its cap before it refuses (measured on 4.4)
    await publish(jobExchanges.jobs, 'notify.sms');
  });

  afterEach(async () => {
    await rabbitApi(capPolicy, 'DELETE').catch(() => undefined);
  });

  it('nacks an unroutable job, so its publisher knows', async () => {
    await expect(publish(jobExchanges.jobs, 'notify.sms')).rejects.toThrow(/nacked/);
  });

  // At-least-once dead-lettering: the job waits where it was, out of the handlers' sight. The
  // broker tries again every 180 s (measured on 4.4), too slow to wait for here
  it('keeps a rejected job in its work queue, never drops it', async () => {
    await publish(jobExchanges.jobs, 'notify.email');
    channel.nack(await takeOne(workQueue, { ack: false }), false, false);
    await vi.waitFor(async () => {
      expect(await queueStats(workQueue)).toMatchObject({ messages: 1 });
    }, statsTimeout);
    expect(await channel.get(workQueue)).toBe(false);
    expect(await depth(jobQueues.dead)).toBe(1);
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
