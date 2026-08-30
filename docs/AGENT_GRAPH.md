# Agent graph

The resumable graph is:

```text
clarify intent
  -> wait for surgeon answers
  -> plan evidence questions
  -> run three grounded perspectives + reference discovery
  -> synthesize and audit the dossier
  -> wait for evidence approval
  -> generate/compile module
  -> render and inspect all required views
  -> wait for quality review or surgeon feedback
```

A checkpoint is written at every node. Resume can reuse cached research or explicitly bypass caches. User revision feedback starts a linked project so the original evidence and accepted result remain auditable.
