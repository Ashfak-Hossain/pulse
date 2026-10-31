# 0004 — Kafka in development: native image, one KRaft node, no auto-created topics

Status: proposed
Date: 2026-10-31

## Context

Pulse publishes domain events to Kafka through the outbox (`docs/architecture.md`). Members
develop on 8 GB Apple Silicon laptops that already run PostGIS under emulation (ADR 0001), and CI
will need the same broker. Kafka 4 runs without ZooKeeper (KRaft). Apache publishes two images for
4.4.0 (checked 2026-10-31): `apache/kafka`, a JVM build with the command-line tools (about 700 MB
on disk), and `apache/kafka-native`, a GraalVM native build (211 MB, arm64) without the tools.
The proposal (Section 12) plans for "Kafka runs from its lightweight native image during
development".

## Decision

Run `apache/kafka-native:4.4.0` as a single node that is both broker and KRaft controller, with
automatic topic creation turned off. Kafka's tools come from `apache/kafka:4.4.0` in a separate
`kafka-cli` service (profile `tools`) that starts only when someone runs it.

## Alternatives

| Option                             | Why not                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `apache/kafka` (JVM) as the broker | Slower start and more memory on a laptop that is already tight; the native build passes the same smoke round trip. |
| Bitnami or Confluent images        | Bitnami stopped publishing free images; Confluent's are larger and add licensing questions for no gain here.       |
| Three brokers                      | Real replication, but three times the memory; one node is enough to develop and test the outbox flow.              |
| Redpanda (Kafka-compatible)        | Not Apache Kafka; behaviour can differ from the Kafka we would run later.                                          |
| Auto topic creation on             | A typo in a topic name would quietly create a new empty topic instead of failing.                                  |

## Consequences

- Kafka is healthy about 6 s after start and uses about 200 MiB (measured: 240 MiB peak with 200,000
  records, under the 384 MiB limit).
- The native image is not the build production would run. Kafka's settings and protocol are the
  same, so this matters only for JVM tuning, which development does not need.
- Every topic must be created on purpose. `@pulse/events` (the event contracts) will own the topic
  list and the step that creates the topics.
- One node keeps one copy of each record, so the internal topics are set to one replica. Replication
  and broker-failure behaviour cannot be tested locally. The step that creates topics must take the
  replication factor and `min.insync.replicas` from configuration (1 here, more on a real cluster).
- Development only: no TLS, passwords or access rules. The port listens on `127.0.0.1` only; any
  shared or production broker needs SASL over TLS and per-service permissions.
- The cluster ID is pinned in Compose, because it is written into the data volume on first start.
  If it ever has to change, `pnpm infra:reset` deletes the old data.
- The native image has no data folder its user can write to, so the volume is mounted on the empty
  home folder `/home/appuser`. Revisit if a later image adds one.
- The CLI image is a large one-time download, made only when the CLI is first run.
