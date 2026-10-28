---
name: add-event
description: Add a new Kafka domain event end to end (schema, outbox write, consumer) following Pulse's outbox and idempotency rules.
argument-hint: '[EventName] [topic]'
---

Add the event: $ARGUMENTS

1. Confirm the name is past tense and the topic exists in `packages/events` `Topics`; ask if not.
2. Define the payload schema (add-only) in `packages/events`, with a test.
3. In the producing service, write the outbox row in the same transaction as the business change.
4. In each consumer, insert into `processed_event` first and skip duplicates.
5. Add an integration test that delivers the event twice and checks the effect happens once.
6. Run all checks, then summarise what changed and why.
