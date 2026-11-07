import type { Database } from '@pulse/db';
import { topics } from '@pulse/events';
import { currentRole } from '../shared/db.js';
import type { BasicLogger } from '../shared/logger.js';
import { runRelayLoop } from './loop.js';
import { oneSendAtATime, relayOnce, type RelayProducer } from './relay.js';

export interface RunRelayOptions {
  db: Database;
  producer: RelayProducer;
  batchSize: number;
  pollMs: number;
  signal: AbortSignal;
  logger: BasicLogger;
}

/** Runs the relay until the signal aborts. It may send to every topic in `@pulse/events`. */
export async function runRelay(options: RunRelayOptions): Promise<void> {
  const { db, producer, batchSize, pollMs, signal, logger } = options;
  const guarded = oneSendAtATime(producer);
  const relayOptions = {
    batchSize,
    topics: new Set<string>(Object.values(topics).map((topic) => topic.name)),
    signal,
  };
  logger.info({ role: await currentRole(db), batchSize, pollMs }, 'Outbox relay started');
  await runRelayLoop(() => relayOnce(db, guarded, relayOptions), {
    batchSize,
    pollMs,
    signal,
    logger,
  });
}
