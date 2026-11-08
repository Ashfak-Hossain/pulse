import { z } from 'zod';
import { courseSchema } from './course.js';

export const termStatusSchema = z.enum(['draft', 'active', 'archived']);
export const sectionStatusSchema = z.enum(['open', 'reserved', 'freshman', 'closed', 'cancelled']);
export const meetingKindSchema = z.enum(['theory', 'lab', 'other']);

export const termSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  startsOn: z.iso.date(),
  endsOn: z.iso.date(),
  status: termStatusSchema.exclude(['draft']),
});
// Not paged: a campus adds about three terms a year.
export const termListSchema = z.strictObject({ items: z.array(termSchema) });

// PostgreSQL permits 24:00 at the end of a day. Preserve any stored sub-minute precision.
const meetingTimeSchema = z.union([z.iso.time(), z.literal('24:00')]);
export const sectionMeetingSchema = z.strictObject({
  kind: meetingKindSchema,
  weekday: z.int().min(0).max(6),
  startTime: meetingTimeSchema,
  endTime: meetingTimeSchema,
  room: z.string().nullable(),
});
export const sectionSchema = z.strictObject({
  id: z.uuid(),
  termId: z.uuid(),
  course: courseSchema.pick({ code: true, title: true }),
  title: z.string(),
  sectionLabel: z.string(),
  status: sectionStatusSchema,
  capacity: z.int().min(0).max(32767),
  enrolled: z.int().min(0).max(32767),
  instructorName: z.string().nullable(),
  meetings: z.array(sectionMeetingSchema),
});

const cursorTokenSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);
const postgresTextSchema = z.string().refine((value) => !value.includes('\0'), 'Invalid text');
export const sectionCursorSchema = z.strictObject({
  code: postgresTextSchema,
  sectionLabel: postgresTextSchema,
  id: z.uuid(),
});
export const sectionListSchema = z.strictObject({
  items: z.array(sectionSchema).max(100),
  nextCursor: cursorTokenSchema.nullable(),
});
export const sectionQuerySchema = z.strictObject({
  termId: z.uuid(),
  // A lone percent is accepted as a literal search, per the catalog acceptance test.
  q: z
    .string()
    .trim()
    .max(50)
    .pipe(postgresTextSchema)
    .refine(
      (q) => q.length >= 2 || q === '%',
      'Search must be at least two characters or a literal percent',
    )
    .optional(),
  limit: z
    .union([z.string().regex(/^\d+$/), z.number()])
    .pipe(z.coerce.number<string | number>().int().min(1).max(100))
    .default(20),
  cursor: cursorTokenSchema.optional(),
});
export type TermList = z.infer<typeof termListSchema>;
export type SectionList = z.infer<typeof sectionListSchema>;
export type SectionQuery = z.infer<typeof sectionQuerySchema>;
export type SectionMeeting = z.infer<typeof sectionMeetingSchema>;
