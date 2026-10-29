import { sql } from 'drizzle-orm';
import {
  bigint,
  geometry,
  index,
  jsonb,
  pgPolicy,
  pgRole,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

// Created by infra/compose/postgres/init/01-app-role.sql, so migrations must not create it
const pulseApp = pgRole('pulse_app').existing();

// withCampus() sets app.campus_id for one transaction. Outside one it is unset (NULL) or, on a
// reused connection, '' — nullif turns '' into NULL, and `x = NULL` matches no row
const currentCampusId = sql`nullif(current_setting('app.campus_id', true), '')::uuid`;

export const campus = pgTable(
  'campus',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    // Only addresses on these domains can sign in to this campus
    emailDomains: text('email_domains').array().notNull(),
    // Longitude (x), latitude (y) in WGS 84, the system GPS and OpenStreetMap use
    location: geometry('location', { type: 'point', mode: 'xy', srid: 4326 }).notNull(),
    // IANA name such as Asia/Dhaka; class times are local to the campus
    timezone: text('timezone').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // The campus table is the tenant itself: its id plays the part campus_id plays elsewhere.
  // Campus facts are public (sign-in finds a campus by email domain before any campus is set),
  // so anyone may read; insert and update only touch the campus set by withCampus(). No policy
  // for delete: pulse_app has no DELETE on campus, since removing a tenant is an admin job.
  // USING picks the rows a command may touch; WITH CHECK guards the rows it writes
  () => [
    pgPolicy('campus_read', { for: 'select', to: pulseApp, using: sql`true` }),
    pgPolicy('campus_insert', {
      for: 'insert',
      to: pulseApp,
      withCheck: sql`id = ${currentCampusId}`,
    }),
    pgPolicy('campus_update', {
      for: 'update',
      to: pulseApp,
      using: sql`id = ${currentCampusId}`,
      withCheck: sql`id = ${currentCampusId}`,
    }),
  ],
);

// Written in the same transaction as the business change; the outbox relay publishes it to Kafka.
// Not campus-scoped: the relay reads every campus's events, so no RLS. The app may only insert
// (no SELECT), so never use .returning() here: create the id with randomUUID() when you need it
export const outboxEvent = pgTable(
  'outbox_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Grows by one on every insert, so the relay publishes in write order. created_at cannot:
    // now() is the transaction's start time, so all events of one transaction share it
    seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
    // for tracing: e.g. aggregate 'campus' and the campus id.
    // The Kafka topic and key are the relay's job, not this table's
    aggregate: text('aggregate').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // NULL until the relay has published the event
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  // The relay asks "unpublished, in seq order"; a partial index holds only those rows, so it
  // stays small however many events were published before
  (table) => [
    index('outbox_event_unpublished_idx')
      .on(table.seq)
      .where(sql`published_at is null`),
  ],
);

// One row per (consumer, event). A consumer inserts it in the same transaction as its effect;
// a redelivered event hits the primary key, so the effect never happens twice
export const processedEvent = pgTable(
  'processed_event',
  {
    consumer: text('consumer').notNull(),
    eventId: uuid('event_id').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.consumer, table.eventId] })],
);
