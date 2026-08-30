# Project structure

```text
src/
  ai/workflow-ai.ts              Gemini clarification, research, module generation, visual QA
  atlas/
    anatomical-registry.ts       registry loader and placement validation
    module-contracts.ts          generated module/placement contracts
    module-compiler.ts           source sandbox, TypeScript validation, esbuild
    module-library.ts            accepted placement library and retrieval
  context/                       memory and ClickHouse workflow stores
  workflow/                      interactive graph and generation supervisor
renderer/
  atlas/
    anatomical-registry.json     MakeHuman-relative frames, structures, cameras
    AnatomicalRegistry.tsx       frame/structure registration components
    PatientAtlas.tsx             calibrated patient and internal context
    OperatingRoom.tsx            reusable room and equipment
    OrganicAnatomy.tsx           reusable organ/tissue geometry helpers
    RegionalAnatomy.tsx          centimetre-scaled regional frames
    HepatobiliaryAtlas.tsx       non-exported RUQ registration/construction reference
  main.ts                        graph UI and compiled-module host
reference-projects/surgical-atlas/
                                 coordinate and component provenance
data/
  projects/                      isolated run artifacts
  library/anatomy/               accepted reusable placements and audit source
```
