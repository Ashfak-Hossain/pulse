# Pulse

[![CI](https://github.com/Ashfak-Hossain/pulse/actions/workflows/ci.yml/badge.svg)](https://github.com/Ashfak-Hossain/pulse/actions/workflows/ci.yml)

Pulse is a timetable-aware commute pooling app for university campuses, piloted at AIUB: it matches students who leave campus at the same time and splits the fare fairly.

## Local services

Docker Compose runs the services the apps need (`infra/compose/compose.yaml`). Ports listen on
`127.0.0.1` only and the credentials are local defaults (`pulse` / `pulse`). Needs Docker
(OrbStack or Docker Desktop); the smoke check also needs `curl` and `jq`.

| Service    | Address                                            | Used for                                  |
| ---------- | -------------------------------------------------- | ----------------------------------------- |
| PostgreSQL | `postgres://pulse:pulse@127.0.0.1:5432/pulse`      | Source of truth, with PostGIS             |
| Redis      | `redis://127.0.0.1:6379`                           | Cache                                     |
| Mailpit    | SMTP `127.0.0.1:1025`, inbox http://127.0.0.1:8025 | Catches every email; nothing is delivered |

| Command            | Does                                               |
| ------------------ | -------------------------------------------------- |
| `pnpm infra:up`    | Start the services and wait until they are healthy |
| `pnpm infra:smoke` | Check each service answers a real request          |
| `pnpm infra:ps`    | Show status and health                             |
| `pnpm infra:logs`  | Follow the logs                                    |
| `pnpm infra:down`  | Stop the services; data is kept                    |
| `pnpm infra:reset` | Stop and delete all data                           |

## API

`pnpm --filter @pulse/api dev` starts the NestJS API on http://127.0.0.1:3000 (change with `HOST`
and `PORT`) and restarts it on every save. `curl 127.0.0.1:3000/health` answers `{"status":"ok"}`.
Tests: `pnpm --filter @pulse/api test` (unit) and `pnpm --filter @pulse/api test:e2e` (over HTTP).

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
