import { randomUUID } from 'node:crypto';
import { createEvent, type PulseEvent } from '@pulse/events';
import { runNotifierLoop, type ConsumedMessage, type NotifierLoopOptions } from './loop.js';

const event = createEvent(
  'CampusCreated',
  { campusId: randomUUID(), name: 'Secret Campus', slug: 'aiub', timezone: 'Asia/Dhaka' },
  { eventId: randomUUID(), occurredAt: new Date('2026-11-05T10:00:00Z') },
);

// Every step the loop takes, in order, so a test can check that a commit came after the work
let steps: string[];

function message(value: Buffer | null, offset: number): ConsumedMessage {
  return {
    topic: 'campuses',
    partition: 0,
    offset: BigInt(offset),
    value,
    commit: () => {
      steps.push(`commit ${offset}`);
    },
  };
}

const bytes = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));

// Like a Kafka stream: each record arrives asynchronously
async function* records(...messages: ConsumedMessage[]): AsyncGenerator<ConsumedMessage> {
  for (const record of messages) yield await Promise.resolve(record);
}

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function options(overrides: Partial<NotifierLoopOptions> = {}): NotifierLoopOptions {
  return {
    signal: new AbortController().signal,
    logger: fakeLogger(),
    retryDelay: (attempt) => attempt * 100,
    sleep: (ms) => {
      steps.push(`sleep ${ms}`);
      return Promise.resolve();
    },
    ...overrides,
  };
}

beforeEach(() => {
  steps = [];
});

describe('runNotifierLoop', () => {
  it('handles each event, then commits its offset', async () => {
    const handle = vi.fn((handled: PulseEvent) => {
      steps.push(`handle ${handled.eventId}`);
      return Promise.resolve();
    });
    await runNotifierLoop(records(message(bytes(event), 7)), handle, options());
    expect(steps).toEqual([`handle ${event.eventId}`, 'commit 7']);
  });

  // Retrying cannot fix such a record, and stopping on it would stop every campus behind it
  it('logs and commits records it cannot handle, without handling them', async () => {
    const handle = vi.fn(() => Promise.resolve());
    const logger = fakeLogger();
    await runNotifierLoop(
      records(
        message(Buffer.from('not json'), 1),
        message(bytes({ ...event, type: 'CampusRenamed' }), 2),
        message(null, 3),
      ),
      handle,
      options({ logger }),
    );
    expect(handle).not.toHaveBeenCalled();
    expect(steps).toEqual(['commit 1', 'commit 2', 'commit 3']);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'campuses', partition: 0, offset: '1', reason: 'not JSON' }),
      expect.any(String),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ offset: '2', type: 'CampusRenamed', version: 1 }),
      expect.any(String),
    );
  });

  // A failed publish or a lost database: the next try may work, and the offset must not move
  // past an event that was not handled
  it('retries a failing event with growing waits, and commits only once it worked', async () => {
    let calls = 0;
    const handle = (): Promise<void> => {
      calls += 1;
      steps.push(`handle ${calls}`);
      return calls < 3
        ? Promise.reject(new Error('RabbitMQ nacked job notify.email'))
        : Promise.resolve();
    };
    const logger = fakeLogger();
    await runNotifierLoop(records(message(bytes(event), 5)), handle, options({ logger }));
    expect(steps).toEqual([
      'handle 1',
      'sleep 100',
      'handle 2',
      'sleep 200',
      'handle 3',
      'commit 5',
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: event.eventId,
        failures: 1,
        error: 'Error: RabbitMQ nacked job notify.email',
      }),
      expect.any(String),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ afterFailures: 2 }),
      expect.any(String),
    );
  });

  it('logs as error from the 10th failure in a row: someone should look', async () => {
    let calls = 0;
    const handle = (): Promise<void> => {
      calls += 1;
      return calls <= 10 ? Promise.reject(new Error('down')) : Promise.resolve();
    };
    const logger = fakeLogger();
    await runNotifierLoop(records(message(bytes(event), 1)), handle, options({ logger }));
    expect(logger.warn).toHaveBeenCalledTimes(9);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ failures: 10 }),
      expect.any(String),
    );
  });

  // The record is read again after a restart; processed_event drops it if it did get through
  it('stops retrying when told to stop, and leaves that offset uncommitted', async () => {
    const controller = new AbortController();
    const handle = (): Promise<void> => {
      steps.push('handle');
      return Promise.reject(new Error('down'));
    };
    await runNotifierLoop(
      records(message(bytes(event), 1), message(bytes(event), 2)),
      handle,
      options({
        signal: controller.signal,
        sleep: () => {
          steps.push('sleep');
          controller.abort();
          return Promise.resolve();
        },
      }),
    );
    expect(steps).toEqual(['handle', 'sleep']);
  });

  it('finishes the record in hand when told to stop, then reads no more', async () => {
    const controller = new AbortController();
    const handle = (): Promise<void> => {
      steps.push('handle');
      controller.abort();
      return Promise.resolve();
    };
    await runNotifierLoop(
      records(message(bytes(event), 1), message(bytes(event), 2)),
      handle,
      options({ signal: controller.signal }),
    );
    expect(steps).toEqual(['handle', 'commit 1']);
  });

  // Stopping closes the Kafka stream, which can cut off a read in flight
  it('stops quietly when the stream fails after a stop, and fails loudly before one', async () => {
    const failing = async function* (): AsyncGenerator<ConsumedMessage> {
      await Promise.resolve();
      yield* [];
      throw new Error('The operation was aborted');
    };
    const controller = new AbortController();
    controller.abort();
    await expect(
      runNotifierLoop(failing(), () => Promise.resolve(), options({ signal: controller.signal })),
    ).resolves.toBeUndefined();

    await expect(runNotifierLoop(failing(), () => Promise.resolve(), options())).rejects.toThrow(
      /aborted/,
    );
  });

  // The event is done, and the next commit carries the offset forward. If none comes, the record
  // returns after a restart and processed_event drops it
  it('goes on to the next record when a commit fails', async () => {
    const logger = fakeLogger();
    const failingCommit: ConsumedMessage = {
      ...message(bytes(event), 1),
      commit: () => Promise.reject(new Error('coordinator moved')),
    };
    await runNotifierLoop(
      records(failingCommit, message(bytes(event), 2)),
      () => Promise.resolve(),
      options({ logger }),
    );
    expect(steps).toEqual(['commit 2']);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ offset: '1', error: 'Error: coordinator moved' }),
      expect.any(String),
    );
  });

  // parseEvent only asks that a type is a non-empty string, so it can hold anything
  it('logs an unknown type only if it looks like an event name', async () => {
    const logger = fakeLogger();
    await runNotifierLoop(
      records(message(bytes({ ...event, type: 'student@aiub.edu PASSWORD=hunter2' }), 1)),
      () => Promise.resolve(),
      options({ logger }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ offset: '1', type: '(unreadable)', version: 1 }),
      expect.any(String),
    );
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain('hunter2');
  });

  it('never logs what a record holds', async () => {
    const logger = fakeLogger();
    await runNotifierLoop(
      records(
        message(Buffer.from('{"name":"Secret Campus"'), 1),
        message(bytes({ ...event, payload: { ...event.payload, slug: 7 } }), 2),
      ),
      () => Promise.resolve(),
      options({ logger }),
    );
    const logged = JSON.stringify([logger.info.mock.calls, logger.error.mock.calls]);
    expect(logged).not.toContain('Secret Campus');
    expect(logger.error).toHaveBeenCalledTimes(2);
  });
});
