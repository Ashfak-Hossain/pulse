import { z } from 'zod';

const countSchema = z.int().nonnegative();
const timeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

const meetingSchema = z
  .strictObject({
    kind: z.enum(['theory', 'lab', 'other']),
    weekday: z.int().min(0).max(6),
    startTime: timeSchema,
    endTime: timeSchema,
    room: z.string().nullable(),
  })
  .refine((meeting) => meeting.endTime > meeting.startTime, 'End time must be after start time');

const sectionSchema = z.strictObject({
  externalClassId: z.string().min(1),
  courseCode: z.string().min(1),
  title: z.string().min(1),
  sectionLabel: z.string().min(1),
  status: z.enum(['open', 'reserved', 'freshman', 'closed', 'cancelled']),
  capacity: countSchema,
  enrolled: countSchema,
  instructorName: z.string().nullable(),
  meetings: z.array(meetingSchema),
});

export const ParsedCatalog = z.strictObject({
  termName: z.string().nullable(),
  sections: z.array(sectionSchema),
  problems: z
    .array(z.strictObject({ row: countSchema, field: z.string(), message: z.string() }))
    .max(200),
  stats: z.strictObject({
    sections: countSchema,
    meetings: countSchema,
    cancelled: countSchema,
    skipped: countSchema,
    errors: countSchema,
  }),
});

export type ParsedCatalog = z.infer<typeof ParsedCatalog>;
export type ParsedSection = z.infer<typeof sectionSchema>;
export type ParsedMeeting = z.infer<typeof meetingSchema>;
