# Workflow and contracts

## Interaction graph

The normal interactive path is:

1. `intake → clarify-intent → await-clarification`
2. user answer resumes at `plan-research`
3. three `research-perspectives` plus one `reference-image-search` execute concurrently
4. `synthesize-research → await-research-approval`
5. approval resumes at `generate-scene`
6. scene planning, procedural/asset resolution, assembly, and state/view visual QA execute
7. `visual-qa → await-feedback` only when every required target passes at the same revision; otherwise `visual-qa → quality-blocked`
8. acceptance completes; revision feedback starts a linked project with the user's explicit preferences

`graph/state.json` and ClickHouse carry the exact cursor, wait reason, typed notes, intent, evidence dossier, and progress steps. Gemini works within nodes; `graph-state.ts` owns all valid edges. The direct `orchestrator.run()` path remains for deterministic CLI/CI smoke tests and omits the human interrupts.

Every produced render is inspected, including the last render after a correction. A correction invalidates passes from older revisions and restarts the required target matrix. Every transition is appended to both the project event log and the configured context store. A model-written `pass` is rejected when scored recognizability, domain fidelity, visual quality, construction completeness, confidence, deterministic spatial checks, or browser health fail. If a safety budget expires before every target passes, the project is checkpointed at `quality-blocked` with `qaExhausted: true`; it is not complete and the feedback/acceptance action is unavailable.

## Bounded inputs

- Reference images: 5 by default.
- Clarification questions: 1–4 in one turn for the MVP.
- Research perspectives: exactly 3 concurrent branches.
- Reference discovery: exactly 1 image-search branch, concurrent with the 3 evidence branches.
- Research follow-ups: configurable from 1–3 total rounds; 2 by default.
- Planned scene objects: 8 by default.
- Asset recipe parts: 16 per asset.
- Inspection/refinement slots: configurable from 1–128; 64 by default, allowing 63 repair actions.
- Wall time: 30 minutes by default, independently configurable up to six hours. A four-hour run is opt-in with `WORKFLOW_MAX_RUNTIME_MINUTES=240`.
- Logical AI calls: 240 by default. Cache hits and deterministic checks consume none; provider retries are bounded separately.
- Targeted self-healing research: up to eight rounds by default, invoked only for semantic/domain failures or stalled repair cycles.
- Required state/view targets: 24 by default. Every required view applies to its declared `stateIds`, or every state when that list is empty.
- Patches: at most one per inspection and therefore at most `WORKFLOW_MAX_ITERATIONS - 1` per run.
- Renderer capture: fixed viewport and camera manifest.

## Cache keys

```text
clarify  = sha256(normalized prompt + explicit preference profile + clarifier identity)
intent   = sha256(prompt + clarification + answers + preference profile)
branch   = sha256(intent + perspective agenda + research model)
refs     = sha256(intent + research agenda + reference-search model)
dossier  = sha256(intent + three branch results + image-search attribution + synthesis model)
plan     = sha256(prompt + approved dossier hash + intent + planning model)
asset    = sha256(normalized asset recipe + Blender driver version + asset schema)
render   = sha256(canonical scene + renderer and capture identities)
inspect  = sha256(canonical scene + asset plan + spatial facts + render hash + inspector model)
```

Files are checked by SHA-256 before a cached asset is reused.

Cache identities are phase-specific. An inspector-model change does not invalidate grounded research, and a renderer change does not invalidate assets. Cached renders with browser errors are rejected.

Exact cache keys are preferred. Every candidate GLB is checksum-verified and measured before use; old rows without geometry metadata are remeasured rather than trusted. If there is no exact match, a related ClickHouse candidate is reusable only when the generator/recipe version, category, style, and tag rules match; its measured size must be within a 0.8–1.25 ratio on every axis of the requested recipe bounds; and each local-bounds anchor must be within 20% of the requested size or 5 cm. A successful compatible reuse creates a new alias record for the requested asset key with the measured geometry attached.

## Scene root

The manifest does not contain executable JavaScript. The renderer creates one `THREE.Group` named `SceneRoot`; environment helpers, loaded assets, procedural construction, labels, and transition targets are attached below it. The procedural payload is a validated data program: coordinate frame and unit conversion, shared landmarks, PBR materials, hierarchy/dependencies, primitives, tapered tubes, extrusions, lathes, instancing, diagnostic views, and measurable invariants.

All planning and scene vectors use the Three.js/glTF Y-up convention. Before executing a primitive recipe, the Blender adapter converts positions and dimensions to Blender's Z-up basis and conjugates non-zero rotations through the same basis. Exported GLBs therefore arrive back in Three.js with the planner's intended orientation.

The Blender driver's recipe version is part of every asset cache key. Coordinate-system or generation changes therefore invalidate older geometry automatically instead of silently reusing an incompatible GLB.

After generation or reuse, the backend parses the GLB scene graph and `POSITION` accessors, applies node transforms, and records the resulting local AABB, size, mesh-instance count, measurement identity, and exact file hash. The spatial analyzer refuses an asset that lacks this measured record. Planner `dimensions` are normalized from the primitive recipe for planning and candidate lookup only; they are not accepted as evidence about an exported GLB.

Procedural geometry uses one `procedural-geometry.ts` builder imported by both the backend analyzer and browser renderer. Bounds are read from the actual `BufferGeometry` built from node parameters, then transformed through the same hierarchy and `metersPerUnit` conversion. Shared-landmark tube junctions are validated in world space.

Procedure states can apply bounded transform and opacity mutations to named imported or procedural entities. The browser animates from immutable base transforms, while target-specific spatial analysis applies the same mutation before measuring bounds and invariants. Transition edges distinguish normal progress, alternatives, and explicit complication branches; arbitrary scripts are not part of the manifest.

## Autonomous recovery policy

Each visual inspection scores recognizability, domain fidelity, visual quality, construction completeness, and confidence. The backend combines those scores with exact spatial issues and browser errors. A failure is routed to one of four bounded actions:

1. rerender after a transient browser/render failure;
2. apply one local camera, light, transform, label, asset, procedural-node, or shared-landmark correction;
3. run targeted grounded research and collect fresh reference images when identity, anatomy, proportions, or relationships are uncertain;
4. replan the affected construction while preserving correct entity IDs and allowing ClickHouse to reuse unchanged components.

Repair fingerprints and recent minimum quality scores detect repeated patches and plateaus. A stalled local loop is automatically promoted to research/replan. Every inspection and action updates `quality/supervisor.json`, an append-only project checkpoint, and the ClickHouse quality-supervisor row, so a process restart can replay cached work inside the original deadline. A deliberate resume after exhaustion creates a fresh supervised time window.

## Visual correction allowlist

Each inspection may request one of:

- camera position or target
- light position, color, or intensity
- object position, rotation, or scale
- label visibility
- regeneration of exactly one named asset using a replacement recipe of 1–16 validated primitives
- replacement of exactly one procedural node
- movement of exactly one shared procedural landmark

An asset-regeneration patch changes only that asset's description and primitive parts, recomputes its recipe bounds, resolves or generates the revised GLB, updates affected object URLs, recomputes spatial evidence, renders, and then reinspects. It cannot add objects, alter arbitrary Blender code, or exceed the global iteration bound.

Before Gemini inspection, the backend transforms exact GLB-derived and shared-builder procedural AABBs into world space and computes floor clearance, declared-support contact, pair intersections, camera depth, projected coverage, frustum visibility, continuity, contact, containment, required visibility, dependency validity, and triangle-budget evidence for the exact target state/view. Each fact names its source and hash. Gemini receives the target-view PNG as inline multimodal input—not merely a path—together with the original request, approved intent, current research brief, object studies, intent coverage, contradictions, scene program, and up to four bounded approved reference images. Geometry facts govern measurable claims while the rendered image governs visible fidelity and semantic judgment. The correction must close a named gap between the observed pixels and the approved acceptance brief.

## Research collection

Gemini 3.7 Flash runs the three schema-validated Google Web Search branches for visual identity, construction/materials, and scale/space. In the same fan-out, Gemini 3.1 Flash Image runs Google Image Search and contributes only returned grounding metadata; it is not asked for structured JSON or image generation. The backend maps findings to exact grounding chunks, refuses unbound findings, preserves Google's rendered search attribution, synthesizes object studies without allowing new URLs, then applies a deterministic readiness gate. Only an approved dossier reaches scene planning.

The backend downloads no more than the configured reference count, records individual failures rather than failing the scene-generation stage, and writes:

```text
research/brief.json
research/intent.json
research/agenda.json
research/dossier.json
research/reference-discovery.json
research/readiness.json
research/perspectives/*.json
research/notes.md
research/sources.json
research/references/index.json
research/references/*.{jpg,png,webp}
```
