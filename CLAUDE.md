# Pulse

Timetable-aware commute pooling for university campuses (AIUB pilot). Course project for
CSC4161 Advanced Programming in Web Technology, built to production standards by a team of three.

Read before larger changes: @docs/architecture.md

Further context (read on demand, not every session):

- Full proposal: `docs/proposal/Pulse_Project_Proposal.pdf`
- Plan, ownership and build order: `docs/development-plan.md`
- Decisions: `docs/adr/` (never edit an accepted ADR; supersede it with a new one)

## Repository map

- `apps/web` Next.js PWA · `apps/api` NestJS API (modular monolith) · `apps/worker` Kafka consumers and RabbitMQ workers
- `packages/contracts` Zod API schemas · `packages/events` Kafka envelope and topics · `packages/jobs` RabbitMQ topology
- `packages/matching`, `packages/money`, `packages/geo` pure algorithm packages (functional core)
- `packages/catalog-adapters`, `packages/request-parser`, `packages/db` (Drizzle), `packages/ui`
- `services/forecast`, `services/request-model` (Python, uv) · `services/roadgraph` (C++17)
- `infra/compose` local services with profiles: core, events, queue, tools, console

## Commands

- Install: `pnpm install` · Services: `pnpm infra:up` (core + events + queue)
- All checks: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build`
- One package: `pnpm --filter @pulse/money test`
- Migrations: `pnpm --filter @pulse/db db:generate` then `db:migrate`
- Python: `cd services/forecast && uv sync && uv run pytest && uv run ruff check .`

## Non-negotiable rules

1. PostgreSQL is the source of truth. Never publish to Kafka from a request handler: write an `outbox_event` row in the same transaction as the change.
2. Every Kafka consumer is idempotent: insert into `processed_event (consumer, event_id)` in the same transaction as its effect.
3. Kafka is for events (facts, past tense: `TripRequested`). RabbitMQ is for jobs (commands done once: `SendPush`). Do not mix them.
4. Event schemas are add-only: never rename or remove a field.
5. `packages/matching`, `packages/money`, `packages/geo` never import database, network, `Date.now()` or unseeded randomness. Inject clocks and seeds.
6. Money is integer paisa. Splits must sum exactly to the total (use `largestRemainderSplit`).
7. Every campus-scoped table has `campus_id` and a row-level security policy.
8. Never send personal data to the Gemini free tier. Public timetable files only, through the AI gateway.
9. The grade report is parsed in the browser; the server receives only term and class IDs. Never store grades.
10. Every AI feature has a feature flag and a non-AI fallback.
11. Validate all input with Zod schemas from `packages/contracts`; reject unknown fields.

## Code style

- TypeScript strict, ESM. Relative imports end in `.js` in Node packages.
- No `any`; use `unknown` and narrow. `import type` for type-only imports.
- Small functions, explicit names. Comments explain why, not what.
- Python: type hints, Ruff. C++: C++17, warnings on.

## Testing

- Every change ships with tests at the right layer (unit, property, integration, end-to-end).
- Algorithms: property tests (fast-check) and a brute-force oracle on small inputs.
- Do not weaken or delete a test to make it pass; fix the code or ask.

## Git workflow

- Never commit to `main`. Branch: `feat/…`, `fix/…`, `chore/…`, `docs/…`.
- Conventional Commits (`feat(matching): add blossom pairing`); commitlint enforces it.
- Small pull requests (under ~400 changed lines) using the PR template; CI must be green.
- Significant decisions get an ADR (`/new-adr`).

## Working style for Claude

- For multi-file features, plan first and wait for approval.
- Explain non-obvious reasoning briefly.
- Prefer official generators (`pnpm init`, `tsc --init`, Nest/Next CLIs), then trim their output to what the repo needs.
- When a rule above blocks the obvious approach, say so instead of working around it.
