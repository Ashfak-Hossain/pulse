import {
  failuresFrom,
  jobHeaders,
  parseJob,
  retryPlanFor,
  type PulseJob,
  type RetryPlan,
} from '@pulse/jobs';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import { describeError } from '../shared/errors.js';
import type { BasicLogger } from '../shared/logger.js';
import type { ConfirmChannelOpener } from './publish.js';

// The same wait as the job publisher: long enough for a quorum queue on a busy broker
const CONFIRM_TIMEOUT_MS = 5000;
// parseJob only pattern-checks a type inside a valid envelope; this keeps junk out of logs
const JOB_TYPE = /^[a-z]+(\.[a-z]+)+$/;

/** A failure no retry can fix (a rejected address, say): the job goes to jobs.dead at once. */
export class PermanentJobError extends Error {
  override readonly name = 'PermanentJobError';
}

export interface JobConsumerOptions {
  queue: string;
  // How many unacked jobs this consumer holds at a time (jobSpecs)
  prefetch: number;
  // Resolves when the job is done; throws to fail it
  handle: (job: PulseJob) => Promise<void>;
  logger: BasicLogger;
  // The broker closed the channel with an error and kept the connection. No reconnect will bring
  // the consumer back, so the worker should exit and restart
  onChannelError: (error: Error) => void;
  confirmTimeoutMs?: number;
}

type RetryOutcome = 'confirmed' | 'refused' | 'unconfirmed' | 'channel-closed';

interface LiveChannel {
  channel: ConfirmChannel;
  // Set before amqplib fails the channel's pending confirms
  closed: boolean;
  // We closed it after a confirm that never came: read on with a new channel
  closedByUs: boolean;
  close: () => void;
}

/**
 * Reads one job queue. A job is acked only once it is done, or once its retry copy is safely in
 * a wait queue; nothing is ever nacked with requeue (RabbitMQ 4 would loop it forever). amqplib
 * brings back the connection, not its channels, so the RabbitMQ setup calls `start` after every
 * connect.
 */
export class JobConsumer {
  readonly #options: Required<JobConsumerOptions>;
  // Every channel reading the queue, with its consumer tag. Usually one, but a reconnect's setup
  // and a reopen can overlap, and stop must cancel them all
  readonly #consumers = new Map<ConfirmChannel, string>();
  #stopping = false;
  readonly #running = new Set<Promise<void>>();

  constructor(options: JobConsumerOptions) {
    this.#options = { confirmTimeoutMs: CONFIRM_TIMEOUT_MS, ...options };
  }

  async start(opener: ConfirmChannelOpener): Promise<void> {
    if (this.#stopping) return;
    const channel = await opener.createConfirmChannel();
    const live: LiveChannel = { channel, closed: false, closedByUs: false, close: () => undefined };
    live.close = () => {
      live.closedByUs = true;
      channel.close().catch(() => undefined);
    };
    // Before amqplib's own close listener, which fails every pending confirm with "channel
    // closed": by then this flag must already say why
    channel.prependListener('close', () => {
      live.closed = true;
    });
    channel.on('error', (error: Error) => {
      if (!this.#stopping && !live.closedByUs) this.#options.onChannelError(error);
    });
    channel.on('close', () => {
      this.#consumers.delete(channel);
      // A confirm that never came: we closed the channel so its jobs return. Read on with a new
      // one; if the connection is gone too, this fails and the reconnect's setup starts us again
      if (live.closedByUs && !this.#stopping) {
        this.start(opener).catch((error: unknown) => {
          this.#options.logger.warn(
            { queue: this.#options.queue, error: describeError(error) },
            'Reopening the job channel failed, waiting for a reconnect',
          );
        });
      }
    });

    // stop() may run while this channel opens; it must not start reading after that
    if (this.#stopping) return live.close();
    await channel.prefetch(this.#options.prefetch);
    if (this.#stopping) return live.close();
    const { consumerTag } = await channel.consume(
      this.#options.queue,
      (message) => {
        // null: the broker cancelled the consumer (the queue was deleted); a reconnect restores it
        if (message === null) return;
        const work = this.#onMessage(live, message);
        this.#running.add(work);
        void work.finally(() => this.#running.delete(work));
      },
      { noAck: false },
    );
    if (this.#stopping) {
      await channel.cancel(consumerTag).catch(() => undefined);
      return;
    }
    this.#consumers.set(channel, consumerTag);
  }

  /** Takes no new jobs and resolves once the running ones are settled. */
  async stop(): Promise<void> {
    this.#stopping = true;
    await Promise.allSettled([...this.#consumers].map(([channel, tag]) => channel.cancel(tag)));
    await Promise.allSettled([...this.#running]);
  }

  async #onMessage(live: LiveChannel, message: ConsumeMessage): Promise<void> {
    const { channel } = live;
    const { logger, queue } = this.#options;
    const parsed = parseJob(parseJson(message.content));
    if (parsed.kind !== 'ok') {
      logger.error(
        parsed.kind === 'unknown'
          ? {
              queue,
              type: JOB_TYPE.test(parsed.type) ? parsed.type : '(unreadable)',
              version: parsed.version,
            }
          : { queue, issues: parsed.error.issues.map((issue) => issue.code) },
        'Dead-lettered a message that is not a job this worker knows',
      );
      return settle(() => channel.nack(message, false, false));
    }

    const { job } = parsed;
    const fields = { queue, jobId: job.jobId, type: job.type };
    const failures = failuresFrom(message.properties.headers);
    if (failures === null) {
      logger.error(fields, 'Dead-lettered a job with an unreadable failure count');
      return settle(() => channel.nack(message, false, false));
    }

    try {
      await this.#options.handle(job);
      return settle(() => channel.ack(message));
    } catch (error) {
      const failed = { ...fields, failures: failures + 1, error: describeError(error) };
      const plan: RetryPlan =
        error instanceof PermanentJobError ? { kind: 'dead' } : retryPlanFor(job, failures + 1);
      if (plan.kind === 'dead') {
        logger.error(failed, 'Job failed for good, sent to jobs.dead');
        return settle(() => channel.nack(message, false, false));
      }

      logger.warn(
        { ...failed, retryIn: plan.headers[jobHeaders.retryTier] },
        'Job failed, retrying',
      );
      const outcome = await this.#publishRetry(live, message, job, plan);
      switch (outcome) {
        case 'confirmed':
          return settle(() => channel.ack(message));
        case 'refused':
          // A full wait queue (they are shared by every job type): give up rather than loop
          logger.error(
            { ...failed, retryRefused: true },
            'RabbitMQ refused the retry, sent to jobs.dead',
          );
          return settle(() => channel.nack(message, false, false));
        case 'unconfirmed':
          // The copy may or may not be in a wait queue. Closing returns the original, which then
          // counts toward x-delivery-limit; a nack could leave it in jobs.dead and a wait queue
          logger.warn(fields, 'RabbitMQ did not confirm the retry, closing the job channel');
          return live.close();
        case 'channel-closed':
          // The broker hands the original out again by itself
          return;
      }
    }
  }

  #publishRetry(
    live: LiveChannel,
    message: ConsumeMessage,
    job: PulseJob,
    plan: Extract<RetryPlan, { kind: 'retry' }>,
  ): Promise<RetryOutcome> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve('unconfirmed'), this.#options.confirmTimeoutMs);
      const done = (outcome: RetryOutcome): void => {
        clearTimeout(timer);
        resolve(outcome);
      };
      try {
        // Only the fields we set: no expiration (the job could expire while it waits) and no
        // headers from earlier trips (x-death)
        live.channel.publish(
          plan.exchange,
          plan.routingKey,
          message.content,
          {
            persistent: true,
            contentType: 'application/json',
            messageId: job.jobId,
            headers: plan.headers,
          },
          // amqplib fails pending confirms when the channel closes; that is not the broker saying no
          (error: unknown) =>
            done(error ? (live.closed ? 'channel-closed' : 'refused') : 'confirmed'),
        );
      } catch {
        // amqplib throws when the channel is already closed
        done('channel-closed');
      }
    });
  }
}

function parseJson(content: Buffer): unknown {
  try {
    return JSON.parse(content.toString('utf8'));
  } catch {
    return undefined;
  }
}

// Acking on a closed channel throws. The broker returns that job by itself, so there is nothing
// left to do
function settle(action: () => void): void {
  try {
    action();
  } catch {
    // The channel is gone
  }
}
