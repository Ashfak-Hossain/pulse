import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, inject, it } from 'vitest';
import {
  assertRestrictedRole,
  campus,
  createDb,
  outboxEvent,
  processedEvent,
  withCampus,
} from '../src/index.js';
import { campusCreated, newCampus, pgErrorCode } from './support/fixtures.js';

const INSUFFICIENT_PRIVILEGE = '42501';
const CHECK_VIOLATION = '23514';

describe('pulse_relay, the role the outbox relay connects as', () => {
  const owner = createDb(inject('ownerUrl'));
  const app = createDb(inject('appUrl'));
  const relay = createDb(inject('relayUrl'));

  afterAll(async () => {
    await Promise.all([owner.$client.end(), app.$client.end(), relay.$client.end()]);
  });

  // A campus and its CampusCreated row, written the way the API writes them
  async function writeCampusEvent(): Promise<string> {
    const created = newCampus();
    await withCampus(app, created.id, async (tx) => {
      await tx.insert(campus).values(created);
      await tx.insert(outboxEvent).values(campusCreated(created.id));
    });
    return created.id;
  }

  it('passes the boot check: not superuser, no BYPASSRLS, owns nothing', async () => {
    await expect(assertRestrictedRole(relay)).resolves.toBeUndefined();
  });

  it('reads unpublished rows with the columns it needs to publish them', async () => {
    const campusId = await writeCampusEvent();
    const [row] = await relay
      .select()
      .from(outboxEvent)
      .where(eq(outboxEvent.aggregateId, campusId));
    expect(row).toMatchObject({
      type: 'CampusCreated',
      version: 1,
      topic: 'campuses',
      key: campusId,
      payload: { campusId },
      attempts: 0,
      lastError: null,
      publishedAt: null,
    });
  });

  it('marks rows published and records failed attempts', async () => {
    const campusId = await writeCampusEvent();
    const byCampus = eq(outboxEvent.aggregateId, campusId);

    await relay
      .update(outboxEvent)
      .set({ attempts: sql`${outboxEvent.attempts} + 1`, lastError: 'Error: broker down' })
      .where(byCampus);
    await relay.update(outboxEvent).set({ publishedAt: new Date() }).where(byCampus);

    const [row] = await owner.select().from(outboxEvent).where(byCampus);
    expect(row).toMatchObject({ attempts: 1, lastError: 'Error: broker down' });
    expect(row?.publishedAt).toBeInstanceOf(Date);
  });

  it('cannot change what an event says', async () => {
    const campusId = await writeCampusEvent();
    const byCampus = eq(outboxEvent.aggregateId, campusId);
    for (const change of [
      { payload: { campusId: 'changed' } },
      { topic: 'trips' },
      { key: 'other' },
      { type: 'Other' },
    ]) {
      expect(await pgErrorCode(relay.update(outboxEvent).set(change).where(byCampus))).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    }
  });

  it('cannot add or delete outbox rows', async () => {
    const campusId = await writeCampusEvent();
    expect(await pgErrorCode(relay.insert(outboxEvent).values(campusCreated(campusId)))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(
      await pgErrorCode(relay.delete(outboxEvent).where(eq(outboxEvent.aggregateId, campusId))),
    ).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('cannot read any other table', async () => {
    expect(await pgErrorCode(relay.select().from(campus))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await pgErrorCode(relay.select().from(processedEvent))).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe('outbox rows always start unpublished', () => {
  const owner = createDb(inject('ownerUrl'));
  const app = createDb(inject('appUrl'));

  afterAll(async () => {
    await Promise.all([owner.$client.end(), app.$client.end()]);
  });

  // The owner too: the guard is a trigger, so it holds for every role
  it.each([
    ['published_at', { publishedAt: new Date() }],
    ['attempts', { attempts: 3 }],
    ['last_error', { lastError: 'Error: made up' }],
  ])('rejects an insert that sets %s', async (_column, preset) => {
    const created = newCampus();
    await owner.insert(campus).values(created);
    const row = { ...campusCreated(created.id), ...preset };

    expect(
      await pgErrorCode(withCampus(app, created.id, (tx) => tx.insert(outboxEvent).values(row))),
    ).toBe(CHECK_VIOLATION);
    expect(await pgErrorCode(owner.insert(outboxEvent).values(row))).toBe(CHECK_VIOLATION);
  });
});

describe('outbox_event checks', () => {
  const owner = createDb(inject('ownerUrl'));
  const relay = createDb(inject('relayUrl'));

  afterAll(async () => {
    await Promise.all([owner.$client.end(), relay.$client.end()]);
  });

  // An empty key would send every event to one partition with no order per campus
  it.each([
    ['an empty key', { key: '' }],
    ['an empty topic', { topic: '' }],
    ['version 0', { version: 0 }],
  ])('rejects a row with %s', async (_case, change) => {
    const created = newCampus();
    await owner.insert(campus).values(created);
    const row = { ...campusCreated(created.id), ...change };

    expect(await pgErrorCode(owner.insert(outboxEvent).values(row))).toBe(CHECK_VIOLATION);
  });

  it('keeps attempts at zero or above', async () => {
    const created = newCampus();
    await owner.insert(campus).values(created);
    await owner.insert(outboxEvent).values(campusCreated(created.id));

    expect(
      await pgErrorCode(
        relay
          .update(outboxEvent)
          .set({ attempts: -1 })
          .where(eq(outboxEvent.aggregateId, created.id)),
      ),
    ).toBe(CHECK_VIOLATION);
  });
});
