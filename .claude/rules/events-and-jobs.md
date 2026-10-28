---
paths:
  - 'packages/events/**'
  - 'packages/jobs/**'
  - 'apps/worker/**'
---

# Events and jobs

- Events: past-tense names, envelope from `@pulse/events`, keyed as in `Topics`. Add-only schema changes.
- Producers write to the outbox; only the outbox relay publishes to Kafka.
- Consumers: insert into `processed_event` first in the transaction; skip if the row already exists.
- Jobs: publish to the `jobs` exchange with a routing key from `@pulse/jobs`; ack only after the work succeeds; failures go through retry tiers, then `jobs.dead`.
- The `ai` queue has one consumer with prefetch 1 (Gemini free-tier limit).
