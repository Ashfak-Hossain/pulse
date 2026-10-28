---
name: prime
description: Start-of-session briefing for Pulse — slice history, what is running, what is next, git state and blockers. Use at the start of every session or after a context reset.
---

Build a short briefing. Read only what is listed; do not read source code.

1. `notes/slices.md` — the slice table.
2. `notes/progress.md` if it exists (private; teammates may not have one).
3. The newest entry of the newest file in `notes/log/` if it exists (the last session).
4. If the running slice has a spec in `notes/slices/`, read its "Acceptance checks" section only.
5. Git: `git branch --show-current`, `git status --short | head -20`,
   `git log --oneline -5`, and `git rev-list --left-right --count main...HEAD` (ahead/behind).
6. If `gh` is logged in and a remote exists: `gh pr list --limit 5` (skip silently otherwise).

Then print exactly this layout, nothing longer than ~30 lines:

```
## Pulse — <date>
Branch <name> · <N> ahead / <M> behind main · working tree <clean | N changes>

Done     S01 …, S02 …              (last 3, newest last)
Running  Sxx <title> — <owner> — <branch>
Next     Syy <title> — <owner>
Blocked  <slices or "none">

Last session: <one line from the log>
Next step:    <the single next concrete action>
Watch out:    <blockers, failing checks, uncommitted work on main, or "nothing">
```

If the current branch does not match the running slice, or there are uncommitted changes on
`main`, say so under "Watch out". End by asking whether to continue with the next step.
