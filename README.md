# Pulse

Pulse is a timetable-aware commute pooling app for university campuses, piloted at AIUB: it matches students who leave campus at the same time and splits the fare fairly.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org), checked by commitlint on every commit:
`type(scope): summary`, for example `feat(money): add largest remainder split`.

| Type       | Use for                                       |
| ---------- | --------------------------------------------- |
| `feat`     | A new feature                                 |
| `fix`      | A bug fix                                     |
| `test`     | Adding or changing tests only                 |
| `refactor` | Code change that neither fixes nor adds       |
| `docs`     | Documentation only                            |
| `chore`    | Tooling and housekeeping                      |
| `build`    | Build system, dependencies, Docker, Turborepo |
| `ci`       | GitHub Actions workflows                      |

Scopes are package or app names: `money`, `db`, `api`, `worker`, `web`, `infra`. Leave the
scope out for repo-wide changes.
