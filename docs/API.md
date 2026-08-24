# HTTP API

The API is asynchronous and interruptible. Creating a project returns `202` after the project folder exists. The backend then reaches a typed wait state; the browser only displays that state and submits user input.

## Create a project

```http
POST /api/projects
content-type: application/json

{"prompt":"A compact medieval blacksmith workshop","userId":"local-user"}
```

The response includes `projectId`, `statusUrl`, `eventsUrl`, `interactionUrl`, and `viewerUrl`.

## Read the interaction graph

```http
GET /api/projects/:projectId/interaction
```

The response contains the project, latest checkpointed graph `state`, and `sceneUrl`. Poll this endpoint while the state is `running`. Stop and render the appropriate form when it is `waiting`.

## Resume clarification

```http
POST /api/projects/:projectId/clarifications
content-type: application/json

{
  "answers":[
    {"questionId":"audience-purpose","answer":"Museum visitors; explain how the tools work together."},
    {"questionId":"accuracy-style","answer":"Reference-faithful silhouettes with simplified materials."}
  ],
  "additionalContext":"Begin with an overview."
}
```

Question IDs must come from the current graph checkpoint. All required questions must be answered.

## Approve or extend research

```http
POST /api/projects/:projectId/research-decision
content-type: application/json

{"decision":"approve","feedback":""}
```

Use `{"decision":"research-more","feedback":"Find better evidence for the bellows proportions"}` for one bounded follow-up round. Approval is rejected unless the deterministic readiness gate passes.

## Submit final feedback

```http
POST /api/projects/:projectId/feedback
content-type: application/json

{
  "decision":"accept",
  "categories":[],
  "objectIds":[],
  "comment":"The overview-first teaching order is right.",
  "preferences":[{"key":"overview-order","value":"Overview before component focus"}]
}
```

`decision` may be `accept`, `revise-scene`, or `revise-intent`. A revision creates a linked project with the same user preference profile; the response includes that project.

## Inspect status

```http
GET /api/projects/:projectId
GET /api/projects/:projectId/events
GET /api/projects/:projectId/scene/latest
GET /api/projects/:projectId/view
```

`scene/latest` returns `404` until an assembled revision exists. `view` opens the generic renderer in guided-project mode; direct screenshot rendering still passes an immutable manifest URL.

## Rerun

```http
POST /api/projects/:projectId/rerun
```

Rerunning creates a linked project and run for the same user. Research branches, plans, assets, clean renders, and inspections remain globally reusable through ClickHouse and content-addressed artifact storage.

## Failure contract

A failed run remains queryable. Its graph checkpoint contains the exact failed node and guidance, while its project record and `logs/events.ndjson` preserve the stage, stack, and completed transitions. Provider failures are not replaced by deterministic output.
