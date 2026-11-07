export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
}

/**
 * Retry wait in ms: 250, 500, 1000… up to 5000. Ten retries add up to ~33 s, enough for
 * Kafka's ~20 s startup.
 */
export function backoffDelay(
  attempt: number,
  { baseMs = 250, maxMs = 5000 }: BackoffOptions = {},
): number {
  // 2 ** 10000 is Infinity, so stop the exponent early
  const exponent = Math.min(attempt - 1, 30);
  return Math.min(maxMs, baseMs * 2 ** exponent);
}
