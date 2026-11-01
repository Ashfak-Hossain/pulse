---
paths:
  - '**/*.md'
---

# Diagrams (Mermaid in Markdown)

GitHub shows Markdown in a column about 880 px wide and shrinks any wider diagram to fit, so
wide diagrams end up with tiny text. Write diagrams for that column.

- **Vertical first**: `flowchart TB`. Use `LR` only for 2–4 small nodes in a row.
- **Size**: natural width ≤ 880 px (never shown below 75%); height ≤ 1,600 px. Too big → split
  into two diagrams with a one-line caption each, never cram.
- **Labels**: ≤ 28 characters per line inside a node (break with `<br/>`), ≤ 20 on an edge.
  Put long explanations in the text or a table, not in the diagram.
- **Flowcharts**: ≤ 14 nodes. Quote labels with punctuation: `A["Step 1: load"]`. A label must
  not start with `1. ` (GitHub shows "Unsupported markdown: list"); write `Step 1:`.
- **Sequence diagrams**: ≤ 5 participants (merge minor ones, e.g. "Mail job" for queue +
  worker); messages ≤ 48 characters; no `;` in a message (it ends the line). A long self-message
  becomes `Note over X: …`; extra detail goes in a `Note`.
- **ER diagrams**: ≤ 10 relationships and ≤ 4 children on one hub (a hub with many children
  spreads sideways); split by sub-domain.
- **Journeys and Gantt**: `journey` only grows sideways, so use a TB flowchart for long journeys.
  In `gantt` a task name must not contain `:` (it separates the name from the dates).
- **Subgraphs**: link nodes inside them, not the subgraphs themselves (subgraph-to-subgraph
  links turn a vertical layout sideways). Avoid an edge passing through a subgraph title.
- **Colour**: default theme. If you highlight with `classDef`, use a fill with white text, which
  reads in light and dark mode.

Check before committing: `node .claude/tools/mermaid-check.mjs <files or folders>` (renders with
the installed Chrome, reports size on GitHub and rule breaks, writes PNGs to look at). The
`diagram-reviewer` agent runs it and also looks at the pictures.
