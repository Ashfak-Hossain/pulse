import { Readable } from 'node:stream';
import type { Database } from '@pulse/db';
import type { RecordConsumer } from '../kafka/client.js';
import { runNotifier } from './run.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

// A stream that ends at once, as a Kafka stream should never do by itself
function consumerWithEmptyStream(): { consumer: RecordConsumer; close: () => Promise<void> } {
  const close = vi.fn(() => Promise.resolve());
  const stream = Object.assign(Readable.from([]), { close });
  const consumer = { consume: () => Promise.resolve(stream) } as unknown as RecordConsumer;
  return { consumer, close };
}

const db = {
  execute: () => Promise.resolve({ rows: [{ role: 'pulse_notifier' }] }),
} as unknown as Database;

function options(consumer: RecordConsumer, signal: AbortSignal) {
  return {
    consumer,
    db,
    publish: () => Promise.resolve(),
    topicNames: ['campuses'],
    signal,
    logger,
  };
}

describe('runNotifier', () => {
  // Otherwise the relay would run on, and the worker would look healthy with no notifier
  it('fails when the stream ends while nobody asked it to stop', async () => {
    const { consumer } = consumerWithEmptyStream();
    await expect(runNotifier(options(consumer, new AbortController().signal))).rejects.toThrow(
      /stream ended/,
    );
  });

  // The abort event has already fired, so a listener added now would never run
  it('closes the stream and returns when told to stop before it started', async () => {
    const { consumer, close } = consumerWithEmptyStream();
    const controller = new AbortController();
    controller.abort();
    await expect(runNotifier(options(consumer, controller.signal))).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledOnce();
  });
});
