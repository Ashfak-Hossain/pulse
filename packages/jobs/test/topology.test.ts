import { describe, expect, it } from 'vitest';
import {
  jobExchanges,
  jobHeaders,
  jobQueues,
  jobTopology,
  jobTypes,
  queueFor,
  retryTiers,
  waitQueueFor,
} from '../src/index.js';

const topology = jobTopology();
const queue = (name: string) => topology.queues.find((q) => q.name === name);
const bindingsOf = (name: string) => topology.bindings.filter((b) => b.queue === name);

describe('jobTopology', () => {
  // A job no queue is bound for must reach jobs.dead, not vanish or sit in a wait queue forever
  it('declares the exchanges, sending unroutable jobs to jobs.dlx', () => {
    const toDead = { 'alternate-exchange': 'jobs.dlx' };
    expect(topology.exchanges).toEqual([
      { name: 'jobs', type: 'topic', durable: true, arguments: toDead },
      { name: 'jobs.retry', type: 'headers', durable: true, arguments: toDead },
      { name: 'jobs.dlx', type: 'fanout', durable: true, arguments: {} },
    ]);
  });

  // Classic queues lose messages when their node dies; quorum queues must be durable
  it('makes every queue a durable quorum queue', () => {
    for (const q of topology.queues) {
      expect(q.arguments['x-queue-type'], q.name).toBe('quorum');
      expect(q.durable, q.name).toBe(true);
    }
  });

  it('never uses one queue name twice, nor the reserved amq. prefix', () => {
    const names = topology.queues.map((q) => q.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).not.toMatch(/^amq\./);
  });

  it('binds only declared queues to declared exchanges', () => {
    const exchanges = new Set(topology.exchanges.map((e) => e.name));
    for (const b of topology.bindings) {
      expect(queue(b.queue), b.queue).toBeDefined();
      expect(exchanges.has(b.exchange), b.exchange).toBe(true);
    }
  });

  describe.each(jobTypes)('work queue for %s', (type) => {
    const name = queueFor(type);

    it('is bound to jobs with the job type as routing key, and nothing else', () => {
      expect(bindingsOf(name)).toEqual([
        { queue: name, exchange: jobExchanges.jobs, routingKey: type, arguments: {} },
      ]);
    });

    // A handler that gives up, or a job that keeps crashing its handler, ends in jobs.dead
    it('dead-letters to jobs.dlx without losing the job on the way', () => {
      expect(queue(name)?.arguments).toMatchObject({
        'x-dead-letter-exchange': jobExchanges.deadLetter,
        'x-dead-letter-strategy': 'at-least-once',
        'x-overflow': 'reject-publish',
        'x-delivery-limit': 5,
        'x-max-length': 100_000,
      });
    });
  });

  describe.each(retryTiers.map((tier) => [tier.name, tier.delayMs] as const))(
    'wait queue for %s',
    (tier, delayMs) => {
      const name = waitQueueFor(tier);

      // No x-dead-letter-routing-key: RabbitMQ keeps the job's own key, so it returns home
      it('holds a job for its delay, then sends it back to jobs', () => {
        const args = queue(name)?.arguments;
        expect(args).toMatchObject({
          'x-message-ttl': delayMs,
          'x-dead-letter-exchange': jobExchanges.jobs,
          'x-dead-letter-strategy': 'at-least-once',
          'x-overflow': 'reject-publish',
          'x-max-length': 100_000,
        });
        expect(args).not.toHaveProperty('x-dead-letter-routing-key');
      });

      // A headers exchange ignores binding arguments that start with x- (other than x-match)
      it('is bound to jobs.retry on its tier header', () => {
        expect(bindingsOf(name)).toEqual([
          {
            queue: name,
            exchange: jobExchanges.retry,
            routingKey: '',
            arguments: { 'x-match': 'all', [jobHeaders.retryTier]: tier },
          },
        ]);
        expect(jobHeaders.retryTier).not.toMatch(/^x-/);
      });
    },
  );

  // RabbitMQ 4's default limit of 20 would drop a dead job after 20 peeks in the UI. When full,
  // it refuses new jobs (they stay where they were) instead of dropping its oldest
  it('collects every given-up job in jobs.dead and never drops it', () => {
    expect(queue(jobQueues.dead)?.arguments).toEqual({
      'x-queue-type': 'quorum',
      'x-delivery-limit': -1,
      'x-max-length': 100_000,
      'x-overflow': 'reject-publish',
    });
    expect(bindingsOf(jobQueues.dead)).toEqual([
      { queue: 'jobs.dead', exchange: 'jobs.dlx', routingKey: '', arguments: {} },
    ]);
  });

  // Integration tests cannot wait ten minutes
  it('takes other delays, and changes nothing else', () => {
    const delayMs = { '10s': 100, '1m': 200, '10m': 300 } as const;
    const queues = topology.queues.map((q) => {
      const tier = retryTiers.find((t) => waitQueueFor(t.name) === q.name);
      return tier
        ? { ...q, arguments: { ...q.arguments, 'x-message-ttl': delayMs[tier.name] } }
        : q;
    });
    expect(jobTopology({ delayMs })).toEqual({ ...topology, queues });
  });

  // RabbitMQ refuses a bad x-message-ttl only when the worker declares it; fail before that
  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    'rejects a delay of %s ms',
    (bad) => {
      const delayMs = { '10s': 100, '1m': bad, '10m': 300 };
      expect(() => jobTopology({ delayMs })).toThrow(/1m/);
    },
  );

  it('takes a delay of 0 ms', () => {
    const { queues } = jobTopology({ delayMs: { '10s': 0, '1m': 0, '10m': 0 } });
    const wait = queues.find((q) => q.name === waitQueueFor('10s'));
    expect(wait?.arguments['x-message-ttl']).toBe(0);
  });
});
