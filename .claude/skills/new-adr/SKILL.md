---
name: new-adr
description: Create a new architecture decision record in docs/adr when the team makes a significant technical decision.
argument-hint: '[decision title]'
---

Create a new ADR for: $ARGUMENTS

1. Find the highest number in `docs/adr/` and use the next one, zero-padded to 4 digits.
2. File name: `NNNN-short-kebab-title.md`.
3. Use the same sections as the existing ADRs: title, Status (proposed), Date (today), Context, Decision, Alternatives, Consequences.
4. Keep it under one page. Ask me for any context you cannot find in the code or docs.
5. If it replaces an older ADR, mark the old one "superseded by NNNN" in a new line under its Status, and change nothing else in it.
