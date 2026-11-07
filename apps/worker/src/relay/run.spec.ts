import type { Database } from '@pulse/db';
import { runRelay } from './run.js';

describe('runRelay', () => {
  it('logs its login role, and sends nothing when told to stop before it started', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const send = vi.fn();
    const controller = new AbortController();
    controller.abort();

    await runRelay({
      db: {
        execute: () => Promise.resolve({ rows: [{ role: 'pulse_relay' }] }),
      } as unknown as Database,
      producer: { send },
      batchSize: 10,
      pollMs: 500,
      signal: controller.signal,
      logger,
    });

    expect(logger.info).toHaveBeenCalledExactlyOnceWith(
      { role: 'pulse_relay', batchSize: 10, pollMs: 500 },
      'Outbox relay started',
    );
    expect(send).not.toHaveBeenCalled();
  });
});
