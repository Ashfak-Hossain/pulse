---
paths:
  - 'apps/api/**'
---

# API (NestJS)

- One NestJS module per domain area; modules talk through services, not each other's repositories.
- Validate every request body with a Zod schema from `@pulse/contracts`; reject unknown fields.
- Guards check role and campus on every route; record ownership is checked in the service.
- Writes that other services care about add an outbox row in the same transaction.
