import { z } from 'zod';
import { eventEnvelopeSchema } from './envelope.js';

// A new campus (tenant) exists. Public campus facts only: events are read by many services and
// kept in Kafka for days, so no personal data goes in a payload
export const campusCreatedPayloadSchema = z.object({
  campusId: z.uuid(),
  // Upper bounds, so a huge string cannot reach a consumer's database writes or logs
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(64),
  timezone: z.string().min(1).max(64),
});

// The envelope with type, version and payload narrowed to this one event
export const campusCreatedEventSchema = eventEnvelopeSchema.extend({
  type: z.literal('CampusCreated'),
  version: z.literal(1),
  payload: campusCreatedPayloadSchema,
});

export type CampusCreatedPayload = z.infer<typeof campusCreatedPayloadSchema>;
export type CampusCreatedEvent = z.infer<typeof campusCreatedEventSchema>;
