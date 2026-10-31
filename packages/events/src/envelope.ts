import { z } from 'zod';

// The outer shape every event on Kafka shares. A building block for event schemas: its payload
// can be anything, so consumers read events with parseEvent, never with this schema
export const eventEnvelopeSchema = z.object({
  eventId: z.uuid(),
  type: z.string().min(1),
  version: z.int().min(1),
  occurredAt: z.iso.datetime({ offset: true }),
  payload: z.record(z.string(), z.unknown()),
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
