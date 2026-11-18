import { catalogLimits, meetingKindSchema, sectionStatusSchema } from '@pulse/contracts';
import { z } from 'zod';

/** Largest capacity or enrollment the section table stores (smallint). */
export const maxSectionCount = 32767;

const countSchema = z.int().nonnegative();
const sectionCountSchema = countSchema.max(maxSectionCount);
const timeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const textSchema = (max: number) => z.string().min(1).max(max);

const meetingSchema = z
  .strictObject({
    kind: meetingKindSchema,
    // 0 = Sunday … 6 = Saturday
    weekday: z.int().min(0).max(6),
    startTime: timeSchema,
    endTime: timeSchema,
    room: textSchema(catalogLimits.room).nullable(),
  })
  .refine((meeting) => meeting.endTime > meeting.startTime, 'End time must be after start time');

const sectionSchema = z.strictObject({
  externalClassId: textSchema(catalogLimits.externalClassId),
  courseCode: textSchema(catalogLimits.courseCode),
  title: textSchema(catalogLimits.courseTitle),
  sectionLabel: textSchema(catalogLimits.sectionLabel),
  status: sectionStatusSchema,
  capacity: sectionCountSchema,
  enrolled: sectionCountSchema,
  instructorName: textSchema(catalogLimits.instructorName).nullable(),
  meetings: z.array(meetingSchema).max(catalogLimits.meetingsPerSection),
});

/** What a timetable adapter hands the importer, checked before it leaves the adapter. */
export const parsedCatalogSchema = z.strictObject({
  termName: textSchema(catalogLimits.termName).nullable(),
  sections: z.array(sectionSchema).max(catalogLimits.sectionsPerTerm),
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

export type ParsedCatalog = z.infer<typeof parsedCatalogSchema>;
export type ParsedSection = z.infer<typeof sectionSchema>;
export type ParsedMeeting = z.infer<typeof meetingSchema>;
