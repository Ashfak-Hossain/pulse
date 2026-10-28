---
paths:
  - 'packages/matching/**'
  - 'packages/money/**'
  - 'packages/geo/**'
---

# Algorithm packages

- Pure functions only: no I/O, no `Date.now()`, no `Math.random()`. Take time and seeds as parameters.
- Deterministic tie-breaking (sort by a stable key), so replaying a day gives identical results.
- Every algorithm gets: unit tests with worked examples, a fast-check property test of its invariants, and a brute-force oracle test on small inputs.
- State the time complexity in the doc comment of each exported function.
