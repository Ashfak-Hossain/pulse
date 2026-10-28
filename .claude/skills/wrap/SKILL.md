---
name: wrap
description: End-of-session wrap-up for Pulse — update the slice board, progress board, session log, learning notes, viva bank and memory, then print commit commands. Use at the end of every working session or before a context reset.
disable-model-invocation: true
---

Keep every update short and factual. Only record what was actually verified.

1. **`notes/slices.md`** (private board): set each touched slice's status, branch and PR.
   A slice is `done` only when its PR is merged.
2. **`notes/progress.md`** (private): rewrite "Now" (≤5 lines), "Next", "Blockers"; move
   finished slices to "Done" with their commit. Keep the file under ~60 lines.
3. **`notes/log/<YYYY-MM>.md`**: append one entry:
   `### <date> — <slice>` · what was done · checks run and results · decisions made ·
   problems hit and how they were solved · next step.
4. **Learning notes:** for every new concept or module this session, make sure a note exists in
   `notes/learn/` or `notes/code/` (use the `/explain` format); add new questions to
   `notes/viva/questions.md`.
5. **Decisions:** record any new decision in `notes/plan/master-plan.md` §3; if it is significant,
   suggest `/new-adr`.
6. **Memory:** update Claude's memory only for durable facts (preferences, team, hosting, scope),
   never for moving status — that lives in the files above.
7. Never touch `notes/scratch/`.

Finish with:

```
## wrap — <date>
Updated: <files>
Uncommitted: <git status summary>
Commit commands:
  git add …
  git commit -m "…"
Next session: run /prime, then <next step>
```

`notes/` is git-ignored (slice board, progress, log, learning notes), so only code appears in the commit commands.
