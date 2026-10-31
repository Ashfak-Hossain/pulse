# Architecture

Pulse is a **modular monolith with an event-driven backbone**. A NestJS API handles user
requests and stores state in PostgreSQL, publishes domain events to Kafka through a
transactional outbox, background services react to those events, and RabbitMQ
distributes one-off jobs.

## Three ways components talk

| Kind                          | Used for                                                      | Technology                                                                 |
| ----------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Request / response            | Browser to API                                                | HTTPS via Next.js, WebSocket for live updates                              |
| Events (facts that happened)  | Service to service; many readers; replayable                  | Kafka 4 (KRaft); Zod schemas in `@pulse/events`, Karapace later (ADR 0005) |
| Jobs (work done exactly once) | Notifications, file parsing, AI calls, settlement, retraining | RabbitMQ 4 (quorum queues)                                                 |

## Rules that hold everywhere

- **PostgreSQL is the source of truth.** Events announce changes; they are not the data store (event-driven, not event-sourced).
- **Outbox, always.** A change that other services care about writes its business rows and an `outbox_event` row in one transaction. Never publish to Kafka directly from a request handler.
- **Idempotent consumers.** Every consumer records `(consumer, event_id)` in `processed_event` in the same transaction as its effect.
- **Functional core, imperative shell.** `packages/matching`, `packages/money` and `packages/geo` are pure functions: no database, network, clock or randomness without an injected seed. NestJS, PostgreSQL, Kafka and RabbitMQ are the shell.
- **Ports and adapters.** AI providers (`ai-gateway`), timetable formats (`catalog-adapters`) and request parsers (`request-parser`) are interfaces with swappable implementations.
- **Tenancy.** Every campus-scoped table has `campus_id` and a row-level security policy.

## Kafka topics

| Topic           | Key         | Why that key                                                |
| --------------- | ----------- | ----------------------------------------------------------- |
| `campuses`      | `campusId`  | A campus's lifecycle is read in order; few events           |
| `trip-requests` | `campusId`  | One matcher instance owns each campus: no distributed locks |
| `trips`         | `tripId`    | A trip's lifecycle is read in order                         |
| `calendar`      | `sectionId` | Class changes per section stay in order                     |
| `ledger`        | `crewId`    | Money events per crew stay in order                         |
| `locations`     | `tripId`    | High volume, short retention; route-deviation checks        |
| `profiles`      | `userId`    | Compacted: latest value per user                            |

## RabbitMQ jobs

Exchange `jobs` (topic). Routing keys: `notify.push`, `notify.email`, `import.timetable`,
`ai.onboarding` (one consumer, prefetch 1), `ledger.settle`, `forecast.retrain`.
Retries: waiting queues with a fixed TTL each (10 s, 1 min, 10 min) and a dead-letter exchange; then `jobs.dead`.

## AI and models

| Feature                                     | Where it trains                                      | Where it runs                                                |
| ------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------ |
| Departure forecast (LightGBM quantiles)     | Laptop, `services/forecast`                          | NestJS via `onnxruntime-node`                                |
| Request understanding, English and Banglish | AIUB AI Supercomputing Lab, `services/request-model` | NestJS via `onnxruntime-node`; rule-based parser as fallback |
| Campus onboarding agent                     | Not trained                                          | Gemini free tier, public timetable files only                |

The running app never calls the lab, and personal data never goes to the Gemini free tier.

See `docs/proposal/Pulse_Project_Proposal.pdf` (Section 12) for the full design and `docs/adr/` for decisions.
