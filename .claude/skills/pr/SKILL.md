---
name: pr
description: Open a pull request for the current Pulse slice using the PR template, after verify and review are green. Use when a slice is committed and ready to merge.
disable-model-invocation: true
---

1. Refuse on `main`. Require a clean working tree (everything committed by the member).
2. Make sure `/verify` and `/review` ran green on the current `HEAD`; if not, run them first.
3. Check commit messages on the branch follow Conventional Commits:
   `git log --format=%s main..HEAD`.
4. Draft the PR from `.github/pull_request_template.md`: title = Conventional Commit summary of the
   slice (`feat(money): add largest remainder split`). Body: **Summary** (1–2 sentences, slice id),
   **Changes** (3–6 bullets, one line each), **Testing** (what ran and what it proved),
   **Notes for reviewers** (size if over ~400 lines per `git diff --stat main...HEAD`, hand edits,
   deferred work, setup after merge; omit if empty), **Checklist**. Keep it short: details belong
   in the ADR or the code, not the PR body.
5. Show the title and body and **ask before pushing** — pushing publishes to a public repo.
6. On approval: `git push -u origin HEAD`, then `gh pr create --title … --body-file …`.
   Print the PR URL and run `gh pr checks --watch` if asked.
7. Update the slice row in `notes/slices.md` with the PR number (status stays `running` until
   merged).
