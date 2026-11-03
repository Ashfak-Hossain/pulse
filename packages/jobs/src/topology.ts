// The map of RabbitMQ boxes the jobs travel through. This file only describes it; the worker
// declares it on the broker at startup (S11b).
//
// A job's journey:
//   1. A publisher sends it to exchange `jobs` with its type as routing key (`notify.email`).
//   2. `jobs` copies it into the queue bound with that key: `q.notify.email`.
//   3. A handler takes it. Success → ack, done.
//   4. Failure → the handler sends it to `jobs.retry` with a `pulse-retry-tier` header. The
//      matching wait queue (`wait.10s`, `wait.1m`, `wait.10m`) holds it until its TTL ends,
//      then RabbitMQ dead-letters it back to `jobs`, and step 2 runs again.
//   5. After the 4th failure (or more than 5 crashes) the queue dead-letters it to `jobs.dlx`,
//      which drops it in `jobs.dead` for a person to look at. A job no queue is bound for takes
//      the same road, through the alternate exchange.
//
// The handler publishes the retry and waits for the broker's confirm before it acks, so a crash
// in between gives a duplicate (dedupeKey absorbs it), never a lost job.
import { jobTypes, type JobType } from './registry.js';
import { jobHeaders, retryTiers, type RetryTier } from './retry.js';

// Durable: survives a broker restart
export interface ExchangeSpec {
  readonly name: string;
  readonly type: 'topic' | 'headers' | 'fanout';
  readonly durable: true;
  readonly arguments: Readonly<Record<string, string>>;
}

export interface QueueSpec {
  readonly name: string;
  // Quorum queues refuse to be declared any other way
  readonly durable: true;
  // Fixed once RabbitMQ has the queue: declaring it again with other values fails
  readonly arguments: Readonly<Record<string, string | number>>;
}

export interface BindingSpec {
  readonly queue: string;
  readonly exchange: string;
  readonly routingKey: string;
  readonly arguments: Readonly<Record<string, string>>;
}

export interface Topology {
  readonly exchanges: readonly ExchangeSpec[];
  readonly queues: readonly QueueSpec[];
  readonly bindings: readonly BindingSpec[];
}

interface QueueWithBinding {
  readonly queue: QueueSpec;
  readonly binding: BindingSpec;
}

export interface TopologyOptions {
  // Only tests change these; a wait queue's name says its delay
  delayMs?: Readonly<Record<RetryTier, number>>;
}

// An exchange never stores a job; it only decides which queues get a copy
export const jobExchanges = {
  // topic: routes by routing key. Publishers send every job here, the job type as key
  jobs: 'jobs',
  // headers: routes by the pulse-retry-tier header and ignores the key, so a retried job keeps
  // its own key for the trip home
  retry: 'jobs.retry',
  // fanout: sends everything to every bound queue (only jobs.dead)
  deadLetter: 'jobs.dlx',
} as const;

export const jobQueues = {
  // Only a person empties it, after fixing the cause
  dead: 'jobs.dead',
} as const;

export function queueFor(type: JobType): string {
  return `q.${type}`;
}

export function waitQueueFor(tier: RetryTier): string {
  return `wait.${tier}`;
}

// Quorum queues keep copies on several nodes. At-least-once dead-lettering keeps a job in its
// queue until the next queue has it, and needs reject-publish
const quorum = { 'x-queue-type': 'quorum' } as const;
const safeDeadLetter = {
  'x-dead-letter-strategy': 'at-least-once',
  'x-overflow': 'reject-publish',
} as const;

/** Every exchange, queue and binding the jobs need, as data for the worker to declare. */
export function jobTopology(options: TopologyOptions = {}): Topology {
  // One queue per job type, where its handler reads
  const workQueues = jobTypes.map((type): QueueWithBinding => ({
    queue: {
      name: queueFor(type),
      durable: true,
      arguments: {
        ...quorum,
        ...safeDeadLetter,
        'x-dead-letter-exchange': jobExchanges.deadLetter,
        // A job returned more than 5 times (it keeps crashing its handler) goes to jobs.dead
        // instead of looping forever
        'x-delivery-limit': 5,
      },
    },
    binding: {
      queue: queueFor(type),
      exchange: jobExchanges.jobs,
      routingKey: type,
      arguments: {},
    },
  }));

  // Waiting rooms, shared by all job types. Nobody reads a wait queue: when the TTL ends,
  // RabbitMQ dead-letters the job back to jobs, and without x-dead-letter-routing-key it keeps
  // its own key, so it returns to its own queue
  const waitQueues = retryTiers.map((tier): QueueWithBinding => ({
    queue: {
      name: waitQueueFor(tier.name),
      durable: true,
      arguments: {
        ...quorum,
        ...safeDeadLetter,
        'x-message-ttl': options.delayMs?.[tier.name] ?? tier.delayMs,
        'x-dead-letter-exchange': jobExchanges.jobs,
      },
    },
    binding: {
      queue: waitQueueFor(tier.name),
      exchange: jobExchanges.retry,
      routingKey: '',
      arguments: { 'x-match': 'all', [jobHeaders.retryTier]: tier.name },
    },
  }));

  // Without an alternate exchange, a job no queue is bound for is dropped without a word, and a
  // retried one is held in its wait queue forever (at-least-once keeps trying to route it)
  const unroutableToDead = { 'alternate-exchange': jobExchanges.deadLetter };

  return {
    exchanges: [
      { name: jobExchanges.jobs, type: 'topic', durable: true, arguments: unroutableToDead },
      { name: jobExchanges.retry, type: 'headers', durable: true, arguments: unroutableToDead },
      { name: jobExchanges.deadLetter, type: 'fanout', durable: true, arguments: {} },
    ],
    queues: [
      ...workQueues.map((w) => w.queue),
      ...waitQueues.map((w) => w.queue),
      // RabbitMQ 4 gives quorum queues a delivery limit of 20 by default, and this queue has
      // nowhere to send a job past it: -1 keeps a dead job however often someone peeks at it
      { name: jobQueues.dead, durable: true, arguments: { ...quorum, 'x-delivery-limit': -1 } },
    ],
    bindings: [
      ...workQueues.map((w) => w.binding),
      ...waitQueues.map((w) => w.binding),
      { queue: jobQueues.dead, exchange: jobExchanges.deadLetter, routingKey: '', arguments: {} },
    ],
  };
}
