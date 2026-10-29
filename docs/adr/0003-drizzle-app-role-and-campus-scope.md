# 0003 — Drizzle with node-postgres, a separate app role, and a transaction-local campus scope

Status: proposed
Date: 2026-10-30

## Context

PostgreSQL with PostGIS is the source of truth (CLAUDE.md rule 1). Every campus-scoped table must
have `campus_id` and a row-level security (RLS) policy (rule 7), so a faulty query can never
return another campus's rows. The outbox (rule 1) and idempotent consumers (rule 2) need explicit
transactions. The code is strict TypeScript and ESM, and migrations must be plain SQL that a
reviewer can read. RLS is ignored for superusers, roles with `BYPASSRLS` and table owners, and the
Compose user `pulse` is all three. Connections are pooled, so a session setting outlives a request.

## Decision

- **Drizzle ORM 0.45** with the **`pg`** driver in `packages/db`. The schema in `src/schema.ts`
  declares tables and RLS policies; `drizzle-kit generate` writes SQL migrations; anything Drizzle
  cannot express (extensions, grants) goes into a custom migration.
- **Two roles.** `pulse` owns the tables and runs migrations (`MIGRATION_DATABASE_URL`).
  `pulse_app` (`NOSUPERUSER NOBYPASSRLS`, owns nothing) is what the API uses (`DATABASE_URL`);
  workers use it too until the relay and consumers get their own role. It is created by `infra/compose/postgres/init/01-app-role.sql`; migrations only
  grant it rights: default privileges on new tables, then revokes where a table needs less.
- **Campus scope.** `withCampus(db, campusId, work)` checks the id is a UUID, then runs `work` in
  one transaction after `set_config('app.campus_id', id, true)`. Policies compare against
  `nullif(current_setting('app.campus_id', true), '')::uuid`, so no setting matches no row.
- **The campus table** is the tenant itself. Its facts are public (sign-in finds a campus by email
  domain before any campus is set), so `pulse_app` may read every row; insert and update only touch
  the campus set by `withCampus`. `pulse_app` cannot delete a campus: removing a tenant is an
  owner/admin job. Tables with personal data stay scoped for reads too.
- **Outbox tables are cross-campus infrastructure.** `outbox_event` and `processed_event` have no
  `campus_id` or RLS, because the outbox relay and consumers read every campus. So `pulse_app` may
  only insert outbox events (no `SELECT`, so no `.returning()`: callers create the event id), and
  only read and insert processed events; reading and marking events published belongs to the
  relay's own role. Events are ordered by an identity column `seq`, because `created_at` is the
  same for every event of one transaction. The counter behind `seq` is hidden from `pulse_app`.
- **Tests** run against a fresh PostGIS from Testcontainers, connected as `pulse_app`. Guard tests
  fail when a table in `public` has no RLS policy for `pulse_app` (unless it is a listed
  exception), when a view runs without `security_invoker`, or when the app can read a
  materialized view.

## Alternatives

| Option                                    | Why not                                                                                                                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeORM                                   | No RLS policies in its schema; decorator entity classes; known ESM friction; migrations as TS classes. Familiar from NestJS docs, which is its main pull.              |
| Prisma                                    | Own schema language and query engine; RLS needs workarounds; raw SQL is second-class.                                                                                  |
| Drizzle 1.0 release candidate             | Not stable yet; breaking changes possible before 1.0. Revisit when it is released.                                                                                     |
| `postgres.js` driver                      | Fast, but fewer examples with NestJS and Drizzle's migrator.                                                                                                           |
| `where campus_id = ?` in every query      | One forgotten `where` leaks another campus's data; nothing in the database stops it.                                                                                   |
| Session-level `SET app.campus_id`         | The pooled connection keeps it, so the next request may run with the wrong campus.                                                                                     |
| Connect the app as `pulse`                | RLS would silently not apply.                                                                                                                                          |
| One `FOR ALL` policy on `campus`          | Hides campuses from sign-in, which runs before any campus is set; the workaround would be connecting as the owner.                                                     |
| Order outbox events by `created_at`       | `now()` is the transaction's start time, so events written together tie, and random UUIDs cannot break the tie.                                                        |
| Column-level `INSERT` grant on the outbox | Would stop the app from setting `published_at` or `seq`, but Drizzle names every column in an insert (`default` for the unset ones), so every insert would be refused. |

## Consequences

- Campus isolation is enforced by PostgreSQL and proven by integration tests, not by code review.
- Every campus-scoped query must go through `withCampus`. Forgetting it on a scoped table returns
  no rows, and on `campus` a write matches no row: safe, but a confusing bug to look for.
- A new table needs either an RLS policy or a reviewed entry in the guard test's exception list.
- `seq` gives the order _within_ a transaction. Two concurrent transactions can commit in the
  opposite order to their `seq`, and `seq` can have gaps. So the relay must keep polling unpublished
  rows `order by seq` and never remember a "last seen seq"; writes that need per-aggregate order
  across transactions lock the aggregate's row first.
- `campus_insert` protects no tenant (the caller chooses the id). Creating a campus must be
  authorised in the API: a platform-admin route, with the id generated on the server.
- Deferred to later work, recorded here so the relay and API authors see them:
  - Relay: its own role (read and mark published), a single active instance, publish only after
    Kafka acknowledges, `attempts`/`last_error` columns, and `topic`/`key` columns filled at write
    time. It also guards against an app bug inserting a row with `published_at` already set.
  - Consumers: their own role; `insert … on conflict do nothing` to skip duplicates, never catching
    the unique-violation error inside the transaction. Then revoke `processed_event` from the API.
  - Events: `CampusCreated` needs a topic, and the envelope's event id must be `outbox_event.id`.
  - Cleanup of published outbox rows and old `processed_event` rows.
  - Email domains move to their own table with a unique key, so two campuses cannot claim one
    domain (sign-in would be ambiguous). Arrays cannot be unique across rows.
  - A lint check that only `campus-scope.ts` and `schema.ts` mention `app.campus_id`, so no code
    sets it for a whole session.
- Changing the schema means `db:generate`, never editing a migration that already ran. drizzle-kit
  0.31 drops the SRID from geometry columns, so generated PostGIS columns are checked by a test and
  fixed by hand before the migration is committed.
- Integration tests need Docker (OrbStack locally, the runner's Docker in CI) and take about 10–20 s.
- A fresh Compose volume is needed once (`pnpm infra:reset`) so the init script creates `pulse_app`.
