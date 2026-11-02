import { createDb, sql, type Database } from '@pulse/db';
import type { LoopLogger } from './loop.js';
import { describeError } from './relay.js';

/**
 * The relay's pool. A lost connection (a Postgres restart, say) is logged and the step using it
 * fails and is retried, instead of an unhandled 'error' event ending the process.
 */
export function createRelayDb(url: string, logger: Pick<LoopLogger, 'warn'>): Database {
  // One step at a time, so one connection plus a spare
  const db = createDb(url, { max: 2 });
  const onError = (error: Error): void => {
    logger.warn({ error: describeError(error) }, 'Database connection lost');
  };
  // pg-pool drops its own listener while a client is checked out, so each client gets one
  db.$client.on('connect', (client) => client.on('error', onError));
  // pg-pool also re-emits an idle client's error on the pool; the client listener logged it
  db.$client.on('error', () => undefined);
  return db;
}

/** The role this pool logs in as, for the start-up log (a role name is not a secret). */
export async function currentRole(db: Database): Promise<string> {
  const { rows } = await db.execute<{ role: string }>(sql`select current_user as role`);
  return rows[0]?.role ?? 'unknown';
}
