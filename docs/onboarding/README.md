# Start here

Welcome to Pulse. This guide takes you from a blank laptop to your first merged endpoint. Nobody
expects you to know NestJS, Docker or PostgreSQL yet: every page explains its words, and the
[glossary](glossary.md) catches the rest.

## What Pulse is, in one minute

Students at AIUB leave campus at different times, and many go the same way. Pulse reads each
student's class timetable, sees who leaves at the same time towards the same area, groups them
into a shared ride, and splits the fare fairly to the paisa.

For the midterm we build the **backend only**: the API that stores campuses, students and trips,
and the background services around it. The web app (Next.js) comes after the midterm.

## The picture

```
 You (Postman, later the web app)
          │  HTTP request: GET /campuses/aiub
          ▼
 ┌─────────────────────┐      ┌──────────────────────────┐
 │ apps/api (NestJS)   │ ───► │ PostgreSQL (in Docker)   │
 │ checks the request, │ ◄─── │ the source of truth:     │
 │ asks the database,  │      │ every campus, trip, fare │
 │ answers with JSON   │      └──────────────────────────┘
 └─────────────────────┘
          │  (later) "this happened" events
          ▼
 Kafka and RabbitMQ  →  apps/worker: emails, matching, settlement   ← Ashfak builds these
```

**Your part is the box in the middle:** NestJS endpoints in `apps/api`. Ashfak builds the
database package, Kafka, RabbitMQ and the workers. You will read about them here, but you will
not need to change them.

## Read in this order

| #   | Page                                       | What you get                                                 | Time   |
| --- | ------------------------------------------ | ------------------------------------------------------------ | ------ |
| 1   | [Setup](01-setup.md)                       | Your laptop runs the API and its tests                       | 1–2 h  |
| 2   | [Repo tour](02-repo-tour.md)               | What every folder and root file is for                       | 30 min |
| 3   | [Request journey](03-request-journey.md)   | One request followed through every file it touches           | 30 min |
| 4   | [Code walkthrough](04-code-walkthrough.md) | The API's files explained line by line                       | 1 h    |
| 5   | [Add an endpoint](05-add-an-endpoint.md)   | The recipe you follow for every endpoint                     | 30 min |
| 6   | [Git and pull requests](06-git-and-prs.md) | Branch, commit, push, PR, review                             | 20 min |
| 7   | [Testing](07-testing.md)                   | The three kinds of test and how to read a failure            | 30 min |
| 8   | [Rules](08-rules.md)                       | The project rules in plain words, and which ones you hit now | 20 min |
| 9   | [Claude Code](09-claude-code.md)           | How to use the AI helpers set up for this repo               | 15 min |
| —   | [Glossary](glossary.md)                    | Every word in one place                                      | —      |

## Your first week

1. **Day 1:** pages 1–2. Done when `curl 127.0.0.1:3000/campuses` shows AIUB on your laptop.
2. **Day 2:** pages 3–4. Open each file next to the page and read it line by line.
3. **Day 3:** pages 5–8. Pick your first task from the GitHub issues labelled
   `good first issue`.
4. **Day 4–5:** build it on a branch, open a pull request, answer the review.

Your first tasks copy the campus endpoint (`apps/api/src/campus/`) almost line for line:

| Who      | Task                                                                         |
| -------- | ---------------------------------------------------------------------------- |
| Member 2 | `GET /campuses/lookup?email=…`: which campus an email address belongs to     |
| Member 2 | `POST /fares/split-preview`: split a fare between riders with `@pulse/money` |
| Member 3 | `GET /campuses/:slug/distance?lat=&lng=`: how far a point is from campus     |
| Member 3 | A `course` table and `GET /campuses/:slug/courses` (pair with Ashfak)        |

## When you are stuck

1. Read the error message to the end; the last line is often the real one.
2. Search this guide and the [glossary](glossary.md).
3. Ask in the team chat with: what you ran, what you expected, what you got (paste the text,
   not a photo).
4. Ask Ashfak to pair for 15 minutes. Being stuck for more than an hour is a reason to ask, not a
   failure.
