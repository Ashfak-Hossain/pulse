# 13 · Decisions, open questions and risks

## 1. Decisions in this plan

✅ = already decided (ADR or team decision). ❓ = proposed here, needs Ashfak's yes before the slice
that depends on it. Each ❓ becomes an ADR with `/new-adr` when agreed.

| #   | Decision                | Recommendation and why                                                                                                                                                                                                                            | Needed by | Status                  |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ----------------------- |
| D4  | PostGIS image on M1     | Official image under amd64 emulation (ADR 0001)                                                                                                                                                                                                   | n/a       | ✅                      |
| D5  | Kafka client            | `@platformatic/kafka`: maintained, pure TypeScript, no install script (Confluent's client would compile librdkafka on Node 26). ADR 0006                                                                                                          | S10b      | ✅ proposed in ADR 0006 |
| D6  | RabbitMQ client         | `amqplib` 2.x alone: built-in recovery, own types, no dependencies (`amqp-connection-manager` not needed). ADR 0008                                                                                                                               | S11b      | ✅ proposed in ADR 0008 |
| D9  | API validation          | Own Zod pipe (ADR 0002)                                                                                                                                                                                                                           | n/a       | ✅                      |
| D16 | Primary keys            | `uuidv7()` (PostgreSQL 18 built-in) for new tables: time-ordered, index-friendly; `campus` keeps v4                                                                                                                                               | S28       | ✅ ADR 0007             |
| D17 | Status and kind columns | `text` + `CHECK`, not PostgreSQL enums (enums can't drop values; checks change in one migration)                                                                                                                                                  | S28       | ✅ ADR 0007             |
| D18 | Live locations          | Exception to the outbox rule: the gateway publishes `LocationReported` directly to `locations` (1-day retention); everything derived from it goes through the outbox. Alternative: Redis Streams, no Kafka topic ([05](05-events-and-jobs.md) §6) | S46       | ❓                      |
| D19 | Job delivery            | At least once; every job has a `dedupeKey`; publish with confirms **before** committing `processed_event`                                                                                                                                         | S14       | ✅ ADR 0009             |
| D20 | Sessions                | JWT access token (15 min) + opaque rotating refresh token, both in httpOnly cookies on one origin via a proxy                                                                                                                                     | S29       | ❓                      |
| D21 | Files                   | `FileStore` port: local disk in dev, any S3-compatible bucket in production; signed short links                                                                                                                                                   | S37       | ❓                      |
| D22 | Realtime                | Socket.IO + Redis adapter; workers emit via redis-emitter; chat sent over REST                                                                                                                                                                    | S46       | ❓                      |
| D23 | Worker shape            | One `apps/worker` with roles (`relay`, `consumers`, `jobs`, `scheduler`) chosen by `WORKER_ROLES`                                                                                                                                                 | S10b      | ❓                      |
| D24 | Matcher ownership       | Kafka partition ownership per campus, plus a per-campus advisory lock as a safety net during rebalances                                                                                                                                           | S44       | ❓                      |
| D25 | New topics              | Add `shuttles` (key `runId`) and `moderation` (key `subjectId`); one `<topic>.dlq` per topic                                                                                                                                                      | S62, S68  | ❓                      |
| D26 | Campus in events        | Every campus-scoped payload has `campusId` (envelope unchanged, ADR 0005)                                                                                                                                                                         | S13       | ❓                      |
| D27 | Bot check               | Cloudflare Turnstile behind flag `auth.turnstile`                                                                                                                                                                                                 | S28       | ❓                      |
| D28 | Map tiles               | MapLibre GL + OpenFreeMap (free, no key)                                                                                                                                                                                                          | S40       | ❓                      |
| D29 | Frontend stack          | Next.js + Tailwind + shadcn/ui + TanStack Query (chosen 2026-11-01)                                                                                                                                                                               | S40       | ✅                      |
| D30 | Hosting                 | Decide by 21 Nov; recommendation: one 4–8 GB VPS with Compose + Caddy ([11](11-quality-and-ops.md) §4.4)                                                                                                                                          | S54       | ❓                      |
| D31 | Home location precision | H3 resolution 8 (~0.7 km² cells); exact pin discarded on save                                                                                                                                                                                     | S35       | ❓                      |
| D32 | Money ledger shape      | One account per (crew, member); signed postings; deferred zero-sum constraint trigger; fare claims before postings                                                                                                                                | S47       | ❓                      |

## 2. Questions for Ashfak

| #   | Question                                                                                                                           | Why it matters                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Q1  | Exact midterm date and final date?                                                                                                 | Fixes the gate and the pilot window                                    |
| Q2  | ✅ XLSX. Not committed: each member keeps it in a git-ignored `fixtures/private/`; CI uses a synthetic workbook in the same layout | S31                                                                    |
| Q3  | Golden grade reports must be **synthetic** (same layout, invented names, IDs and grades). Who builds two or three of them?         | Real grade reports can never be committed (rule 9 and the public repo) |
| Q4  | Is Cloudflare Turnstile acceptable (free, needs a Cloudflare account), or skip the bot check for the pilot?                        | D27                                                                    |
| Q5  | Can M2 and M3 each take one Wednesday walkthrough per week?                                                                        | Viva readiness: everyone must explain parts they did not build         |
| Q6  | Do we have student credits (GitHub Student Pack: DigitalOcean / Azure; AWS Educate) for hosting?                                   | D30                                                                    |

## 3. Risks

| Risk                                                     | Likelihood | Impact    | Mitigation                                                                                                     |
| -------------------------------------------------------- | ---------- | --------- | -------------------------------------------------------------------------------------------------------------- |
| Full scope does not fit six weeks                        | High       | High      | Waves, gate on 28 Nov, explicit cut order ([12](12-roadmap.md) §4)                                             |
| 8 GB laptops can't run the full stack plus the IDE       | High       | Medium    | Compose profiles; native Kafka image; run web against a shared staging API when needed                         |
| Grade-report layout differs between students             | Medium     | High      | ≥ 20 volunteer tests in week 3; search fallback; clear "unmatched" reasons                                     |
| Not enough pilot users                                   | Medium     | High      | Survey doubles as recruitment; class announcements; route waitlists; start with friend groups on shared routes |
| Lab access delays model training                         | Medium     | Medium    | Rule parser ships first; the dataset can be generated on a laptop; lab only for fine-tuning                    |
| Gemini free-tier limits or policy change                 | Medium     | Low       | Feature flag; hand-written adapter fallback; prefetch 1; rate limiter                                          |
| Kafka or RabbitMQ consumes too much memory in production | Medium     | Medium    | Memory limits; 4 GB minimum host; `apache/kafka` heap set to 512 MB                                            |
| A teammate becomes unavailable                           | Medium     | High      | Small slices; docs and walkthroughs; Ashfak reviews every PR, so knowledge is shared                           |
| Privacy bug (grades or exact home leak)                  | Low        | Very high | Browser-only parsing with a network-level e2e test; pin discarded on save; public-safety reviewer on every PR  |
| Money bug (shares ≠ fare, unbalanced entry)              | Low        | High      | Property tests; deferred zero-sum trigger in the database; append-only ledger                                  |

## 4. Future upgrades (after the course)

From the proposal, plus what this plan defers: self-hosted LLM for admin questions; Bangla
interface; Temporal for long workflows; production monitoring (Prometheus, Grafana, OpenTelemetry);
real bKash and operator partnerships; Karapace schema registry (ADR 0005 says later); a revenue
model (shuttle seats, university licences); native apps; splitting heavy modules (matching,
realtime) into their own services if load requires it.
