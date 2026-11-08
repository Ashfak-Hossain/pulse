# Code structure

How code is organised inside each app and package, so anyone on the team can open a file and
follow it without help. `architecture.md` covers how the big pieces talk to each other; this page
covers what a folder and a file should look like. The reasons are in
[ADR 0010](adr/0010-code-structure-and-readability-checks.md).

## The six rules

1. **Folders are features.** Name a folder after what it does (`relay/`, `notifier/`, `campus/`),
   never after a kind of file (`services/`, `helpers/`, `utils/`). To change a feature, you should
   need to open one folder.
2. **An entry file reads top to bottom.** `main.ts` creates what the features need and starts them.
   The work itself goes in the feature it belongs to.
3. **The same job looks the same.** If two features do the same job, give it the same name and
   place. Never add a file just to match a neighbour.
4. **Imports go one way.** See the picture below.
5. **Files read top-down.** Exports first, then the helpers they use, so the main idea comes first.
6. **Simple wins.** One clear long function beats five small ones you must jump between. Add a file,
   wrapper or interface only when it solves a problem you have today. If a rule here makes the code
   worse, ignore the urge to work around it and change the rule.

## Where code goes

```text
apps/worker/src/
  main.ts          starts everything; imported by nobody
  lifecycle.ts     stop signals, closing connections, exiting on a fatal error
  side-by-side.ts  runs the features together; if one fails, all stop
  relay/           feature: outbox to Kafka
  notifier/        feature: Kafka to RabbitMQ jobs
  kafka/  rabbit/  how we talk to each broker
  config/          environment settings
  shared/          code at least two features use, and that knows no broker

apps/api/src/
  main.ts          starts the API
  app.module.ts    joins the modules; app.setup.ts sets up what every request goes through
  campus/ course/ fare/ health/
                   one Nest module per domain: x.module.ts, x.controller.ts, x.service.ts
                   (only the files it needs: health/ has no service)
  common/ config/ db/  used across the app
```

The relay and notifier both use `run.ts` to start and stop, and `loop.ts` to repeat their work. A
new feature uses those names if it does those jobs. A feature with no loop has no `loop.ts`.

| You are adding…                            | It goes in…                                      |
| ------------------------------------------ | ------------------------------------------------ |
| Code for one feature                       | That feature's folder, even if it looks reusable |
| Code a second feature now needs too        | `shared/`, moved in the same change              |
| Anything that talks to Kafka or RabbitMQ   | `kafka/` or `rabbit/`                            |
| Pure logic other apps need too             | A package in `packages/`                         |
| A calculation with no I/O (fares, pairing) | `packages/money`, `matching` or `geo`            |

Do not put code in `shared/` "in case": code in the wrong folder is cheap to move later, and a
`shared/` full of one-user helpers tells a reader nothing.

## Who may import whom

```text
main.ts → features → kafka, rabbit, config → shared
```

Every level may use `packages/`, except that the algorithm packages themselves import no database,
network or Node API. `lifecycle.ts` and `side-by-side.ts` are for `main.ts` only.

Worker features never import each other. If they ever need to work together, `main.ts` connects them
by passing functions. If two need the same code, it moves down a level. API modules may use a service
another module exports, because that is how Nest shares code.

## Size limits

These are high ceilings that catch a real mess, not targets. Most code should be well under them,
and being under them does not make code good.

| Limit                 | Maximum |
| --------------------- | ------- |
| Lines in a function   | 100     |
| Lines in a file       | 400     |
| Complexity (branches) | 40      |
| Nesting depth         | 10      |
| Parameters            | 10      |

Blank lines, comments and test files do not count.

When you hit one, look for a natural seam: a place where the code already does two separate things.
Never split just to get under a number. If there is no seam, raise it with the team rather than
adding `eslint-disable` on your own.

## How it is checked

| Check                                                            | Catches                                                                 | Runs in       |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------- |
| ESLint (`pnpm lint`)                                             | Size limits; `Date.now()` and `Math.random()` in the algorithm packages | CI, `/verify` |
| dependency-cruiser (`pnpm check:arch`, `.dependency-cruiser.js`) | Import cycles and imports going the wrong way                           | CI, `/verify` |
| `readability-reviewer` agent                                     | Unclear names, mixed jobs, needless layers                              | `/review`     |

A new worker folder counts as a feature automatically, so the import rules cover it from its first
file.

## Existing code

Tools enforce the size limits, and the import directions listed in `.dependency-cruiser.js`. They do
not cover everything: `lifecycle.ts` and `side-by-side.ts` have no rule, and `kafka/` could import
`rabbit/`, so reviewers watch for those.

The other rules are for new and changed code. Leave a file you are not otherwise changing as it is,
because a rewrite for style alone adds risk and review work. A mechanical edit, like a rename or a
new import path, does not count as changing it.
