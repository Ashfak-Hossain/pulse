import { DrizzleQueryError } from '@pulse/db';

/**
 * Turns an error into text for logs and `last_error`: name, code and message. Causes are left out
 * because a ZodError there can hold row data; a query error is the one exception, below. It cannot
 * clean a message, so a message we write must never hold row data.
 */
export function describeError(error: unknown): string {
  // Drizzle's message is the SQL and its params, which can be row data. The database error in its
  // cause is the useful part: pg's code and message, not the params (a message can still quote a
  // bad value, so query params stay ids for now)
  if (error instanceof DrizzleQueryError) {
    return error.cause === undefined
      ? 'Query failed'
      : `Query failed: ${describeError(error.cause)}`;
  }
  if (!(error instanceof Error)) return String(error);
  const code = 'code' in error && typeof error.code === 'string' ? ` [${error.code}]` : '';
  return `${error.name}${code}: ${error.message}`;
}
