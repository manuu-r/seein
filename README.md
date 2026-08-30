# SeeIn Local Core

SeeIn turns a surgeon's prompt into an evidence-grounded, live React Three Fiber surgical visualization.

The runtime has one scene path:

1. clarify anatomy, laterality, approach, variation, audience, and teaching goal;
2. run three grounded medical research perspectives and collect structure-specific reference images;
3. require review of the evidence dossier;
4. retrieve stable human/anatomical registrations and relevant accepted placements;
5. ask Gemini for complete request-specific TSX source against `@seein/atlas`;
6. validate placement metadata, constrain imports, typecheck, and bundle the source;
7. render every required view with Playwright and send the real PNG to Gemini;
8. replace the complete source on failure and accept it only when all views pass one revision;
9. promote accepted placement/size metadata to the reusable anatomy library.

There is no fixture AI, placeholder PNG, primitive-scene fallback, GLB recipe path, or alternate 3D generator. Generation or rendering failures are shown as errors.

## Anatomical reference model

`reference-projects/surgical-atlas` is the provenance source for the reusable atlas:

- a 175 cm CC0 MakeHuman base at 13.4 atlas units;
- supine patient, operating-room, abdominal, thoracic, pelvic, and right-groin frames;
- registered organ/landmark centres, nominal sizes, axes, and camera starts;
- reusable R3F patient, room, tissue, organ, vessel, duct, membrane, and regional components.

Stable registration is deliberately separate from morphology. Each prompt produces new visual anatomy from the approved research; the registry only prevents floating, buried, mirrored, or mis-scaled structures. Accepted new structures are stored with frame, centre, size, rotation, anchors, and QA scores. Prior scene source remains audit evidence and is not copied into unrelated prompts.

## Run locally

Requirements: Docker, Docker Compose, a Gemini API key, and internet access. The
workflow calls Gemini live; there is no offline or mock mode.

```bash
git clone https://github.com/manuu-r/seein.git
cd seein
cp .env.example .env
```

Set `GEMINI_API_KEY` in `.env`. To run without downloaded reference images, also
set `REFERENCE_SEARCH_DRIVER=none`; grounded textual research still runs and no
Firecrawl key is needed. To exercise the full image-grounded path instead, set
`FIRECRAWL_API_KEY` and leave the driver at its default.

```bash
docker compose up --build
```

The first build pulls Playwright Chromium and is the slowest step. ClickHouse
migrations run automatically. Open http://localhost:8787.

## Walking through a run

Enter a surgical teaching prompt, for example:

> Laparoscopic cholecystectomy, critical view of safety, for surgical trainees

The run then moves through five stages, streamed live:

1. **Clarify** — anatomy, laterality, approach, variation, audience, and teaching goal.
2. **Research dossier** — three grounded medical research perspectives run in parallel and are synthesized into object studies, spatial relationships, contradictions, and readiness gaps. The dossier must be approved before generation starts.
3. **Generation** — Gemini writes a complete React Three Fiber module against `@seein/atlas`. Placement, scale, and laterality are validated against the registered anatomical model, imports are constrained, and the source is typechecked and bundled.
4. **Visual QA** — Chromium renders every required view and the real PNG is sent back to Gemini for inspection against the approved intent. A failure requests replacement source, and all views must pass again at that same revision.
5. **Accepted scene** — explore the result in the viewer and step through the procedure. Accepted placement metadata is promoted to the reusable anatomy library.

A run is bounded by `WORKFLOW_MAX_RUNTIME_MINUTES` (default 30) along with limits
on logical AI calls, source repairs, and QA targets.

## Direct development

Use Node 22 or newer.

```bash
npm ci
npx playwright install chromium
npm run typecheck
npm test
docker compose up clickhouse -d
npm run migrate
npm run dev
```

See [architecture](docs/ARCHITECTURE.md), [workflow](docs/WORKFLOW.md), [local setup](docs/LOCAL_SETUP.md), and [verification](docs/VERIFICATION.md).
