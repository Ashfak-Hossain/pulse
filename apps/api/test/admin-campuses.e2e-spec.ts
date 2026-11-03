import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { apiErrorSchema, campusSchema, type CreateCampus } from '@pulse/contracts';
import { campus, createDb, eq, outboxEvent, sql, type Database } from '@pulse/db';
import { parseEvent } from '@pulse/events';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { App } from 'supertest/types.js';
import { inject } from 'vitest';
import { configureApp } from '../src/app.setup.js';
import { AppModule } from '../src/app.module.js';
import { DATABASE } from '../src/db/db.module.js';

// Shared database, files run in parallel: every slug here carries this file's run id
const run = randomUUID().slice(0, 8);
// Set in vitest.config.e2e.ts
const auth = `Bearer ${process.env.ADMIN_TOKEN ?? ''}`;

function newCampus(label: string): CreateCampus {
  return {
    name: `Admin E2E ${label}`,
    slug: `admin-${label}-${run}`,
    emailDomains: [`${label}-${run}.pulse.test`],
    timezone: 'Asia/Dhaka',
    location: { lat: 23.8223, lng: 90.4274 },
  };
}

describe('POST /admin/campuses, against a real database', () => {
  let app: INestApplication<App>;
  // pulse_app cannot read outbox_event, so checks go through the owner
  let owner: Database;
  const failSlug = `admin-fail-${run}`;
  const trigger = `e2e_fail_outbox_${run}`;

  const post = (body: unknown, authorization: string | null = auth) => {
    const req = request(app.getHttpServer()).post('/admin/campuses');
    return (authorization === null ? req : req.set('Authorization', authorization)).send(
      body as object,
    );
  };

  const campusesWithSlug = (slug: string) =>
    owner.select().from(campus).where(eq(campus.slug, slug));
  const outboxRowsForSlug = (slug: string) =>
    owner
      .select()
      .from(outboxEvent)
      .where(sql`${outboxEvent.payload}->>'slug' = ${slug}`);

  beforeAll(async () => {
    owner = createDb(inject('ownerUrl'));
    // Test-only: refuses the outbox insert for one slug, so the rollback can be seen.
    // Names and the slug come from randomUUID, never from input
    await owner.execute(
      sql.raw(`
        CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.payload->>'slug' = '${failSlug}' THEN
            RAISE EXCEPTION 'e2e: outbox insert refused';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER ${trigger} BEFORE INSERT ON outbox_event
          FOR EACH ROW EXECUTE FUNCTION ${trigger}();
      `),
    );

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE)
      .useFactory({ factory: () => createDb(inject('appUrl')) })
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await owner
      ?.execute(
        sql.raw(
          `DROP TRIGGER IF EXISTS ${trigger} ON outbox_event; DROP FUNCTION IF EXISTS ${trigger}();`,
        ),
      )
      .catch(() => undefined);
    await app?.close();
    await owner?.$client.end();
  });

  it('stores the campus and one CampusCreated outbox row the relay can publish', async () => {
    const body = newCampus('ok');
    const res = await post(body).expect(201);

    const created = campusSchema.parse(res.body);
    expect(created).toEqual({ id: expect.any(String) as string, ...body });

    const [row] = await campusesWithSlug(body.slug);
    expect(row).toMatchObject({
      id: created.id,
      name: body.name,
      location: { x: 90.4274, y: 23.8223 },
    });

    const outbox = await owner
      .select()
      .from(outboxEvent)
      .where(eq(outboxEvent.aggregateId, created.id));
    expect(outbox).toHaveLength(1);
    const [event] = outbox;
    expect(event).toMatchObject({
      aggregate: 'campus',
      type: 'CampusCreated',
      version: 1,
      topic: 'campuses',
      key: created.id,
      publishedAt: null,
      attempts: 0,
    });
    // The eventId is the outbox row's own id, never the campus id
    expect(event?.id).not.toBe(created.id);

    // Mirrors toRecord() in apps/worker/src/relay/record.ts: the row read back as an envelope
    const parsed = parseEvent({
      eventId: event?.id,
      type: event?.type,
      version: event?.version,
      occurredAt: event?.createdAt.toISOString(),
      payload: event?.payload,
    });
    expect(parsed).toEqual({
      kind: 'ok',
      event: expect.objectContaining({
        payload: { campusId: created.id, name: body.name, slug: body.slug, timezone: 'Asia/Dhaka' },
      }) as unknown,
    });
  });

  // Every token case is in admin-token.guard.spec.ts; this proves the guard is on the route
  it('answers 401 without the admin token and writes nothing', async () => {
    const body = newCampus('noauth');
    const res = await post(body, null).expect(401);
    expect(apiErrorSchema.parse(res.body)).toEqual({
      statusCode: 401,
      error: 'Unauthorized',
      message: 'Unauthorized',
    });
    expect(await campusesWithSlug(body.slug)).toHaveLength(0);
  });

  it('answers 400 for an unknown field (a client-chosen id) and writes nothing', async () => {
    const body = { ...newCampus('strict'), id: randomUUID() };
    const res = await post(body).expect(400);
    expect(apiErrorSchema.parse(res.body).statusCode).toBe(400);
    expect(await campusesWithSlug(body.slug)).toHaveLength(0);
  });

  it('two requests for one slug at once: one 201, one 409, one outbox row', async () => {
    const body = newCampus('race');
    const [a, b] = await Promise.all([post(body), post({ ...body, name: 'Other name' })]);

    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const conflict = a.status === 409 ? a : b;
    // Fixed text: never the slug, never PostgreSQL's message
    expect(apiErrorSchema.parse(conflict.body)).toEqual({
      statusCode: 409,
      error: 'Conflict',
      message: 'A campus with this slug already exists',
    });
    expect(await campusesWithSlug(body.slug)).toHaveLength(1);
    expect(await outboxRowsForSlug(body.slug)).toHaveLength(1);
  });

  it('rolls the campus back when the outbox insert fails', async () => {
    const body = { ...newCampus('fail'), slug: failSlug };
    const res = await post(body).expect(500);
    expect(apiErrorSchema.parse(res.body)).toEqual({
      statusCode: 500,
      error: 'Internal Server Error',
      message: 'Internal Server Error',
    });
    expect(await campusesWithSlug(failSlug)).toHaveLength(0);
    expect(await outboxRowsForSlug(failSlug)).toHaveLength(0);
  });

  // The contract's limits must fit inside the event's, or createEvent throws and a valid body gets 500
  it('accepts the largest valid body (contract limits fit the event schema)', async () => {
    const slug = `max-${run}-`.padEnd(64, 'x');
    const body = { ...newCampus('max'), name: 'N'.repeat(200), slug };
    await post(body).expect(201);
    expect(await outboxRowsForSlug(slug)).toHaveLength(1);
  });
});
