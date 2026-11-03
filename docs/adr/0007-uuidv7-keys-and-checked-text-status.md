# 0007 — UUIDv7 keys and `text` + `CHECK` status columns for new tables

Status: accepted
Date: 2026-11-03

## Context

About seventy tables are coming (`docs/plan/03-data-model.md`), starting with the catalog (S30)
and auth (S28). Two choices repeat in every one of them: how a row gets its id, and how a column
with a fixed set of values (`status`, `type`, `kind`) is stored. Deciding once keeps migrations
and reviews consistent. These are D16 and D17 in `docs/plan/13-decisions-and-risks.md`.

Today `campus` and `course` use `gen_random_uuid()` (UUID v4, fully random). PostgreSQL 18, which
our image runs, has a built-in `uuidv7()`: the first 48 bits are a millisecond timestamp.

## Decision

New tables use `uuid` primary keys with `default uuidv7()` (in Drizzle:
``uuid('id').primaryKey().default(sql`uuidv7()`)``). Columns with a fixed set of values are
`text` with a named `CHECK (col in (…))` constraint, mirrored by a `z.enum` in
`@pulse/contracts`. `campus` and `course` keep their v4 ids.

## Alternatives

| Option                  | Why not                                                                                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| UUID v4 everywhere      | Random ids land on random index pages: bigger, slower B-trees on busy tables (`location`, `message`, `outbox_event`) |
| `bigint` identity keys  | Guessable and sequential across campuses; ids would leak row counts and could not be made before the insert          |
| PostgreSQL `enum` types | A value can be added but not removed or renamed; changing one needs a new type and a column rewrite                  |
| `text` with no check    | A typo (`'actve'`) is stored silently; only the API would guard the values                                           |

## Consequences

- Ids sort by creation time, so `order by id` is a cheap stable tie-breaker and new rows append
  to the end of the index.
- An id reveals roughly when its row was made. Nothing in Pulse treats creation time as secret.
- Two id kinds live side by side; nothing may assume an id's version.
- Changing an allowed value is one migration that drops and re-adds the named check, plus the
  matching `z.enum` change in the same PR.
- The migration reviewer checks both rules on every new table.
