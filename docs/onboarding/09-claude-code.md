# 9. Claude Code in this repo

[Claude Code](https://docs.claude.com/en/docs/claude-code/overview) is an AI assistant that works
in your terminal or VS Code. This repo is set up for it: it knows our rules, has reviewers for
our kind of code, and has guard rails that stop it doing dangerous things. Using it is optional;
the rules apply whether code is written by you or by it.

## What is set up

| Path                   | What it does                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE.md`            | Read at the start of every session: the project, commands, the 11 rules, code style, git. Git ignores it (kept per machine): ask Ashfak for the team copy and put it in the repo root |
| `docs/architecture.md` | Read before larger changes                                                                                                                                                            |
| `.claude/rules/`       | Extra rules per area (`api.md`, `db.md`, …), loaded when Claude works on those files                                                                                                  |
| `.claude/agents/`      | Reviewers: code, security, public safety, migrations, events                                                                                                                          |
| `.claude/skills/`      | Commands you type, like `/verify` (below)                                                                                                                                             |
| `.claude/hooks/`       | Guard rails: no commit or push on `main`, no force push, no edits to `.env` files or merged migrations; formats every file it writes                                                  |

## Commands

| Command           | What it does                                                                                | When                          |
| ----------------- | ------------------------------------------------------------------------------------------- | ----------------------------- |
| `/verify`         | Runs format, lint, typecheck, test, build (and e2e when the API changed); a pass/fail table | After you change code         |
| `/review`         | Runs the reviewers that fit your changes and merges their findings                          | After `/verify` is green      |
| `/pr`             | Drafts the PR title and body from the template                                              | When your branch is committed |
| `/explain`        | Writes an easy explanation of a file or concept into your `notes/`                          | When something is unclear     |
| `/slice`          | Plans and builds one task: spec, tests first, code, checks                                  | Starting a task               |
| `/prime`, `/wrap` | Start-of-session briefing and end-of-session wrap-up                                        | Each session                  |
| `/new-adr`        | Writes an Architecture Decision Record                                                      | Rarely; ask Ashfak first      |

`/prime`, `/slice` and `/wrap` read and write a private `notes/` folder (git ignores it). To use
them, create your own: `mkdir -p notes/slices notes/log` and a `notes/slices.md` with a table of
your tasks. Your notes stay on your laptop.

## Good habits

- **Ask it to explain before it writes.** "Explain `withCampus` with an example" teaches you more
  than code you did not read.
- **Read every line it writes before you commit.** You are the author of your PR; in review you
  must be able to explain each line.
- **Give it the task and the rule.** "Add `GET /campuses/lookup?email=` following
  docs/onboarding/05-add-an-endpoint.md; write the e2e test first" works better than "make the
  lookup endpoint".
- **Let the checks decide.** Run `/verify` (or the commands yourself). If it says green but you
  did not see the output, run them again.
- **Never paste secrets** (passwords, tokens, `.env` contents) into a prompt.
- If it suggests weakening a test, breaking a rule or committing to `main`, say no: the rules in
  `CLAUDE.md` and [Rules](08-rules.md) win.
