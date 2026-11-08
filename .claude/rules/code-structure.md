---
paths:
  - 'apps/**'
  - 'packages/**'
---

# Code structure

Full rules and reasons: `docs/code-structure.md`.

- Folders are features, never kinds of file. No `utils/`, `helpers/` or `services/` folders.
- Entry files (`main.ts`) only create what the features need and start them. Logic goes in its feature.
- The same job looks the same: `run.ts` starts a worker feature, `loop.ts` repeats its work; an API module has `x.module.ts`, `x.controller.ts`, `x.service.ts`. Never add a file just to match.
- Imports go one way: `main` → features → `kafka`, `rabbit`, `config` → `shared`. Worker features never import each other; API modules may use a service another module exports.
- `shared/` holds only code at least two features already use. Move it there in the change that adds the second user.
- Files read top-down: exports first, helpers below.
- Simple wins: one clear long function beats five small ones to jump between. Add a file, wrapper or interface only for a problem you have today.
- High ceilings, not targets: 100 lines per function, 400 per file, complexity 40, depth 10, 10 parameters. Never split just for the number. No `eslint-disable` without asking.
- Name by what a call site can see: a generic word (`createConsumer`) needs its technology when more than one could apply (`createKafkaConsumer`).
- Check with `pnpm check:arch` and `pnpm lint`.
