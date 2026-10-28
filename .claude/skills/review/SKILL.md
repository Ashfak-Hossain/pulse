---
name: review
description: Run the Pulse reviewer agents that match the changed files, in parallel, and merge their findings into one verdict. Use after /verify is green and before /pr.
---

1. Changed paths: `git diff main...HEAD --name-only` plus uncommitted files from `git status`.
2. Choose agents:

   | Agent                    | Run when                                                                                                      |
   | ------------------------ | ------------------------------------------------------------------------------------------------------------- |
   | `code-reviewer`          | always                                                                                                        |
   | `public-safety-reviewer` | always (the repo is public)                                                                                   |
   | `security-reviewer`      | `apps/`, `packages/db`, `packages/contracts`, `.github/`, any `package.json`, `pnpm-workspace.yaml`, `infra/` |
   | `migration-reviewer`     | `packages/db/`                                                                                                |
   | `events-reviewer`        | `packages/events`, `packages/jobs`, `apps/worker`, or any diff line mentioning `outbox`                       |

3. Launch the chosen agents in parallel with the Agent tool, each with the branch name and the
   slice id.
4. Merge: drop duplicates, sort blockers first, keep `file:line`.

Report:

```
## review — <branch>
Agents: code, public-safety, …
| Agent | Severity | File:line | Problem | Fix |
Verdict: ready for PR | blocked (N blockers)
```

Do not apply fixes automatically; list them and ask who writes each.
