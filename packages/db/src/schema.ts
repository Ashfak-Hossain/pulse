import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  geometry,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgRole,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

// Created by the Compose init script, not by migrations
const pulseApp = pgRole('pulse_app').existing();

// Set by withCampus(). A reused connection holds '' instead of NULL, so turn it back into NULL
const currentCampusId = sql`nullif(current_setting('app.campus_id', true), '')::uuid`;

export const campus = pgTable(
  'campus',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    // Only these email domains can sign in here
    emailDomains: text('email_domains').array().notNull(),
    // x = longitude, y = latitude (WGS 84)
    location: geometry('location', { type: 'point', mode: 'xy', srid: 4326 }).notNull(),
    // e.g. Asia/Dhaka
    timezone: text('timezone').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Anyone may read a campus (sign-in looks it up by email domain). Writes only touch the
  // campus set by withCampus(). No delete: removing a tenant is an admin job
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

// Events waiting for the relay to publish them. Not campus-scoped: the relay reads every
// campus, so no RLS. The app can insert but not read, so never call .returning() on it
export const outboxEvent = pgTable(
  'outbox_event',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Publish order. Not created_at: every row of one transaction gets the same time
    seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
    aggregate: text('aggregate').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    type: text('type').notNull(),
    // Filled from @pulse/events, so the relay never needs to know event types
    version: integer('version').notNull(),
    topic: text('topic').notNull(),
    key: text('key').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
  },
  // The index holds only unpublished rows, so it stays small
  (table) => [
    index('outbox_event_unpublished_idx')
      .on(table.seq)
      .where(sql`published_at is null`),
    check('outbox_event_version_positive', sql`${table.version} > 0`),
    check('outbox_event_topic_not_empty', sql`${table.topic} <> ''`),
    check('outbox_event_key_not_empty', sql`${table.key} <> ''`),
    check('outbox_event_attempts_not_negative', sql`${table.attempts} >= 0`),
  ],
);

// A consumer inserts this in the same transaction as its work,
// so a redelivered event fails on the primary key and runs once
export const processedEvent = pgTable(
  'processed_event',
  {
    consumer: text('consumer').notNull(),
    eventId: uuid('event_id').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.consumer, table.eventId] })],
);
