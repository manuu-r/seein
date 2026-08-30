# Workflow

## Research before construction

The interactive graph clarifies clinically meaningful uncertainty, then runs three medical evidence branches plus anatomical image discovery. Synthesis produces object studies, critical spatial relationships, intent coverage, contradictions, and readiness gaps. Generation does not begin until the dossier is approved.

## Placement and scale

Every structure has one placement record:

- `registered`: exact frame, centre, size, and rotation from the stable atlas;
- `research-derived`: a new part positioned relative to at least two named anchors.

The backend rejects known structures that drift from their registered centre or nominal size and rejects placements outside regional bounds.

## Source generation

Gemini receives the full static registry, approved research, relevant reference images, the curated component API, and only the placement metadata from relevant accepted modules. It must produce a complete deterministic TSX module plus structure, placement, step, and QA-view metadata.

## Visual correction

Every required QA view is rendered by Chromium. Gemini inspects the actual PNG against the approved intent, research, structures, topology, scale, laterality, tissue planes, operative corridor, and critical relationships. A failure always requests replacement TSX; local primitive or transform patches do not exist.

After any replacement, all required views must pass again at that same source revision. Only then is the module accepted and its placement metadata added to the reusable library.
