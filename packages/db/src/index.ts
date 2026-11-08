export { withCampus } from './campus-scope.js';
export { createDb, type Database, type PoolOptions, type Transaction } from './client.js';
export {
  campus,
  course,
  emailDelivery,
  outboxEvent,
  processedEvent,
  term,
  section,
  sectionMeeting,
} from './schema.js';
export { assertRestrictedRole } from './role-check.js';
export {
  and,
  arrayContains,
  asc,
  desc,
  DrizzleQueryError,
  eq,
  ilike,
  inArray,
  isNull,
  or,
  sql,
} from 'drizzle-orm';
