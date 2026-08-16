# Architecture

## Boundary

The backend owns every decision and side effect. The frontend receives a versioned scene manifest, loads GLBs, and displays labels, highlights, orbit controls, and declarative transitions. It has no Gemini, ClickHouse, research, Blender, or workflow credentials.

```text
prompt -> backend bounded loop
  -> ClickHouse phase caches
  -> Gemini grounded research + plan (one cold call)
       ├─ reference downloads || research artifact writes
       └─ bulk ClickHouse asset lookup
            -> one Qwen-MM Blender batch for all missing GLBs
  -> manifest + deterministic spatial facts
  -> cached or fresh Three.js/Playwright render
  -> cached or fresh Gemini inspection
  -> zero or one validated patch for this iteration
  -> rerender -> reinspect, until pass or WORKFLOW_MAX_ITERATIONS
```

## Local services

| Component | Responsibility | Persistent data |
|---|---|---|
| Core API | Workflow, HTTP API, manifest delivery | Project folders |
| ClickHouse | Phase caches, project index, assets, scene graph, spatial facts, runs, revisions, QA | Docker volume |
| Qwen-MM Blender MCP | Safe access to a running Blender instance | Shared artifact volume |
| Blender + Xvfb | Geometry, materials, GLB export | Shared artifact volume |
| Chromium | Render fidelity and screenshots | Screenshots in project folders |
| Gemini API | Research synthesis, planning, multimodal QA | Only provider outside the host |

Gemini research enables both web and image search grounding. The cold path requests research and a scene plan together. Grounding chunks are merged into the validated research brief so reference images retain their containing source page. The configured research model must support image-search grounding; the default is `gemini-3.1-flash-image`.

## Portability seams

The core depends on interfaces rather than deployment products:

- `ArtifactStore`: local disk now, Google Cloud Storage later.
- `ContextStore`: ClickHouse locally and in ClickHouse Cloud using the same schema.
- `WorkflowAI`: Gemini in production, deterministic fixture provider in tests.
- `BlenderDriver`: Qwen-MM MCP in production, valid minimal GLBs in tests.
- `ScreenshotDriver`: Playwright in production, deterministic placeholder image in tests.
- `JobRunner`: in-process locally, Cloud Run Job trigger later.

## Container image

The production core image includes Blender, Chromium, Xvfb plus its required `xauth` helper, Blender-Python's `numpy` and `requests` dependencies, `uv`/`uvx`, and the Qwen-MM Blender capability pinned to `qwen-mm-plugins-blender-v1.0.1`. Blender is installed from the Debian image repository rather than downloaded at first run: Qwen's official download URL can be blocked by CDN bot protection, which would make container startup nondeterministic. Qwen launches the installed binary under Xvfb and the backend reuses that live instance for every missing asset in the run.

## Why Firecrawl is not in the first version

The MVP does not use Firecrawl. Gemini's Google Search and image-search grounding already supplies the small, prompt-specific source set needed by this workflow, while the reference collector safely downloads only the selected images. Adding a crawler now would introduce another service, API credential, document-normalization path, and cache policy without improving the critical prompt-to-scene loop.

Firecrawl remains a clean optional research adapter for a later phase if runs need deep traversal of a specific site, reliable extraction from JavaScript-heavy pages, or broader document ingestion. It should implement the existing research interface and write the same `ResearchBrief`, sources, references, and ClickHouse cache records; no planning, asset, or renderer code should depend on it.

## Source of truth

Project folders are the artifact source of truth. ClickHouse is the searchable context and lineage engine. Database rows contain immutable revision records and content-addressed paths, never GLB or screenshot blobs. HTTP reads use the ClickHouse index first and fall back to project folders for recovery or import.

## Safety

- URLs are restricted to HTTP(S); localhost and private-network targets are rejected.
- Reference downloads enforce type, byte, redirect, and count limits.
- Gemini output is parsed through Zod schemas.
- Blender input is a bounded recipe; arbitrary model-authored Python is not accepted from the API.
- QA can change only an allowlisted set of scene properties.
- A geometry correction can replace one asset's bounded primitive recipe; it cannot inject Python or expand the object graph.
- Run attempts and revisions are bounded (`WORKFLOW_MAX_ITERATIONS`, 1–4; default 2).
