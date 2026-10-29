---
name: explain
description: Write or update an easy-language explanation note in notes/ for a Pulse file, module, flow or concept (NestJS, Kafka, RabbitMQ, outbox…). Use when a slice adds something new or the member asks how something works.
argument-hint: '[file path, module, flow or concept]'
---

Explain: $ARGUMENTS

1. Pick the target note:
   - a concept (Kafka, dependency injection, RLS…) → `notes/learn/NN-topic.md` (see the table in
     `notes/README.md`)
   - our code (a file or module) → `notes/code/<area>.md` (`api`, `db`, `worker`, `events`, `jobs`)
   - an end-to-end path → `notes/flows/<name>.md`
     Update the existing section if there is one; never duplicate.
2. Read the real code involved and link to it with relative paths and line numbers.
3. Write for a student who has never seen the topic, in this structure:
   1. **In plain words** — 2–4 sentences, no jargon; define each technical word on first use.
   2. **Analogy** — one everyday comparison, and where it stops being accurate.
   3. **Picture** — a small text diagram of the parts and the data flow.
   4. **In Pulse** — which files, what each one does, how a request or message moves through them,
      step by step.
   5. **Why we did it this way** — the decision and the alternative we rejected.
   6. **Common mistakes** — and the error message you would see.
   7. **Try it** — one command or experiment that shows it working.
   8. **Viva** — 3 questions with short answers; also add them to `notes/viva/NN-topic.md` (same number as the `learn/` note; heading per question, answer in `<details>`) and list the file in `notes/viva/README.md`.
4. Short paragraphs, tables over prose for comparisons. No copy-paste of large code blocks:
   quote at most the 5–10 lines that matter.
5. Never write in `notes/scratch/`. If `notes/` does not exist (a teammate's machine), create
   the folder structure from `notes/README.md`'s table first.
