# ClickHouse context engine

ClickHouse is the fast metadata, cache, scene-graph, and lineage plane. Binary artifacts remain under `DATA_ROOT` locally and move to object storage in cloud deployments.

## Data boundary

Store in ClickHouse:

- project status and ordered run events;
- research, plan, render, and inspection cache payloads;
- asset recipes, tags, dimensions, hashes, paths, and generator identity;
- immutable scene revisions and flattened object transforms;
- typed object relationships;
- screenshot paths and hashes;
- spatial reports, per-object facts, and issue evidence;
- QA verdicts and patches.

Do not store GLB, PNG, or reference-image bytes in ClickHouse. Keeping blobs in artifact storage makes local/cloud migration, CDN delivery, checksums, and lifecycle rules straightforward.

## Tables

| Table | Purpose |
|---|---|
| `projects` | Fast project list/status lookup without scanning directories |
| `run_events` | Ordered workflow transitions and diagnostic payloads |
| `research_cache` | Prompt/model/schema keyed grounded briefs |
| `workflow_cache` | Typed plan, render, and inspection cache entries |
| `assets` | Recipes, search fields, generator version, output hash, and path |
| `scene_revisions` | Full immutable scene manifests and content hashes |
| `scene_objects` | Fast per-revision object state lookup |
| `object_relationships` | Typed scene-graph edges |
| `renders` | Initial/final screenshot paths and hashes |
| `qa_reports` | Gemini verdict, evidence, and allowlisted patch |
| `spatial_reports` | Full deterministic spatial report by scene revision |
| `spatial_object_facts` | Bounds, clearance, depth, coverage, and framing per object |
| `spatial_issues` | Queryable collision, support, scale, and framing evidence |

Replacing tables retain the newest value by deterministic key. Revision/evidence tables remain append-oriented. Project folders are still the recoverable artifact source of truth.

## Hot retrieval path

Asset resolution performs two ClickHouse queries for an entire plan, not two queries per object:

1. exact deterministic asset keys;
2. a bounded category/tag candidate pool.

The backend scores that pool and then enforces generator identity, category, style, tag overlap, dimension ratio, file existence, and SHA-256 validity. A compatible related hit receives an alias under the requested content key.

Project list/status, latest scene, and events are also served from ClickHouse. The filesystem fallback warms the index when running with a fresh in-memory store or importing older project folders.

## Write path

- Missing assets are inserted as one batch.
- Run events use a short 75 ms buffer and a 32-event threshold.
- Latest project snapshots are coalesced by project ID before insertion; events preserve stage history.
- Scene manifest, object rows, and relationship rows insert concurrently.
- Spatial report, object facts, and issue rows insert concurrently.
- Full payload strings preserve the validated contract; frequently queried fields are duplicated into typed columns.

This avoids the small-insert-per-object pattern that creates excessive MergeTree parts. It also avoids server-side async-insert wait time on the request path; client batching is explicit and observable.

## Cache invalidation

Keys include the normalized input, schema version, and only the provider identity relevant to that phase:

- changing the inspector model invalidates inspections, not research;
- changing the Blender recipe identity invalidates assets;
- changing the renderer contract invalidates screenshots;
- a file with the right key but wrong checksum is rejected.

## Semantic retrieval later

Category/style/tag retrieval is sufficient for the MVP and has zero embedding cost. When the asset library is large enough to demonstrate recall problems, add an `Array(Float32)` embedding produced locally in batches and a ClickHouse HNSW vector index. Keep exact keys and metadata filters as the first gate; vector similarity should expand candidates, never bypass checksum or compatibility checks.

## Migration

The local Compose image follows ClickHouse `26.3` LTS. Run:

```bash
npm run migrate
```

DDL uses `CREATE TABLE IF NOT EXISTS` plus additive `ALTER ... ADD COLUMN IF NOT EXISTS`, so upgrades from the previous schema are repeatable. ClickHouse Cloud uses the same adapter and schema; only TLS URL, database, username, and password change.
