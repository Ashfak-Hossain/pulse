import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
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

// Catalog text as the app shows it: no edge spaces, not empty, at most `max` characters (the
// numbers match catalogLimits in @pulse/contracts; change both). NULL passes, so optional columns stay optional
function cleanTextCheck(column: AnyPgColumn, max: number) {
  return sql`${column} = btrim(${column}) and length(${column}) between 1 and ${sql.raw(String(max))}`;
}

// A coarse place: an H3 cell at resolution 8 is exactly 15 lowercase hex characters
function h3CellCheck(column: AnyPgColumn) {
  return sql`${column} ~ '^[0-9a-f]{15}$'`;
}

// A phone number in E.164: a plus, a country code that does not start with 0, 8 to 15 digits
function e164Check(column: AnyPgColumn) {
  return sql`${column} ~ '^[+][1-9][0-9]{7,14}$'`;
}

// Drizzle's geometry() only parses points. An area stays PostGIS's own value (hex EWKB) in
// TypeScript; queries read and write it as GeoJSON with ST_AsGeoJSON and ST_GeomFromGeoJSON
const multiPolygon = customType<{ data: string; driverData: string }>({
  dataType: () => 'geometry(MultiPolygon,4326)',
});

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
    check('course_code_clean', cleanTextCheck(table.code, 32)),
    check('course_title_clean', cleanTextCheck(table.title, 200)),
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
    check('term_name_clean', cleanTextCheck(table.name, 100)),
    check('term_dates_ordered', sql`${table.endsOn} > ${table.startsOn}`),
    check('term_status_valid', sql`${table.status} in ('draft', 'active', 'archived')`),
    pgPolicy('term_read', {
      for: 'select',
      to: pulseApp,
      using: sql`${table.campusId} = ${currentCampusId}`,
    }),
    // Campus admins create and activate terms. Grants (migration 0022) limit updates to status.
    // A new term starts as a draft: only activation (with its outbox event) makes one active
    pgPolicy('term_insert', {
      for: 'insert',
      to: pulseApp,
      withCheck: sql`${table.campusId} = ${currentCampusId} and ${table.status} = 'draft'`,
    }),
    pgPolicy('term_update', {
      for: 'update',
      to: pulseApp,
      using: sql`${table.campusId} = ${currentCampusId}`,
      withCheck: sql`${table.campusId} = ${currentCampusId}`,
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
    check('section_external_class_id_clean', cleanTextCheck(table.externalClassId, 32)),
    check('section_label_clean', cleanTextCheck(table.sectionLabel, 32)),
    check('section_title_clean', cleanTextCheck(table.title, 200)),
    check('section_instructor_name_clean', cleanTextCheck(table.instructorName, 200)),
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
    // 0 = Sunday … 6 = Saturday, as JavaScript's getDay()
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
    // One class cannot hold the same kind of meeting twice at one time; also makes re-imports
    // and the seed skip rows they already wrote
    unique('section_meeting_slot_unique').on(
      table.sectionId,
      table.weekday,
      table.startTime,
      table.kind,
    ),
    index('section_meeting_section_campus_idx').on(table.sectionId, table.campusId),
    index('section_meeting_departure_idx').on(table.campusId, table.weekday, table.endTime),
    check('section_meeting_kind_valid', sql`${table.kind} in ('theory', 'lab', 'other')`),
    check('section_meeting_weekday_valid', sql`${table.weekday} between 0 and 6`),
    check('section_meeting_times_ordered', sql`${table.endTime} > ${table.startTime}`),
    check('section_meeting_room_clean', cleanTextCheck(table.room, 64)),
    pgPolicy('section_meeting_read', {
      for: 'select',
      to: pulseApp,
      using: sql`${table.campusId} = ${currentCampusId}`,
    }),
  ],
);

// One row per person who has signed in.
export const appUser = pgTable(
  'app_user',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    campusId: uuid('campus_id')
      .notNull()
      .references(() => campus.id),
    email: text('email').notNull(),
    role: text('role', {
      // No platform_admin yet: that role works across campuses, but RLS locks this row to one.
      // The admin slice adds that path
      enum: ['student', 'faculty', 'staff', 'operator', 'campus_admin'],
    })
      .notNull()
      .default('student'),
    status: text('status', { enum: ['pending_profile', 'active', 'suspended', 'deleted'] })
      .notNull()
      .default('pending_profile'),
    // Personal data from here down: never log these, never put them in a URL or a snapshot.
    // Null until the user completes their profile; an active user has a name and a gender
    firstName: text('first_name'),
    // Never shown to other riders
    lastName: text('last_name'),
    // Self-declared, used only for the "same gender" preference
    gender: text('gender', { enum: ['female', 'male', 'unspecified'] }),
    department: text('department'),
    // E.164 (+8801...); never shown to anyone
    phoneE164: text('phone_e164'),
    createdAt: timestamp('created_at', {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    // Set by the set_updated_at trigger (migration 0015); never write it
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Global, not per campus: one address is one person, whichever campus it maps to. Account
    // deletion (future slice) wipes the email to deleted+<id>@invalid, freeing the address
    unique('app_user_email_unique').on(table.email),
    // Lets later tables (session, preference…) point at a user of the same campus
    unique('app_user_id_campus_unique').on(table.id, table.campusId),
    // Covers the RLS filter and the campus foreign key; role second for the admin user list
    index('app_user_campus_role_idx').on(table.campusId, table.role),
    // Deleted exactly when wiped: a deleted row never keeps a real email, and a live account
    // can never take the placeholder
    check(
      'app_user_deleted_email_wiped',
      sql`(${table.status} = 'deleted') = (${table.email} like 'deleted+%@invalid')`,
    ),
    check('app_user_email_lowercase', sql`${table.email} = lower(${table.email})`),
    check(
      'app_user_role_valid',
      sql`${table.role} in ('student', 'faculty', 'staff', 'operator', 'campus_admin')`,
    ),
    check(
      'app_user_status_valid',
      sql`${table.status} in ('pending_profile', 'active', 'suspended', 'deleted')`,
    ),
    check('app_user_first_name_clean', cleanTextCheck(table.firstName, 100)),
    check('app_user_last_name_clean', cleanTextCheck(table.lastName, 100)),
    check('app_user_gender_valid', sql`${table.gender} in ('female', 'male', 'unspecified')`),
    check('app_user_department_clean', cleanTextCheck(table.department, 100)),
    check('app_user_phone_e164', e164Check(table.phoneE164)),
    // The matcher needs a name to show and a gender to match on, so an active user has both
    check(
      'app_user_active_has_profile',
      sql`${table.status} <> 'active' or (${table.firstName} is not null and ${table.lastName} is not null and ${table.gender} is not null)`,
    ),
    // Read and insert inside the campus set by withCampus(), nothing else. Updating and deleting
    // are taken away by grants (0015), not by this policy
    pgPolicy('app_user_campus', {
      for: 'all',
      to: pulseApp,
      using: sql`${table.campusId} = ${currentCampusId}`,
      withCheck: sql`${table.campusId} = ${currentCampusId}`,
    }),
  ],
);

// One row per code sent. Only a keyed hash of the code is stored, never the code itself
export const emailOtp = pgTable(
  'email_otp',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    campusId: uuid('campus_id')
      .notNull()
      .references(() => campus.id),
    email: text('email').notNull(),
    codeHash: text('code_hash').notNull(),
    attempts: smallint('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    // Lets an admin spot one IP requesting many codes without storing the IP itself
    ipHash: text('ip_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Starts with campus_id: covers the RLS filter and the campus foreign key, and still
    // serves verify's "newest code for this email" lookup
    index('email_otp_campus_email_created_idx').on(
      table.campusId,
      table.email,
      table.createdAt.desc(),
    ),
    check('email_otp_email_lowercase', sql`${table.email} = lower(${table.email})`),
    // A hex HMAC-SHA-256 is exactly 64 hex characters, so a plain code or IP never fits
    check('email_otp_code_hash_hex', sql`${table.codeHash} ~ '^[0-9a-f]{64}$'`),
    check('email_otp_ip_hash_hex', sql`${table.ipHash} ~ '^[0-9a-f]{64}$'`),
    // 5 = the most wrong tries per code; verify must use the same limit
    check('email_otp_attempts_range', sql`${table.attempts} between 0 and 5`),
    // A code lives at most 15 minutes, whatever the API asks for
    check(
      'email_otp_expires_window',
      sql`${table.expiresAt} > ${table.createdAt} and ${table.expiresAt} <= ${table.createdAt} + interval '15 minutes'`,
    ),
    // Same campus rule as app_user. Grants (0015) leave only attempts and consumed_at updatable,
    // and a trigger makes those one-way
    pgPolicy('email_otp_campus', {
      for: 'all',
      to: pulseApp,
      using: sql`${table.campusId} = ${currentCampusId}`,
      withCheck: sql`${table.campusId} = ${currentCampusId}`,
    }),
  ],
);

// One row per refresh token. Reusing an old (rotated) token revokes its whole family.
export const authSession = pgTable(
  'auth_session',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    campusId: uuid('campus_id')
      .notNull()
      .references(() => campus.id),
    userId: uuid('user_id').notNull(),
    familyId: uuid('family_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    // The database sets these times itself
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokeReason: text('revoke_reason', {
      enum: ['sign_out', 'sign_out_all', 'reuse_detected', 'suspended', 'deleted'],
    }),
    userAgent: text('user_agent'),
    ipHash: text('ip_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Refresh finds the row by this hash, inside the campus the token's prefix names
    unique('auth_session_token_hash_unique').on(table.tokenHash),
    // The user must belong to the session's campus (app_user has a unique (id, campus_id))
    foreignKey({
      name: 'auth_session_user_campus_fk',
      columns: [table.userId, table.campusId],
      foreignColumns: [appUser.id, appUser.campusId],
    }),
    index('auth_session_campus_user_idx').on(table.campusId, table.userId),
    index('auth_session_family_idx').on(table.familyId),
    check('auth_session_token_hash_hex', sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check('auth_session_ip_hash_hex', sql`${table.ipHash} ~ '^[0-9a-f]{64}$'`),
    check(
      'auth_session_expires_window',
      sql`${table.expiresAt} > ${table.createdAt} and ${table.expiresAt} <= ${table.createdAt} + interval '30 days'`,
    ),
    check('auth_session_user_agent_length', sql`char_length(${table.userAgent}) <= 200`),
    check(
      'auth_session_revoke_reason_valid',
      sql`${table.revokeReason} in ('sign_out', 'sign_out_all', 'reuse_detected', 'suspended', 'deleted')`,
    ),
    check(
      'auth_session_revoked_with_reason',
      sql`(${table.revokedAt} is null) = (${table.revokeReason} is null)`,
    ),
    pgPolicy('auth_session_campus', {
      for: 'all',
      to: pulseApp,
      using: sql`${table.campusId} = ${currentCampusId}`,
      withCheck: sql`${table.campusId} = ${currentCampusId}`,
    }),
  ],
);

// Where trips start or end on campus. The service sets cell from location; clients never send it
export const campusGate = pgTable(
  'campus_gate',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    campusId: uuid('campus_id')
      .notNull()
      .references(() => campus.id),
    name: text('name').notNull(),
    // x = longitude, y = latitude (WGS 84)
    location: geometry('location', { type: 'point', mode: 'xy', srid: 4326 }).notNull(),
    cell: text('cell').notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Set by the set_updated_at trigger (migration 0020); never write it
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Lets trips (a later slice) point at a gate of the same campus
    unique('campus_gate_id_campus_unique').on(table.id, table.campusId),
    // Also indexes the campus foreign key
    unique('campus_gate_campus_name_unique').on(table.campusId, table.name),
    uniqueIndex('campus_gate_one_primary_per_campus')
      .on(table.campusId)
      .where(sql`${table.isPrimary}`),
    check('campus_gate_name_clean', cleanTextCheck(table.name, 100)),
    check('campus_gate_cell_h3', h3CellCheck(table.cell)),
    pgPolicy('campus_gate_campus', {
      for: 'all',
      to: pulseApp,
      using: sql`${table.campusId} = ${currentCampusId}`,
      withCheck: sql`${table.campusId} = ${currentCampusId}`,
    }),
  ],
);

// Named home areas drawn by the campus admin, e.g. Mirpur 10
export const zone = pgTable(
  'zone',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    campusId: uuid('campus_id')
      .notNull()
      .references(() => campus.id),
    name: text('name').notNull(),
    area: multiPolygon('area').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Set by the set_updated_at trigger (migration 0020); never write it
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Lets meeting points and preferences point at a zone of the same campus
    unique('zone_id_campus_unique').on(table.id, table.campusId),
    // Also indexes the campus foreign key
    unique('zone_campus_name_unique').on(table.campusId, table.name),
    index('zone_area_gist_idx').using('gist', table.area),
    check('zone_name_clean', cleanTextCheck(table.name, 100)),
    // A self-crossing polygon breaks ST_Contains, so the database refuses it
    check('zone_area_valid', sql`ST_IsValid(${table.area})`),
    pgPolicy('zone_campus', {
      for: 'all',
      to: pulseApp,
      using: sql`${table.campusId} = ${currentCampusId}`,
      withCheck: sql`${table.campusId} = ${currentCampusId}`,
    }),
  ],
);

// Where a crew gathers. Deleting one only sets is_active = false: trips will point at it later
export const meetingPoint = pgTable(
  'meeting_point',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    campusId: uuid('campus_id')
      .notNull()
      .references(() => campus.id),
    // Null for gate-side points, which belong to no home area
    zoneId: uuid('zone_id'),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['gate', 'landmark', 'bus_stop', 'junction'] }).notNull(),
    // x = longitude, y = latitude (WGS 84)
    location: geometry('location', { type: 'point', mode: 'xy', srid: 4326 }).notNull(),
    cell: text('cell').notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // Set by the set_updated_at trigger (migration 0020); never write it
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('meeting_point_id_campus_unique').on(table.id, table.campusId),
    // A null zone_id skips the check, so gate-side points need no zone
    foreignKey({
      name: 'meeting_point_zone_campus_fk',
      columns: [table.zoneId, table.campusId],
      foreignColumns: [zone.id, zone.campusId],
    }),
    index('meeting_point_campus_idx').on(table.campusId),
    index('meeting_point_zone_campus_idx').on(table.zoneId, table.campusId),
    index('meeting_point_location_gist_idx').using('gist', table.location),
    check('meeting_point_name_clean', cleanTextCheck(table.name, 100)),
    check(
      'meeting_point_kind_valid',
      sql`${table.kind} in ('gate', 'landmark', 'bus_stop', 'junction')`,
    ),
    check('meeting_point_cell_h3', h3CellCheck(table.cell)),
    pgPolicy('meeting_point_campus', {
      for: 'all',
      to: pulseApp,
      using: sql`${table.campusId} = ${currentCampusId}`,
      withCheck: sql`${table.campusId} = ${currentCampusId}`,
    }),
  ],
);

// Who changed what, one row per admin write, in the same transaction as the change. Append-only:
// the policies allow select and insert, and grants (migration 0020) take away update and delete
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    campusId: uuid('campus_id')
      .notNull()
      .references(() => campus.id),
    actorId: uuid('actor_id').notNull(),
    // e.g. gate.create, term.activate
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: uuid('entity_id').notNull(),
    // Ids and non-personal before/after values only, never names, emails or phone numbers
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    // Same keyed hash as email_otp.ip_hash, never the IP itself
    ipHash: text('ip_hash'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // The actor must belong to the row's campus
    foreignKey({
      name: 'audit_log_actor_campus_fk',
      columns: [table.actorId, table.campusId],
      foreignColumns: [appUser.id, appUser.campusId],
    }),
    // The admin list, newest first; also covers the campus foreign key
    index('audit_log_campus_at_idx').on(table.campusId, table.at.desc()),
    index('audit_log_actor_campus_idx').on(table.actorId, table.campusId),
    check('audit_log_action_shape', sql`${table.action} ~ '^[a-z_]+[.][a-z_]+$'`),
    check('audit_log_action_short', sql`length(${table.action}) <= 64`),
    check('audit_log_entity_clean', cleanTextCheck(table.entity, 64)),
    check('audit_log_metadata_object', sql`jsonb_typeof(${table.metadata}) = 'object'`),
    check('audit_log_ip_hash_hex', sql`${table.ipHash} ~ '^[0-9a-f]{64}$'`),
    pgPolicy('audit_log_read', {
      for: 'select',
      to: pulseApp,
      using: sql`${table.campusId} = ${currentCampusId}`,
    }),
    pgPolicy('audit_log_insert', {
      for: 'insert',
      to: pulseApp,
      withCheck: sql`${table.campusId} = ${currentCampusId}`,
    }),
  ],
);
