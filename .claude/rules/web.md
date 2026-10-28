---
paths:
  - 'apps/web/**'
  - 'packages/ui/**'
---

# Web (Next.js PWA)

- Every screen has loading, empty and error states, and passes an axe accessibility check.
- Mobile first; installable PWA. English interface.
- The browser only calls `/api/*` on the Next.js server (no direct calls to NestJS).
- The grade report is parsed in the browser with pdf.js; send only term and class IDs.
