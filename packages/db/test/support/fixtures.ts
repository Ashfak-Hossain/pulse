import { randomUUID } from 'node:crypto';
import type { campus, outboxEvent } from '../../src/index.js';

type NewCampus = typeof campus.$inferInsert & { id: string };

// A unique campus per test, so tests sharing one database never see each other's rows
export function newCampus(): NewCampus {
  const id = randomUUID();
  return {
    id,
    name: `Campus ${id.slice(0, 8)}`,
    slug: `campus-${id}`,
    emailDomains: ['aiub.edu'],
    location: { x: 90.4274, y: 23.8223 },
    timezone: 'Asia/Dhaka',
  };
}

export function campusCreated(campusId: string): typeof outboxEvent.$inferInsert {
  return {
    aggregate: 'campus',
    aggregateId: campusId,
    type: 'CampusCreated',
    payload: { campusId },
  };
}

// Drizzle wraps driver errors; PostgreSQL's SQLSTATE code sits on the original error (`cause`)
export async function pgErrorCode(work: PromiseLike<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    const original = error instanceof Error && error.cause !== undefined ? error.cause : error;
    if (typeof original === 'object' && original !== null && 'code' in original) {
      return typeof original.code === 'string' ? original.code : undefined;
    }
  }
  return undefined;
}
