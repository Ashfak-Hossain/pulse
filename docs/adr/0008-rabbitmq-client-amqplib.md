# 0008 — RabbitMQ client for Node: `amqplib` 2.x

Status: proposed
Date: 2026-11-04

## Context

The worker needs a Node RabbitMQ client to declare the job topology from `@pulse/jobs`
(exchanges, quorum queues, wait queues, `jobs.dead`), publish jobs with publisher confirms and,
from S14 on, consume them. The broker is RabbitMQ 4.4 (Compose `queue` profile) over AMQP 0-9-1.
A connection drops when the broker restarts or the network blips, and the worker must come back
without a person restarting it. The same install limits apply as in ADR 0006: Node 26, no
install scripts, 8 GB laptops.

## Decision

Use `amqplib` 2.x on its own, with its opt-in recovery (`connect(url, { recovery })`). It has no
dependencies, ships its own types, and reconnects with backoff and jitter. Recovery brings back
the connection, not its channels or consumers, so the worker passes a `setup` function that runs
after every connect: it declares the topology (`ensureTopology`) and, later, starts the
consumers. Integration tests on `rabbitmq:4.4-management-alpine` (the Compose image) prove the
routes, retry tiers, dead-lettering, the delivery limit and a re-declare after the broker drops
the connection.

## Alternatives

| Option                     | Why not                                                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `amqp-connection-manager`  | A reconnect wrapper around `amqplib`; 2.x now does that itself, so it would be one more package and API for the same job.          |
| `rabbitmq-client`          | Also no dependencies and built-in recovery; a smaller community and its own API. The fallback if `amqplib` stops being maintained. |
| NestJS microservices (RMQ) | The worker is not a NestJS app, and the transport hides the exchange and queue arguments the topology depends on.                  |

## Consequences

- Startup gives up after 10 tries (about 25 s, each try at most 10 s), so a wrong URL or password
  fails the deploy; once connected, the worker reconnects forever. A reconnect that the broker
  refuses for good (403 login, 406 queue with other arguments, 530 no vhost) exits the worker
  instead, since retrying would leave it running with no queues or consumers. `AMQP_URL` has no
  default because it holds the password, and logs never print it.
- `setup` runs on every connect, so a queue deleted by hand comes back on the next reconnect.
- Queue arguments (type, dead-lettering, TTL, `x-max-length`, `x-delivery-limit`) are fixed once
  declared, and a declare with other values fails with `PRECONDITION_FAILED`. They stay arguments
  in `@pulse/jobs`, not a broker policy, so the code alone says what a queue does. Changing one:
  give the queue a new name, deploy the workers that use it, stop every old worker, drain or move
  the old queue, then delete it. Deleting it while an old worker runs does not work: its next
  reconnect declares the old queue again.
- Every channel and connection needs an `error` listener; without one, amqplib throws the event
  and the process crashes. `ensureTopology` uses a short-lived channel of its own, and
  `connectRabbit` adds a listener before `setup` runs.
- On RabbitMQ 4, `x-delivery-limit` counts only jobs returned by a crash (the channel closed with
  the job unacked), not `nack` with requeue. A handler that fails a job must send it through the
  retry tiers; requeueing would loop forever.
- The connection is plaintext (`amqp://`): the password crosses the wire unencrypted. That is
  acceptable only while broker and worker share one host's Docker network. Once they are on
  different hosts, `AMQP_URL` must be `amqps://` with a TLS listener on the broker (S54).
- The worker connects as the broker's default admin user for now. Before S54 it gets its own user
  with configure, write and read rights on its vhost only, no `administrator` tag, and the
  management UI stays off the public network.
- Revisit if `amqplib` stops being maintained (then `rabbitmq-client`) or if the worker needs
  AMQP 1.0 or streams.
