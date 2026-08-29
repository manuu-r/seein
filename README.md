# SeeIn Local Core

SeeIn turns a surgeon’s anatomy or procedure prompt into an evidence-grounded interactive 3D medical visualization through a resumable backend agent graph. It clarifies anatomy, laterality, approach, and teaching intent; runs three grounded medical evidence searches plus one anatomical reference-image search in parallel; exposes an evidence-readiness checkpoint; retrieves reusable procedural structures and GLBs; constructs the anatomy; then sends every required operative-view render to Gemini for multimodal inspection and correction at one accepted revision. The browser is only a renderer and typed input surface.

> Status: working local MVP. The deterministic AI provider is intended for offline development and CI; the production path uses Gemini while all other workflow services remain local.

## Design constraints

- Gemini is the only required managed API.
- Gemini 3.7 Flash is the default for research, planning, synthesis, clarification, and screenshot inspection; Gemini 3.1 Flash Image is isolated to grounded reference-image discovery because it is the current model with Google Image Search support.
- ClickHouse, Blender, Qwen-MM-Plugins, Chromium, storage, and orchestration run locally.
- Every request gets an isolated project folder under `data/projects`.
- Large artifacts live on disk; ClickHouse indexes paths, hashes, lineage, and reusable metadata.
- The autonomous quality supervisor uses a 30-minute default wall-clock budget with 64 inspection/refinement slots (63 repair actions), a separate logical AI-call budget, transient-provider retries, and up to 24 required state/view targets. Longer unattended sessions, such as four hours, are enabled explicitly with `WORKFLOW_MAX_RUNTIME_MINUTES=240`. A correction invalidates prior passes, so all targets must pass again at the same revision.
- Every Gemini inspection returns recognizability, domain-fidelity, visual-quality, construction-completeness, and confidence scores. The backend—not the model's verdict alone—enforces the thresholds and can escalate a stalled local patch into targeted grounded research and a reconstruction replan.
- Each inspection sends Gemini the actual target-view PNG, the original request, approved intent, current research brief, relevant object studies, measured scene evidence, and up to four bounded reference images. Corrections must address the mismatch between that visual evidence and the approved target—not a generic notion of attractiveness.
- Spatial evidence comes from exact GLB mesh accessors or the shared procedural geometry builder used by both backend and renderer. Planner-declared asset dimensions are never used as measured geometry.
- Gemini returns schema-validated plans and patches and never writes renderer source code. Procedural construction is a declarative program of coordinate frames, landmarks, materials, nodes, views, states, and invariants.
- Gemini performs semantic work inside typed nodes; deterministic backend guards choose graph edges and bounds.
- All scene content is mounted below one Three.js `SceneRoot` group.

## Quick start

Requirements: Docker, Docker Compose, and a Gemini API key for the production workflow. The recommended path runs the complete backend—including Blender and Chromium—in the worker image:

```bash
cp .env.example .env
# Add GEMINI_API_KEY to .env, then:
docker compose up --build
```

The API starts at `http://localhost:8787`; ClickHouse migration is automatic and idempotent. The first image build is large because it contains Blender and both Playwright Chromium variants. For backend development outside the container, follow [Local operations](docs/LOCAL_SETUP.md); that path additionally requires Node.js 22+ and local Qwen/Blender tooling.

Create a run with:

```bash
curl -X POST http://localhost:8787/api/projects \
  -H 'content-type: application/json' \
  -d '{"prompt":"Right hepatic hilum anatomy for laparoscopic cholecystectomy, including Calot’s triangle and structures at risk"}'
```

Open the returned `viewerUrl`. The guided renderer shows the backend's clarification questions, research checks, generation progress, scene states, and final feedback controls.

For an offline deterministic smoke run that does not require Gemini, Blender, ClickHouse, or Chromium:

```bash
npm run demo -- "Endoscopic endonasal transsphenoidal approach with carotid and optic relationships"
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Agent graph design and research](docs/AGENT_GRAPH.md)
- [Project structure and file map](docs/PROJECT_STRUCTURE.md)
- [Performance, graph, loop, and spatial decisions](docs/PERFORMANCE.md)
- [Workflow and contracts](docs/WORKFLOW.md)
- [Local operations](docs/LOCAL_SETUP.md)
- [Cloud migration](docs/CLOUD_DEPLOYMENT.md)
- [HTTP API](docs/API.md)
- [ClickHouse schema and retrieval](docs/CLICKHOUSE.md)
- [Verification matrix and evidence](docs/VERIFICATION.md)

## Implementation status

- [x] Project scaffolding and schema-validated contracts
- [x] Local artifact store and ClickHouse context schema
- [x] Gemini 3.7 grounded web research/planning/inspection plus parallel Gemini 3.1 grounded image-reference discovery
- [x] SSRF-aware, size-limited reference-image collection
- [x] Qwen-MM Blender MCP recipe execution and GLB export adapter
- [x] Exact and compatible-asset reuse with checksum and measured-geometry validation
- [x] Bulk asset retrieval and one-call Blender batch generation
- [x] Declarative scene assembly and a bounded allowlisted refinement loop
- [x] Backend-authored procedural primitives, tapered tubes, extrusions, lathes, instancing, shared landmarks, hierarchy, units, views, and invariants
- [x] Required state × view QA matrix with pass invalidation after every patch and non-completable `quality-blocked` checkpoints
- [x] Four-hour durable self-healing supervisor with scored acceptance gates, cycle/plateau detection, targeted re-research, partial replanning, retries, and ClickHouse checkpoints
- [x] GLB- and shared-builder-measured spatial evidence with hash provenance for support, collision, scale, framing, continuity, contact, containment, visibility, and performance
- [x] Bounded single-asset primitive-recipe regeneration for obvious geometry failures
- [x] Display-only Three.js anatomy renderer with a common root, lighting, orbit controls, labels, highlights, operative views, and timed procedure states
- [x] Persistent Playwright browser, content-addressed render reuse, and renderer-readiness protocol
- [x] ClickHouse-indexed project status, latest scene, events, phase caches, spatial facts, procedural components, procedure states, and per-target QA
- [x] Backend API, run status, events, and reruns
- [x] Resumable clarification → parallel research → readiness approval → generation → feedback graph
- [x] Guided display-only renderer for graph progress, approvals, and revision feedback
- [x] Deterministic end-to-end, geometry-regeneration, reuse, final-reinspection, and exhaustion verification
- [x] Real Chromium rendering and two-pass screenshot verification
- [ ] Live Gemini verification (requires `GEMINI_API_KEY`)
- [x] Live Qwen-MM/Blender/Xvfb MCP export verification
- [x] Live ClickHouse migration, persistence, research-cache, and asset-reuse verification
- [x] Integrated ClickHouse + Qwen/Blender + Three.js + Playwright two-pass run

Production providers fail visibly and never fall back to fixtures. Live Gemini is the sole remaining environment verification gate and requires a user-provided API key; the adapter and schemas are implemented.
