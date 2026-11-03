import { z } from 'zod';

// The outer shape every job on RabbitMQ shares. A building block for job schemas: its payload
// can be anything, so handlers read jobs with parseJob, never with this schema
export const jobEnvelopeSchema = z.object({
  jobId: z.uuid(),
  // Also the routing key. Pattern-checked so an unknown type is still safe to log
  type: z
    .string()
    .max(100)
    .regex(/^[a-z]+(\.[a-z]+)+$/),
  version: z.int().min(1),
  // The same work always gets the same key, so a handler can drop a second delivery. Built
  // from ids only (campus-created:<campusId>), never from an email or a name
  dedupeKey: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-z0-9.:_-]+$/i),
  createdAt: z.iso.datetime({ offset: true }),
  payload: z.record(z.string(), z.unknown()),
});

export type JobEnvelope = z.infer<typeof jobEnvelopeSchema>;
