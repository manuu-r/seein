# HTTP API

- `POST /api/projects` — start a guided run with `{ prompt, userId? }`.
- `GET /api/projects` — list runs.
- `GET /api/projects/:id` — project status.
- `GET /api/projects/:id/events` — ordered stage/provider events.
- `GET /api/projects/:id/interaction` — current graph state and scene URL.
- `POST /api/projects/:id/interaction/clarification` — submit clarification answers.
- `POST /api/projects/:id/interaction/research` — approve or revise research.
- `POST /api/projects/:id/interaction/feedback` — accept or request a linked revision.
- `POST /api/projects/:id/resume` — rewind to a resumable checkpoint.
- `POST /api/projects/:id/cancel` — cooperatively stop a run.
- `DELETE /api/projects/:id` — delete project-scoped artifacts and index rows.
- `GET /api/projects/:id/view` — open the guided viewer.

Provider events identify Gemini calls, source compilation, Playwright capture, attempts, duration, and exact errors. No event can report a fixture renderer or deterministic scene generator.
