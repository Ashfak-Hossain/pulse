import { asc, inArray, isNull, outboxEvent, sql, type Database, type Transaction } from '@pulse/db';
import { describeError } from '../shared/errors.js';
import { toRecord, type OutboxRecord, type OutboxRow } from './record.js';

// Postgres advisory lock that keeps it to one relay at a time. Any fixed number works, as long as
// nothing else in the database locks it
export const RELAY_LOCK_ID = 4_172_001;

const MAX_ERROR_LENGTH = 1000;

// How long one pass waits for Kafka. It doesn't stop the send: against a broker that never
// answers, the Kafka client can keep retrying after this (oneSendAtATime() blocks a second send)
const DEFAULT_SEND_TIMEOUT_MS = 45_000;

export interface RelayProducer {
  send(request: { messages: OutboxRecord[] }): Promise<unknown>;
}

export interface RelayOptions {
  batchSize: number;
  // The only topics the relay may send to
  topics: ReadonlySet<string>;
  // The transaction and the lock stay open while waiting for Kafka, so the wait needs a limit
  sendTimeoutMs?: number;
  // Aborted on shutdown: stop waiting for Kafka. The rows stay unpublished for the next start
  signal?: AbortSignal;
}

export type RelayResult =
  | { status: 'standby' }
  | { status: 'published'; count: number }
  | { status: 'failed'; published: number; error: unknown };

/**
 * One pass of the outbox: sends the oldest unpublished rows to Kafka and marks them published.
 * Returns `standby` if another relay holds the lock. A failed send or bad row comes back as
 * `failed` instead of being thrown, because a throw would roll back the transaction, losing the
 * saved error and any published marks.
 */
export async function relayOnce(
  db: Database,
  producer: RelayProducer,
  options: RelayOptions,
): Promise<RelayResult> {
  return db.transaction(async (tx) => {
    if (!(await tryLock(tx))) return { status: 'standby' };

    const rows = await tx
      .select({
        id: outboxEvent.id,
        type: outboxEvent.type,
        version: outboxEvent.version,
        topic: outboxEvent.topic,
        key: outboxEvent.key,
        payload: outboxEvent.payload,
        createdAt: outboxEvent.createdAt,
      })
      .from(outboxEvent)
      .where(isNull(outboxEvent.publishedAt))
      .orderBy(asc(outboxEvent.seq))
      .limit(options.batchSize);

    const { records, ids, bad } = prepare(rows, options.topics);

    if (records.length > 0) {
      try {
        await sendWithin(producer, records, {
          timeoutMs: options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS,
          signal: options.signal,
        });
      } catch (error) {
        await recordFailure(tx, ids, error);
        return { status: 'failed', published: 0, error };
      }
      await tx
        .update(outboxEvent)
        .set({ publishedAt: sql`now()` })
        .where(inArray(outboxEvent.id, ids));
    }

    if (bad !== undefined) {
      await recordFailure(tx, [bad.id], bad.error);
      return { status: 'failed', published: ids.length, error: bad.error };
    }
    return { status: 'published', count: ids.length };
  });
}

// False if another relay holds the lock. Postgres releases it when the transaction ends, even if
// the process dies
async function tryLock(tx: Transaction): Promise<boolean> {
  const { rows } = await tx.execute<{ locked: boolean }>(
    sql`select pg_try_advisory_xact_lock(${RELAY_LOCK_ID}) as locked`,
  );
  return rows[0]?.locked === true;
}

// Stops at the first bad row: rows before it still go out and rows after it wait, so events
// never go out of order
function prepare(rows: OutboxRow[], topics: ReadonlySet<string>) {
  const records: OutboxRecord[] = [];
  const ids: string[] = [];
  for (const row of rows) {
    try {
      records.push(toRecord(row, topics));
      ids.push(row.id);
    } catch (error) {
      return { records, ids, bad: { id: row.id, error } };
    }
  }
  return { records, ids, bad: undefined };
}

/**
 * Refuses a new send while the last one is still running. After a timeout the relay stops
 * waiting, but the Kafka client keeps retrying that send. With a newer send on top, a late copy
 * of the old events could land after newer ones.
 */
export function oneSendAtATime(producer: RelayProducer): RelayProducer {
  let running = false;
  return {
    async send(request) {
      if (running) throw new Error('Previous Kafka send still running');
      running = true;
      try {
        return await producer.send(request);
      } finally {
        running = false;
      }
    },
  };
}

// Waits for Kafka, but gives up on a timeout or shutdown. Giving up ends only the wait: the send
// can't be cancelled and may still land, and those rows go out again later (consumers dedupe).
// Marking rows published is outside this limit: once Kafka has them, committing avoids a resend
async function sendWithin(
  producer: RelayProducer,
  messages: OutboxRecord[],
  { timeoutMs, signal }: { timeoutMs: number; signal: AbortSignal | undefined },
): Promise<void> {
  if (signal?.aborted) throw stoppedByShutdown();
  let giveUp: (error: Error) => void = () => undefined;
  const gaveUp = new Promise<never>((_resolve, reject) => {
    giveUp = reject;
  });
  const timer = setTimeout(
    () => giveUp(new Error(`Kafka send timed out after ${timeoutMs} ms`)),
    timeoutMs,
  );
  const onAbort = (): void => giveUp(stoppedByShutdown());
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await Promise.race([producer.send({ messages }), gaveUp]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function stoppedByShutdown(): Error {
  return new Error('Kafka send stopped by shutdown');
}

async function recordFailure(tx: Transaction, ids: string[], error: unknown): Promise<void> {
  await tx
    .update(outboxEvent)
    .set({
      attempts: sql`${outboxEvent.attempts} + 1`,
      lastError: describeError(error).slice(0, MAX_ERROR_LENGTH),
    })
    .where(inArray(outboxEvent.id, ids));
}
