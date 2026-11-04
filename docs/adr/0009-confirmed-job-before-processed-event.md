# 0009 — Consumers that queue jobs: confirm the job before `processed_event` commits

Status: proposed
Date: 2026-11-05

## Context

A Kafka consumer that reacts to an event by queuing a RabbitMQ job (the notifier turns
`CampusCreated` into a `notify.email` job) writes to two systems that share no transaction:
PostgreSQL (`processed_event`, which makes the consumer idempotent) and RabbitMQ. The worker can
crash between any two steps, Kafka redelivers anything whose offset was not committed, and a
lost job means a lost email with no error anywhere. Plan decision D19 asked for the order.

The plan also gave all worker consumers one shared role (`pulse_worker`). The relay already has
its own (`pulse_relay`, ADR 0003 pattern).

## Decision

Per record: `BEGIN` → insert `processed_event (consumer, event_id) on conflict do nothing
returning` (no row back: a repeat, skip) → publish the job and wait for the broker's confirm
(`mandatory`, persistent, 5 s timeout) → `COMMIT` → commit the Kafka offset. Any failure rolls
back and retries the same record with backoff; the offset never passes an unhandled record. A
failed offset commit only logs a warning, because the next commit carries it forward and
`processed_event` absorbs a redelivery. Records that cannot be read (bad JSON, schema errors, too
large) are logged with topic, partition, offset and Zod issue codes only, then committed. Unknown
event types also log their version and, if it looks like an event name, their type.

Job ids are UUID v5 of `<job type>:<event id>`, so a redelivered event makes the same job id.
Each consumer group gets its own database role: `pulse_notifier` may insert and read
`processed_event` and nothing else, and `pulse_app` lost both rights (migration 0008).

## Alternatives

| Option                                        | Why not                                                                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Commit `processed_event`, then publish        | A crash after `COMMIT` loses the job for good: the redelivered event is skipped as a repeat.                                                           |
| A job outbox table, published by a relay      | Exactly-once into RabbitMQ, but a second outbox, relay and poll loop for each job type. Duplicates are cheap here, since jobs carry a `dedupeKey`.     |
| Catch `23505` on a plain insert               | The failed statement aborts the transaction, so nothing after it can run; `on conflict do nothing` reports the repeat without an error.                |
| One shared `pulse_worker` role                | Each new consumer would widen the rights of all of them; the matcher should not write notifications.                                                   |
| A Kafka dead-letter topic for invalid records | One more topic and producer in the consumer path. Our own producers validate with the same schemas, so an invalid record is a bug to find in the logs. |

## Consequences

- Delivery is at least once: a crash after the confirm and before `COMMIT`, or a confirm that
  times out and is retried, queues the job again with the same `jobId` and `dedupeKey`. A
  check-then-send in the email worker (S15) is not enough, since two copies can run at once
  (`prefetch: 10`). It must claim the job atomically through a unique `dedupe_key` insert, with a
  state, so a retry after a failed send is not dropped as a duplicate.
- While RabbitMQ refuses jobs (a full queue, a broker down), the notifier holds its instance's whole
  stream and Kafka keeps the backlog; nothing is dropped. Long holds show as `error` logs from the
  10th failure in a row. Revisit this before the notifier reads a topic with several partitions.
- A job type with no queue goes to `jobs.dead` through the alternate exchange and is confirmed, so
  it shows up as a non-empty `jobs.dead`, not as a held event.
- If the broker closes the publisher's channel and keeps the connection (the exchange deleted, a
  right revoked), no reconnect will replace the channel, so the worker exits and restarts.
- The notifier's pool has limits on PostgreSQL waits (10 s statement, 15 s idle in transaction,
  above the 5 s confirm wait), so a hung database fails the try instead of blocking it silently.
- The consumer reads from its group's committed offsets, and a new group starts at the
  beginning of the topic (the library's default, latest, would skip records written while no
  worker ran).
- Every future consumer gets its own role, init script, migration and `*_DATABASE_URL`.
