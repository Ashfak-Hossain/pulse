import type { PulseEvent } from '@pulse/events';
import { backoffDelay } from '../kafka/backoff.js';
import type { LoopLogger } from '../logger.js';
import { describeError } from '../shared/errors.js';
import { abortableSleep } from '../shared/sleep.js';
import { decodeRecord } from './decode.js';

// From this many failures in a row on, each one logs as error: someone should look
const ALERT_AFTER_FAILURES = 10;
const MAX_RETRY_MS = 30_000;
// parseEvent only asks that a type is a non-empty string, so it can hold any text from the record
const EVENT_NAME = /^[A-Za-z0-9]{1,100}$/;

// The parts of a Kafka record the loop uses (a @platformatic/kafka Message fits)
export interface ConsumedMessage {
  topic: string;
  partition: number;
  offset: bigint;
  value: Buffer | null | undefined;
  commit(): void | Promise<void>;
}

export interface NotifierLoopOptions {
  signal: AbortSignal;
  logger: LoopLogger;
  // Injected so tests skip real waits
  retryDelay?: (failures: number) => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Handles records one at a time and commits each offset only after its record is done. A
 * record that cannot be read is logged and skipped; a failed handle is retried until it works
 * or the signal aborts (its offset then stays, and the record comes again after a restart).
 */
export async function runNotifierLoop(
  messages: AsyncIterable<ConsumedMessage>,
  handle: (event: PulseEvent) => Promise<unknown>,
  options: NotifierLoopOptions,
): Promise<void> {
  const { signal } = options;
  try {
    for await (const message of messages) {
      if (!(await handleRecord(message, handle, options))) return;
      await commitOffset(message, options);
      if (signal.aborted) return;
    }
  } catch (error) {
    // Stopping closes the stream, which can cut off a read or a commit in flight. A record whose
    // commit was lost comes again after a restart, and processed_event drops it
    if (signal.aborted) return;
    throw error;
  }
}

// The record is done, and the next commit carries the offset forward. If none comes, the record
// returns after a restart and processed_event drops it. A consumer that lost its group does end
// the stream, so the next read throws and the worker restarts
async function commitOffset(
  message: ConsumedMessage,
  { signal, logger }: NotifierLoopOptions,
): Promise<void> {
  try {
    await message.commit();
  } catch (error) {
    if (signal.aborted) return;
    logger.warn(
      { ...whereIs(message), error: describeError(error) },
      'Committing an offset failed, the next commit carries it forward',
    );
  }
}

// Where a record is, never what it holds. A bigint does not fit in JSON, hence String
function whereIs(message: ConsumedMessage): Record<string, unknown> {
  return {
    topic: message.topic,
    partition: message.partition,
    offset: String(message.offset),
  };
}

// true once the record is dealt with; false when the signal aborted first (offset must stay)
async function handleRecord(
  message: ConsumedMessage,
  handle: (event: PulseEvent) => Promise<unknown>,
  options: NotifierLoopOptions,
): Promise<boolean> {
  const { logger } = options;
  const where = whereIs(message);
  const record = decodeRecord(message.value);

  switch (record.kind) {
    case 'ok': {
      const { event } = record;
      const fields = { ...where, eventId: event.eventId, type: event.type };
      return handleUntilDone(() => handle(event), fields, options);
    }
    case 'unknown':
      // A newer producer may write events this worker does not know yet
      logger.info(
        {
          ...where,
          type: EVENT_NAME.test(record.type) ? record.type : '(unreadable)',
          version: record.version,
        },
        'Skipped an event the notifier does not handle',
      );
      return true;
    case 'invalid':
      // Retrying cannot fix it, and waiting on it would hold up every record behind it
      logger.error(
        { ...where, reason: record.reason },
        'Skipped a record that is not a valid event',
      );
      return true;
  }
}

// true once the work succeeded; false when the signal aborted first
async function handleUntilDone(
  work: () => Promise<unknown>,
  fields: Record<string, unknown>,
  options: NotifierLoopOptions,
): Promise<boolean> {
  const { signal, logger } = options;
  const retryDelay =
    options.retryDelay ??
    ((failures) => backoffDelay(failures, { baseMs: 500, maxMs: MAX_RETRY_MS }));
  const sleep = options.sleep ?? abortableSleep;
  let failures = 0;

  for (;;) {
    try {
      await work();
      if (failures > 0) {
        logger.info({ ...fields, afterFailures: failures }, 'Event handled after retrying');
      }
      return true;
    } catch (error) {
      failures += 1;
      const level = failures >= ALERT_AFTER_FAILURES ? 'error' : 'warn';
      logger[level](
        { ...fields, failures, error: describeError(error) },
        'Handling an event failed, retrying',
      );
      if (signal.aborted) return false;
      await sleep(retryDelay(failures), signal);
      if (signal.aborted) return false;
    }
  }
}
