# Performance and engineering decisions

This document records the speed design and the graph/loop research cross-check as of 2026-08-15.

## Critical path

```text
cold prompt
  -> 1 Gemini grounded research+plan call
  -> references download || research files
  -> 2 ClickHouse asset queries
  -> 0 or 1 batched Blender MCP call
  -> scene + spatial facts stored in parallel
  -> 1 browser render
  -> 1 Gemini multimodal inspection
  -> optional patch + cached/fresh rerender
  -> mandatory inspection of that rerender
  -> repeat only up to WORKFLOW_MAX_ITERATIONS

exact warm prompt
  -> ClickHouse cache reads
  -> reference/asset/render file copies
  -> 0 Gemini calls, 0 Blender calls, 0 Chromium captures
```

The warm path assumes unchanged cache identities and healthy cached files. Every binary cache hit is SHA-256 checked before reuse. Renderer errors are never cached.

## Implemented speed controls

| Cost center | Implementation |
|---|---|
| Gemini research + plan | One combined grounded structured call on a cold prompt |
| Repeat AI calls | Phase-specific content-addressed research, plan, and inspection caches |
| Reference images | Concurrent downloads and a URL-addressed local reference library |
| Asset lookup | One exact-key query plus one related-candidate query for the whole plan |
| Asset validation | Concurrent reads with in-run checksum and GLB-measurement de-duplication |
| Blender startup/tool overhead | Every missing recipe is exported through one MCP batch |
| Scene persistence | Manifest, spatial report, and ClickHouse facts write concurrently |
| Browser startup | One Playwright browser per backend process; pages are short-lived |
| Repeat rendering | Content-addressed screenshot cache keyed by scene and renderer contract |
| Passing QA | No second scene revision and no second render |
| Refinement bound | 1–4 inspections; default 2 gives one repair and one verification inspection |
| Run telemetry | Events buffer briefly and insert as a batch |
| HTTP project reads | ClickHouse project/latest-scene/event indexes; filesystem is fallback truth |

## Why the loop stays plain TypeScript

The current loop has fixed phases and a small configured iteration bound. An orchestration framework would add state serialization, adapters, and debugging layers without shortening this code.

- [LangGraph](https://docs.langchain.com/oss/python/langgraph/workflows-agents) is a strong fit when the graph becomes dynamic, interruptible, or human-reviewed.
- [Pydantic AI with DBOS](https://pydantic.dev/articles/pydantic-ai-dbos) and Temporal-style execution are relevant when a run must resume across worker crashes or span distributed jobs.
- Neither improves the current single-process critical path. The existing `run_events`, immutable revisions, typed phase outputs, and deterministic cache keys are the migration boundary if durability becomes necessary.

Adopt a durable engine only when at least one real requirement appears: multi-worker ownership, crash resume inside a phase, human approval waits, scheduled jobs, or dynamic/long-running graphs beyond this bounded loop.

## Graph research cross-check

Knowledge-graph RAG systems such as [LightRAG](https://github.com/HKUDS/LightRAG) are designed to extract and retrieve relationships across document corpora. SeeIn currently researches a small source set per prompt; graph extraction would add model calls and latency before it adds useful recall. It is therefore not on the request path.

The useful graph is the scene graph already produced by planning:

```text
object node -> typed spatial/semantic edge -> object node
            -> world bounds and camera facts
            -> asset recipe and immutable output hash
```

That direction agrees with recent spatial work: [3DGraphLLM](https://github.com/CognitiveAISystems/3DGraphLLM), [OSU-3DSG](https://github.com/YuansuHao/OSU-3DSG), [SaGe](https://github.com/zwyang6/SaGe), and [Scenethesis](https://arxiv.org/abs/2505.02836) all make structured scene relationships or vision-guided layout feedback central to spatial reasoning. The lean implementation applies that lesson without importing their training stacks: it computes deterministic world-space facts, checks claimed support against geometry, and gives those facts to Gemini alongside the render.

Mesh-derived static bounds are now implemented by parsing the exact GLB and following its scene/node transforms. The next spatial upgrade should add renderer-derived depth, instance masks, occlusion, or contact evidence—not replace measured geometry with a generic graph database.

## ClickHouse choices

ClickHouse is used as a fast index, cache, and analytical lineage plane. GLBs, images, and screenshots stay in artifact storage. Hot filter/order fields are typed columns; full validated payloads remain strings for round-trip fidelity. This follows ClickHouse guidance that known structures should use explicit columns, while native JSON is most valuable for genuinely evolving paths.

The local image tracks the [26.3 LTS line](https://clickhouse.com/blog/clickhouse-release-26-03). Asset retrieval is lexical today because it is deterministic and requires no embedding call. When the library grows beyond what category/tag filtering handles well, add a locally generated embedding column and ClickHouse's [HNSW vector similarity index](https://clickhouse.com/docs/engines/table-engines/mergetree-family/annindexes); do not add an embedding API call to every request.

## Firecrawl decision

Do not put Firecrawl on the default path. Gemini grounding already returns the few sources and images this workflow needs. Add Firecrawl only as an optional cached research adapter for deep site traversal, JavaScript-heavy extraction, or user-specified document collections.
