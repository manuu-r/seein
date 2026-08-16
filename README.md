# SeeIn Local Core

SeeIn turns a concept prompt into a reusable interactive 3D scene. The backend performs grounded research, collects references, plans objects, reuses measured compatible assets, generates missing GLBs in Blender, assembles a declarative scene, captures it in a real browser, and runs a bounded Gemini visual-QA/refinement loop before publishing the final scene. The browser is only a renderer.

> Status: working local MVP. The deterministic AI provider is intended for offline development and CI; the production path uses Gemini while all other workflow services remain local.

## Design constraints

- Gemini is the only required managed API.
- ClickHouse, Blender, Qwen-MM-Plugins, Chromium, storage, and orchestration run locally.
- Every request gets an isolated project folder under `data/projects`.
- Large artifacts live on disk; ClickHouse indexes paths, hashes, lineage, and reusable metadata.
- The workflow has a configurable 1–4 inspection iterations; the default of 2 permits one correction followed by mandatory verification of the corrected render.
- Spatial evidence is derived from the exact GLB's mesh accessors and carries its SHA-256 provenance; planner-declared dimensions are never used as measured geometry.
- Gemini returns schema-validated data and never writes renderer source code.
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
  -d '{"prompt":"A compact medieval blacksmith workshop with labeled tools"}'
```

For an offline deterministic smoke run that does not require Gemini, Blender, ClickHouse, or Chromium:

```bash
npm run demo -- "A compact medieval blacksmith workshop"
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
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
- [x] Gemini grounded web/image research, planning, and multimodal inspection adapters
- [x] SSRF-aware, size-limited reference-image collection
- [x] Qwen-MM Blender MCP recipe execution and GLB export adapter
- [x] Exact and compatible-asset reuse with checksum and measured-geometry validation
- [x] Bulk asset retrieval and one-call Blender batch generation
- [x] Declarative scene assembly and a bounded allowlisted refinement loop
- [x] GLB-measured spatial evidence with asset-hash provenance for support, collision, scale, and framing
- [x] Bounded single-asset primitive-recipe regeneration for obvious geometry failures
- [x] Generic Three.js renderer with a common root, lighting, orbit controls, labels, highlights, and timed states
- [x] Persistent Playwright browser, content-addressed render reuse, and renderer-readiness protocol
- [x] ClickHouse-indexed project status, latest scene, events, phase caches, and spatial facts
- [x] Backend API, run status, events, and reruns
- [x] Deterministic end-to-end, geometry-regeneration, reuse, final-reinspection, and exhaustion verification
- [x] Real Chromium rendering and two-pass screenshot verification
- [ ] Live Gemini verification (requires `GEMINI_API_KEY`)
- [x] Live Qwen-MM/Blender/Xvfb MCP export verification
- [x] Live ClickHouse migration, persistence, research-cache, and asset-reuse verification
- [x] Integrated ClickHouse + Qwen/Blender + Three.js + Playwright two-pass run

Production providers fail visibly and never fall back to fixtures. Live Gemini is the sole remaining environment verification gate and requires a user-provided API key; the adapter and schemas are implemented.
