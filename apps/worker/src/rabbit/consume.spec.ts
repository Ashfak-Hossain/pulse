import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createJob, jobExchanges, jobHeaders, type PulseJob } from '@pulse/jobs';
import type { ConfirmChannel, ConsumeMessage, Options } from 'amqplib';
import { JobConsumer, PermanentJobError, type JobConsumerOptions } from './consume.js';

type Confirm = (error: unknown) => void;

// Stands in for amqplib's confirm channel: records what the consumer does to each message
class FakeChannel extends EventEmitter {
  onMessage: ((message: ConsumeMessage | null) => void) | undefined;
  readonly acked: ConsumeMessage[] = [];
  readonly nacked: { message: ConsumeMessage; requeue: boolean | undefined }[] = [];
  readonly sent: { exchange: string; key: string; content: Buffer; options: Options.Publish }[] =
    [];
  readonly confirms: Confirm[] = [];
  prefetchCount = 0;
  consumedFrom = '';
  readonly nackAttempts: ConsumeMessage[] = [];
  cancelled = false;
  closed = false;

  // Like amqplib's ConfirmChannel: its own close listener, added first, fails every pending
  // confirm with "channel closed"
  constructor() {
    super();
    this.on('close', () => {
      const pending = this.confirms.splice(0);
      for (const confirm of pending) confirm(new Error('channel closed'));
    });
  }

  // The broker or the network closes the channel
  drop(): void {
    this.closed = true;
    this.emit('close');
  }

  prefetch(count: number): Promise<void> {
    this.prefetchCount = count;
    return Promise.resolve();
  }

  consume(queue: string, onMessage: (message: ConsumeMessage | null) => void) {
    this.consumedFrom = queue;
    this.onMessage = onMessage;
    return Promise.resolve({ consumerTag: 'tag-1' });
  }

  ack(message: ConsumeMessage): void {
    if (this.closed) throw new Error('Channel closed');
    this.acked.push(message);
  }

  nack(message: ConsumeMessage, _allUpTo?: boolean, requeue?: boolean): void {
    this.nackAttempts.push(message);
    if (this.closed) throw new Error('Channel closed');
    this.nacked.push({ message, requeue });
  }

  publish(exchange: string, key: string, content: Buffer, options: Options.Publish, cb: Confirm) {
    this.sent.push({ exchange, key, content, options });
    this.confirms.push(cb);
    return true;
  }

  cancel(): Promise<void> {
    this.cancelled = true;
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.drop();
    return Promise.resolve();
  }
}

function newJob(): PulseJob {
  const campusId = randomUUID();
  return createJob(
    'notify.email',
    { template: 'campus-created', campusId },
    { jobId: randomUUID(), dedupeKey: `campus-created:${campusId}`, createdAt: new Date() },
  );
}

function messageOf(body: unknown, headers: Record<string, unknown> = {}): ConsumeMessage {
  const content = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return {
    content,
    fields: { deliveryTag: 1, redelivered: false, exchange: 'jobs', routingKey: 'notify.email' },
    // An expiration the retry must not copy: the job could expire in its wait queue
    properties: { headers, expiration: '60000', messageId: 'm' },
  } as unknown as ConsumeMessage;
}

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

async function started(options: Partial<JobConsumerOptions> = {}) {
  const channels: FakeChannel[] = [];
  const opener = {
    createConfirmChannel: () => {
      const channel = new FakeChannel();
      channels.push(channel);
      return Promise.resolve(channel as unknown as ConfirmChannel);
    },
  };
  const consumer = new JobConsumer({
    queue: 'q.notify.email',
    prefetch: 10,
    handle: vi.fn(() => Promise.resolve()),
    logger: logger(),
    onChannelError: vi.fn(),
    confirmTimeoutMs: 50,
    ...options,
  });
  await consumer.start(opener);
  const channel = channels[0];
  if (!channel) throw new Error('no channel');
  const deliver = (message: ConsumeMessage) => channel.onMessage?.(message);
  return { consumer, channel, channels, deliver };
}

describe('JobConsumer', () => {
  it('reads its queue with the prefetch it was given', async () => {
    const { channel } = await started();
    expect(channel.consumedFrom).toBe('q.notify.email');
    expect(channel.prefetchCount).toBe(10);
  });

  // Only with LOG_LEVEL=debug (development): pino drops debug lines at the default level
  it('shows the whole job at debug level', async () => {
    const log = { ...logger(), debug: vi.fn() };
    const { deliver } = await started({ logger: log });
    const job = newJob();
    deliver(messageOf(job));
    await vi.waitFor(() =>
      expect(log.debug).toHaveBeenCalledWith(
        { queue: 'q.notify.email', failures: 0, job },
        'RabbitMQ job received',
      ),
    );
  });

  it('acks a job only after its handler finished', async () => {
    let finish: () => void = () => undefined;
    const handle = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const { channel, deliver } = await started({ handle });
    const job = newJob();
    deliver(messageOf(job));

    await vi.waitFor(() => expect(handle).toHaveBeenCalledWith(job));
    expect(channel.acked).toHaveLength(0);
    finish();
    await vi.waitFor(() => expect(channel.acked).toHaveLength(1));
    expect(channel.nacked).toHaveLength(0);
  });

  // Retrying cannot fix any of these; jobs.dead keeps them for a person to look at
  it.each([
    ['not JSON', '{oops', {}],
    ['an unknown type', { ...newJob(), type: 'notify.fax' }, {}],
    ['a broken envelope', { jobId: 'x' }, {}],
    ['an unreadable failure count', newJob(), { [jobHeaders.failures]: 'many' }],
  ])('dead-letters %s without running the handler', async (_case, body, headers) => {
    const handle = vi.fn(() => Promise.resolve());
    const log = logger();
    const { channel, deliver } = await started({ handle, logger: log });
    deliver(messageOf(body, headers));

    await vi.waitFor(() => expect(channel.nacked).toHaveLength(1));
    expect(channel.nacked[0]?.requeue).toBe(false);
    expect(handle).not.toHaveBeenCalled();
    expect(channel.sent).toHaveLength(0);
    // Where and why, never what: the body can hold ids we do not log as text
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('oops');
  });

  it('sends a failed job to the first wait queue and acks once the broker has the copy', async () => {
    const handle = vi.fn(() => Promise.reject(new Error('SMTP down')));
    const { channel, deliver } = await started({ handle });
    const job = newJob();
    const message = messageOf(job);
    deliver(message);

    await vi.waitFor(() => expect(channel.sent).toHaveLength(1));
    const sent = channel.sent[0];
    expect(sent?.exchange).toBe(jobExchanges.retry);
    expect(sent?.key).toBe('notify.email');
    expect(sent?.content.equals(message.content)).toBe(true);
    expect(sent?.options).toEqual({
      persistent: true,
      contentType: 'application/json',
      messageId: job.jobId,
      headers: { [jobHeaders.failures]: 1, [jobHeaders.retryTier]: '10s' },
    });
    expect(channel.acked).toHaveLength(0);
    channel.confirms[0]?.(null);
    await vi.waitFor(() => expect(channel.acked).toHaveLength(1));
    expect(channel.nacked).toHaveLength(0);
  });

  it('counts on from the failures header', async () => {
    const handle = vi.fn(() => Promise.reject(new Error('SMTP down')));
    const { channel, deliver } = await started({ handle });
    deliver(messageOf(newJob(), { [jobHeaders.failures]: 2, 'x-death': [{ count: 2 }] }));

    await vi.waitFor(() => expect(channel.sent).toHaveLength(1));
    expect(channel.sent[0]?.options.headers).toEqual({
      [jobHeaders.failures]: 3,
      [jobHeaders.retryTier]: '10m',
    });
  });

  it('dead-letters a job that fails after its last wait', async () => {
    const handle = vi.fn(() => Promise.reject(new Error('SMTP down')));
    const log = logger();
    const { channel, deliver } = await started({ handle, logger: log });
    deliver(messageOf(newJob(), { [jobHeaders.failures]: 3 }));

    await vi.waitFor(() => expect(channel.nacked).toHaveLength(1));
    expect(channel.nacked[0]?.requeue).toBe(false);
    expect(channel.sent).toHaveLength(0);
    expect(log.error).toHaveBeenCalled();
  });

  it('dead-letters a permanent failure at once', async () => {
    const handle = vi.fn(() => Promise.reject(new PermanentJobError('SMTP 550')));
    const { channel, deliver } = await started({ handle });
    deliver(messageOf(newJob()));

    await vi.waitFor(() => expect(channel.nacked).toHaveLength(1));
    expect(channel.nacked[0]?.requeue).toBe(false);
    expect(channel.sent).toHaveLength(0);
  });

  // A full shared wait queue nacks every type's retries; give up loudly rather than loop
  it('dead-letters the job when the broker refuses its retry copy', async () => {
    const handle = vi.fn(() => Promise.reject(new Error('SMTP down')));
    const log = logger();
    const { channel, deliver } = await started({ handle, logger: log });
    deliver(messageOf(newJob()));

    await vi.waitFor(() => expect(channel.confirms).toHaveLength(1));
    channel.confirms[0]?.(new Error('message nacked'));
    await vi.waitFor(() => expect(channel.nacked).toHaveLength(1));
    expect(channel.nacked[0]?.requeue).toBe(false);
    expect(channel.acked).toHaveLength(0);
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ retryRefused: true }),
      expect.any(String),
    );
  });

  // Nacking here could leave the job both in jobs.dead and in a wait queue
  it('closes the channel and opens a new one when the retry is never confirmed', async () => {
    const handle = vi.fn(() => Promise.reject(new Error('SMTP down')));
    const { channel, channels, deliver } = await started({ handle });
    deliver(messageOf(newJob()));

    await vi.waitFor(() => expect(channel.closed).toBe(true));
    expect(channel.acked).toHaveLength(0);
    expect(channel.nacked).toHaveLength(0);
    await vi.waitFor(() => expect(channels).toHaveLength(2));
    expect(channels[1]?.consumedFrom).toBe('q.notify.email');
  });

  // The broker hands the unacked job out again, and that counts toward x-delivery-limit
  it('leaves the job alone when the channel drops while it waits for a confirm', async () => {
    const handle = vi.fn(() => Promise.reject(new Error('SMTP down')));
    const log = logger();
    const { channel, deliver } = await started({ handle, logger: log });
    deliver(messageOf(newJob()));

    await vi.waitFor(() => expect(channel.confirms).toHaveLength(1));
    channel.drop();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(channel.acked).toHaveLength(0);
    expect(channel.nackAttempts).toHaveLength(0);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('does not crash when the channel is gone by the time a handler finishes', async () => {
    let finish: () => void = () => undefined;
    const handle = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const { channel, deliver } = await started({ handle });
    deliver(messageOf(newJob()));
    await vi.waitFor(() => expect(handle).toHaveBeenCalled());

    channel.drop();
    finish();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(channel.acked).toHaveLength(0);
  });

  it('on stop, cancels the consumer and waits for running handlers', async () => {
    let finish: () => void = () => undefined;
    const handle = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const { consumer, channel, deliver } = await started({ handle });
    deliver(messageOf(newJob()));
    await vi.waitFor(() => expect(handle).toHaveBeenCalled());

    let stopped = false;
    const stopping = consumer.stop().then(() => (stopped = true));
    await vi.waitFor(() => expect(channel.cancelled).toBe(true));
    expect(stopped).toBe(false);
    finish();
    await stopping;
    expect(channel.acked).toHaveLength(1);
  });

  it('closes a channel that finished opening after stop, so nothing reads during shutdown', async () => {
    let open: (channel: ConfirmChannel) => void = () => undefined;
    const late = new FakeChannel();
    const consumer = new JobConsumer({
      queue: 'q.notify.email',
      prefetch: 10,
      handle: vi.fn(() => Promise.resolve()),
      logger: logger(),
      onChannelError: vi.fn(),
    });
    // A reconnect's setup is opening a channel when the worker is told to stop
    const starting = consumer.start({
      createConfirmChannel: () => new Promise<ConfirmChannel>((resolve) => (open = resolve)),
    });
    await consumer.stop();
    open(late as unknown as ConfirmChannel);
    await starting;
    expect(late.closed).toBe(true);
    expect(late.onMessage).toBeUndefined();
  });

  it('cancels every consumer it started when it stops', async () => {
    const { consumer, channels } = await started();
    const opener = {
      createConfirmChannel: () => {
        const channel = new FakeChannel();
        channels.push(channel);
        return Promise.resolve(channel as unknown as ConfirmChannel);
      },
    };
    // A reconnect's setup and a reopen can overlap and leave two live channels
    await consumer.start(opener);
    await consumer.stop();
    expect(channels.map((channel) => channel.cancelled)).toEqual([true, true]);
  });

  it('reports a channel the broker closed with an error, but not one closed while stopping', async () => {
    const onChannelError = vi.fn();
    const { consumer, channel } = await started({ onChannelError });
    channel.emit('error', new Error('PRECONDITION_FAILED'));
    expect(onChannelError).toHaveBeenCalledTimes(1);

    await consumer.stop();
    channel.emit('error', new Error('late'));
    expect(onChannelError).toHaveBeenCalledTimes(1);
  });
});
