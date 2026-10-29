import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

// One pool per process: each query borrows a connection and gives it back afterwards.
// Passing the schema gives typed results; close with `db.$client.end()`
export function createDb(connectionString: string) {
  return drizzle({ client: new Pool({ connectionString }), schema });
}

export type Database = ReturnType<typeof createDb>;

// The `tx` that db.transaction() hands to its callback
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
