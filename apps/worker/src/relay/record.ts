import { eventEnvelopeSchema } from '@pulse/events';

export interface OutboxRow {
  id: string;
  type: string;
  version: number;
  topic: string;
  key: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface OutboxRecord {
  topic: string;
  key: string;
  value: string;
  headers: { eventId: string; type: string };
}

/**
 * Turns an outbox row into the Kafka record the relay sends. Throws if its topic is not in
 * `topics` or it is not a valid event.
 */
export function toRecord(row: OutboxRow, topics: ReadonlySet<string>): OutboxRecord {
  // A wrong topic could put a fake event where others trust it, e.g. on the compacted profiles
  if (!topics.has(row.topic)) {
    throw new Error(`Outbox row ${row.id} has an unknown topic "${row.topic}"`);
  }
  const envelope = eventEnvelopeSchema.safeParse({
    eventId: row.id,
    type: row.type,
    version: row.version,
    occurredAt: row.createdAt.toISOString(),
    payload: row.payload,
  });
  if (!envelope.success) {
    // The row id only: the payload may hold personal data, and this message is stored and logged
    throw new Error(`Outbox row ${row.id} is not a valid event envelope`, {
      cause: envelope.error,
    });
  }
  return {
    topic: row.topic,
    key: row.key,
    value: JSON.stringify(envelope.data),
    headers: { eventId: row.id, type: row.type },
  };
}
