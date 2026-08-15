# Verification

This document separates adapter implementation from live runtime evidence. Fixture tests never claim to prove Blender, Chromium, ClickHouse, or Gemini behavior.

## Automated checks

Run from the repository root:

```bash
npm run typecheck
npm test
npm run build
npm audit --omit=dev
```

Current result:

- TypeScript typecheck passes.
- 5 test files and 13 tests pass.
- Renderer and backend production builds pass.
- The renderer bundle has a non-blocking size warning; it is intentionally a single minimal viewer entry for the MVP.
- The production dependency audit reports 0 vulnerabilities.

Tests cover contract bounds, artifact path safety, deterministic single/batch GLB generation, Y-up to Z-up conversion, generator-version cache isolation, world bounds, camera framing, real support-contact validation, the full bounded state machine, indexed reads, the one-patch revision rule, no-op refinement, and repeat-run AI/render cache reuse.

## Live local verification

Previously verified on Docker Desktop with the `linux/amd64` core image and ClickHouse 25.8. The additive schema migration has also been executed successfully against that live database before changing the Compose target to the 26.3 LTS line:

| Capability | Result | Evidence |
|---|---|---|
| ClickHouse migration | Pass | Project/cache/spatial additions created idempotently on the existing database |
| ClickHouse workflow | Pass | Project index, workflow cache, two spatial reports, and six per-object spatial facts persisted |
| Cross-process warm path | Pass | Research, plan, initial render, inspection, and patched final render all returned `cacheHit: true`; final project index returned `completed` |
| Research cache | Pass | Identical second prompt reports `cacheHit: true` |
| Asset reuse | Pass | Corrected second run reports `generated: 0`, `reused: 3` |
| Qwen-MM MCP | Prior live pass | Pinned `qwen-mm-plugins-blender-v1.0.1` accepted real exports; the new multi-recipe single-call path is fixture-tested but needs the worker image for a fresh live smoke test |
| Blender under Xvfb | Pass | Blender autolaunched on port 9876 and exported three GLB 2.0 files |
| Coordinate contract | Pass | Final visual has a horizontal platform and upright subject/marker |
| Three.js renderer | Pass | All three real Blender GLBs loaded below `SceneRoot` |
| Chromium capture | Pass | Revision 1 and revision 2 screenshots created with no browser errors |
| Bounded refinement | Pass | One framing issue produced one camera patch and no further loop |
| Docker image | Pass | Final amd64 image builds with a 20–25 KB context |

The definitive integrated run is retained under:

```text
data/full-local/projects/
  a-compact-modular-observatory-with-three-labeled-7dd9068b/
```

Its event stream contains 24 ordered events from `created` through `completed`; its three generated assets are valid GLB 2.0 files. The following identical run, ending in `b31abd8f`, reused all three corrected recipe-v2 assets and completed both browser renders without starting Blender again.

## Runtime issues found and fixed

Live testing caught four problems that fixture-only tests would not reveal:

1. Qwen's Blender 4.2 CDN download returned a Cloudflare 403. Blender is now installed in the image at build time.
2. `xvfb-run` required the separately packaged `xauth` helper.
3. Debian Blender requires explicit `python3-requests` for Qwen's addon and `python3-numpy` for its glTF exporter.
4. Blender's Z-up primitive recipes initially received Three.js Y-up vectors. The adapter now maps position/scale axes, conjugates rotations, and versions the recipe in asset cache keys. Exact and related reuse both require a matching generator version.

## Gemini gate

The Gemini adapter performs grounded web and image research, schema-constrained planning, and screenshot inspection. A live call is intentionally not attempted without `GEMINI_API_KEY`.

After setting the key in `.env`, the production-local acceptance test is:

```bash
docker compose up --build
curl -X POST http://localhost:8787/api/projects \
  -H 'content-type: application/json' \
  -d '{"prompt":"A compact medieval blacksmith workshop with labeled tools"}'
```

Accept the run only when its events finish at `completed`, research contains grounded sources/references, the initial screenshot exists, any patched final screenshot exists, and fresh render events have an empty `browserErrors` array.
