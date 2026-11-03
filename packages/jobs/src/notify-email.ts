import { z } from 'zod';
import { jobEnvelopeSchema } from './envelope.js';

// Ids only: the handler loads the recipient and the content when it sends, so no address or
// name sits in a queue (or in jobs.dead) for days
const campusCreatedEmailSchema = z.object({
  template: z.literal('campus-created'),
  campusId: z.uuid(),
});

// One option per template; a new template is a new option, never a changed one
export const notifyEmailPayloadSchema = z.discriminatedUnion('template', [
  campusCreatedEmailSchema,
]);

export const notifyEmailJobSchema = jobEnvelopeSchema.extend({
  type: z.literal('notify.email'),
  version: z.literal(1),
  payload: notifyEmailPayloadSchema,
});

export type NotifyEmailPayload = z.infer<typeof notifyEmailPayloadSchema>;
export type NotifyEmailJob = z.infer<typeof notifyEmailJobSchema>;
