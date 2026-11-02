import { asc, inArray, isNull, outboxEvent, sql, type Database, type Transaction } from '@pulse/db';
import { toRecord, type OutboxRecord, type OutboxRow } from './record.js';

// Any fixed number works, as long as nothing else in the database locks it
export const RELAY_LOCK_ID = 4_172_001;

const MAX_ERROR_LENGTH = 1000;

export interface RelayProducer {
  send(request: { messages: OutboxRecord[] }): Promise<unknown>;
}

export interface RelayOptions {
  batchSize: number;
  // The only topics the relay may send to
  topics: ReadonlySet<string>;
}

export type RelayResult =
  | { status: 'standby' }
  | { status: 'published'; count: number }
  | { status: 'failed'; published: number; error: unknown };

/**
 * Publishes the oldest unpublished outbox rows in seq order and marks them published.
 * One relay works at a time; the others get 'standby'.
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
        await producer.send({ messages: records });
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

// Released by itself when the transaction ends, even if the process dies
async function tryLock(tx: Transaction): Promise<boolean> {
  const { rows } = await tx.execute<{ locked: boolean }>(
    sql`select pg_try_advisory_xact_lock(${RELAY_LOCK_ID}) as locked`,
  );
  return rows[0]?.locked === true;
}

// Stops at the first bad row: the rows after it wait, so events never go out of order
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

async function recordFailure(tx: Transaction, ids: string[], error: unknown): Promise<void> {
  await tx
    .update(outboxEvent)
    .set({
      attempts: sql`${outboxEvent.attempts} + 1`,
      lastError: describeError(error).slice(0, MAX_ERROR_LENGTH),
    })
    .where(inArray(outboxEvent.id, ids));
}

// Never the cause: a ZodError there can hold row data
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = 'code' in error && typeof error.code === 'string' ? ` [${error.code}]` : '';
  return `${error.name}${code}: ${error.message}`;
}
