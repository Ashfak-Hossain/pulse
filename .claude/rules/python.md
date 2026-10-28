---
paths:
  - 'services/**/*.py'
---

# Python services

- Managed with uv; type hints everywhere; Ruff for lint and format.
- Evaluate on held-out data split by time, never randomly.
- Never commit raw user data or model weights; models are exported to ONNX for NestJS.
