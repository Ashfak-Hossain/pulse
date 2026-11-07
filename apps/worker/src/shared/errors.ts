import { DrizzleQueryError } from '@pulse/db';

/**
 * Turns an error into text that is safe to store and log: name, code and message. Causes are left
 * out because a ZodError there can hold row data; a query error is the one exception, below.
 */
export function describeError(error: unknown): string {
  // Drizzle's message is the SQL and its params, which can be row data. The database error
  // in its cause (pg: code and message, no values) is the useful part
  if (error instanceof DrizzleQueryError) {
    return error.cause === undefined
      ? 'Query failed'
      : `Query failed: ${describeError(error.cause)}`;
  }
  if (!(error instanceof Error)) return String(error);
  const code = 'code' in error && typeof error.code === 'string' ? ` [${error.code}]` : '';
  return `${error.name}${code}: ${error.message}`;
}
