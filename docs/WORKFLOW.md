# Workflow and contracts

## State machine

The workflow stages are:

1. `created`
2. `researching`
3. `planning`
4. `resolving_assets`
5. `generating_assets`
6. `assembling`
7. `rendering_initial`
8. `inspecting`
9. `refining` (applies at most one typed patch in the current iteration)
10. `rendering_final`
11. repeat `inspecting → refining → rendering_final` until QA passes or the configured bound is reached
12. `completed` or `failed`

Every produced render is inspected, including the last render after a correction. Every transition is appended to both the project event log and the configured context store. A restarted implementation can reconstruct the visible run history without overwriting prior evidence. If the final allowed inspection still requests a fix, the project completes with `finalQaVerdict: "fix"` and `qaExhausted: true` instead of silently claiming success.

## Bounded inputs

- Reference images: 5 by default.
- Planned scene objects: 8 by default.
- Asset recipe parts: 16 per asset.
- Inspection iterations: configurable from 1–4; 2 by default, allowing one correction plus one verification inspection.
- Patches: at most one per inspection and therefore at most `WORKFLOW_MAX_ITERATIONS - 1` per run.
- Renderer capture: fixed viewport and camera manifest.

## Cache keys

```text
research = sha256(normalized prompt + research schema version + research model)
plan     = sha256(prompt + research hash + plan schema + planning models)
asset    = sha256(normalized asset recipe + Blender driver version + asset schema)
render   = sha256(canonical scene + renderer and capture identities)
inspect  = sha256(canonical scene + asset plan + spatial facts + render hash + inspector model)
```

Files are checked by SHA-256 before a cached asset is reused.

Cache identities are phase-specific. An inspector-model change does not invalidate grounded research, and a renderer change does not invalidate assets. Cached renders with browser errors are rejected.

Exact cache keys are preferred. Every candidate GLB is checksum-verified and measured before use; old rows without geometry metadata are remeasured rather than trusted. If there is no exact match, a related ClickHouse candidate is reusable only when the generator/recipe version, category, style, and tag rules match; its measured size must be within a 0.8–1.25 ratio on every axis of the requested recipe bounds; and each local-bounds anchor must be within 20% of the requested size or 5 cm. A successful compatible reuse creates a new alias record for the requested asset key with the measured geometry attached.

## Scene root

The manifest does not contain executable JavaScript. The renderer creates one `THREE.Group` named `SceneRoot`; environment helpers, loaded assets, labels, and transition targets are attached below it or to explicitly documented renderer layers.

All planning and scene vectors use the Three.js/glTF Y-up convention. Before executing a primitive recipe, the Blender adapter converts positions and dimensions to Blender's Z-up basis and conjugates non-zero rotations through the same basis. Exported GLBs therefore arrive back in Three.js with the planner's intended orientation.

The Blender driver's recipe version is part of every asset cache key. Coordinate-system or generation changes therefore invalidate older geometry automatically instead of silently reusing an incompatible GLB.

After generation or reuse, the backend parses the GLB scene graph and `POSITION` accessors, applies node transforms, and records the resulting local AABB, size, mesh-instance count, measurement identity, and exact file hash. The spatial analyzer refuses an asset that lacks this measured record. Planner `dimensions` are normalized from the primitive recipe for planning and candidate lookup only; they are not accepted as evidence about an exported GLB.

## Visual correction allowlist

Each inspection may request one of:

- camera position or target
- light position, color, or intensity
- object position, rotation, or scale
- label visibility
- regeneration of exactly one named asset using a replacement recipe of 1–16 validated primitives

An asset-regeneration patch changes only that asset's description and primitive parts, recomputes its recipe bounds, resolves or generates the revised GLB, updates affected object URLs, recomputes spatial evidence, renders, and then reinspects. It cannot add objects, alter arbitrary Blender code, or exceed the global iteration bound.

Before Gemini inspection, the backend transforms the exact GLB-derived local AABBs into world-space AABBs and computes floor clearance, declared-support contact, pair intersections, camera depth, projected coverage, and frustum visibility. Each object fact names its asset ID, SHA-256, local bounds, and measurement source. Gemini receives this evidence with the screenshot: the measured static-geometry facts are authoritative for bounds-related physical claims, while the image remains authoritative for visible fidelity and semantic judgment.

## Research collection

Gemini Google Search grounding provides textual sources and image-search chunks. The backend merges the grounding metadata with the structured model response, downloads no more than the configured reference count, records individual failures rather than failing the research stage, and writes:

```text
research/brief.json
research/notes.md
research/sources.json
research/references/index.json
research/references/*.{jpg,png,webp}
```
