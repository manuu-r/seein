# Architecture

## Boundary

The backend owns every decision and side effect. The frontend receives a versioned scene manifest, loads GLBs, interprets a bounded procedural construction program, and displays labels, highlights, orbit controls, and declarative transitions. State mutations are constrained to transform and opacity fields and transition edges carry normal/alternative/complication semantics; the frontend only interprets them. It has no Gemini, ClickHouse, research, Blender, or workflow credentials.

```text
prompt -> checkpointed backend graph
  -> Gemini clarification -> wait for typed answers
  -> Gemini intent + three-perspective research agenda
  -> visual identity || objects/materials || scale/space research || reference-image search
  -> synthesis + deterministic evidence gate -> wait for approval
  -> ClickHouse procedural-component + GLB retrieval
  -> Gemini declarative construction plan from approved dossier and reusable components
       ├─ reference downloads || evidence artifact writes
       └─ bulk ClickHouse asset lookup
            -> one Qwen-MM Blender batch for all missing GLBs
  -> manifest + shared-builder geometry facts + invariant results
  -> for every required state/view at the current revision:
       Three.js/Playwright render -> Gemini inspection
       -> zero or one validated patch -> invalidate prior passes -> restart target matrix
  -> score recognizability/domain/visual/construction quality
  -> local fix, rerender, targeted research, or reconstruction replan
  -> all targets pass at one revision, or checkpoint as quality-blocked when a safety budget expires
  -> wait for acceptance/revision feedback
```

## Local services

| Component | Responsibility | Persistent data |
|---|---|---|
| Core API | Workflow, HTTP API, manifest delivery | Project folders |
| ClickHouse | Graph checkpoints, preferences, phase caches, project index, assets, scene graph, spatial facts, runs, revisions, QA | Docker volume |
| Qwen-MM Blender MCP | Safe access to a running Blender instance | Shared artifact volume |
| Blender + Xvfb | Geometry, materials, GLB export | Shared artifact volume |
| Chromium | Render fidelity and screenshots | Screenshots in project folders |
| Gemini API | Research synthesis, planning, multimodal QA | Only provider outside the host |

The Gemini adapter assigns models by capability. [`gemini-3.7-flash`](https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash) is the current GA default for clarification, grounded web research, structured synthesis and planning, and multimodal screenshot inspection. A separate [`gemini-3.1-flash-image`](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-image) node performs Google Image Search because it is the current GA model for that search type. The four research calls run concurrently, then join before synthesis. This also avoids asking the image model for unsupported structured JSON output.

The cold path separates intent, research, and scene planning so an attractive early guess cannot become geometry before the evidence gate. Grounding chunks, claim-support indices, reference-image chunks, queries, and Google's required rendered search attribution are bound into validated artifacts so findings and references retain provenance. The renderer displays the attribution markup in an isolated sandboxed frame; it does not call Gemini.

## Portability seams

The core depends on interfaces rather than deployment products:

- `ArtifactStore`: local disk now, Google Cloud Storage later.
- `ContextStore`: ClickHouse locally and in ClickHouse Cloud using the same schema.
- `WorkflowAI`: Gemini in production, deterministic fixture provider in tests.
- `BlenderDriver`: Qwen-MM MCP in production, valid minimal GLBs in tests.
- `ScreenshotDriver`: Playwright in production, deterministic placeholder image in tests.
- Graph executor: explicit TypeScript nodes/checkpoints locally, durable worker runtime later without changing state contracts.

## Container image

The production core image includes Blender, Chromium, Xvfb plus its required `xauth` helper, Blender-Python's `numpy` and `requests` dependencies, `uv`/`uvx`, and the Qwen-MM Blender capability pinned to `qwen-mm-plugins-blender-v1.0.1`. Blender is installed from the Debian image repository rather than downloaded at first run: Qwen's official download URL can be blocked by CDN bot protection, which would make container startup nondeterministic. Qwen launches the installed binary under Xvfb and the backend reuses that live instance for every missing asset in the run.

## Firecrawl boundary

Gemini grounding remains the source of research claims and citations. Firecrawl is the default narrow reference-image search adapter because it returns direct, downloadable candidates per object study more reliably than the image-grounding metadata path alone. It does not synthesize claims, crawl the open web recursively, or bypass the evidence dossier. Set `REFERENCE_SEARCH_DRIVER=none` to run without it.

Deep traversal of a specific JavaScript-heavy site or document collection remains opt-in. Any later extractor must write the same source/reference contracts and ClickHouse cache records; planning, procedural construction, Blender, and the renderer do not depend on Firecrawl.

## Source of truth

Project folders are the artifact source of truth. ClickHouse is the searchable context and lineage engine. Database rows contain immutable revision records and content-addressed paths, never GLB or screenshot blobs. HTTP reads use the ClickHouse index first and fall back to project folders for recovery or import.

## Safety

- URLs are restricted to HTTP(S); localhost and private-network targets are rejected.
- Reference downloads enforce type, byte, redirect, and count limits.
- Gemini output is parsed through Zod schemas.
- Blender input is a bounded recipe; arbitrary model-authored Python is not accepted from the API.
- QA can change only an allowlisted set of scene properties, one procedural node, or one shared landmark per inspection.
- A geometry correction can replace one asset's bounded primitive recipe; it cannot inject Python or expand the object graph.
- Corrections are bounded (`WORKFLOW_MAX_ITERATIONS`, 1–128; default 64), as are runtime (30 minutes by default; four hours only when explicitly configured), logical AI calls (240), targeted research rounds (8), provider retries, and target count. Exhaustion is not success: the graph checkpoints at `quality-blocked` and cannot be accepted.
- Gemini supplies a structured assessment, but the backend owns acceptance. It rejects false passes below recognizability/domain/visual/construction thresholds or with low confidence, spatial errors, or browser errors.
- Repair-cycle and score-plateau detection escalate repeated local patches to targeted grounded research and a recovery replan. Unchanged assets and procedural components are then reused through ClickHouse.
- A running checkpoint without an in-process owner is treated as interrupted, not busy. Startup recovery is enabled by default and can be delegated to an external scheduler with `WORKFLOW_AUTO_RESUME_INTERRUPTED=false`.
- Required state/view targets are bounded by `WORKFLOW_MAX_QA_TARGETS` (default 24); excess targets fail planning rather than being silently truncated.
- Research attempts are bounded (`WORKFLOW_MAX_RESEARCH_ROUNDS`, 1–3; default 2).
