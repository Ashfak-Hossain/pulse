import type { OutboxRecord } from './record.js';
import { oneSendAtATime, type RelayProducer } from './relay.js';

const request = { messages: [] as OutboxRecord[] };

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
