import type { Logger } from 'pino';
import { describeError } from './shared/errors.js';
import type { LoopLogger } from './shared/logger.js';

// Docker sends SIGKILL 10 s after SIGTERM, so give up a little before that
const SHUTDOWN_TIMEOUT_MS = 8000;

export type Closer = () => Promise<void>;

/**
 * First signal: finish the current step, then close. Second signal, or a stop that takes too
 * long: exit at once (the outbox keeps any row that was not marked, so nothing is lost).
 */
export function stopOnSignals(controller: AbortController, logger: Logger): void {
  const stop = (signal: NodeJS.Signals): void => {
    if (controller.signal.aborted) {
      logger.warn({ signal }, 'Second signal, exiting now');
      process.exit(1);
    }
    logger.info({ signal }, 'Stopping');
    controller.abort();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  // On every stop, so a feature that failed cannot leave a half-stopped worker running either
  controller.signal.addEventListener('abort', () => {
    // unref: this timer alone must not keep the process alive after a clean stop
    setTimeout(() => {
      logger.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, 'Stopping took too long, exiting');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
  });
}

/** Runs every closer, even after one fails: a failed close must not leave another open. */
export async function closeAll(closers: Closer[], logger: Pick<LoopLogger, 'warn'>): Promise<void> {
  const results = await Promise.allSettled(closers.map((close) => close()));
  for (const result of results) {
    if (result.status === 'rejected') {
      logger.warn({ error: describeError(result.reason) }, 'Closing a connection failed');
    }
  }
}

/** A clear log and a restart beat running on in an unknown state. */
export function exitOnUncaughtErrors(logger: Logger): void {
  process.on('uncaughtException', (error) => exitWithError(logger, error, 'Uncaught exception'));
  process.on('unhandledRejection', (reason) =>
    exitWithError(logger, reason, 'Unhandled rejection'),
  );
}

export function exitWithError(logger: Logger, error: unknown, message: string): never {
  logger.fatal({ error: describeError(error) }, message);
  process.exit(1);
}
