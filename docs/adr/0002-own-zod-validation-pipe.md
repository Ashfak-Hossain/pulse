# 0002 — Our own Zod validation pipe for NestJS

Status: proposed
Date: 2026-10-29

## Context

Every request body must be validated with a Zod schema from `@pulse/contracts`, and unknown
fields must be rejected (CLAUDE.md rule 11). NestJS validates through pipes; its built-in
`ValidationPipe` uses `class-validator` decorators, not Zod. The same schemas are shared with the
web app and the worker, so they must stay plain Zod.

## Decision

Write a small `ZodValidationPipe` in `apps/api/src/common/` that takes a schema, returns the parsed
value, and turns Zod issues into a `400` with `issues: [{ path, code, message }]`. Unknown fields
are rejected by the schemas themselves (`z.strictObject`), not by the pipe.

## Alternatives

| Option                          | Why not                                                                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `nestjs-zod`                    | Another dependency tracking both Nest and Zod majors; brings DTO classes and Swagger helpers we do not need yet. |
| `class-validator` DTOs          | A second way to describe the same shape; the web app and worker could not reuse it.                              |
| Validate inside each controller | Easy to forget on one route; a pipe on `@Body()` makes validation visible in the signature.                      |

## Consequences

- One error format for every endpoint, tested once (unit + e2e).
- About 25 lines we own and must keep working across Zod and Nest upgrades.
- If we add OpenAPI docs later, we generate them from the Zod schemas ourselves or revisit
  `nestjs-zod` in a new ADR.
