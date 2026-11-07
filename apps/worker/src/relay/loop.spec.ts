import type { LoopLogger } from '../shared/logger.js';
import { runRelayLoop, type RelayLoopOptions } from './loop.js';
import type { RelayResult } from './relay.js';

const POLL_MS = 500;
const BATCH_SIZE = 10;

type LogEntry = {
  level: 'info' | 'warn' | 'error';
  fields: Record<string, unknown>;
  message: string;
};

function recordingLogger() {
  const entries: LogEntry[] = [];
  const log =
    (level: LogEntry['level']) =>
    (fields: Record<string, unknown>, message: string): void => {
      entries.push({ level, fields, message });
    };
  const logger: LoopLogger = { info: log('info'), warn: log('warn'), error: log('error') };
  return { logger, entries };
}

const published = (count: number): RelayResult => ({ status: 'published', count });
const standby: RelayResult = { status: 'standby' };
const failed = (error: unknown = new Error('Kafka down'), done = 0): RelayResult => ({
  status: 'failed',
  published: done,
  error,
});

/**
 * Runs the loop over a fixed list of step outcomes (a thrown Error is thrown by the step), then
 * stops it: the last step aborts before it returns. Returns what the loop did.
 */
async function run(
  outcomes: Array<RelayResult | Error>,
  options: Partial<Omit<RelayLoopOptions, 'signal' | 'logger' | 'sleep'>> = {},
) {
  const controller = new AbortController();
  const { logger, entries } = recordingLogger();
  const sleeps: number[] = [];
  let calls = 0;

  const step = (): Promise<RelayResult> => {
    const outcome = outcomes[calls];
    calls += 1;
    if (calls >= outcomes.length) controller.abort();
    if (outcome === undefined) {
      return Promise.reject(new Error('the loop called the step after the last outcome'));
    }
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  };

  await runRelayLoop(step, {
    batchSize: BATCH_SIZE,
    pollMs: POLL_MS,
    // 0.5 makes the jitter factor exactly 1, so most tests can check exact waits
    random: () => 0.5,
    ...options,
    signal: controller.signal,
    logger,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });

  return { calls: () => calls, sleeps, entries };
}

describe('runRelayLoop', () => {
  describe('waiting between steps', () => {
    it('runs again at once after a full batch (more rows are probably waiting)', async () => {
      const result = await run([published(BATCH_SIZE), published(BATCH_SIZE), published(0)]);
      expect(result.calls()).toBe(3);
      expect(result.sleeps).toEqual([]);
    });

    it('sleeps pollMs after a partial batch, an empty one, or standby', async () => {
      const result = await run([published(3), published(0), standby, published(0)]);
      expect(result.sleeps).toEqual([POLL_MS, POLL_MS, POLL_MS]);
    });

    it.each([
      [0, POLL_MS * 0.8],
      [0.25, POLL_MS * 0.9],
      [0.75, POLL_MS * 1.1],
    ])('adds jitter: random()=%s → sleeps %s ms', async (random, expected) => {
      const result = await run([published(0), published(0)], { random: () => random });
      expect(result.sleeps).toEqual([expected]);
    });

    // Many relays started together would otherwise poll in lock step
    it('keeps every idle sleep inside [0.8, 1.2) × pollMs for any random() in [0, 1)', async () => {
      const randoms = [0, 0.1, 0.33, 0.5, 0.9, 0.999_999];
      for (const value of randoms) {
        const result = await run([standby, standby], { random: () => value });
        const [sleep] = result.sleeps;
        expect(sleep).toBeGreaterThanOrEqual(POLL_MS * 0.8);
        expect(sleep).toBeLessThan(POLL_MS * 1.2);
        expect(Number.isInteger(sleep)).toBe(true);
      }
    });
  });

  describe('failures', () => {
    it('backs off longer after each failure in a row', async () => {
      const result = await run([failed(), failed(), failed(), failed(), published(0)]);
      expect(result.sleeps).toEqual([500, 1000, 2000, 4000]);
    });

    it('caps the backoff at 30 s before jitter', async () => {
      const outcomes = [...Array.from({ length: 12 }, () => failed()), published(0)];
      const result = await run(outcomes);
      expect(Math.max(...result.sleeps)).toBe(30_000);
      expect(result.sleeps.at(-1)).toBe(30_000);
    });

    it('starts the backoff again after a success', async () => {
      const result = await run([failed(), failed(), published(1), failed(), published(0)]);
      expect(result.sleeps).toEqual([500, 1000, POLL_MS, 500]);
    });

    it('counts a failed step that published some rows first as a failure', async () => {
      const result = await run([failed(new Error('bad row'), 4), failed(), published(0)]);
      expect(result.sleeps).toEqual([500, 1000]);
    });

    it('treats a step that throws like a failed one, and keeps going', async () => {
      const result = await run([new Error('pool is closed'), published(0), published(0)]);
      expect(result.calls()).toBe(3);
      expect(result.sleeps).toEqual([500, POLL_MS]);
      expect(result.entries).toContainEqual(
        expect.objectContaining({
          level: 'warn',
          fields: expect.objectContaining({ failures: 1 }) as unknown,
        }),
      );
    });

    it('also handles a thrown value that is not an Error', async () => {
      const controller = new AbortController();
      const { logger, entries } = recordingLogger();
      await runRelayLoop(
        () => {
          controller.abort();
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the case under test
          return Promise.reject('plain string');
        },
        {
          batchSize: BATCH_SIZE,
          pollMs: POLL_MS,
          signal: controller.signal,
          logger,
          sleep: () => Promise.resolve(),
        },
      );
      expect(entries).toEqual([
        expect.objectContaining({
          level: 'warn',
          fields: expect.objectContaining({ failures: 1, error: 'plain string' }) as unknown,
        }),
      ]);
    });

    it('logs failures 1–9 in a row as warn, and from the 10th on as error', async () => {
      const outcomes = [...Array.from({ length: 11 }, () => failed()), published(0)];
      const result = await run(outcomes);
      const failureLogs = result.entries.filter((entry) => entry.level !== 'info');
      expect(failureLogs.map((entry) => entry.level)).toEqual([
        ...Array.from({ length: 9 }, () => 'warn'),
        'error',
        'error',
      ]);
      expect(failureLogs.map((entry) => entry.fields.failures)).toEqual(
        Array.from({ length: 11 }, (_, index) => index + 1),
      );
    });

    it('logs the recovery once, with how many failures came before it', async () => {
      const result = await run([failed(), failed(), published(2), published(0)]);
      const recovered = result.entries.filter((entry) =>
        Object.hasOwn(entry.fields, 'afterFailures'),
      );
      expect(recovered).toHaveLength(1);
      expect(recovered[0]).toMatchObject({ level: 'info', fields: { afterFailures: 2 } });
    });

    it('logs the error name, code and message, never its cause (a ZodError there can hold row data)', async () => {
      const error = Object.assign(
        new Error('send failed', { cause: new Error('payload email=a@example.test') }),
        { code: 'NETWORK' },
      );
      const result = await run([failed(error), new Error('thrown', { cause: 'secret row' })]);
      const text = JSON.stringify(result.entries);
      expect(text).toContain('send failed');
      expect(text).toContain('NETWORK');
      expect(text).toContain('thrown');
      expect(text).not.toContain('a@example.test');
      expect(text).not.toContain('secret row');
      for (const entry of result.entries) {
        for (const value of Object.values(entry.fields)) {
          // Only plain values: an Error object would let the logger print its cause
          expect(value).not.toBeInstanceOf(Error);
        }
      }
    });
  });

  describe('logging published rows', () => {
    it('logs how many rows went out, and nothing for empty batches or standby', async () => {
      const result = await run([published(3), published(0), standby, published(0)]);
      expect(result.entries).toEqual([
        expect.objectContaining({ level: 'info', fields: { count: 3 } }),
      ]);
    });
  });

  describe('stopping', () => {
    it('returns without running a step when the signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      let calls = 0;
      await runRelayLoop(
        () => {
          calls += 1;
          return Promise.resolve(standby);
        },
        {
          batchSize: BATCH_SIZE,
          pollMs: POLL_MS,
          signal: controller.signal,
          logger: recordingLogger().logger,
          sleep: () => Promise.resolve(),
        },
      );
      expect(calls).toBe(0);
    });

    it('finishes the current step and does not sleep after it once aborted', async () => {
      const result = await run([published(1)]);
      expect(result.calls()).toBe(1);
      expect(result.sleeps).toEqual([]);
    });

    it('stops after a sleep that the abort cut short, without another step', async () => {
      const controller = new AbortController();
      let calls = 0;
      await runRelayLoop(
        () => {
          calls += 1;
          return Promise.resolve(standby);
        },
        {
          batchSize: BATCH_SIZE,
          pollMs: POLL_MS,
          signal: controller.signal,
          logger: recordingLogger().logger,
          // What abortableSleep does: the abort ends the sleep early
          sleep: () => {
            controller.abort();
            return Promise.resolve();
          },
        },
      );
      expect(calls).toBe(1);
    });

    it('passes the signal to sleep, so a shutdown does not wait out the poll', async () => {
      const controller = new AbortController();
      const signals: AbortSignal[] = [];
      await runRelayLoop(() => Promise.resolve(standby), {
        batchSize: BATCH_SIZE,
        pollMs: POLL_MS,
        signal: controller.signal,
        logger: recordingLogger().logger,
        sleep: (_ms, signal) => {
          signals.push(signal);
          controller.abort();
          return Promise.resolve();
        },
      });
      expect(signals).toEqual([controller.signal]);
    });
  });
});
