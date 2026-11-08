import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  assertRestrictedRole,
  campus,
  course,
  createDb,
  emailDelivery,
  outboxEvent,
  processedEvent,
  section,
  sectionMeeting,
  term,
} from '../src/index.js';
import { newCampus, pgErrorCode } from './support/fixtures.js';

const INSUFFICIENT_PRIVILEGE = '42501';
const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';

describe('pulse_mailer, the role the email worker connects as', () => {
  const owner = createDb(inject('ownerUrl'));
  const app = createDb(inject('appUrl'));
  const mailer = createDb(inject('mailerUrl'));
  const tenant = newCampus();

  beforeAll(async () => {
    await owner.insert(campus).values(tenant);
  });

  afterAll(async () => {
    await Promise.all([owner.$client.end(), app.$client.end(), mailer.$client.end()]);
  });

  const delivery = () => ({
    dedupeKey: `campus-created:${randomUUID()}`,
    jobId: randomUUID(),
    template: 'campus-created',
    status: 'sending' as const,
    claimId: randomUUID(),
  });

  it('passes the boot check: not superuser, no BYPASSRLS, owns nothing', async () => {
    await expect(assertRestrictedRole(mailer)).resolves.toBeUndefined();
  });

  it('claims, marks and reads deliveries, one row per dedupe key', async () => {
    const row = delivery();
    await mailer.insert(emailDelivery).values(row);
    expect(await pgErrorCode(mailer.insert(emailDelivery).values(row))).toBe(UNIQUE_VIOLATION);
    const byKey = eq(emailDelivery.dedupeKey, row.dedupeKey);
    await mailer.update(emailDelivery).set({ status: 'sent', sentAt: new Date() }).where(byKey);
    const [stored] = await mailer.select().from(emailDelivery).where(byKey);
    expect(stored).toMatchObject({ status: 'sent', attempts: 1, lastError: null });
  });

  // A deleted row would let a redelivered job send its email again
  it('cannot erase a delivery', async () => {
    const row = delivery();
    await mailer.insert(emailDelivery).values(row);
    expect(
      await pgErrorCode(
        mailer.delete(emailDelivery).where(eq(emailDelivery.dedupeKey, row.dedupeKey)),
      ),
    ).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it.each([
    { status: 'queued' },
    { status: 'sent' },
    { status: 'sending', sentAt: new Date() },
    { lastError: 'x'.repeat(201) },
    { dedupeKey: 'x'.repeat(201) },
    { template: 'x'.repeat(101) },
    { attempts: 0 },
  ])('rejects an impossible row %o', async (change) => {
    expect(
      await pgErrorCode(mailer.insert(emailDelivery).values({ ...delivery(), ...change } as never)),
    ).toBe(CHECK_VIOLATION);
  });

  // Templates need the campus name; nothing else about a campus is the mailer's business
  it('reads only the id and name of a campus', async () => {
    const [row] = await mailer
      .select({ id: campus.id, name: campus.name })
      .from(campus)
      .where(eq(campus.id, tenant.id));
    expect(row).toEqual({ id: tenant.id, name: tenant.name });
    expect(await pgErrorCode(mailer.select().from(campus))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(
      await pgErrorCode(mailer.update(campus).set({ name: 'x' }).where(eq(campus.id, tenant.id))),
    ).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('cannot read or write any other app table', async () => {
    for (const read of [
      mailer.select().from(course),
      mailer.select().from(outboxEvent),
      mailer.select().from(processedEvent),
      mailer.select().from(term),
      mailer.select().from(section),
      mailer.select().from(sectionMeeting),
    ]) {
      expect(await pgErrorCode(read)).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  // The API sends no email: an OTP is queued as a job, the worker sends it
  it('keeps the API role out of email_delivery', async () => {
    expect(await pgErrorCode(app.select().from(emailDelivery))).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await pgErrorCode(app.insert(emailDelivery).values(delivery()))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(await pgErrorCode(app.update(emailDelivery).set({ status: 'failed' }))).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
  });
});
