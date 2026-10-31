# 6. Git and pull requests

`main` is locked: nobody, not even Ashfak, can push to it. Every change reaches `main` through a
**pull request (PR)** that CI has checked and Ashfak has approved. This page is the whole loop.

```
main ──●────────────────────────────●──── (squash merge: your PR becomes one commit)
        \                          ↗
         ●── commit ── commit ── PR ── CI green ── Ashfak approves
         your branch: feat/campus-lookup
```

## 1. Start from the latest `main`

```sh
git switch main
git pull
git switch -c feat/campus-lookup
```

Branch names: `feat/…` (new feature), `fix/…` (bug), `docs/…`, `chore/…`. Short and
lowercase with hyphens. One branch = one task = one PR.

## 2. Work in small commits

```sh
git status                 # what changed
git diff                   # the changes themselves
git add packages/contracts # stage what belongs in this commit
git commit -m "feat(contracts): add the campus lookup schemas"
```

**Commit messages follow Conventional Commits**: `type(scope): summary`.

| Part      | Rule                                                                      | Example                      |
| --------- | ------------------------------------------------------------------------- | ---------------------------- |
| `type`    | `feat` `fix` `test` `refactor` `docs` `chore` `build` `ci`                | `feat`                       |
| `(scope)` | The package or app: `api`, `contracts`, `db`, `money`, `infra`            | `(api)`                      |
| `summary` | Lowercase, imperative ("add", not "added"), no full stop, under ~70 chars | `add campus lookup by email` |

Two hooks run on every commit:

- **before:** `pnpm format:check`. If it fails, run `pnpm format` and commit again.
- **after you write the message:** commitlint. If it fails, the message breaks the rules above.

## 3. Check before you push

```sh
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e && pnpm build
```

The same checks run in CI. Running them first saves a round trip.

## 4. Push and open the PR

```sh
git push -u origin feat/campus-lookup
```

Then open the PR: the easiest way is the link the push prints ("Create a pull request for …").
GitHub fills the body with the template. With the GitHub CLI, give the title yourself:

```sh
gh pr create --base main --title "feat(api): add campus lookup by email"
```

(it opens your editor with the template for the body).

**Title:** a Conventional Commit, because the squash merge turns it into the one commit on
`main`: `feat(api): add campus lookup by email`. CI checks it.

**Body:** fill in the template:

- **Summary:** one or two sentences and the issue it closes (`Closes #12`).
- **Changes:** 3–6 bullets.
- **Testing:** what you ran and what it proved ("e2e: unknown domain answers 404").
- **Notes for reviewers:** anything surprising; delete if empty.
- **Checklist:** tick honestly.

Add labels: `enhancement` and an area (`area: api`). Keep PRs under about 400 changed lines; a
bigger task becomes two PRs.

## 5. CI and review

- CI runs on every push to the PR. A red check shows its log: click **Details**, scroll to the
  first red line.
- Ashfak reviews. Comments are about the code, not about you. Reply to each one: fix it and say
  "done", or explain why not. Then press **Resolve conversation**: `main` only accepts a PR whose
  review threads are all resolved.
- Push more commits to the same branch to answer review; the PR updates itself.
- When CI is green and the PR is approved, it is **squash-merged** and the branch is deleted on
  GitHub automatically.

## 6. After the merge

```sh
git switch main
git pull
git branch -D feat/campus-lookup   # delete your local copy
```

Capital `-D`: a squash merge creates a new commit, so git thinks your branch was "not fully
merged" and `-d` refuses. It is safe once GitHub shows the PR as **Merged**.

## When git surprises you

| Situation                                        | What to do                                                                                                                        |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `main` moved while you worked                    | `git switch main && git pull && git switch - && git merge main`, fix conflicts, commit                                            |
| A merge conflict (`<<<<<<<` in a file)           | Keep the right lines, delete the markers, `git add` the file, `git commit`                                                        |
| You committed to `main` by accident              | Don't push. `git switch -c feat/rescue` (keeps the commit), then `git switch main && git reset --hard origin/main`. Ask if unsure |
| You want to undo uncommitted changes in one file | `git restore path/to/file` (they are gone for good)                                                                               |
| The commit hook says formatting is wrong         | `pnpm format`, `git add` again, commit again                                                                                      |
| You committed a secret (`.env`, a password)      | Tell Ashfak at once. Deleting it in a new commit is not enough                                                                    |

Never `git push --force` to a shared branch, and never commit `.env`, real passwords or personal
data. The repository is public.
