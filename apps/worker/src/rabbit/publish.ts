import { jobExchanges, type PulseJob } from '@pulse/jobs';
import type { ChannelModel, ConfirmChannel, Message } from 'amqplib';

// Long enough for a quorum queue to replicate on a busy broker; short enough that a stuck
// channel shows up as a failed publish (and a retry) instead of a hung consumer
const CONFIRM_TIMEOUT_MS = 5000;

export interface JobPublisherOptions {
  confirmTimeoutMs?: number;
  // The broker closed the channel and kept the connection (the exchange is gone, say, or a right
  // was revoked). No reconnect will replace this channel, so the worker should exit and restart
  onChannelError: (error: Error) => void;
}

// A plain connection and a recovering one both open confirm channels this way
export type ConfirmChannelOpener = Pick<ChannelModel, 'createConfirmChannel'>;

/**
 * Publishes jobs and resolves only once RabbitMQ has them. amqplib brings back the connection,
 * not its channels, so the RabbitMQ setup calls `attach` after every connect.
 */
export class JobPublisher {
  readonly #confirmTimeoutMs: number;
  readonly #onChannelError: (error: Error) => void;
  #channel: ConfirmChannel | undefined;
  // Jobs the broker sent back because no queue took them. RabbitMQ sends the return before the
  // ack of the same job, so the confirm callback finds the id here
  readonly #returned = new Set<string>();

  constructor({ confirmTimeoutMs = CONFIRM_TIMEOUT_MS, onChannelError }: JobPublisherOptions) {
    this.#confirmTimeoutMs = confirmTimeoutMs;
    this.#onChannelError = onChannelError;
  }

  async attach(opener: ConfirmChannelOpener): Promise<void> {
    const channel = await opener.createConfirmChannel();
    // Only the broker closing the channel emits this; a dropped connection is just a close. Jobs
    // in flight fail through their confirm callback
    channel.on('error', (error: Error) => this.#onChannelError(error));
    channel.on('close', () => {
      // A late close of an old channel must not detach the one a reconnect just attached
      if (this.#channel === channel) this.#channel = undefined;
    });
    channel.on('return', (message: Message) => {
      this.#returned.add(String(message.properties.messageId));
    });
    this.#channel = channel;
  }

  /** Resolves when the broker confirms the job; rejects on a nack, a return or no confirm. */
  async publish(job: PulseJob): Promise<void> {
    const channel = this.#channel;
    if (channel === undefined) throw new Error('No RabbitMQ channel (reconnecting)');

    const confirmed = new Promise<void>((resolve, reject) => {
      channel.publish(
        jobExchanges.jobs,
        job.type,
        Buffer.from(JSON.stringify(job)),
        {
          // Survives a broker restart
          persistent: true,
          // A type with no queue goes to jobs.dead (alternate exchange) and is confirmed. Only if
          // that route has no queue either does the broker send the job back
          mandatory: true,
          contentType: 'application/json',
          messageId: job.jobId,
        },
        (error: unknown) => {
          if (this.#returned.delete(job.jobId)) {
            reject(new Error(`RabbitMQ returned job ${job.type}: no queue took it`));
          } else if (error) {
            reject(new Error(`RabbitMQ nacked job ${job.type}`, { cause: error }));
          } else {
            resolve();
          }
        },
      );
    });

    try {
      await withTimeout(
        confirmed,
        this.#confirmTimeoutMs,
        `RabbitMQ did not confirm job ${job.type} within ${this.#confirmTimeoutMs} ms`,
      );
    } finally {
      // A return with no confirm (the timeout won) would otherwise stay in the set for good
      this.#returned.delete(job.jobId);
    }
  }
}

// Promise.race keeps listening to `work`, so a confirm that comes after the timeout is not an
// unhandled rejection
async function withTimeout(work: Promise<void>, ms: number, message: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
