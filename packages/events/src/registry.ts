import { z } from 'zod';
import { campusCreatedEventSchema } from './campus-created.js';
import { eventEnvelopeSchema } from './envelope.js';
import { topics, type TopicName } from './topics.js';

// A new event = its schema file, plus one entry here, one in
// currentVersions and one case in routeFor.
// One schema per type: the union rejects a repeated type, so a breaking change is a new event
// name (CampusCreatedV2), never a second version of the same name
export const eventSchema = z.discriminatedUnion('type', [campusCreatedEventSchema]);

export type PulseEvent = z.infer<typeof eventSchema>;
export type EventType = PulseEvent['type'];
type EventOf<T extends EventType> = Extract<PulseEvent, { type: T }>;

// The version createEvent writes today
const currentVersions = { CampusCreated: 1 } as const satisfies Record<EventType, number>;

export interface EventMeta {
  // The outbox row's id
  eventId: string;
  occurredAt: Date;
}

export function createEvent<T extends EventType>(
  type: T,
  payload: EventOf<T>['payload'],
  meta: EventMeta,
): EventOf<T> {
  const event = {
    eventId: meta.eventId,
    type,
    version: currentVersions[type],
    occurredAt: meta.occurredAt.toISOString(),
    payload,
  };

  return eventSchema.parse(event) as EventOf<T>;
}

// What a consumer should do with a record: handle it, skip it, or dead-letter it
export type ParsedEvent =
  | { kind: 'ok'; event: PulseEvent }
  | { kind: 'unknown'; type: string; version: number }
  | { kind: 'invalid'; error: z.ZodError };

// For consumers: never throws. Zod's issues hold paths and codes, not input values, so logging
// error.issues does not leak the payload
export function parseEvent(raw: unknown): ParsedEvent {
  const envelope = eventEnvelopeSchema.safeParse(raw);
  if (!envelope.success) return { kind: 'invalid', error: envelope.error };

  const { type, version } = envelope.data;
  if (!isKnown(type, version)) return { kind: 'unknown', type, version };

  const event = eventSchema.safeParse(raw);
  return event.success
    ? { kind: 'ok', event: event.data }
    : { kind: 'invalid', error: event.error };
}

// Object.hasOwn, not `in`: a type such as "constructor" must not match Object.prototype
function isKnown(type: string, version: number): boolean {
  return Object.hasOwn(currentVersions, type) && currentVersions[type as EventType] === version;
}

export interface Route {
  topic: TopicName;
  key: string;
}

// The topic an event goes to and its message key
export function routeFor(event: PulseEvent): Route {
  switch (event.type) {
    case 'CampusCreated':
      return {
        topic: topics.campuses.name,
        key: event.payload.campusId,
      };
  }
}
