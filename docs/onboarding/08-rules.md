# 8. Rules, in plain words

The project has a short list of rules that never bend (this page is the team's shared copy;
Claude Code reads the same rules from `CLAUDE.md`). Each one exists because breaking it causes a bug that is hard to find later.
The last column says whether you will meet it in your first tasks.

## The non-negotiable rules

| #   | Rule                                                                                                                                  | Why                                                                                                                 | You now?                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 1   | PostgreSQL is the source of truth. Never publish to Kafka from a request handler: write an `outbox_event` row in the same transaction | If the API wrote the data but crashed before telling Kafka (or the other way round), the two would disagree forever | Later                                            |
| 2   | Every Kafka consumer is idempotent: it records `(consumer, event_id)` in `processed_event` with its effect                            | Kafka may deliver a message twice; doing the work twice (two emails, two charges) is a bug                          | No                                               |
| 3   | Kafka is for events (facts, past tense: `TripRequested`). RabbitMQ is for jobs (commands done once: `SendPush`)                       | Different tools for different jobs; mixing them makes both harder to reason about                                   | No                                               |
| 4   | Event schemas are add-only: never rename or remove a field                                                                            | Old events stay in Kafka; a renamed field breaks every reader of the old ones                                       | No                                               |
| 5   | `packages/matching`, `money`, `geo` never touch the database, network, `Date.now()` or unseeded randomness                            | Pure functions are easy to test and give the same answer every time                                                 | Fare task: you call `money`, you don't change it |
| 6   | Money is integer **paisa** (1 taka = 100 paisa). Splits must add up exactly (`largestRemainderSplit`)                                 | Decimals (`0.1 + 0.2 = 0.30000000000000004`) lose paisa; riders' shares must equal the fare                         | **Yes (M2 fare task)**                           |
| 7   | Every campus-scoped table has `campus_id` and a row-level security policy                                                             | One campus must never see another campus's data, even if a query forgets a `where`                                  | **Yes (M3 course task)**                         |
| 8   | Never send personal data to the Gemini free tier                                                                                      | The free tier may use inputs for training                                                                           | No                                               |
| 9   | The grade report is parsed in the browser; the server gets only term and class IDs. Never store grades                                | Grades are sensitive; not having them means they cannot leak                                                        | No                                               |
| 10  | Every AI feature has a feature flag and a non-AI fallback                                                                             | The app must work when the AI is down or wrong                                                                      | No                                               |
| 11  | Validate all input with Zod schemas from `packages/contracts`; reject unknown fields                                                  | Bad input is stopped at the door with a clear 400, not deep inside with a 500                                       | **Yes, every endpoint**                          |

## Rules for every endpoint you write

These came out of code reviews of the first endpoints. Follow them from day one.

1. **Contract first.** Request and response schemas go in `packages/contracts`, as
   `z.strictObject(...)` (unknown fields are rejected). The response is the contract, not the
   database row: map the row in the service (`toCampus` in `campus.service.ts` is the example).
2. **Controller = HTTP only.** It validates with `ZodValidationPipe` and calls the service. No
   queries and no business logic in the controller.
3. **Errors:** throw Nest's exceptions (`NotFoundException('Campus not found')`). The global
   error filter turns them into `{ statusCode, error, message }`. Write your own 4xx messages;
   never copy a lower layer's error text (a database error can contain other people's data).
4. **Wrapping an error:** `new Error('could not save the trip', { cause: error })`. Never put
   `error.message` inside your new message.
5. **Lists:** every list has a hard limit (`.limit(…)`) and a stable order that ends on a unique
   column (`orderBy(asc(campus.name), asc(campus.slug))`). Return `{ items: [...] }`, never a
   bare array.
6. **Public or not:** there is no sign-in yet. A route may be public only if its data is public
   (campuses are). Anything with personal data waits for the auth guard.
7. **Campus-scoped tables** are read and written only inside `withCampus(db, campusId, tx => …)`.
   Outside it, row-level security shows no rows at all.
8. **No personal data in URL paths** (emails, phone numbers, student IDs): server error logs
   print the path. Use slugs or UUIDs in paths; an email goes in a query string or body.
9. **Tests ship with the code** (unit for logic, e2e for the endpoint), and Postman gets a request
   with tests and a saved example. See [Testing](07-testing.md).
10. **e2e tests share one database** and test files run at the same time, so each test file
    creates its own rows with unique slugs (`aiub-${run}`) and checks only its own rows.

## Code style

- TypeScript strict, ESM. Relative imports end in `.js` (`'./campus.service.js'`), even though the
  file is `.ts`: Node needs the name of the compiled file.
- No `any`. If you really don't know a type, use `unknown` and narrow it with checks.
- `import type { … }` for things used only as types. But a class you inject in a constructor
  (`CampusService`) is imported normally: Nest needs the real class at runtime.
- Small functions, clear names. Comments explain **why**, not what the next line does.
- Don't weaken or delete a test to make it pass. Fix the code, or ask.

## Git rules

- Never commit to `main` (you can't push it anyway). One branch per task.
- Conventional Commits for every commit and PR title.
- PRs under about 400 changed lines, with the template filled in, and CI green.
- Never commit `.env`, real passwords or personal data. The repository is public.
