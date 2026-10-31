# Glossary

Every word this guide uses, in plain language. Alphabetical.

**ADR (Architecture Decision Record):** a short file in `docs/adr/` that says what we decided,
why, and what we gave up. Once accepted it is never edited; a new ADR replaces it.

**API:** the program other programs talk to. Ours answers HTTP requests with JSON
(`apps/api`).

**Container (Docker):** a small, isolated computer-inside-your-computer that runs one program
(PostgreSQL, Redis) with everything it needs. **Docker Compose** starts several containers from
one file (`infra/compose/compose.yaml`).

<a id="contract"></a>**Contract:** the agreed shape of a request or response, written as a Zod
schema in `packages/contracts`. The API promises to answer in that shape; clients rely on it.
Not the same as the database row.

**Controller (NestJS):** the class that receives HTTP requests for one route
(`@Controller('campuses')`) and hands them to a service.

**CI (Continuous Integration):** GitHub runs every check on every pull request
(`.github/workflows/ci.yml`). A PR can merge only when CI is green.

**Conventional Commits:** the message format `type(scope): summary`, e.g.
`feat(api): add campus lookup by email`.

**Decorator:** the `@Something()` lines above a class or method (`@Get(':slug')`,
`@Injectable()`). They attach information Nest reads at startup.

**Dependency injection (DI):** instead of creating what a class needs (`new CampusService()`),
the class asks for it in its constructor and Nest hands it in. Tests can then hand in a fake.

**Drizzle:** the library we use to write SQL queries in TypeScript with types
(`db.select().from(campus).where(eq(campus.slug, slug))`).

**DTO:** "data transfer object", the shape of data crossing the API boundary. In Pulse our
DTOs are the Zod schemas in `contracts`.

**e2e test (end to end):** starts the whole app and calls it over real HTTP, with a real database
in a container (`apps/api/test/*.e2e-spec.ts`).

**Endpoint / route:** one URL and method the API answers, e.g. `GET /campuses/:slug`.

**ESM:** the modern JavaScript module system (`import` / `export`). Ours everywhere.

**Event (Kafka):** a fact that already happened, named in the past tense (`CampusCreated`).
Many services may read it.

**Exception filter:** Nest code that catches every error and decides the response. Ours
(`common/http-error.filter.ts`) gives every error the same shape and hides server errors.

**Idempotent:** doing it twice has the same effect as doing it once.

**Job (RabbitMQ):** a command to do something exactly once (`SendEmail`).

**Kafka:** a log of events that services publish to and read from, in order. Ashfak's area.

**Migration:** a numbered SQL file that changes the database (create a table, add a column).
They run in order, once each (`packages/db/migrations`).

**Module (NestJS):** a box that groups the controller and services of one feature
(`CampusModule`). `AppModule` lists all modules.

**Monorepo:** one repository with several apps and packages, built and tested together.

**Outbox:** a table (`outbox_event`) where the API writes "this happened" in the same transaction
as the change. A separate relay later publishes it to Kafka, so data and events never disagree.

**Paisa:** 1/100 of a taka. All money in Pulse is a whole number of paisa.

**Pipe (NestJS):** code that checks or transforms input before the controller sees it. Ours,
`ZodValidationPipe`, answers 400 when the input breaks the contract.

**pnpm / workspace:** the package manager. A workspace is the set of packages it manages
together (`pnpm-workspace.yaml`). `--filter @pulse/api` runs a command in one package.

**PostGIS:** a PostgreSQL extension for map data: points, distances. Campus locations are PostGIS
points (x = longitude, y = latitude).

**PostgreSQL:** our database, and the source of truth.

**Pull request (PR):** a request to merge your branch into `main`, with a description, CI checks
and a review.

**RabbitMQ:** a queue that hands jobs to workers. Ashfak's area.

**Row-level security (RLS):** PostgreSQL rules that decide which rows a role may see or change.
The API connects as `pulse_app`, which RLS limits to one campus at a time.

**Seed:** sample data for local development (`pnpm infra:seed`).

**Service (NestJS):** a class with the logic and the database queries for one feature
(`CampusService`). Marked `@Injectable()` so Nest can inject it.

**Slice:** one small, shippable piece of work: one branch, one PR, with its own tests.

**Slug:** a short, URL-safe name: lowercase words joined by hyphens (`aiub`, `north-south`).

**Squash merge:** all commits of a PR become one commit on `main`, titled with the PR title.

**Tenant / campus-scoped:** each campus is a tenant. A campus-scoped table holds rows that belong
to one campus (`campus_id` column) and must never be seen by another.

**Testcontainers:** a library that starts a real database in Docker for a test run and throws it
away afterwards.

**Transaction:** several database changes that succeed or fail together.

**Turborepo (turbo):** runs a task (`build`, `test`) in every package, in the right order, and
skips work it has already done.

**Unit test:** tests one function or class on its own, with no network or database
(`*.spec.ts`, `*.test.ts`). Fast.

**`withCampus()`:** the function in `@pulse/db` that runs your queries inside a transaction with
the campus set, so row-level security shows that campus's rows and nothing else.

**Zod:** the library we use to describe data shapes and check values against them
(`z.strictObject({ slug: z.string() })`).
