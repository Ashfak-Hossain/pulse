import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import * as schema from './schema.js';

// Pool tuning only: user, host and password always come from the URL
type PoolOptions = Pick<
  PoolConfig,
  'max' | 'idleTimeoutMillis' | 'connectionTimeoutMillis' | 'query_timeout' | 'statement_timeout'
>;

// One pool per process: each query borrows a connection and gives it back afterwards.
// Passing the schema gives typed results; close with `db.$client.end()`
export function createDb(connectionString: string, poolOptions: PoolOptions = {}) {
  return drizzle({ client: new Pool({ ...poolOptions, connectionString }), schema });
}

export type Database = ReturnType<typeof createDb>;

// The `tx` that db.transaction() hands to its callback
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
