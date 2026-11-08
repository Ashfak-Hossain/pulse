import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  foreignKey,
  geometry,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgRole,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  time,
  uniqueIndex,
  uuid,
  unique,
} from 'drizzle-orm/pg-core';

// Created by the Compose init script, not by migrations
const pulseApp = pgRole('pulse_app').existing();
const pulseMailer = pgRole('pulse_mailer').existing();

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
    // Every row: an email about a campus has no campus context. Column grants (migration 0013)
    // limit it to id and name
    pgPolicy('campus_mailer_read', { for: 'select', to: pulseMailer, using: sql`true` }),
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

// A consumer inserts this first, in the same transaction as its work. On a redelivered event the
// primary key makes the insert return no row, so the work runs once
export const processedEvent = pgTable(
  'processed_event',
  {
    consumer: text('consumer').notNull(),
    eventId: uuid('event_id').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.consumer, table.eventId] })],
);

// One row per email the worker sends, keyed by the job's dedupeKey. The worker claims a row
// before it sends, so two copies of a job never both send (ADR 0011). A platform table like
// processed_event: no campus_id, and only pulse_mailer can reach it
export const emailDelivery = pgTable(
  'email_delivery',
  {
    dedupeKey: text('dedupe_key').primaryKey(),
    // The job that holds or last held the claim
    jobId: uuid('job_id').notNull(),
    template: text('template').notNull(),
    status: text('status', { enum: ['sending', 'sent', 'failed'] }).notNull(),
    // New on every claim, so a copy that lost its claim cannot mark the row
    claimId: uuid('claim_id').notNull(),
    attempts: integer('attempts').notNull().default(1),
    // An SMTP code or a fixed label, never an address
    lastError: text('last_error'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (table) => [
    check('email_delivery_status_valid', sql`${table.status} in ('sending', 'sent', 'failed')`),
    check(
      'email_delivery_sent_at_iff_sent',
      sql`(${table.status} = 'sent') = (${table.sentAt} is not null)`,
    ),
    check('email_delivery_attempts_positive', sql`${table.attempts} >= 1`),
    check('email_delivery_last_error_short', sql`length(${table.lastError}) <= 200`),
    check('email_delivery_dedupe_key_short', sql`length(${table.dedupeKey}) <= 200`),
    check('email_delivery_template_short', sql`length(${table.template}) <= 100`),
  ],
);

// Course reads are campus-scoped; writes remain owner-only until an admin workflow exists.
export const course = pgTable(
  'course',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    campusId: uuid('campus_id')
      .notNull()
      .references(() => campus.id),
    code: text('code').notNull(),
    title: text('title').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Also indexes the campus foreign key and the scoped code-ordered list query.
    unique('course_campus_code_unique').on(table.campusId, table.code),
    unique('course_id_campus_unique').on(table.id, table.campusId),
    index('course_title_trgm_idx').using('gin', table.title.op('gin_trgm_ops')),
    pgPolicy('course_read', {
      for: 'select',
      to: pulseApp,
      using: sql`${table.campusId} = ${currentCampusId}`,
    }),
  ],
);

export const term = pgTable(
  'term',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    campusId: uuid('campus_id')
      .notNull()
      .references(() => campus.id),
    name: text('name').notNull(),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    status: text('status', { enum: ['draft', 'active', 'archived'] })
      .notNull()
      .default('draft'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Set by the set_updated_at trigger (migration 0012); never write it
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('term_id_campus_unique').on(table.id, table.campusId),
    unique('term_campus_name_unique').on(table.campusId, table.name),
    uniqueIndex('term_one_active_per_campus')
      .on(table.campusId)
      .where(sql`${table.status} = 'active'`),
    check('term_dates_ordered', sql`${table.endsOn} > ${table.startsOn}`),
    check('term_status_valid', sql`${table.status} in ('draft', 'active', 'archived')`),
    pgPolicy('term_read', {
      for: 'select',
      to: pulseApp,
      using: sql`${table.campusId} = ${currentCampusId}`,
    }),
  ],
);

export const section = pgTable(
  'section',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    campusId: uuid('campus_id')
      .notNull()
      .references(() => campus.id),
    termId: uuid('term_id').notNull(),
    courseId: uuid('course_id').notNull(),
    externalClassId: text('external_class_id').notNull(),
    sectionLabel: text('section_label').notNull(),
    title: text('title').notNull(),
    capacity: smallint('capacity').notNull(),
    enrolled: smallint('enrolled').notNull(),
    status: text('status', {
      enum: ['open', 'reserved', 'freshman', 'closed', 'cancelled'],
    }).notNull(),
    instructorName: text('instructor_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Set by the set_updated_at trigger (migration 0012); never write it
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('section_id_campus_unique').on(table.id, table.campusId),
    unique('section_term_external_class_unique').on(table.termId, table.externalClassId),
    foreignKey({
      name: 'section_term_campus_fk',
      columns: [table.termId, table.campusId],
      foreignColumns: [term.id, term.campusId],
    }),
    foreignKey({
      name: 'section_course_campus_fk',
      columns: [table.courseId, table.campusId],
      foreignColumns: [course.id, course.campusId],
    }),
    index('section_campus_idx').on(table.campusId),
    index('section_term_campus_idx').on(table.termId, table.campusId),
    index('section_course_campus_idx').on(table.courseId, table.campusId),
    index('section_title_trgm_idx').using('gin', table.title.op('gin_trgm_ops')),
    check('section_capacity_nonnegative', sql`${table.capacity} >= 0`),
    check('section_enrolled_nonnegative', sql`${table.enrolled} >= 0`),
    check(
      'section_status_valid',
      sql`${table.status} in ('open', 'reserved', 'freshman', 'closed', 'cancelled')`,
    ),
    pgPolicy('section_read', {
      for: 'select',
      to: pulseApp,
      using: sql`${table.campusId} = ${currentCampusId}`,
    }),
  ],
);

export const sectionMeeting = pgTable(
  'section_meeting',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    campusId: uuid('campus_id')
      .notNull()
      .references(() => campus.id),
    sectionId: uuid('section_id').notNull(),
    kind: text('kind', { enum: ['theory', 'lab', 'other'] }).notNull(),
    weekday: smallint('weekday').notNull(),
    startTime: time('start_time').notNull(),
    endTime: time('end_time').notNull(),
    room: text('room'),
  },
  (table) => [
    foreignKey({
      name: 'section_meeting_section_campus_fk',
      columns: [table.sectionId, table.campusId],
      foreignColumns: [section.id, section.campusId],
    }).onDelete('cascade'),
    index('section_meeting_section_campus_idx').on(table.sectionId, table.campusId),
    index('section_meeting_departure_idx').on(table.campusId, table.weekday, table.endTime),
    check('section_meeting_kind_valid', sql`${table.kind} in ('theory', 'lab', 'other')`),
    check('section_meeting_weekday_valid', sql`${table.weekday} between 0 and 6`),
    check('section_meeting_times_ordered', sql`${table.endTime} > ${table.startTime}`),
    pgPolicy('section_meeting_read', {
      for: 'select',
      to: pulseApp,
      using: sql`${table.campusId} = ${currentCampusId}`,
    }),
  ],
);
