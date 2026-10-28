---
paths:
  - 'packages/db/**'
---

# Database

- Change the schema in `src/schema.ts`, then `pnpm --filter @pulse/db db:generate`; never edit an applied migration.
- Every campus-scoped table has `campus_id` and a row-level security policy.
- Money columns are integer paisa (`*_paisa`). Timestamps are `timestamptz`.
