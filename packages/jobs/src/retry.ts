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
