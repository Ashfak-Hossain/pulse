import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Campus, CampusList, CreateCampus } from '@pulse/contracts';
import {
  asc,
  campus,
  DrizzleQueryError,
  eq,
  outboxEvent,
  withCampus,
  type Database,
} from '@pulse/db';
import { createEvent, routeFor } from '@pulse/events';
import { randomUUID } from 'node:crypto';
import { DATABASE } from '../db/db.module.js';

type CampusRow = typeof campus.$inferSelect;

// A hard cap on every list: a public endpoint must never return a whole table.
// Campuses are few; bigger lists will add a cursor to the { items } wrapper
const CAMPUS_LIST_LIMIT = 200;

// Reads and creates campuses. Campus facts are public (the read policy is `true`), so reads skip
// withCampus(); writes and campus-scoped tables (courses, trips…) go through it
@Injectable()
export class CampusService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(): Promise<CampusList> {
    const rows = await this.db
      .select()
      .from(campus)
      // Names can repeat; ending on a unique column (slug) makes the order fixed
      .orderBy(asc(campus.name), asc(campus.slug))
      .limit(CAMPUS_LIST_LIMIT);
    return { items: rows.map(toCampus) };
  }

  async getBySlug(slug: string): Promise<Campus> {
    const [row] = await this.db.select().from(campus).where(eq(campus.slug, slug)).limit(1);
    if (!row) {
      throw new NotFoundException('Campus not found');
    }
    return toCampus(row);
  }

  /** Stores a campus and its CampusCreated outbox row in one transaction. Duplicate slug → 409. */
  async create(input: CreateCampus): Promise<Campus> {
    // Made here, never taken from the request: withCampus(id) lets the insert policy pass for
    // this one row only
    const id = randomUUID();
    const occurredAt = new Date();
    // Built and validated before the transaction opens, so a bad event writes nothing and the
    // transaction holds its connection only for the two inserts
    const event = createEvent(
      'CampusCreated',
      { campusId: id, name: input.name, slug: input.slug, timezone: input.timezone },
      { eventId: randomUUID(), occurredAt },
    );
    const { topic, key } = routeFor(event);

    try {
      await withCampus(this.db, id, async (tx) => {
        // No "slug taken?" SELECT first: it races and costs a round trip; the unique index decides
        await tx.insert(campus).values({
          id,
          name: input.name,
          slug: input.slug,
          emailDomains: input.emailDomains,
          timezone: input.timezone,
          location: { x: input.location.lng, y: input.location.lat },
          createdAt: occurredAt, // One instant for the row and the event
        });
        // No .returning(): pulse_app cannot read outbox_event
        await tx.insert(outboxEvent).values({
          id: event.eventId,
          aggregate: 'campus',
          aggregateId: id,
          type: event.type,
          version: event.version,
          topic,
          key,
          payload: event.payload,
          createdAt: occurredAt,
        });
      });
    } catch (error) {
      if (isUniqueViolation(error, 'campus_slug_unique')) {
        // Fixed text: PostgreSQL's message would echo the slug back
        throw new ConflictException('A campus with this slug already exists');
      }
      throw error;
    }

    // Built from what was stored, so no SELECT after the insert
    return { id, ...input };
  }
}

// The row is internal; clients get the contract. PostGIS stores the point as x = longitude,
// y = latitude, and created_at stays inside
function toCampus(row: CampusRow): Campus {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    emailDomains: row.emailDomains,
    timezone: row.timezone,
    location: { lat: row.location.y, lng: row.location.x },
  };
}

// 23505 = unique_violation. Matched on the constraint name, so any other duplicate stays a 500
function isUniqueViolation(error: unknown, constraint: string): boolean {
  const cause: unknown = error instanceof DrizzleQueryError ? error.cause : undefined;
  return (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    cause.code === '23505' &&
    'constraint' in cause &&
    cause.constraint === constraint
  );
}
