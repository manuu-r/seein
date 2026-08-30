# Architecture

The backend owns research, placement retrieval, source generation, validation, compilation, rendering, inspection, and acceptance. The frontend only displays the graph and mounts a compiled surgical module.

```text
surgeon prompt
  -> clarification
  -> parallel grounded research + structure references
  -> evidence approval
  -> stable anatomical registry + relevant accepted placements
  -> Gemini request-specific R3F source
  -> Zod placement contract + source sandbox + TypeScript + esbuild
  -> Playwright render for every required step/view
  -> Gemini multimodal QA
       pass all views at one revision -> accepted anatomy library
       failure -> full-source replacement -> compile/render/inspect again
```

The static registry is based on the Codex-built `reference-projects/surgical-atlas` MakeHuman coordinate system. Dynamic accepted entries extend it with new research-derived structures anchored to at least two registered landmarks.

Generated modules may import only React, Three.js, and `@seein/atlas`. Network calls, storage access, dynamic imports, Node APIs, and arbitrary packages are rejected. The viewer refuses manifests without a compiled module.
