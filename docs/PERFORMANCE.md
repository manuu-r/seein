# Performance and engineering decisions

This document records the speed design and the graph/loop research cross-check as of 2026-08-15.

## Critical path

```text
cold prompt
  -> 1 Gemini clarification call -> user interrupt
  -> 1 Gemini intent/agenda call
  -> 3 Gemini grounded research calls in parallel
  -> 1 Gemini synthesis call -> evidence approval interrupt
  -> 1 Gemini scene-plan call
  -> references download || evidence files
  -> 2 ClickHouse asset queries
  -> 0 or 1 batched Blender MCP call
  -> scene + spatial facts stored in parallel
  -> 1 browser render
  -> 1 Gemini multimodal inspection
  -> optional patch + cached/fresh rerender
  -> mandatory inspection of that rerender
  -> repeat only up to WORKFLOW_MAX_ITERATIONS

exact warm prompt
  -> ClickHouse graph/semantic-node cache reads
  -> reference/asset/render file copies
  -> 0 repeated Gemini calls for unchanged node inputs, 0 Blender calls, 0 Chromium captures
```

The warm path assumes unchanged cache identities and healthy cached files. Every binary cache hit is SHA-256 checked before reuse. Renderer errors are never cached.

## Implemented speed controls

| Cost center | Implementation |
|---|---|
| Clarification | Content-addressed by prompt plus explicit preference profile |
| Gemini research | Three independent grounded calls run concurrently; a slow branch sets latency, not their sum |
| Research synthesis + plan | Separate cacheable calls because approval and feedback can invalidate one without invalidating the other |
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

## Why the graph stays plain TypeScript for the MVP

The current graph now includes durable human interrupts, parallel research, conditional edges, typed notes, and two bounded loops. Its state and checkpoints are implemented explicitly so the control boundary is inspectable and no framework-specific chat transcript becomes the source of truth.

- [LangGraph interrupts](https://langchain-ai.github.io/langgraph/concepts/breakpoints/), [Google ADK](https://developers.googleblog.com/build-long-running-ai-agents-that-pause-resume-and-never-lose-context-with-adk/), [AutoGen GraphFlow](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/graph-flow.html), and [Mastra workflows](https://mastra.ai/ai-workflows) converge on explicit state, conditional edges, suspension/resume, and observable steps.
- SeeIn implements those portable primitives over its current ClickHouse/project-folder boundary. Mastra is the closest TypeScript replacement when multi-worker leasing or crash-safe replay inside a running node becomes necessary.

Adopt a general durable engine when multi-worker ownership, idempotency leases, or crash-safe replay *inside* a running node becomes necessary. Waiting checkpoints already resume across HTTP requests and process restarts.

## Graph research cross-check

Knowledge-graph RAG systems such as [LightRAG](https://github.com/HKUDS/LightRAG) are designed to extract and retrieve relationships across document corpora. SeeIn currently researches a small source set per prompt; graph extraction would add model calls and latency before it adds useful recall. The research agenda and object studies provide a smaller evidence graph without another extraction call.

The useful graph is the scene graph already produced by planning:

```text
object node -> typed spatial/semantic edge -> object node
            -> world bounds and camera facts
            -> asset recipe and immutable output hash
```

That direction agrees with recent spatial work: [Agentic 3D Scene Generation](https://spatctxvlm.github.io/project_page/), [View-on-Graph](https://ojs.aaai.org/index.php/AAAI/article/view/37677), [SceneAssistant](https://github.com/ROUJINN/SceneAssistant), and [3DGraphLLM](https://github.com/CognitiveAISystems/3DGraphLLM) externalize spatial context and use render feedback rather than rely on an LLM's implicit geometry. SeeIn applies that lesson without importing their training stacks: it keeps object/relationship constraints, measures exact GLBs, computes deterministic world-space facts, and gives those facts to Gemini alongside the render.

Mesh-derived static bounds are now implemented by parsing the exact GLB and following its scene/node transforms. The next spatial upgrade should add renderer-derived depth, instance masks, occlusion, or contact evidence—not replace measured geometry with a generic graph database.

## ClickHouse choices

ClickHouse is used as a fast index, cache, and analytical lineage plane. GLBs, images, and screenshots stay in artifact storage. Hot filter/order fields are typed columns; full validated payloads remain strings for round-trip fidelity. This follows ClickHouse guidance that known structures should use explicit columns, while native JSON is most valuable for genuinely evolving paths.

The local image tracks the [26.3 LTS line](https://clickhouse.com/blog/clickhouse-release-26-03). Asset retrieval is lexical today because it is deterministic and requires no embedding call. When the library grows beyond what category/tag filtering handles well, add a locally generated embedding column and ClickHouse's [HNSW vector similarity index](https://clickhouse.com/docs/engines/table-engines/mergetree-family/annindexes); do not add an embedding API call to every request.

## Firecrawl decision

Do not put Firecrawl on the default path. Gemini grounding already returns the few sources and images this workflow needs. Add Firecrawl only as an optional cached research adapter for deep site traversal, JavaScript-heavy extraction, or user-specified document collections.
