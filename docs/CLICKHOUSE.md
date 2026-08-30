# ClickHouse

ClickHouse indexes workflow state and lineage; generated TSX, bundles, reference images, and PNGs remain in artifact storage.

Active tables cover:

- projects and ordered run events;
- research and workflow caches;
- graph checkpoints and user preferences;
- scene/module revisions and procedure states;
- renders, QA reports, per-view QA results, and spatial issue summaries;
- quality-supervisor checkpoints.

Accepted cross-project anatomy lives in `data/library/anatomy`. Its JSON index stores structure/placement metadata and QA scores; source files are retained beside definitions for audit. The prompt retriever returns metadata, not prior TSX.
