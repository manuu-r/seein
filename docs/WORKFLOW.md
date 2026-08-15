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
9. `refining` (applies zero or one patch)
10. `rendering_final` (reuses the initial render when no patch exists)
11. `completed` or `failed`

Every transition is appended to both the project event log and the configured context store. A restarted implementation can reconstruct the visible run history without overwriting prior evidence.

## Bounded inputs

- Reference images: 5 by default.
- Planned scene objects: 8 by default.
- Asset recipe parts: 16 per asset.
- Visual corrections: exactly 1 maximum.
- Renderer capture: fixed viewport and camera manifest.

## Cache keys

```text
research = sha256(normalized prompt + research schema version + research model)
plan     = sha256(prompt + research hash + plan schema + planning models)
asset    = sha256(normalized asset recipe + Blender driver version)
render   = sha256(canonical scene + renderer and capture identities)
inspect  = sha256(canonical scene + spatial facts + render hash + inspector model)
```

Files are checked by SHA-256 before a cached asset is reused.

Cache identities are phase-specific. An inspector-model change does not invalidate grounded research, and a renderer change does not invalidate assets. Cached renders with browser errors are rejected.

Exact cache keys are preferred. If there is no exact match, related ClickHouse candidates are reusable only when the generator/recipe version matches, category and style match, at least two requested tags overlap, dimensions remain within a 0.5–2.0 ratio on every axis, and the stored file checksum is valid. A successful compatible reuse creates a new alias record for the requested asset key.

## Scene root

The manifest does not contain executable JavaScript. The renderer creates one `THREE.Group` named `SceneRoot`; environment helpers, loaded assets, labels, and transition targets are attached below it or to explicitly documented renderer layers.

All planning and scene vectors use the Three.js/glTF Y-up convention. Before executing a primitive recipe, the Blender adapter converts positions and dimensions to Blender's Z-up basis and conjugates non-zero rotations through the same basis. Exported GLBs therefore arrive back in Three.js with the planner's intended orientation.

The Blender driver's recipe version is part of every asset cache key. Coordinate-system or generation changes therefore invalidate older geometry automatically instead of silently reusing an incompatible GLB.

## Visual correction allowlist

The inspection result may request one of:

- camera position or target
- light position, color, or intensity
- object position, rotation, or scale
- label visibility

Geometry regeneration is recorded as an issue but is intentionally not automatic in the first correction pass; this prevents a screenshot critique from opening an unbounded Blender loop.

Before Gemini inspection, the backend computes world-space AABBs, floor clearance, declared-support contact, pair intersections, camera depth, projected coverage, and frustum visibility. Gemini receives this deterministic evidence with the screenshot; the image is used for semantic and visual judgment, while geometry facts are authoritative for physical claims.

## Research collection

Gemini Google Search grounding provides textual sources and image-search chunks. The backend merges the grounding metadata with the structured model response, downloads no more than the configured reference count, records individual failures rather than failing the research stage, and writes:

```text
research/brief.json
research/notes.md
research/sources.json
research/references/index.json
research/references/*.{jpg,png,webp}
```
