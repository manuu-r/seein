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

Requirements: Docker, Docker Compose, and a Gemini API key.

```bash
cp .env.example .env
# Set GEMINI_API_KEY, then:
docker compose up --build
```

Open http://localhost:8787. ClickHouse migrations run automatically. The worker image contains Node, the generated-source compiler, and Playwright Chromium.

For direct development:

```bash
npm ci
npx playwright install chromium
npm run typecheck
npm test
npm run dev
```

See [architecture](docs/ARCHITECTURE.md), [workflow](docs/WORKFLOW.md), [local setup](docs/LOCAL_SETUP.md), and [verification](docs/VERIFICATION.md).
