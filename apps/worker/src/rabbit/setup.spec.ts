import type { ChannelModel } from 'amqplib';
import type { Logger } from 'pino';
import type { JobPublisher } from './publish.js';
import { setupRabbit } from './setup.js';

describe('setupRabbit', () => {
  // A publisher on a new channel must not be able to send before the queues exist
  it('finishes declaring the topology before it attaches the publisher', async () => {
    const steps: string[] = [];
    const channel = {
      on: vi.fn(),
      assertExchange: vi.fn(() => Promise.resolve()),
      assertQueue: vi.fn(() => Promise.resolve()),
      bindQueue: vi.fn(() => Promise.resolve()),
      close: vi.fn(() => {
        steps.push('topology declared');
        return Promise.resolve();
      }),
    };
    const model = { createChannel: () => Promise.resolve(channel) } as unknown as ChannelModel;
    const publisher = {
      attach: () => {
        steps.push('publisher attached');
        return Promise.resolve();
      },
    } as unknown as JobPublisher;

    await setupRabbit(model, publisher, { info: vi.fn() } as unknown as Logger, []);

    expect(steps).toEqual(['topology declared', 'publisher attached']);
  });
});
