# 0005 — Events: a JSON envelope checked by Zod, add-only by test, Karapace later

Status: accepted
Date: 2026-11-01

## Context

The outbox writer (API), the relay and every consumer must agree on each event's shape, topic
and key. Event schemas are add-only (CLAUDE.md rule 4): events stay in Kafka for days and can be
replayed, so a reader must still understand every event written before it. The architecture
names Karapace as the schema registry, but it is one more JVM-sized container on 8 GB laptops
that already run PostGIS and Kafka (ADR 0001, ADR 0004), and only one event exists today.

## Decision

`@pulse/events` defines one envelope (`eventId`, `type`, `version`, `occurredAt`, `payload`) sent
as JSON in the Kafka record value, each event as a Zod schema, and the topic list (name, key,
partitions, config). `eventId` is the `outbox_event.id`, so a re-sent event can be skipped by
consumers. Readers are tolerant: event schemas use `z.object`, which drops unknown fields instead
of rejecting them, unlike API input (rule 11). Add-only is enforced by a unit test that compares
each event's JSON Schema (input mode, so it describes what a reader accepts) with a baseline
committed in `packages/events/schemas/` when the version was released: no field may be removed,
renamed, retyped or made optional, new fields must be optional, and every baseline must still
match a registered event. `parseEvent` tells a consumer whether a record is a known event, an
unknown type or version (skip it), or invalid (dead-letter it). Karapace is deferred.

## Alternatives

| Option                         | Why not now                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Karapace from the start        | Memory on 8 GB laptops; with one TypeScript codebase the shared package already gives one schema per event.    |
| Avro or Protobuf               | Smaller records, but needs a registry and code generation; JSON is readable in `kafka-console-consumer`.       |
| Strict event schemas           | A newer producer adding a field would make every older consumer reject the event.                              |
| Vitest file snapshot of schema | Any added field fails it, and `-u` would also accept a removal; the custom check tells the two apart.          |
| Topic and key in each consumer | Producers and consumers could disagree; `routeFor(event)` is the one place, and the compiler covers new types. |

## Consequences

- The outbox writer builds events with `createEvent`, the outbox relay publishes them with
  `routeFor` and creates topics from `topics`, and consumers read them with `parseEvent`.
- One schema per event type: the discriminated union rejects a repeated `type`. A breaking change
  is therefore a new event name (`CampusCreatedV2`) with its own baseline, never an edit. Keeping
  two versions of one name readable would need a union on `version` per type, decided when needed.
- The baseline embeds Zod's own regex for `uuid` and `date-time`; the check ignores `pattern`
  where a `format` is present, so a Zod upgrade does not fail it.
- If a non-TypeScript service (the Python forecast) ever reads Kafka, revisit Karapace: register
  the committed JSON Schemas there with `BACKWARD_TRANSITIVE` compatibility.
