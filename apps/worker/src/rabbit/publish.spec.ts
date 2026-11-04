import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createJob, jobExchanges, type PulseJob } from '@pulse/jobs';
import type { ConfirmChannel, Options } from 'amqplib';
import { JobPublisher, type JobPublisherOptions } from './publish.js';

type Confirm = (error: unknown) => void;

// Stands in for amqplib's confirm channel: records each publish and lets the test answer it
class FakeChannel extends EventEmitter {
  readonly sent: { exchange: string; key: string; body: unknown; options: Options.Publish }[] = [];
  readonly confirms: Confirm[] = [];

  publish(exchange: string, key: string, content: Buffer, options: Options.Publish, cb: Confirm) {
    this.sent.push({ exchange, key, body: JSON.parse(content.toString()) as unknown, options });
    this.confirms.push(cb);
    return true;
  }

  confirm(index: number, error: unknown = null): void {
    this.confirms[index]?.(error);
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

const newPublisher = (options: Partial<JobPublisherOptions> = {}): JobPublisher =>
  new JobPublisher({ onChannelError: vi.fn(), ...options });

async function attached(
  options?: Partial<JobPublisherOptions>,
): Promise<{ publisher: JobPublisher; channel: FakeChannel }> {
  const channel = new FakeChannel();
  const publisher = newPublisher(options);
  await publisher.attach({
    createConfirmChannel: () => Promise.resolve(channel as unknown as ConfirmChannel),
  });
  return { publisher, channel };
}

describe('JobPublisher', () => {
  it('sends a job to the jobs exchange under its type, persistent, and waits for the ack', async () => {
    const { publisher, channel } = await attached();
    const job = newJob();
    let settled = false;
    const publishing = publisher.publish(job).then(() => (settled = true));

    await vi.waitFor(() => expect(channel.sent).toHaveLength(1));
    expect(channel.sent[0]).toEqual({
      exchange: jobExchanges.jobs,
      key: 'notify.email',
      body: job,
      options: expect.objectContaining({
        persistent: true,
        mandatory: true,
        contentType: 'application/json',
        messageId: job.jobId,
      }) as unknown,
    });
    expect(settled).toBe(false);
    channel.confirm(0);
    await publishing;
    expect(settled).toBe(true);
  });

  it('fails when the broker nacks the job (a full queue, say)', async () => {
    const { publisher, channel } = await attached();
    const publishing = publisher.publish(newJob());
    await vi.waitFor(() => expect(channel.confirms).toHaveLength(1));
    channel.confirm(0, new Error('message nacked'));
    await expect(publishing).rejects.toThrow(/nacked/);
  });

  // mandatory: true. Only when the alternate route has no queue either: RabbitMQ sends the job
  // back before it acks it
  it('fails when the broker returns the job as unroutable, though it acks it', async () => {
    const { publisher, channel } = await attached();
    const job = newJob();
    const publishing = publisher.publish(job);
    await vi.waitFor(() => expect(channel.confirms).toHaveLength(1));
    channel.emit('return', { properties: { messageId: job.jobId } });
    channel.confirm(0);
    await expect(publishing).rejects.toThrow(/returned/);
  });

  it('fails when no confirm comes in time', async () => {
    const { publisher } = await attached({ confirmTimeoutMs: 20 });
    await expect(publisher.publish(newJob())).rejects.toThrow(/did not confirm/);
  });

  it('fails at once with no channel: before the first connect, and after the channel closes', async () => {
    await expect(newPublisher().publish(newJob())).rejects.toThrow(/no RabbitMQ channel/i);

    const { publisher, channel } = await attached();
    channel.emit('close');
    await expect(publisher.publish(newJob())).rejects.toThrow(/no RabbitMQ channel/i);
    expect(channel.sent).toHaveLength(0);
  });

  // amqplib brings back the connection, not its channels: setup attaches a new one each time
  it('publishes on the channel from the latest connect', async () => {
    const { publisher, channel: first } = await attached();
    const second = new FakeChannel();
    await publisher.attach({
      createConfirmChannel: () => Promise.resolve(second as unknown as ConfirmChannel),
    });
    // The old channel closing late must not detach the new one
    first.emit('close');

    const publishing = publisher.publish(newJob());
    await vi.waitFor(() => expect(second.sent).toHaveLength(1));
    second.confirm(0);
    await expect(publishing).resolves.toBeUndefined();
    expect(first.sent).toHaveLength(0);
  });

  // The broker closed the channel and left the connection up, so no reconnect will replace it.
  // A plain close (a dropped connection, a shutdown) is not reported: reconnecting handles that
  it('reports a channel error, but not a plain close', async () => {
    const onChannelError = vi.fn();
    const { channel } = await attached({ onChannelError });
    channel.emit('close');
    expect(onChannelError).not.toHaveBeenCalled();

    const error = new Error('NOT_FOUND');
    channel.emit('error', error);
    expect(onChannelError).toHaveBeenCalledWith(error);
  });
});
