import { randomUUID } from 'node:crypto';
import { asc, count, eq } from 'drizzle-orm';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { campus, createDb, outboxEvent, processedEvent, withCampus } from '../src/index.js';
import { campusCreated, newCampus, pgErrorCode } from './support/fixtures.js';

describe('outbox and processed events, as pulse_app', () => {
  const owner = createDb(inject('ownerUrl'));
  const app = createDb(inject('appUrl'));

  afterAll(async () => {
    await Promise.all([owner.$client.end(), app.$client.end()]);
  });

  async function rowsFor(campusId: string): Promise<{ campuses: number; events: number }> {
    const [campuses] = await owner
      .select({ n: count() })
      .from(campus)
      .where(eq(campus.id, campusId));
    const [events] = await owner
      .select({ n: count() })
      .from(outboxEvent)
      .where(eq(outboxEvent.aggregateId, campusId));
    return { campuses: campuses?.n ?? 0, events: events?.n ?? 0 };
  }

  it('commits a campus and its outbox event together', async () => {
    const created = newCampus();
    await withCampus(app, created.id, async (tx) => {
      await tx.insert(campus).values(created);
      await tx.insert(outboxEvent).values(campusCreated(created.id));
    });
    expect(await rowsFor(created.id)).toEqual({ campuses: 1, events: 1 });
  });

  it('keeps the events of one transaction in the order they were written', async () => {
    const created = newCampus();
    await withCampus(app, created.id, async (tx) => {
      await tx.insert(campus).values(created);
      await tx.insert(outboxEvent).values(campusCreated(created.id));
      await tx.insert(outboxEvent).values({ ...campusCreated(created.id), type: 'CampusRenamed' });
    });

    const events = await owner
      .select({ type: outboxEvent.type })
      .from(outboxEvent)
      .where(eq(outboxEvent.aggregateId, created.id))
      .orderBy(asc(outboxEvent.seq));
    expect(events.map((event) => event.type)).toEqual(['CampusCreated', 'CampusRenamed']);
  });

  it('rolls both back when the transaction fails after the inserts', async () => {
    const created = newCampus();
    const work = withCampus(app, created.id, async (tx) => {
      await tx.insert(campus).values(created);
      await tx.insert(outboxEvent).values(campusCreated(created.id));
      throw new Error('failure after both inserts');
    });
    await expect(work).rejects.toThrow('failure after both inserts');
    expect(await rowsFor(created.id)).toEqual({ campuses: 0, events: 0 });
  });

  it('leaves a new outbox event unpublished', async () => {
    const created = newCampus();
    await withCampus(app, created.id, async (tx) => {
      await tx.insert(campus).values(created);
      await tx.insert(outboxEvent).values(campusCreated(created.id));
    });
    const [event] = await owner
      .select({ publishedAt: outboxEvent.publishedAt })
      .from(outboxEvent)
      .where(eq(outboxEvent.aggregateId, created.id));
    expect(event).toEqual({ publishedAt: null });
  });

  it('refuses RETURNING on an outbox insert (the app cannot read events back)', async () => {
    const created = newCampus();
    const work = withCampus(app, created.id, async (tx) => {
      await tx.insert(campus).values(created);
      return tx.insert(outboxEvent).values(campusCreated(created.id)).returning();
    });
    // 42501: permission denied for table outbox_event. Callers make the event id themselves
    expect(await pgErrorCode(work)).toBe('42501');
  });

  it('rejects the same event twice for one consumer', async () => {
    const row = { consumer: 'campus-notifier', eventId: randomUUID() };
    await app.insert(processedEvent).values(row);
    // 23505: unique violation on the (consumer, event_id) primary key
    expect(await pgErrorCode(app.insert(processedEvent).values(row))).toBe('23505');
  });

  it('lets two consumers record the same event', async () => {
    const eventId = randomUUID();
    await app.insert(processedEvent).values({ consumer: 'campus-notifier', eventId });
    await app.insert(processedEvent).values({ consumer: 'campus-search', eventId });
    const [recorded] = await owner
      .select({ n: count() })
      .from(processedEvent)
      .where(eq(processedEvent.eventId, eventId));
    expect(recorded?.n).toBe(2);
  });
});
