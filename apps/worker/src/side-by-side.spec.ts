import { runSideBySide } from './side-by-side.js';

describe('runSideBySide', () => {
  it('waits for every part, and aborts nothing when all end well', async () => {
    const controller = new AbortController();
    const finished: string[] = [];
    await runSideBySide(controller, [
      () => {
        finished.push('a');
        return Promise.resolve();
      },
      () => {
        finished.push('b');
        return Promise.resolve();
      },
    ]);
    expect(finished).toEqual(['a', 'b']);
    expect(controller.signal.aborted).toBe(false);
  });

  // Half a worker looks alive but does half its work, so a failure stops the other part too
  it('stops the other part when one fails, waits for it, then throws the failure', async () => {
    const controller = new AbortController();
    let otherStopped = false;
    const other = new Promise<void>((resolve) => {
      controller.signal.addEventListener('abort', () => {
        otherStopped = true;
        resolve();
      });
    });
    await expect(
      runSideBySide(controller, [() => Promise.reject(new Error('relay failed')), () => other]),
    ).rejects.toThrow('relay failed');
    expect(otherStopped).toBe(true);
  });
});
