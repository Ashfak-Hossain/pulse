# Pulse

[![CI](https://github.com/Ashfak-Hossain/pulse/actions/workflows/ci.yml/badge.svg)](https://github.com/Ashfak-Hossain/pulse/actions/workflows/ci.yml)

Pulse is a timetable-aware commute pooling app for university campuses, piloted at AIUB: it matches students who leave campus at the same time and splits the fare fairly.

## Getting started

New to the project? Start with the [onboarding guide](docs/onboarding/README.md): setup from a
blank laptop, a tour of the repo, the code explained line by line, and the recipe for adding an
endpoint.

## Local services

Docker Compose runs the services the apps need (`infra/compose/compose.yaml`, local only;
production uses `infra/compose/compose.prod.yaml`). Ports listen on
`127.0.0.1` only and the credentials are local defaults (`pulse` / `pulse`). Needs Docker
(OrbStack or Docker Desktop); the smoke check also needs `curl` and `jq`, and its first run downloads the Kafka tools image
(about 700 MB on disk). Kafka creates no topic
by itself: a topic that does not exist is an error, not a new topic.

| Service    | Address                                                        | Used for                                    |
| ---------- | -------------------------------------------------------------- | ------------------------------------------- |
| PostgreSQL | `postgres://pulse:pulse@127.0.0.1:5432/pulse`                  | Source of truth, with PostGIS               |
| Redis      | `redis://127.0.0.1:6379`                                       | Cache                                       |
| Mailpit    | SMTP `127.0.0.1:1025`, inbox http://127.0.0.1:8025             | Catches every email; nothing is delivered   |
| Kafka      | `127.0.0.1:9092` (laptop), `kafka:19092` (containers)          | Domain events from the outbox (ADR 0004)    |
| RabbitMQ   | `amqp://pulse:pulse@127.0.0.1:5672`, UI http://127.0.0.1:15672 | Jobs done once (email, imports, AI calls)   |
| Kafka UI   | http://127.0.0.1:8080 (only with `pnpm infra:console`)         | Browse topics, messages and consumer groups |

| Command              | Does                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `pnpm infra:up`      | Start the services and wait until they are healthy                                                     |
| `pnpm infra:console` | Also start Kafka UI (about 300 MB of memory, so it is off by default)                                  |
| `pnpm infra:smoke`   | Check each service answers a real request                                                              |
| `pnpm infra:kafka`   | Run a Kafka tool, for example `pnpm infra:kafka kafka-topics.sh --bootstrap-server kafka:19092 --list` |
| `pnpm infra:ps`      | Show status and health                                                                                 |
| `pnpm infra:logs`    | Follow the logs                                                                                        |
| `pnpm infra:down`    | Stop the services; data is kept                                                                        |
| `pnpm infra:reset`   | Stop and delete all data                                                                               |

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
| `pnpm infra:seed:courses`             | Add sample AIUB courses (after `infra:seed`); safe to run again                                          |
| `pnpm infra:seed:catalog`             | Add a synthetic AIUB term and timetable after the course seed. Safe to run again.                        |
| `pnpm infra:seed:places`              | Add AIUB gates, two zones and four meeting points (after `infra:seed`); safe to run again                |

`pulse_app` reads courses only inside `withCampus()`; only the owner can write them.

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

| Endpoint                                                | Answers                                                                                                                                                                                                     |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                                           | `{"status":"ok"}` while the process runs                                                                                                                                                                    |
| `GET /health/ready`                                     | 200 when PostgreSQL answers, 503 when it does not                                                                                                                                                           |
| `GET /campuses`                                         | `{ "items": [campus, …] }`, sorted by name                                                                                                                                                                  |
| `POST /campuses/lookup`                                 | Accepts JSON with an email and returns a campus summary (slug and name), or a null campus if no domain matches. Returns 409 for ambiguous domains.                                                          |
| `GET /campuses/:slug/courses`                           | Up to 500 public courses from that campus, ordered by code; 404 for unknown campus                                                                                                                          |
| `GET /campuses/:slug/terms`                             | All active and archived terms, newest first.                                                                                                                                                                |
| `GET /campuses/:slug/sections`                          | Sections and meetings for `termId`. Optional `q` searches course code or either title, `limit` selects 1–100 rows (default 20), and `cursor` resumes from `nextCursor`.                                     |
| `GET /campuses/:slug/distance?lat=…&lng=…`              | Distance from a point to campus, in whole metres; 400 for invalid coordinates, 404 for an unknown campus                                                                                                    |
| `GET /campuses/:slug`                                   | One campus (`id`, `name`, `slug`, `emailDomains`, `timezone`, `location: { lat, lng }`); 404 if none                                                                                                        |
| `POST /fares/split-preview`                             | Preview an exact integer-paisa fare split for 1–8 riders; 200 on success, 400 for invalid input                                                                                                             |
| `POST /admin/campuses`                                  | Create a campus and its `CampusCreated` outbox row; 401 without the admin token, 409 if the slug exists                                                                                                     |
| `GET /gates` · `/zones` · `/meeting-points`             | Places of the caller's campus (any signed-in user): gates primary first, zones with a GeoJSON `area`, active meeting points (`?zoneId=` narrows); 401 without a session                                     |
| `GET /gates/:id` · `/zones/:id` · `/meeting-points/:id` | One place of the caller's campus by id (any signed-in user); 404 for an unknown id, another campus's id or a hidden meeting point                                                                           |
| `POST · PATCH · DELETE /admin/gates`                    | Campus admins only (403 otherwise). The server sets the H3 cell; a new primary clears the old one; deleting or unsetting the primary gate answers 409                                                       |
| `POST · PATCH · DELETE /admin/zones`                    | Campus admins only. A self-crossing area answers 422; deleting a zone with active meeting points answers 409; hidden points do not block it                                                                 |
| `POST · PATCH · DELETE /admin/meeting-points`           | Campus admins only. DELETE hides the point; another campus's zone answers 422. Every admin place write adds one `audit_log` row                                                                             |
| `POST /admin/terms`                                     | Campus admins only. Creates a draft term; 400 if it ends before it starts, 409 if the name exists                                                                                                           |
| `POST /admin/terms/:id/activate`                        | Campus admins only. Activates a draft, archives the previous active term and writes a `TermActivated` outbox row; 409 for a term that is not a draft                                                        |
| `GET · PATCH /me`                                       | Your profile, role, status and campus (any signed-in user). PATCH sets names, gender, department and an E.164 phone; a pending profile becomes active once name and gender are set. Writes `ProfileChanged` |
| `GET · PUT /me/preferences`                             | Your travel preferences (404 before the first PUT). The home pin becomes an H3 cell and zone; the pin itself is never stored, logged or returned. Writes `ProfileChanged`                                   |
| `GET · POST · PATCH · DELETE /me/vehicles`              | Your own cars (1–6 free seats) and bikes (1), also `GET /me/vehicles/:id`. Riders only (not operators). DELETE hides the vehicle; another user's id answers 404                                             |
| `GET · POST · DELETE /me/trusted-contacts`              | Up to three emergency contacts with E.164 phones. A fourth answers 422 with `code: TRUSTED_CONTACT_LIMIT`; another user's id answers 404                                                                    |

There is no sign-in yet. `/admin/*` routes need `Authorization: Bearer <ADMIN_TOKEN>` (from
`.env`, a stand-in until sign-in); every other route is public. Campuses are public on purpose (the app needs
them before sign-in). A new route is public only if its data is public too; anything personal
waits for the auth guard. Campus-scoped tables are read and written only inside `withCampus()`,
and every list has a hard limit.

Every error answers in one shape, `{ statusCode, error, message }` (plus `issues` when validation
fails), described by `apiErrorSchema` in `packages/contracts`. Server errors (5xx) never show
their real message: it goes to the log.

### Postman

For the Catalog folder, run the campus, course and catalog seeds first, then run the folder in order.

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
