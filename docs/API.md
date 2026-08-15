# HTTP API

The API is asynchronous. Creating a project returns `202` after the project folder exists; the workflow continues in the backend.

## Create a project

```http
POST /api/projects
content-type: application/json

{"prompt":"A compact medieval blacksmith workshop"}
```

The response includes `projectId`, `statusUrl`, `eventsUrl`, and `viewerUrl`.

## Inspect status

```http
GET /api/projects/:projectId
GET /api/projects/:projectId/events
GET /api/projects/:projectId/scene/latest
GET /api/projects/:projectId/view
```

`scene/latest` returns `404` until the first assembled revision exists. `view` redirects to the generic renderer with that endpoint as its manifest input.

## Rerun

```http
POST /api/projects/:projectId/rerun
```

Rerunning creates a new project and run. Research, plans, assets, clean renders, and inspections remain globally reusable through ClickHouse and content-addressed artifact storage.

## Failure contract

A failed run remains queryable. Its project record contains the failing stage and stack, while `logs/events.ndjson` preserves all completed transitions. Provider failures are not replaced by deterministic output.
