import { DrizzleQueryError } from '@pulse/db';
import type { OutboxRecord } from './record.js';
import { describeError, oneSendAtATime, type RelayProducer } from './relay.js';

const request = { messages: [] as OutboxRecord[] };

describe('describeError', () => {
  it('gives the name and message of an Error', () => {
    expect(describeError(new TypeError('bad value'))).toBe('TypeError: bad value');
  });

  it('adds a string code when there is one', () => {
    const error = Object.assign(new Error('broker down'), { code: 'PLT_KFK_NETWORK' });
    expect(describeError(error)).toBe('Error [PLT_KFK_NETWORK]: broker down');
  });

  it('turns a thrown value that is not an Error into a string', () => {
    expect(describeError('plain string')).toBe('plain string');
  });

  it('never includes the cause (a ZodError there can hold row data)', () => {
    const error = new Error('row is not a valid event', {
      cause: new Error('payload.email=a@example.test'),
    });
    expect(describeError(error)).not.toContain('a@example.test');
  });

  // Drizzle's own message is "Failed query: <sql> params: <values>", and the values can be row data
  it('describes a failed query by its database error, never by the query or its params', () => {
    const pgError = Object.assign(new Error('permission denied for table outbox_event'), {
      code: '42501',
    });
    const error = new DrizzleQueryError(
      'select * from x where email = $1',
      ['a@example.test'],
      pgError,
    );

    const text = describeError(error);

    expect(text).toContain('42501');
    expect(text).toContain('permission denied for table outbox_event');
    expect(text).not.toContain('a@example.test');
    expect(text).not.toContain('select');
  });

  it('still says something for a failed query without a cause', () => {
    const error = new DrizzleQueryError('select $1', ['a@example.test']);
    const text = describeError(error);
    expect(text).toMatch(/query failed/i);
    expect(text).not.toContain('a@example.test');
  });
});

describe('oneSendAtATime', () => {
  // A send that finishes only when the test says so
  function controllableProducer() {
    const calls: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
    const producer: RelayProducer = {
      send: () =>
        new Promise((resolve, reject) => {
          calls.push({ resolve: () => resolve({ ok: true }), reject });
        }),
    };
    return { producer, calls };
  }

  it('passes a send through and returns its result', async () => {
    const { producer, calls } = controllableProducer();
    const guarded = oneSendAtATime(producer);

    const sending = guarded.send(request);
    calls[0]?.resolve();

    await expect(sending).resolves.toEqual({ ok: true });
  });

  // After a timeout the Kafka client keeps retrying the old send; a second one on top would
  // stack duplicates that can land after newer events
  it('refuses a second send while the first is still running', async () => {
    const { producer, calls } = controllableProducer();
    const guarded = oneSendAtATime(producer);

    const first = guarded.send(request);
    await expect(guarded.send(request)).rejects.toThrow(/still running/);
    expect(calls).toHaveLength(1);

    calls[0]?.resolve();
    await first;
  });

  it('allows the next send once the first has finished', async () => {
    const { producer, calls } = controllableProducer();
    const guarded = oneSendAtATime(producer);

    const first = guarded.send(request);
    calls[0]?.resolve();
    await first;

    const second = guarded.send(request);
    expect(calls).toHaveLength(2);
    calls[1]?.resolve();
    await expect(second).resolves.toEqual({ ok: true });
  });

  it('allows the next send once the first has failed', async () => {
    const { producer, calls } = controllableProducer();
    const guarded = oneSendAtATime(producer);

    const first = guarded.send(request);
    calls[0]?.reject(new Error('broker down'));
    await expect(first).rejects.toThrow('broker down');

    void guarded.send(request);
    expect(calls).toHaveLength(2);
  });

  it('allows the next send after a send that threw at once', async () => {
    let calls = 0;
    const guarded = oneSendAtATime({
      send: () => {
        calls += 1;
        if (calls === 1) throw new Error('closed');
        return Promise.resolve({ ok: true });
      },
    });

    await expect(guarded.send(request)).rejects.toThrow('closed');
    await expect(guarded.send(request)).resolves.toEqual({ ok: true });
  });
});
