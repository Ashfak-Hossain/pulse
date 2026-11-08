import { abortableSleep } from './sleep.js';

describe('abortableSleep', () => {
  it('waits about the given time', async () => {
    const started = performance.now();
    await abortableSleep(30, new AbortController().signal);
    expect(performance.now() - started).toBeGreaterThanOrEqual(25);
  });

  it('ends early, without throwing, when the signal aborts', async () => {
    const controller = new AbortController();
    const started = performance.now();
    const sleeping = abortableSleep(60_000, controller.signal);
    controller.abort();
    await expect(sleeping).resolves.toBeUndefined();
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('returns at once when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(abortableSleep(60_000, controller.signal)).resolves.toBeUndefined();
  });
});
