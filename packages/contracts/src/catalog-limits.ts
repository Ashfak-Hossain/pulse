/**
 * Longest values the catalog stores. The parser rejects longer cells. The text limits are repeated
 * in the cleanTextCheck() CHECKs in packages/db/src/schema.ts: change both, then db:generate.
 * The two counts at the end are enforced in Zod only.
 */
export const catalogLimits = {
  courseCode: 32,
  courseTitle: 200,
  termName: 100,
  externalClassId: 32,
  sectionLabel: 32,
  instructorName: 200,
  room: 64,
  sectionsPerTerm: 20_000,
  meetingsPerSection: 20,
} as const;
