---
name: verify
description: Run every Pulse check that applies to the current change and report a pass/fail table. Use after implementing anything, before /review and /pr.
---

1. Find what changed: `git diff main...HEAD --name-only` plus `git status --short`.
2. Always run, from the repo root, each as its own command so failures are attributable:
   `pnpm format:check`, `pnpm lint`, `pnpm exec eslint .` (root config files), `pnpm typecheck`,
   `pnpm test`, `pnpm build`.
3. Add when relevant:
   - `apps/api` changed → `pnpm --filter @pulse/api test:e2e`
   - `packages/db` changed → check `pnpm infra:ps` shows postgres healthy, then
     `pnpm --filter @pulse/db db:migrate` (ask before starting containers)
   - integration tests exist for a changed package → run them
4. Never "fix" a failure by weakening or deleting a test, skipping a check, or adding
   `eslint-disable`; fix the code or ask.

Report:

```
## verify — <branch>
| Check | Result | First error (if any) |
| format:check | ✅ / ❌ | file:line message |
...
Verdict: green | red (N failing)
```

For each failure give the most likely cause in one sentence and the fix you propose; apply it
only after asking who writes it.
