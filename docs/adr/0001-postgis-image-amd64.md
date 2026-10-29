# 0001 — Official PostGIS image under amd64 emulation

Status: proposed
Date: 2026-10-29

## Context

Pulse needs PostgreSQL with PostGIS locally (`infra/compose`) and in CI. The team develops on
Apple Silicon (arm64) laptops with 8 GB of RAM; GitHub-hosted runners are amd64. The official
`postgis/postgis:18-3.6` image is published for amd64 only (checked 2026-10-29).

## Decision

Use the official `postgis/postgis` image everywhere, with `platform: linux/amd64` in Compose, so
Apple Silicon runs it under Rosetta.

## Alternatives

| Option                                       | Why not                                                                                  |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `imresamu/postgis` (native arm64 build)      | Community-maintained and marked experimental; local would run a different build than CI. |
| `postgres` image + install PostGIS ourselves | A Dockerfile to maintain and rebuild for every PostGIS release.                          |
| Homebrew PostgreSQL on the laptop            | Versions drift between members; not reproducible; nothing like CI.                       |

## Consequences

- Local and CI run the same image, so a migration that works on a laptop works in CI.
- First start and heavy queries are slower under emulation; the Compose health check allows a
  30 s start period. Acceptable for development data sizes.
- Revisit when an official arm64 image is published: drop the `platform` line in a new ADR.
