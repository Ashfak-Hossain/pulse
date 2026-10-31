# 2. Repo tour: what every folder and file is for

Pulse is a **monorepo**: one git repository holding several apps and shared packages. They are
built and tested together, so a change to a shared package and the app that uses it land in one
pull request.

```
pulse/
├── apps/            programs that run (the API, later the worker and the web app)
├── packages/        shared code that apps import by name (@pulse/db, @pulse/contracts…)
├── infra/           Docker Compose: the local database and other services
├── postman/         the Postman collection, one YAML file per request
├── docs/            architecture, decisions (ADRs), the proposal, this guide
├── services/        (later) the Python and C++ services
├── .github/         CI workflows, PR and issue templates, code owners
├── .claude/         Claude Code setup: reviewers, commands, project rules
└── root files       workspace, TypeScript, lint, format, commit settings
```

## `apps/`: programs that run

| Folder        | What it is                                                         | Who              |
| ------------- | ------------------------------------------------------------------ | ---------------- |
| `apps/api`    | The NestJS API: answers HTTP requests, reads and writes PostgreSQL | **You** + Ashfak |
| `apps/worker` | (later) reads Kafka events, runs RabbitMQ jobs (emails, matching)  | Ashfak           |
| `apps/web`    | (after the midterm) the Next.js web app                            | everyone         |

Inside `apps/api`:

```
apps/api/
├── src/
│   ├── main.ts                 starts the app (the only file that runs on its own)
│   ├── app.module.ts           the root module: lists every feature module
│   ├── app.setup.ts            app-wide HTTP setup (security headers), shared with tests
│   ├── config/env.ts           reads and checks the settings in .env at startup
│   ├── db/db.module.ts         opens the database connection pool, shares it
│   ├── common/                 shared pieces: the Zod validation pipe, the error filter
│   ├── health/                 GET /health and /health/ready
│   └── campus/                 GET /campuses and /campuses/:slug ← the example you copy
├── test/                       e2e tests: start the app, call it over HTTP
│   └── support/global-setup.ts starts one PostgreSQL container for the test run
├── vitest.config.ts            unit tests: src/**/*.spec.ts
├── vitest.config.e2e.ts        e2e tests: test/**/*.e2e-spec.ts
├── nest-cli.json               settings for the Nest CLI (`nest g …`, `nest build`)
└── package.json                its scripts (dev, test, test:e2e…) and dependencies
```

**Rule of thumb:** one folder per feature under `src/` (`campus/`, later `fare/`, `course/`),
each with a module, a controller and a service.

## `packages/`: shared code

| Package            | What it holds                                                                | Used by               |
| ------------------ | ---------------------------------------------------------------------------- | --------------------- |
| `@pulse/contracts` | Zod schemas: the shape of every request and response, and of every error     | api, tests, later web |
| `@pulse/db`        | Table definitions (Drizzle), migrations, the connection pool, `withCampus()` | api, later worker     |
| `@pulse/money`     | Splitting a fare fairly in integer paisa (`largestRemainderSplit`)           | api (your fare task)  |

Why packages and not folders inside the API? **More than one app needs them**, and a copy would
drift. Why two packages? `contracts` is the public promise to clients (the browser may import
it); `db` is private internals (the browser must never import it). See the
[glossary](glossary.md#contract).

One thing to remember: apps use a package's **built** `dist/` folder, not its source. After
changing a package, run `pnpm --filter @pulse/<name> build` (the root `pnpm build`, `pnpm test`
and `pnpm test:e2e` do it for you).

Inside `packages/db`:

| Path                  | What it is                                                            |
| --------------------- | --------------------------------------------------------------------- |
| `src/schema.ts`       | The tables in TypeScript (Drizzle). Changing a table starts here      |
| `migrations/*.sql`    | The SQL that creates and changes tables, in order (0000, 0001, …)     |
| `src/client.ts`       | `createDb()`: one connection pool per process                         |
| `src/campus-scope.ts` | `withCampus()`: the only way to touch campus-scoped rows              |
| `src/role-check.ts`   | Refuses to start if the app connects as a role that bypasses security |
| `src/testing.ts`      | `startTestDatabase()`: a throwaway PostgreSQL for tests (tests only)  |
| `drizzle.config.ts`   | Settings for `drizzle-kit` (generate and run migrations)              |

## `infra/`: local services

| Path                           | What it is                                                            |
| ------------------------------ | --------------------------------------------------------------------- |
| `infra/compose/compose.yaml`   | Docker Compose: PostgreSQL + PostGIS, Redis, Mailpit (127.0.0.1 only) |
| `infra/compose/postgres/init/` | Runs once on an empty database: creates the `pulse_app` role          |
| `infra/compose/postgres/seed/` | Sample data for `pnpm infra:seed`                                     |
| `infra/compose/smoke.sh`       | `pnpm infra:smoke`: checks each service answers a real request        |

## `postman/`

One YAML file per request (Postman Native Git), so a change to a request is reviewed in a pull
request like code. One folder per feature (`Health`, `Campuses`). Every endpoint you add gets a
request here with test scripts and a saved example response.

## `docs/`

| Path                       | What it is                                                                       |
| -------------------------- | -------------------------------------------------------------------------------- |
| `docs/architecture.md`     | The big picture: API, events (Kafka), jobs (RabbitMQ), the rules                 |
| `docs/adr/`                | Architecture Decision Records: why we chose X over Y. Never edit an accepted one |
| `docs/development-plan.md` | Who owns what, the 13-week plan                                                  |
| `docs/proposal/`           | The full project proposal (PDF)                                                  |
| `docs/onboarding/`         | This guide                                                                       |

## `.github/`

| Path                       | What it is                                                                     |
| -------------------------- | ------------------------------------------------------------------------------ |
| `workflows/ci.yml`         | CI: on every PR it runs format, lint, typecheck, test, e2e, int, build         |
| `workflows/pr-title.yml`   | Checks the PR title is a Conventional Commit (it becomes the commit on `main`) |
| `pull_request_template.md` | The sections every PR description fills in                                     |
| `ISSUE_TEMPLATE/`          | Bug and feature forms                                                          |
| `CODEOWNERS`               | Ashfak reviews every change                                                    |
| `dependabot.yml`           | Opens PRs to update dependencies and pinned actions                            |

## `.claude/`

The Claude Code setup for this repo: reviewer agents (`agents/`), commands such as `/verify`
(`skills/`), project rules per area (`rules/`), and safety hooks. See
[Claude Code](09-claude-code.md).

## Root files

| File                     | What it does                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| `package.json`           | Root scripts (`pnpm test`, `pnpm infra:up`…) and the pnpm version                           |
| `pnpm-workspace.yaml`    | Which folders are packages; shared versions (the "catalog")                                 |
| `pnpm-lock.yaml`         | The exact version of every installed package. Never edit by hand                            |
| `turbo.json`             | Turborepo: runs a task in every package, builds dependencies first, caches                  |
| `tsconfig.base.json`     | TypeScript settings every package extends (strict mode and more)                            |
| `eslint.config.js`       | Lint rules (finds mistakes, e.g. unsafe `any`)                                              |
| `.prettierrc.json`       | Formatting rules (Prettier rewrites style; you do not argue about it)                       |
| `commitlint.config.js`   | Which commit types are allowed (`feat`, `fix`, `test`…)                                     |
| `.husky/`                | Git hooks: format check before a commit, message check after                                |
| `.editorconfig`          | Editor basics: UTF-8, LF line endings, 2-space indent                                       |
| `.nvmrc`                 | The Node version (26); fnm reads it                                                         |
| `.env.example`           | Safe local settings; copy to `.env` (never commit `.env`)                                   |
| `.gitignore`             | Files git never tracks (`node_modules`, `dist`, `.env`, `notes/`)                           |
| `CLAUDE.md`              | Claude Code's instructions. Kept per machine (git ignores it): ask Ashfak for the team copy |
| `README.md`              | Short reference: services, database, API, Postman, commit messages                          |
| `SECURITY.md`, `LICENSE` | How to report a vulnerability; MIT licence                                                  |

You will see folders that git ignores: `node_modules/` (installed packages), `dist/` (build
output), `.turbo/` (cache) and maybe `notes/` (private notes; every teammate may keep their own).
