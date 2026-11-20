import { z } from 'zod';
import { eventEnvelopeSchema } from './envelope.js';

// A user's profile or travel preferences changed. A full snapshot, not a diff: the profiles
// topic is compacted, so the newest event per user is all a new consumer ever reads. Names,
// phone numbers and the exact home pin never go in: the matcher needs only what is here
export const profileChangedPayloadSchema = z.object({
  campusId: z.uuid(),
  userId: z.uuid(),
  role: z.enum(['student', 'faculty', 'staff', 'operator', 'campus_admin']),
  status: z.enum(['pending_profile', 'active', 'suspended', 'deleted']),
  // The rest is null until the user saves their preferences
  zoneId: z.uuid().nullable(),
  // H3 resolution 8 cell of the home pin (about 0.7 km²), never the pin itself
  homeCell: z
    .string()
    .regex(/^[0-9a-f]{15}$/)
    .nullable(),
  genderPref: z.enum(['any', 'same_gender']).nullable(),
  modes: z.array(z.string().min(1).max(32)).max(7).nullable(),
  autopilotOn: z.boolean().nullable(),
});

// The envelope with type, version and payload narrowed to this one event
export const profileChangedEventSchema = eventEnvelopeSchema.extend({
  type: z.literal('ProfileChanged'),
  version: z.literal(1),
  payload: profileChangedPayloadSchema,
});

export type ProfileChangedPayload = z.infer<typeof profileChangedPayloadSchema>;
export type ProfileChangedEvent = z.infer<typeof profileChangedEventSchema>;
