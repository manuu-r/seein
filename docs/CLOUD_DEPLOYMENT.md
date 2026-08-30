# Cloud deployment

Use the same single runtime path in a long-running worker or job:

- API service writes project/graph state and starts work;
- worker runs Gemini research/source/inspection plus local TypeScript/esbuild and Playwright;
- durable artifacts go to object storage;
- ClickHouse stores searchable workflow lineage;
- the accepted anatomy-library index and module audit files are stored durably.

The worker needs no Python, 3D desktop application, GPU process, or MCP sidecar. Size CPU/memory and task timeout for Chromium plus the configured QA loop.
