export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
}

/**
 * Retry wait in ms that doubles each attempt, up to a cap. The defaults (250 ms to 5 s) are the
 * ones the Kafka client relies on; other callers pass their own.
 */
export function backoffDelay(
  attempt: number,
  { baseMs = 250, maxMs = 5000 }: BackoffOptions = {},
): number {
  // 2 ** 10000 is Infinity, so stop the exponent early
  const exponent = Math.min(attempt - 1, 30);
  return Math.min(maxMs, baseMs * 2 ** exponent);
}
