# Development plan (13 weeks)

The full, editable plan lives in the team's shared doc. This file is the copy that
Claude Code and new teammates read.

## Ownership

| Owner    | Owns                                                                                                                                                           |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ashfak   | Architecture, Kafka and RabbitMQ, matching and algorithms, simulator, forecast and request models (AIUB AI lab), onboarding agent, geo safety, GitHub pipeline |
| Member 2 | Auth and onboarding screens, profiles and preferences, admin panel, operator dashboard, wallet and ledger screens, safety centre                               |
| Member 3 | Catalog and grade-report import UI, week view, go now / plan / Autopilot screens, crew and trip screens, notifications UI, end-to-end and accessibility tests  |

## Build order

| Weeks        | Core (Ashfak)                                                                                          | Team                                     |
| ------------ | ------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| 1–2          | Monorepo, CI, schema, Kafka, RabbitMQ, outbox                                                          | Design system, auth and onboarding       |
| 3–4          | Matching, road distances, simulator                                                                    | Import screens and week view             |
| 5–6          | Trip lifecycle, ride modes, forecast baseline                                                          | Ride screens, crew card, trip, chat      |
| **End of 6** | **Gate: a simulated AIUB day runs end to end (import, request, match, confirm, ride, arrive, settle)** |                                          |
| 7–8          | Fair split, ledger, privacy, GPS safety                                                                | Wallet, safety centre, shuttle, operator |
| 9            | AI gateway, onboarding agent, request model                                                            | Admin panel, playground, analytics       |
| 10           | LightGBM model, shadow matching, fault-injection suite                                                 | End-to-end, accessibility, bug bash      |
| 11           | Performance and security pass                                                                          | Bug bash                                 |
| 12           | Pilot with real users and survey                                                                       | Pilot support                            |
| 13           | Buffer, report, viva preparation                                                                       | Final report                             |

Hosting for the pilot is chosen before week 10.

## Weekly rhythm

- **Sunday planning (30 min):** pick the week's issues on the GitHub Project board.
- **Daily async stand-up:** done, next, blocked.
- **Wednesday walkthrough (45 min):** one owner explains one part with its ADR.
- **End-of-week demo:** on a simulated campus day.

## Testing layers

Unit (Vitest, pytest) · property-based (fast-check) · brute-force oracles for algorithms ·
golden files for AIUB parsing · request-model accuracy vs rule-based parser ·
integration (Testcontainers: PostgreSQL, Redis, Kafka, RabbitMQ) · contract (buf, Zod) ·
end-to-end (Playwright) · fault injection (Toxiproxy, killed consumers, nightly) ·
simulator replay (nightly) · model evaluation · accessibility (axe).
