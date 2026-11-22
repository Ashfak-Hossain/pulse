# 0012 — Request understanding: no rule parser; the form is the fallback

Status: accepted
Date: 2026-11-20

## Context

Plan 09 §2 put a rule-based English and Banglish parser (`@pulse/request-parser`, S43) in front
of a trained model. The rules would be the non-AI fallback (CLAUDE.md rule 10) and the baseline
the model must beat (objective O3). PR #69 built it: spelling variants, a place list with H3
cells, and patterns for direction, time, gender, wait and modes.

Hand-written word rules for typed Banglish are a moving target. Spellings vary without limit,
every new phrase needs a new rule, and a model is planned to do this job anyway. We don't want
to keep a second language engine just to have something to fall back on.

Free text was never the only way in. `POST /requests` takes structured fields, and the web app
shows a parsed request as chips the rider edits before confirming (plan 10 §6). The AI's whole
job is to pre-fill that form.

## Decision

No typed-language rules. Free-text request understanding is an AI-only feature behind
`ai.request_model`. When the flag is off, the model fails or its confidence is low, the rider
fills the structured request form themselves. That form is the non-AI fallback.

From PR #69 we keep what any model needs: the output contract (`parsedRequestSchema` in
`@pulse/contracts`), the AIUB place list with H3 cells and an exact name lookup (a model names
a place, code turns the name into a cell), and the hand-labelled golden sentences as the start of
the test set. `POST /requests/parse` (PR #70) waits for the model.

Two things are decided when the model slice starts: which model to use (the plan's fine-tuned
encoder exported to ONNX, or a small local LLM), and the fixed accuracy target that replaces
"beats the rules" in O3. Any model runs locally: request text is personal data and never goes to
Gemini (rule 8).

## Alternatives

| Option                                    | Why not                                                                                                       |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Keep the rule parser (plan §2.2)          | A second language engine to maintain; Banglish spellings never stop growing.                                  |
| Drop all of PR #69                        | The contract, the place list and the labelled sentences are needed by any model; we would rebuild them later. |
| Gemini for parsing until a model is ready | Request text is personal data (rule 8).                                                                       |
| Pick the model now                        | Nothing depends on it yet; the choice is better made with training data and latency numbers in hand.          |

## Consequences

- Until the model ships, riders use the form only; there is no free-text box.
- O3 for request understanding becomes "meets a fixed field accuracy on unseen human-written
  sentences" instead of "beats the rules". The target is set and recorded with the model.
- The rule-10 e2e check for this feature is "flag off → the form works, nothing is pre-filled".
- `@pulse/request-parser` stays a pure package (no tokeniser): contract helpers, place list and
  lookup, and later the post-processing shared by whichever model wins.
- Plan 09 §2, plan 12 (S43), plan README, `docs/architecture.md` and `docs/development-plan.md`
  are updated to match.
