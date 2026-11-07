import { backoffDelay } from '../shared/backoff.js';
import { describeError } from '../shared/errors.js';
import type { LoopLogger } from '../shared/logger.js';
import { abortableSleep } from '../shared/sleep.js';
import type { RelayResult } from './relay.js';

// From this many failures in a row on, each one logs as error: someone should look
const ALERT_AFTER_FAILURES = 10;
const MAX_BACKOFF_MS = 30_000;

export interface RelayLoopOptions {
  batchSize: number;
  pollMs: number;
  signal: AbortSignal;
  logger: LoopLogger;
  // Injected so tests can pin the jitter and skip real waits
  random?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Runs relay steps until the signal aborts. The step in progress always finishes first. */
export async function runRelayLoop(
  step: () => Promise<RelayResult>,
  options: RelayLoopOptions,
): Promise<void> {
  const { batchSize, pollMs, signal, logger } = options;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? abortableSleep;
  let failures = 0;

  while (!signal.aborted) {
    const result = await runStep(step);

    if (result.status === 'failed') {
      failures += 1;
      const level = failures >= ALERT_AFTER_FAILURES ? 'error' : 'warn';
      logger[level](
        { failures, published: result.published, error: describeError(result.error) },
        'Outbox relay step failed',
      );
    } else {
      if (failures > 0) {
        logger.info({ afterFailures: failures }, 'Outbox relay recovered');
        failures = 0;
      }
      if (result.status === 'published' && result.count > 0) {
        logger.info({ count: result.count }, 'Published outbox rows');
      }
    }

    if (signal.aborted) break;
    const waitMs = nextWait(result, failures, batchSize, pollMs);
    if (waitMs > 0) await sleep(withJitter(waitMs, random), signal);
  }
}

// A step that throws (the pool closed, say) counts as a failure, so the loop never dies of one
async function runStep(step: () => Promise<RelayResult>): Promise<RelayResult> {
  try {
    return await step();
  } catch (error) {
    return { status: 'failed', published: 0, error };
  }
}

function nextWait(
  result: RelayResult,
  failures: number,
  batchSize: number,
  pollMs: number,
): number {
  if (result.status === 'failed') {
    return backoffDelay(failures, { baseMs: pollMs, maxMs: MAX_BACKOFF_MS });
  }
  // A full batch means more rows are probably waiting
  if (result.status === 'published' && result.count === batchSize) return 0;
  return pollMs;
}

// × [0.8, 1.2), so relays started together do not all poll at the same moment
function withJitter(ms: number, random: () => number): number {
  return Math.floor(ms * 0.8 + ms * 0.4 * random());
}
