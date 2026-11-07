import type { Database } from '@pulse/db';
import type { PulseJob } from '@pulse/jobs';
import { consumeCommitted, type RecordConsumer } from '../kafka/client.js';
import type { LoopLogger } from '../logger.js';
import { createWorkerDb, currentRole } from '../shared/db.js';
import { describeError } from '../shared/errors.js';
import { handleCampusCreated, NOTIFIER } from './campus-created.js';
import { runNotifierLoop } from './loop.js';

// A hung database must fail the try, or the loop neither retries nor logs. The server gives up
// first; the client's limit is for a connection that no longer answers at all. Only the notifier:
// the relay keeps its transaction open for up to 45 s while Kafka answers, and this 15 s limit
// must stay above the 5 s confirm wait that happens inside the notifier's transaction
const DB_LIMITS = {
  connectionTimeoutMillis: 5000,
  statement_timeout: 10_000,
  query_timeout: 15_000,
  idle_in_transaction_session_timeout: 15_000,
  keepAlive: true,
};

/** The notifier's pool, connected as pulse_notifier. */
export function createNotifierDb(url: string, logger: Pick<LoopLogger, 'warn'>): Database {
  return createWorkerDb(url, logger, DB_LIMITS);
}

export interface RunNotifierOptions {
  consumer: RecordConsumer;
  db: Database;
  // Resolves only once RabbitMQ confirmed the job
  publish: (job: PulseJob) => Promise<void>;
  topicNames: string[];
  signal: AbortSignal;
  logger: LoopLogger;
  // Injected so tests skip real waits
  retryDelay?: (failures: number) => number;
}

/** Runs the notifier until the signal aborts. Throws if its Kafka stream fails or ends. */
export async function runNotifier(options: RunNotifierOptions): Promise<void> {
  const { consumer, db, publish, topicNames, signal, logger, retryDelay } = options;
  const stream = await consumeCommitted(consumer, topicNames);
  // Stopping in the middle of a record ends the loop's read, which destroys the stream with an
  // AbortError. With no listener that error event would crash the worker on its way out
  stream.on('error', (error) => {
    if (!signal.aborted) logger.warn({ error: describeError(error) }, 'Kafka stream error');
  });
  // An idle loop waits for the next record; closing the stream ends that wait
  const close = (): void => void stream.close().catch(() => undefined);
  if (signal.aborted) return close();
  signal.addEventListener('abort', close, { once: true });

  logger.info(
    { role: await currentRole(db), group: NOTIFIER, topics: topicNames },
    'Notifier started',
  );
  const deps = { db, publish, now: () => new Date() };
  // CampusCreated is the only event so far; a second one makes this a switch on event.type
  await runNotifierLoop(stream, (event) => handleCampusCreated(deps, event), {
    signal,
    logger,
    retryDelay,
  });
  if (!signal.aborted) throw new Error('The Kafka stream ended while the notifier was running');
}
