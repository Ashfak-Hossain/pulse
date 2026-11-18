import { z } from 'zod';
import { catalogLimits } from './catalog-limits.js';
import { cursorTextSchema, cursorTokenSchema, pageLimitSchema } from './paging.js';

// Public course fields only; campus scope and database timestamps remain internal.
export const courseSchema = z.strictObject({
  id: z.uuid(),
  code: z.string().min(1).max(catalogLimits.courseCode),
  title: z.string().min(1).max(catalogLimits.courseTitle),
});

export const courseQuerySchema = z.strictObject({
  limit: pageLimitSchema(500, 100),
  cursor: cursorTokenSchema.optional(),
});
// Codes are unique per campus, so the last code alone marks where the next page starts
export const courseCursorSchema = z.strictObject({ code: cursorTextSchema });
export const courseListSchema = z.strictObject({
  items: z.array(courseSchema).max(500),
  nextCursor: cursorTokenSchema.nullable(),
});

export type Course = z.infer<typeof courseSchema>;
export type CourseQuery = z.infer<typeof courseQuerySchema>;
export type CourseList = z.infer<typeof courseListSchema>;
