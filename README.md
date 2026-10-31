# Pulse

[![CI](https://github.com/Ashfak-Hossain/pulse/actions/workflows/ci.yml/badge.svg)](https://github.com/Ashfak-Hossain/pulse/actions/workflows/ci.yml)

Pulse is a timetable-aware commute pooling app for university campuses, piloted at AIUB: it matches students who leave campus at the same time and splits the fare fairly.

## Getting started

New to the project? Start with the [onboarding guide](docs/onboarding/README.md): setup from a
blank laptop, a tour of the repo, the code explained line by line, and the recipe for adding an
endpoint.

## Local services

Docker Compose runs the services the apps need (`infra/compose/compose.yaml`). Ports listen on
`127.0.0.1` only and the credentials are local defaults (`pulse` / `pulse`). Needs Docker
(OrbStack or Docker Desktop); the smoke check also needs `curl` and `jq`, and its first run downloads the Kafka tools image
(about 700 MB on disk). Kafka creates no topic
by itself: a topic that does not exist is an error, not a new topic.

| Service    | Address                                               | Used for                                  |
| ---------- | ----------------------------------------------------- | ----------------------------------------- |
| PostgreSQL | `postgres://pulse:pulse@127.0.0.1:5432/pulse`         | Source of truth, with PostGIS             |
| Redis      | `redis://127.0.0.1:6379`                              | Cache                                     |
| Mailpit    | SMTP `127.0.0.1:1025`, inbox http://127.0.0.1:8025    | Catches every email; nothing is delivered |
| Kafka      | `127.0.0.1:9092` (laptop), `kafka:19092` (containers) | Domain events from the outbox (ADR 0004)  |

| Command            | Does                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `pnpm infra:up`    | Start the services and wait until they are healthy                                                     |
| `pnpm infra:smoke` | Check each service answers a real request                                                              |
| `pnpm infra:kafka` | Run a Kafka tool, for example `pnpm infra:kafka kafka-topics.sh --bootstrap-server kafka:19092 --list` |
| `pnpm infra:ps`    | Show status and health                                                                                 |
| `pnpm infra:logs`  | Follow the logs                                                                                        |
| `pnpm infra:down`  | Stop the services; data is kept                                                                        |
| `pnpm infra:reset` | Stop and delete all data                                                                               |

## Database

`packages/db` holds the Drizzle schema and SQL migrations (ADR 0003). Migrations run as the owner
`pulse`; the apps connect as `pulse_app`, which row-level security limits to one campus at a time.
Compose creates `pulse_app` only on an empty volume, so after pulling this change run
`pnpm infra:reset` once.

| Command                               | Does                                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `pnpm --filter @pulse/db db:migrate`  | Apply new migrations to the Compose database                                                             |
| `pnpm --filter @pulse/db db:generate` | Write a migration from changes in `src/schema.ts`                                                        |
| `pnpm --filter @pulse/db db:check`    | Schema and migrations agree, merged migrations untouched (CI runs it too; `git fetch origin main` first) |
| `pnpm --filter @pulse/db db:studio`   | Browse the tables in the browser (as the owner)                                                          |
| `pnpm --filter @pulse/db test:int`    | Integration tests against a fresh PostGIS container                                                      |
| `pnpm infra:seed`                     | Add local sample data (AIUB and a demo campus); safe to run again                                        |

## API

First run: `cp .env.example .env`, `pnpm infra:up`, `pnpm --filter @pulse/db db:migrate`,
`pnpm infra:seed`.

`pnpm --filter @pulse/api dev` starts the NestJS API on http://127.0.0.1:3000 (change with `HOST`
and `PORT`) and restarts it on every save. It checks its settings at startup and refuses to start
on a bad value, or when `DATABASE_URL` is a role that row-level security does not limit (use
`pulse_app`, never the owner). `curl 127.0.0.1:3000/health` answers `{"status":"ok"}` while the
process runs; `/health/ready` also checks PostgreSQL (503 when it is unreachable).
Tests: `pnpm --filter @pulse/api test` (unit) and `pnpm --filter @pulse/api test:e2e` (over HTTP,
against a PostGIS container, so Docker must be running).

| Endpoint              | Answers                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------- |
| `GET /health`         | `{"status":"ok"}` while the process runs                                                             |
| `GET /health/ready`   | 200 when PostgreSQL answers, 503 when it does not                                                    |
| `GET /campuses`       | `{ "items": [campus, …] }`, sorted by name                                                           |
| `GET /campuses/:slug` | One campus (`id`, `name`, `slug`, `emailDomains`, `timezone`, `location: { lat, lng }`); 404 if none |

There is no sign-in yet, so every route is public. Campuses are public on purpose (the app needs
them before sign-in). A new route is public only if its data is public too; anything personal
waits for the auth guard. Campus-scoped tables are read and written only inside `withCampus()`,
and every list has a hard limit.

Every error answers in one shape, `{ statusCode, error, message }` (plus `issues` when validation
fails), described by `apiErrorSchema` in `packages/contracts`. Server errors (5xx) never show
their real message: it goes to the log.

### Postman

The collection lives in `postman/` as one YAML file per request (Postman Native Git), so changes
are reviewed in pull requests like code. Postman v12: open your workspace, connect it to this repo
folder (Local View), pick the **Pulse local** environment and send requests. From the terminal,
with the [Postman CLI](https://learning.postman.com/docs/postman-cli/postman-cli-installation/)
installed and the API running: `pnpm api:postman`.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org), checked by commitlint on every commit:
`type(scope): summary`, for example `feat(money): add largest remainder split`.

| Type       | Use for                                       |
| ---------- | --------------------------------------------- |
| `feat`     | A new feature                                 |
| `fix`      | A bug fix                                     |
| `test`     | Adding or changing tests only                 |
| `refactor` | Code change that neither fixes nor adds       |
| `docs`     | Documentation only                            |
| `chore`    | Tooling and housekeeping                      |
| `build`    | Build system, dependencies, Docker, Turborepo |
| `ci`       | GitHub Actions workflows                      |

CI checks the pull request title the same way, because squash merge makes it the commit on `main`.

Scopes are package or app names: `money`, `db`, `api`, `worker`, `web`, `infra`. Leave the
scope out for repo-wide changes.
