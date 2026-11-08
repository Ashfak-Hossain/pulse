import { closeAll } from './lifecycle.js';

describe('closeAll', () => {
  it('still runs the other closers after one fails, and logs the failure', async () => {
    const logger = { warn: vi.fn() };
    const closed: string[] = [];
    const closers = [
      () => Promise.reject(new Error('broker gone')),
      () => {
        closed.push('database');
        return Promise.resolve();
      },
    ];

    await expect(closeAll(closers, logger)).resolves.toBeUndefined();

    expect(closed).toEqual(['database']);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      { error: 'Error: broker gone' },
      'Closing a connection failed',
    );
  });
});
