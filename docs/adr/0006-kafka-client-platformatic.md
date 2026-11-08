# 0006 — Kafka client for Node: `@platformatic/kafka`

Status: proposed
Date: 2026-11-01

## Context

The worker needs a Node Kafka client: first for the outbox relay (an idempotent producer with
`acks=all`, and an admin client that creates the topics listed in `@pulse/events`), later for
consumer groups. The broker is Kafka 4.4 (ADR 0004). Kafka 4 removed the oldest protocol
versions (KIP-896), so a client must speak recent ones. The repo runs Node 26, and
`pnpm-workspace.yaml` denies install scripts unless a package truly needs one. Every member
installs on a laptop, some with 8 GB of RAM, and CI installs on every pull request.

## Decision

Use `@platformatic/kafka`: a maintained client written in TypeScript, with no install script and
nothing compiled at install (an optional prebuilt CRC32 binary has a WASM fallback). It supports
idempotent producers, `acks=all`, admin topic creation and consumer groups. Its CI covers Kafka
3.5 to 4.2, so a Testcontainers test runs the same image as Compose (`apache/kafka-native:4.4.0`)
and proves, on 4.4, keyed produce with `acks=all`, that the producer gets a producer id
(idempotent mode), topic creation and a consumer-group round trip.

## Alternatives

| Option                           | Why not                                                                                                                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kafkajs`                        | No release since February 2023; nobody is fixing it for newer brokers.                                                                                                                                                                |
| `@confluentinc/kafka-javascript` | Built on librdkafka, a native addon. Prebuilt binaries stop at Node ABI 137 and we run Node 26 (ABI 147), so every install would compile librdkafka from C (needs build tools, slow on 8 GB), and its install script must be allowed. |
| NestJS microservices transport   | Uses kafkajs underneath, and the worker is not a NestJS app.                                                                                                                                                                          |

## Consequences

- No build step: the same code runs on macOS, in CI and in a later Docker image, with no
  `allowBuilds` exception.
- The producer retries 10 times (about 33 s with backoff), not forever as the library does by
  default for idempotent producers. The outbox relay (S10c) records the error on the row and
  retries on its next loop. After giving up, the producer gets a new producer id, so a resend can
  write a duplicate: delivery is at least once, and consumers drop duplicates with
  `processed_event`.
- The connection is plaintext with no authentication, which is fine for local Compose only.
  Production needs SASL and TLS, configured through the same Zod env schema, with secret values
  kept out of error messages.
- Kafka 4.4 is newer than the client's tested range. The integration tests are the guard: run
  them on every client or broker upgrade.
- Its API is its own (not kafkajs-style), so kafkajs tutorials do not apply directly; the
  worker keeps the client behind small functions (`createKafkaProducer`, `createKafkaAdmin`,
  `ensureTopics`) so swapping it later touches few files.
- Revisit if the client stops being maintained or if Confluent ships Node 26 binaries and we need
  librdkafka features (for example, exactly-once transactions across topics).
