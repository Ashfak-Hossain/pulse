import type { Database } from '@pulse/db';
import { topics } from '@pulse/events';
import type { Env } from '../config/env.js';
import { currentRole } from '../shared/db.js';
import type { LoopLogger } from '../shared/logger.js';
import { runRelayLoop } from './loop.js';
import { oneSendAtATime, relayOnce, type RelayProducer } from './relay.js';

export interface RunRelayOptions {
  db: Database;
  producer: RelayProducer;
  env: Pick<Env, 'RELAY_BATCH_SIZE' | 'RELAY_POLL_MS'>;
  signal: AbortSignal;
  logger: LoopLogger;
}

/** Runs the relay until the signal aborts. It may send to every topic in `@pulse/events`. */
export async function runRelay({
  db,
  producer,
  env,
  signal,
  logger,
}: RunRelayOptions): Promise<void> {
  const batchSize = env.RELAY_BATCH_SIZE;
  const pollMs = env.RELAY_POLL_MS;
  const guarded = oneSendAtATime(producer);
  const passOptions = {
    batchSize,
    topics: new Set<string>(Object.values(topics).map((topic) => topic.name)),
    signal,
  };
  logger.info({ role: await currentRole(db), batchSize, pollMs }, 'Outbox relay started');
  await runRelayLoop(() => relayOnce(db, guarded, passOptions), {
    batchSize,
    pollMs,
    signal,
    logger,
  });
}
