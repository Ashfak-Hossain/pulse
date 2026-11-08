import { z } from 'zod';

// When a failed job runs again. Each tier is one wait queue (see topology.ts); a job that fails
// once more after the last tier goes to jobs.dead
export const retryTiers = [
  { name: '10s', delayMs: 10_000 },
  { name: '1m', delayMs: 60_000 },
  { name: '10m', delayMs: 600_000 },
] as const;

// '10s' | '1m' | '10m'
export type RetryTier = (typeof retryTiers)[number]['name'];

export type RetryStep = { kind: 'retry'; tier: RetryTier } | { kind: 'dead' };

// Message headers, not body fields, so the job body stays the same on every try. No x- prefix:
// a headers exchange ignores binding arguments that start with x-
export const jobHeaders = {
  // How many times the job has failed so far. Absent on the first try; the handler that fails
  // it calls retryStep(header + 1) and republishes with that new count
  failures: 'pulse-failures',
  // The wait queue a retried job goes to
  retryTier: 'pulse-retry-tier',
} as const;

/** What to do after a job's nth failure (1 = it failed on its first try). */
export function retryStep(failures: number): RetryStep {
  if (!Number.isInteger(failures) || failures < 1) {
    throw new RangeError(`failures must be a whole number >= 1, got ${failures}`);
  }
  const tier = retryTiers[failures - 1];
  return tier ? { kind: 'retry', tier: tier.name } : { kind: 'dead' };
}

// More than any real retry path reaches; a bigger count means the header was tampered with
const MAX_HEADER_FAILURES = 100;
const failuresHeaderSchema = z.coerce.number().int().min(0).max(MAX_HEADER_FAILURES);

/**
 * How many times a job has failed so far, from its message headers. Absent is 0 (the first
 * try). null means the header is there but unreadable: the handler dead-letters the job rather
 * than guess, since a guess could give it endless retries.
 */
export function failuresFrom(
  headers: Readonly<Record<string, unknown>> | undefined,
): number | null {
  const value = headers?.[jobHeaders.failures];
  if (value === undefined) return 0;
  // coerce turns '' into 0 and true into 1; only numbers and digit strings are counts
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return null;
  const parsed = failuresHeaderSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
