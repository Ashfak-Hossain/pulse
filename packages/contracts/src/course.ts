import { z } from 'zod';

// Public course fields only; campus scope and database timestamps remain internal.
export const courseSchema = z.strictObject({
  id: z.uuid(),
  code: z.string().min(1),
  title: z.string().min(1),
});
export const courseListSchema = z.strictObject({ items: z.array(courseSchema).max(500) });
export type Course = z.infer<typeof courseSchema>;
export type CourseList = z.infer<typeof courseListSchema>;
