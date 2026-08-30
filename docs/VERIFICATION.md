# Verification

Local verification consists of:

```bash
npm run typecheck
npm test
npm run build
```

Tests cover artifact safety, configuration, diagnostics, anatomical registry validation, known-structure drift rejection, accepted placement retrieval, generated-source sandboxing, TypeScript validation, and module bundling.

A live verification additionally requires Gemini credentials and runs the full guided flow. Completion requires real Chromium PNGs, zero browser errors, all required QA views passing one revision, and an accepted entry under `data/library/anatomy`. Fixture output cannot satisfy the production contracts.
