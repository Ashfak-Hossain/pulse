---
name: slice
description: Plan and build one Pulse slice (one branch, one small PR) — spec, approval, tests first, implementation, verification. Use when starting or continuing a slice from notes/slices.md.
argument-hint: '[slice id, e.g. S04, or a new slice title]'
---

Slice: $ARGUMENTS

## 1. Find or create the spec

- Look up the slice in `notes/slices.md`. If it is a new title, propose the next free id, an owner
  and where it fits in the order, and ask before adding the row.
- If `notes/slices/<id>-<kebab-name>.md` does not exist, draft it from
  `template.md` (next to this skill). Read only the docs and code the slice touches.
- Check its dependencies in `notes/slices.md` are `done`; if not, stop and say which.

## 2. Plan and wait

Show the plan: files to create or change (and which come from a generator), tests per layer,
commands to run, open decisions (with a recommendation each), and the estimated changed lines
(must stay under ~400; otherwise propose a split). For each file, ask **who writes it** — Ashfak
or Claude. **Stop and wait for approval.**

## 3. Build

1. Branch: suggest `git switch main && git pull && git switch -c <type>/<name>`; the member runs it.
2. Mark the slice `running` with its branch in `notes/slices.md`.
3. Tests first; run them and show they fail for the right reason.
4. Implement in small steps; after each step run the narrowest check
   (`pnpm --filter <pkg> test`).
5. When done, run `/verify`, then `/review`.

## 4. Close

- Write or update the easy-language notes with `/explain` for every new concept and module.
- Tick the spec's acceptance checks, with the real command output.
- Print the commit commands (Conventional Commits, one per logical step) for the member to run.
- Suggest `/pr` once the member has committed, and `/wrap` at the end of the session.
