# Project structure

The code is intentionally organized by responsibility rather than framework. The full workflow remains visible in one file, and every external system sits behind one small interface.

```text
SeeIn/
├── src/
│   ├── workflow/orchestrator.ts      # The bounded end-to-end loop and concurrency
│   ├── contracts.ts                  # All validated data exchanged between phases
│   ├── ai/workflow-ai.ts             # Gemini and deterministic AI adapters
│   ├── context/
│   │   ├── context-store.ts          # Storage interface + in-memory test version
│   │   └── clickhouse-store.ts       # ClickHouse schema, retrieval, and batching
│   ├── blender/blender-driver.ts     # Qwen-MM MCP batch generation + test GLBs
│   ├── research/reference-collector.ts # Safe, cached reference-image downloads
│   ├── scene/
│   │   ├── scene-assembler.ts        # Plan -> declarative scene manifest
│   │   └── spatial-analyzer.ts       # Bounds, support, collision, scale, framing facts
│   ├── render/screenshot-driver.ts   # Persistent Playwright browser + test capture
│   ├── storage/
│   │   ├── artifact-store.ts         # Files, hashes, URLs, and future cloud seam
│   │   └── project-manager.ts        # Project folders backed by a ClickHouse index
│   ├── app.ts                        # Dependency construction and test overrides
│   ├── server.ts                     # Thin HTTP API
│   ├── cli.ts                        # Migrate, demo, and direct-run commands
│   └── config.ts                     # Environment validation and defaults
├── renderer/
│   ├── main.ts                       # Display-only Three.js renderer
│   ├── style.css
│   └── index.html
├── tests/                             # Contract, asset, spatial, cache, and workflow tests
├── docs/                              # Architecture and operating decisions
├── docker/core.Dockerfile             # Local worker image with Blender/Chromium/Xvfb
├── docker-compose.yml                 # Core + ClickHouse 26.3 LTS
└── data/
    ├── projects/                      # One isolated folder per request
    └── library/                       # Content-addressed reusable assets/references
```

## Where to change behavior

| Goal | Start here |
|---|---|
| Change the workflow order or concurrency | `src/workflow/orchestrator.ts` |
| Change what Gemini returns | `src/contracts.ts`, then `src/ai/workflow-ai.ts` |
| Add a local model/provider | Implement the relevant interface in its existing adapter file |
| Change asset reuse rules | `src/workflow/orchestrator.ts` and `src/context/clickhouse-store.ts` |
| Improve physical/spatial reasoning | `src/scene/spatial-analyzer.ts` |
| Change scene behavior or file format | `src/contracts.ts` and `renderer/main.ts` |
| Add Google Cloud Storage | Implement `ArtifactStore`; do not change the workflow |
| Move to ClickHouse Cloud | Change credentials only; the schema and adapter stay the same |
| Add a durable job runner later | Wrap `Orchestrator.run`; keep phase functions unchanged |

## Project folder produced by one request

```text
data/projects/<slug>-<id>/
├── request.json
├── research/
│   ├── brief.json
│   ├── notes.md
│   ├── sources.json
│   └── references/
├── plan/scene-plan.json
├── assets/
│   ├── index.json
│   ├── generated/
│   └── reused/
├── scene/revision-001.json
├── qa/
│   ├── spatial-revision-001.json
│   └── revision-001.json
├── renders/revision-001.png
└── logs/events.ndjson
```

A second scene and render revision exists only when QA produced a real patch. A pass does not create a duplicate revision.
