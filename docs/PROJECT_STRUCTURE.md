# Project structure

The code is intentionally organized by responsibility rather than framework. The full workflow remains visible in one file, and every external system sits behind one small interface.

```text
SeeIn/
├── src/
│   ├── workflow/
│   │   ├── orchestrator.ts           # Graph nodes, interrupts, generation, and bounded QA
│   │   ├── graph-contracts.ts        # Intent, questions, evidence, notes, feedback, checkpoints
│   │   └── graph-state.ts            # Deterministic edges, progress guide, readiness gate
│   ├── contracts.ts                  # All validated data exchanged between phases
│   ├── ai/workflow-ai.ts             # Gemini and deterministic AI adapters
│   ├── context/
│   │   ├── context-store.ts          # Storage interface + in-memory test version
│   │   └── clickhouse-store.ts       # ClickHouse schema, retrieval, and batching
│   ├── blender/blender-driver.ts     # Qwen-MM MCP batch generation + test GLBs
│   ├── research/reference-collector.ts # Safe, cached reference-image downloads
│   ├── scene/
│   │   ├── geometry-bounds.ts        # Parse GLB accessors/node transforms and recipe bounds
│   │   ├── scene-assembler.ts        # Plan -> manifest + typed refinement patches
│   │   └── spatial-analyzer.ts       # Measured support, collision, scale, framing facts
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
| Change graph edges, readiness, or progress steps | `src/workflow/graph-state.ts` |
| Change a graph node or its concurrency | `src/workflow/orchestrator.ts` |
| Change interaction/research contracts | `src/workflow/graph-contracts.ts`, then `src/ai/workflow-ai.ts` |
| Change scene/QA contracts | `src/contracts.ts`, then the relevant adapter |
| Add a local model/provider | Implement the relevant interface in its existing adapter file |
| Change asset reuse rules | `src/workflow/orchestrator.ts` and `src/context/clickhouse-store.ts` |
| Change GLB measurement or recipe bounds | `src/scene/geometry-bounds.ts` |
| Improve physical/spatial reasoning | `src/scene/spatial-analyzer.ts` |
| Change allowed refinement patches | `src/contracts.ts` and `src/scene/scene-assembler.ts` |
| Change scene behavior or file format | `src/contracts.ts` and `renderer/main.ts` |
| Add Google Cloud Storage | Implement `ArtifactStore`; do not change the workflow |
| Move to ClickHouse Cloud | Change credentials only; the schema and adapter stay the same |
| Add a durable job runner later | Wrap graph-node execution; preserve `WorkflowGraphState` and node contracts |

## Project folder produced by one request

```text
data/projects/<slug>-<id>/
├── request.json
├── graph/
│   ├── state.json                         # latest resumable checkpoint
│   └── checkpoints/0001-clarify-intent.json
├── research/
│   ├── intent.json
│   ├── agenda.json
│   ├── dossier.json
│   ├── readiness.json
│   │   ├── visual-identity.json
│   │   ├── objects-materials.json
│   │   └── scale-space.json
│   ├── brief.json
│   ├── notes.md
│   ├── sources.json
│   └── references/
├── plan/scene-plan.json
├── plan/scene-plan-revision-002.json       # only after asset regeneration
├── assets/
│   ├── index.json
│   ├── index-revision-002.json             # only after asset regeneration
│   ├── generated/revision-001/
│   └── reused/revision-001/
├── scene/revision-001.json
├── qa/
│   ├── spatial-revision-001.json
│   └── revision-001.json
├── renders/revision-001.png
├── feedback/revision-NNN.json
└── logs/events.ndjson
```

A later scene and render revision exists only when QA produced a real patch. Each generated/reused asset copy lives under its revision so geometry evidence remains attributable and a repair cannot overwrite the prior GLB. A pass does not create a duplicate revision, but every final render has a corresponding `qa/revision-NNN.json` inspection. Feedback files and graph checkpoints make human decisions just as attributable as generated geometry.
