import { z } from 'zod';
import { eventEnvelopeSchema } from './envelope.js';

// A campus switched to a new term: the previous active term (if any) is archived in the same
// transaction. Matching and routines read this to know which timetable is current
export const termActivatedPayloadSchema = z.object({
  campusId: z.uuid(),
  termId: z.uuid(),
  // Same upper bound as term.name in the database
  name: z.string().min(1).max(100),
  // Calendar dates in the campus timezone, YYYY-MM-DD
  startsOn: z.iso.date(),
  endsOn: z.iso.date(),
});

// The envelope with type, version and payload narrowed to this one event
export const termActivatedEventSchema = eventEnvelopeSchema.extend({
  type: z.literal('TermActivated'),
  version: z.literal(1),
  payload: termActivatedPayloadSchema,
});

export type TermActivatedPayload = z.infer<typeof termActivatedPayloadSchema>;
export type TermActivatedEvent = z.infer<typeof termActivatedEventSchema>;
