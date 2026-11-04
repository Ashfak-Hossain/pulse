import { randomUUID } from 'node:crypto';
import { count, eq } from 'drizzle-orm';
import { afterAll, describe, expect, inject, it } from 'vitest';
import {
  assertRestrictedRole,
  campus,
  course,
  createDb,
  outboxEvent,
  processedEvent,
} from '../src/index.js';
import { campusCreated, pgErrorCode } from './support/fixtures.js';

const INSUFFICIENT_PRIVILEGE = '42501';
const UNIQUE_VIOLATION = '23505';

describe('pulse_notifier, the role the notifier consumer connects as', () => {
  const owner = createDb(inject('ownerUrl'));
  const app = createDb(inject('appUrl'));
  const notifier = createDb(inject('notifierUrl'));

  afterAll(async () => {
    await Promise.all([owner.$client.end(), app.$client.end(), notifier.$client.end()]);
  });

  const processed = () => ({ consumer: 'notifier', eventId: randomUUID() });

  it('passes the boot check: not superuser, no BYPASSRLS, owns nothing', async () => {
    await expect(assertRestrictedRole(notifier)).resolves.toBeUndefined();
  });

  it('rejects the same event twice for one consumer', async () => {
    const row = processed();
    await notifier.insert(processedEvent).values(row);
    expect(await pgErrorCode(notifier.insert(processedEvent).values(row))).toBe(UNIQUE_VIOLATION);
  });

  // The consumer's way in: 0 rows back means the event was handled before
  it('learns from the insert alone whether the event is new', async () => {
    const row = processed();
    const insert = () =>
      notifier
        .insert(processedEvent)
        .values(row)
        .onConflictDoNothing()
        .returning({ eventId: processedEvent.eventId });
    expect(await insert()).toEqual([{ eventId: row.eventId }]);
    expect(await insert()).toEqual([]);
  });

  it('lets two consumers record the same event', async () => {
    const eventId = randomUUID();
    await notifier.insert(processedEvent).values({ consumer: 'notifier', eventId });
    await notifier.insert(processedEvent).values({ consumer: 'campus-search', eventId });
    const [recorded] = await owner
      .select({ n: count() })
      .from(processedEvent)
      .where(eq(processedEvent.eventId, eventId));
    expect(recorded?.n).toBe(2);
  });

  // An erased row would let a redelivered event run twice
  it('cannot change or erase what it recorded', async () => {
    const row = processed();
    await notifier.insert(processedEvent).values(row);
    const byEvent = eq(processedEvent.eventId, row.eventId);
    expect(
      await pgErrorCode(notifier.update(processedEvent).set({ consumer: 'other' }).where(byEvent)),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await pgErrorCode(notifier.delete(processedEvent).where(byEvent))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });

  it('cannot read or write any other app table', async () => {
    for (const read of [
      notifier.select().from(campus),
      notifier.select().from(course),
      notifier.select().from(outboxEvent),
    ]) {
      expect(await pgErrorCode(read)).toBe(INSUFFICIENT_PRIVILEGE);
    }
    expect(
      await pgErrorCode(notifier.insert(outboxEvent).values(campusCreated(randomUUID()))),
    ).toBe(INSUFFICIENT_PRIVILEGE);
  });

  // Only consumers record handled events; the API handles none
  it('is the only app role that records handled events', async () => {
    expect(await pgErrorCode(app.insert(processedEvent).values(processed()))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await pgErrorCode(app.select().from(processedEvent))).toBe(INSUFFICIENT_PRIVILEGE);
  });
});
