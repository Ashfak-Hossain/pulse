import { z } from 'zod';
import { catalogLimits } from './catalog-limits.js';
import { courseSchema } from './course.js';
import { cursorTextSchema, cursorTokenSchema, pageLimitSchema } from './paging.js';

export const termStatusSchema = z.enum(['draft', 'active', 'archived']);
export const sectionStatusSchema = z.enum(['open', 'reserved', 'freshman', 'closed', 'cancelled']);
export const meetingKindSchema = z.enum(['theory', 'lab', 'other']);

export const termSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().max(catalogLimits.termName),
  startsOn: z.iso.date(),
  endsOn: z.iso.date(),
  status: termStatusSchema.exclude(['draft']),
});
// Not paged: a campus adds about three terms a year.
export const termListSchema = z.strictObject({ items: z.array(termSchema) });

// What campus admins see of a term: drafts included
export const adminTermSchema = termSchema.extend({ status: termStatusSchema });

// Route params of /admin/terms/:id/activate
export const termParamsSchema = z.strictObject({ id: z.uuid() });

// Body of POST /admin/terms. A new term always starts as a draft; activating it is its own call
export const createTermSchema = z
  .strictObject({
    name: z
      .string()
      .trim()
      .min(1)
      .max(catalogLimits.termName)
      .regex(/^[^\p{Cc}\u202A-\u202E\u2066-\u2069]+$/u, 'Name has hidden characters'),
    startsOn: z.iso.date(),
    endsOn: z.iso.date(),
  })
  // ISO dates compare correctly as text
  .refine((term) => term.endsOn > term.startsOn, {
    message: 'A term must end after it starts',
    path: ['endsOn'],
  });

// PostgreSQL permits 24:00 at the end of a day. Preserve any stored sub-minute precision.
const meetingTimeSchema = z.union([z.iso.time(), z.literal('24:00')]);
export const sectionMeetingSchema = z.strictObject({
  kind: meetingKindSchema,
  // 0 = Sunday … 6 = Saturday, as JavaScript's getDay()
  weekday: z.int().min(0).max(6),
  startTime: meetingTimeSchema,
  endTime: meetingTimeSchema,
  room: z.string().max(catalogLimits.room).nullable(),
});
export const sectionSchema = z.strictObject({
  id: z.uuid(),
  termId: z.uuid(),
  course: courseSchema.pick({ code: true, title: true }),
  title: z.string().max(catalogLimits.courseTitle),
  sectionLabel: z.string().max(catalogLimits.sectionLabel),
  status: sectionStatusSchema,
  capacity: z.int().min(0).max(32767),
  enrolled: z.int().min(0).max(32767),
  instructorName: z.string().max(catalogLimits.instructorName).nullable(),
  meetings: z.array(sectionMeetingSchema).max(catalogLimits.meetingsPerSection),
});

export const sectionCursorSchema = z.strictObject({
  code: cursorTextSchema,
  sectionLabel: cursorTextSchema,
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
    .refine((q) => !q.includes('\0'), 'Invalid text')
    .refine(
      (q) => q.length >= 2 || q === '%',
      'Search must be at least two characters or a literal percent',
    )
    .optional(),
  limit: pageLimitSchema(100, 20),
  cursor: cursorTokenSchema.optional(),
});
export type TermList = z.infer<typeof termListSchema>;
export type AdminTerm = z.infer<typeof adminTermSchema>;
export type TermParams = z.infer<typeof termParamsSchema>;
export type CreateTerm = z.infer<typeof createTermSchema>;
export type SectionList = z.infer<typeof sectionListSchema>;
export type SectionQuery = z.infer<typeof sectionQuerySchema>;
export type SectionMeeting = z.infer<typeof sectionMeetingSchema>;
