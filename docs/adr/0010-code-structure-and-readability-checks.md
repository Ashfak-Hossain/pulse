# 0010 — Code structure and readability checks

Status: proposed
Date: 2026-11-07

## Context

`docs/architecture.md` defines the system: a modular monolith, events, an outbox, and a pure core
with an I/O shell. Nothing defined the level below it: what a folder holds, what an entry file may
contain, or who may import whom. Two signs of that showed up in the worker: `main.ts` mixed wiring,
relay startup, broker setup and shutdown, and code shared by several features sat inside `relay/`.

The rule that algorithm packages stay pure (CLAUDE.md rule 5) and all readability were checked only
by reviewers. A dry run of strict limits flagged only 6 functions and no file, so the code is
healthy: this is about keeping it that way as three people add to it, without adding ceremony.

## Decision

Keep the current architecture and organise code by feature, under six short rules in
`docs/code-structure.md`. Enforce them with high ESLint ceilings, dependency-cruiser for import
direction and cycles, and a `readability-reviewer` agent for what tools cannot judge. When a rule
and simple code disagree, simple code wins and the rule changes.

## Alternatives

| Option                                                                    | Why not                                                                                                                           |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Clean or hexagonal folders (`domain/`, `application/`, `infrastructure/`) | Built for much larger systems; here one small feature would spread over several folders and be harder to read                     |
| Folders by kind of file (`services/`, `utils/`)                           | Changing one feature means opening many folders, and `utils/` becomes a dumping ground                                            |
| Written rules with no tools                                               | Rules that only reviewers check were already drifting                                                                             |
| `eslint-plugin-boundaries` or `import-x`                                  | Workable, but dependency-cruiser checks cycles and the whole import graph in one command, apart from ESLint's plugin versions     |
| Strict limits (50 lines per function, complexity 12)                      | Tried first. They forced splitting `jobTopology` and squeezing `main()` to satisfy a number, which made the code harder to follow |

## Consequences

- Import mistakes and oversized functions fail CI with a named rule, instead of relying on a reviewer.
- A new dev dependency (dependency-cruiser), and one more CI step that runs after packages are built.
- High ceilings will let some long functions through. That is accepted: the agent reviews whether a
  function does too many jobs, and length alone is not a problem.
- The size limits are a judgement call; change them here, with a reason, if they start to hurt.
