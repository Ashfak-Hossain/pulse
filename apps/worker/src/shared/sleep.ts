import { setTimeout as delay } from 'node:timers/promises';

/** Waits `ms`, or less when the signal aborts. Never throws. */
export async function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  // An abort is the only way this wait rejects, and it only means "stop waiting"
  await delay(ms, undefined, { signal }).catch(() => undefined);
}
