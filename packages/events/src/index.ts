export { eventEnvelopeSchema, type EventEnvelope } from './envelope.js';
export { topics, type TopicName, type TopicSpec } from './topics.js';
export {
  campusCreatedEventSchema,
  campusCreatedPayloadSchema,
  type CampusCreatedEvent,
  type CampusCreatedPayload,
} from './campus-created.js';
export {
  createEvent,
  eventSchema,
  parseEvent,
  routeFor,
  type EventMeta,
  type EventType,
  type PulseEvent,
  type Route,
} from './registry.js';
