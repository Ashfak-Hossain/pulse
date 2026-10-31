import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Campus, CampusList } from '@pulse/contracts';
import { asc, campus, eq, type Database } from '@pulse/db';
import { DATABASE } from '../db/db.module.js';

type CampusRow = typeof campus.$inferSelect;

// A hard cap on every list: a public endpoint must never return a whole table.
// Campuses are few; bigger lists will add a cursor to the { items } wrapper
const CAMPUS_LIST_LIMIT = 200;

// Reads campuses. Campus facts are public (the read policy is `true`), so no withCampus() here;
// campus-scoped tables (courses, trips…) must go through withCampus()
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
