import { sql } from 'drizzle-orm';
import type { Database, Transaction } from './client.js';

// The canonical 8-4-4-4-12 hex form. Anything else would only fail later inside a policy's
// ::uuid cast, with an error that echoes the raw value back
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The only way to run campus-scoped queries: one transaction in which row-level security shows
// this campus's rows and nothing else. The `true` in set_config makes the setting end with the
// transaction, so a pooled connection never carries one request's campus into the next
export async function withCampus<T>(
  db: Database,
  campusId: string,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  if (!uuidPattern.test(campusId)) {
    // The value is left out on purpose: it may come from a request and must not be echoed back
    throw new TypeError('withCampus: campusId must be a UUID');
  }

  return db.transaction(async (tx) => {
    // ${campusId} is sent as a bound parameter, never spliced into the SQL text
    await tx.execute(sql`select set_config('app.campus_id', ${campusId}, true)`);
    return work(tx);
  });
}
