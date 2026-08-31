import fs from "node:fs/promises";
import {
  GoogleGenAI,
  Modality,
  ThinkingLevel,
  type GroundingChunk,
  type GroundingSupport,
} from "@google/genai";
import { z } from "zod";
import { recordGeminiResponse } from "./gemini-usage.js";
import {
  SurgicalModuleSourceSchema,
  type SurgicalModuleRecoveryContext,
  type SurgicalModuleSource,
} from "../atlas/module-contracts.js";
import { anatomicalRegistryPromptReference } from "../atlas/anatomical-registry.js";
import type { SurgicalAtlasLibraryEntry } from "../atlas/module-library.js";
import type { Config } from "../config.js";
import {
  InspectionSchema,
  ResearchBriefSchema,
  type Inspection,
  type ResearchBrief,
  type SceneManifest,
  type SpatialReport,
} from "../contracts.js";
import {
  ClarificationTurnSchema,
  IntentAndAgendaSchema,
  ResearchDossierDraftSchema,
  ReferenceDiscoverySchema,
  ResearchPerspectiveResultSchema,
  type ClarificationAnswer,
  type ClarificationTurn,
  type IntentAndAgenda,
  type IntentFrame,
  type ResearchDossier,
  type ReferenceDiscovery,
  type ResearchAgenda,
  type ResearchPerspective,
  type ResearchPerspectiveResult,
  type UserPreferenceProfile,
} from "../workflow/graph-contracts.js";

const SURGICAL_ANATOMY_MANDATE = `SeeIn creates evidence-grounded educational 3D anatomy and procedure visualizations for surgeons. Treat every request as a surgical-anatomy communication task, not a generic 3D scene. Preserve anatomical identity, laterality, orientation, topology, attachment, containment, tissue planes, critical neurovascular structures, operative corridors, and procedure-state logic when they are relevant. Never invent anatomy, pathology, an approach, an instrument relationship, or a procedural step that is not supported by the approved request and evidence. The result supports education and communication; it is not patient-specific planning, diagnosis, or clinical advice.`;

/** A downloaded reference image, bound to the object study it depicts. */
export interface PlannerReferenceImage {
  studyId: string;
  studyName: string;
  mediaType: string;
  data: Buffer;
}

export interface QaInspectionContext {
  requestPrompt: string;
  approvedIntent?: IntentFrame | undefined;
  researchBrief: ResearchBrief;
  objectStudies: ResearchDossier["objectStudies"];
  intentCoverage: ResearchDossier["intentCoverage"];
  contradictions: ResearchDossier["contradictions"];
  targetId: string;
  stateId?: string | undefined;
  viewId?: string | undefined;
  targetLabel: string;
  passedTargetIds: string[];
  refinement: number;
}

export interface WorkflowAI {
  readonly identity: string;
  readonly researchIdentity: string;
  readonly synthesisIdentity: string;
  readonly moduleIdentity: string;
  readonly inspectionIdentity: string;
  readonly clarificationIdentity: string;
  readonly deepResearchIdentity: string;
  readonly referenceResearchIdentity: string;
  clarify(prompt: string, profile: UserPreferenceProfile): Promise<ClarificationTurn>;
  prepareIntent(
    prompt: string,
    clarification: ClarificationTurn,
    answers: ClarificationAnswer[],
    additionalContext: string,
    profile: UserPreferenceProfile,
  ): Promise<IntentAndAgenda>;
  researchPerspective(intent: IntentFrame, perspective: ResearchPerspective): Promise<ResearchPerspectiveResult>;
  researchReferences(intent: IntentFrame, agenda: ResearchAgenda): Promise<ReferenceDiscovery>;
  synthesizeResearch(
    intent: IntentFrame,
    perspectives: ResearchPerspectiveResult[],
  ): Promise<Omit<ResearchDossier, "perspectives" | "readiness" | "generatedAt">>;
  research(prompt: string): Promise<ResearchBrief>;
  generateSurgicalModule(
    prompt: string,
    research: ResearchBrief,
    intent?: IntentFrame,
    dossier?: ResearchDossier,
    referenceImages?: PlannerReferenceImage[],
    reusableAtlas?: SurgicalAtlasLibraryEntry[],
    recovery?: SurgicalModuleRecoveryContext,
  ): Promise<SurgicalModuleSource>;
  inspect(
    manifest: SceneManifest,
    screenshotPath: string,
    spatial?: SpatialReport,
    context?: QaInspectionContext,
    referenceImages?: PlannerReferenceImage[],
  ): Promise<Inspection>;
}

export class GeminiWorkflowAI implements WorkflowAI {
  readonly identity: string;
  readonly researchIdentity: string;
  readonly synthesisIdentity: string;
  readonly moduleIdentity: string;
  readonly inspectionIdentity: string;
  readonly clarificationIdentity: string;
  readonly deepResearchIdentity: string;
  readonly referenceResearchIdentity: string;
  private readonly ai: GoogleGenAI;

  constructor(private readonly config: Config) {
    if (!config.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is required: no fixture AI is available at runtime");
    this.ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
    this.identity = `gemini:${config.GEMINI_RESEARCH_MODEL}:${config.GEMINI_REFERENCE_MODEL}:${config.GEMINI_PLANNER_MODEL}:${config.GEMINI_INSPECTOR_MODEL}`;
    this.researchIdentity = `gemini-research:${config.GEMINI_RESEARCH_MODEL}:${config.GEMINI_REFERENCE_MODEL}:surgical-anatomy-v5`;
    this.synthesisIdentity = `gemini-research-synthesis:${config.GEMINI_PLANNER_MODEL}:surgical-anatomy-v3`;
    this.moduleIdentity = `gemini-atlas-module:${config.GEMINI_PLANNER_MODEL}:r3f-atlas-v2`;
    this.inspectionIdentity = `gemini-inspection:${config.GEMINI_INSPECTOR_MODEL}:surgical-visual-target-comparison-v4`;
    this.clarificationIdentity = `gemini-clarification:${config.GEMINI_PLANNER_MODEL}:surgical-anatomy-v2`;
    this.deepResearchIdentity = `gemini-perspective-research:${config.GEMINI_RESEARCH_MODEL}:surgical-anatomy-v4`;
    this.referenceResearchIdentity = `gemini-reference-research:${config.GEMINI_REFERENCE_MODEL}:surgical-anatomy-v2`;
  }

  async clarify(prompt: string, profile: UserPreferenceProfile): Promise<ClarificationTurn> {
    const result = await this.generateContent({
      model: this.config.GEMINI_PLANNER_MODEL,
      contents: `${SURGICAL_ANATOMY_MANDATE}

You are clarifying a surgeon-facing anatomy visualization before any research or generation. Identify only missing facts that could materially change the anatomy researched, surgical approach, laterality, pathology/variant, structures at risk, operative viewpoint, procedure sequence, spatial construction, or acceptance criteria.

Requested anatomy/procedure: ${prompt}
Explicit saved preferences: ${JSON.stringify(profile.preferences)}

Ask 1-4 concise, high-information questions. Prioritize anatomy region and laterality, procedure or teaching objective, surgical approach/viewpoint, pathology or anatomical variation, and the fidelity needed by the intended surgical audience. Do not ask all of these when the request already answers them. Give a short clinical-visual reason for each question and useful options where they reduce effort, while allowing free text. Do not ask for facts that authoritative research can resolve. Do not plan geometry yet. Never silently assume laterality, a surgical approach, pathology, or a patient-specific condition; surface those as questions or mark them explicitly unspecified.`,
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: toGeminiJsonSchema(ClarificationTurnSchema),
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      },
    });
    return ClarificationTurnSchema.parse(parseJsonResponse(result.text));
  }

  async prepareIntent(
    prompt: string,
    clarification: ClarificationTurn,
    answers: ClarificationAnswer[],
    additionalContext: string,
    profile: UserPreferenceProfile,
  ): Promise<IntentAndAgenda> {
    const result = await this.generateContent({
      model: this.config.GEMINI_PLANNER_MODEL,
      contents: `${SURGICAL_ANATOMY_MANDATE}

Convert this anatomy/procedure request and clarification exchange into an explicit surgeon-facing visual intent and a three-perspective research agenda. This is research planning only: do not write scene code or place scene structures.

Requested anatomy/procedure: ${prompt}
Questions and rationale: ${JSON.stringify(clarification)}
Answers: ${JSON.stringify(answers)}
Additional context: ${additionalContext || "None"}
Explicit saved preferences: ${JSON.stringify(profile.preferences)}

The agenda must contain exactly these perspective IDs:
- visual-identity: canonical anatomy, surface and deep landmarks, tissue boundaries, laterality/orientation cues, operative and radiologic views, normal variants, and dangerous lookalikes;
- objects-materials: required anatomical structures, tissue layers, lesions/implants/instruments only when requested, clinically meaningful visual encoding, transparency/cutaway needs, and structures at risk;
- scale-space: relative dimensions, branching/topology, attachment, containment, adjacency, neurovascular courses, safe/unsafe corridors, approach geometry, and diagnostic camera viewpoints.

Make the intent explicit about anatomy region, laterality, procedure/clinical focus, surgical approach, audience, viewing orientation, must-show structures, must-avoid errors, and teaching sequence using the available schema fields. Accuracy should normally be reference-faithful for surgeons unless the user explicitly requests simplification. For each perspective, write 2-8 self-questions and search hints whose answers would change anatomical construction or spatial evaluation. Evaluation criteria must be observable in the rendered views or measurable in the scene graph, including correct identity without labels, laterality, topology, critical relationships, and visibility of the requested operative corridor.`,
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: toGeminiJsonSchema(IntentAndAgendaSchema),
        thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
      },
    });
    return IntentAndAgendaSchema.parse(parseJsonResponse(result.text));
  }

  async researchPerspective(
    intent: IntentFrame,
    perspective: ResearchPerspective,
  ): Promise<ResearchPerspectiveResult> {
    // A demanding responseJsonSchema suppresses tool use: the model answers from
    // parametric knowledge and never issues a search, so grounding comes back empty.
    // Ground in free text first, then convert that grounded prose into the contract.
    const grounded = await this.generateContent({
      model: this.config.GEMINI_RESEARCH_MODEL,
      contents: `${SURGICAL_ANATOMY_MANDATE}

Research one evidence branch for a surgeon-facing anatomy visualization. Answer the supplied self-questions using grounded web search before drawing conclusions. This branch is evidence collection only: do not generate scene source.

Approved intent: ${JSON.stringify(intent)}
Perspective: ${JSON.stringify(perspective)}

Requirements:
- Prefer peer-reviewed anatomy or surgical literature, recognized anatomical atlases, radiology references, professional surgical societies, academic medical centers, standards, and device manufacturers for device-specific geometry. Distinguish general anatomy from technique-dependent or disputed claims.
- Bind every finding to one or more exact source URLs actually returned by search.
- Describe which anatomical, operative, endoscopic, cross-sectional, or radiologic views reveal identity and critical relationships; a separate image-search node collects the actual images.
- Record laterality, orientation convention, anatomical variation, evidence conflicts, and technique dependence instead of collapsing them into one invented answer.
- Return candidates only for anatomy, pathology, instruments, implants, landmarks, tissue planes, or contextual structures that are visually or spatially necessary for the approved teaching objective.`,
      config: {
        tools: [{ googleSearch: {} }],
        thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
      },
    });
    const grounding = grounded.candidates?.[0]?.groundingMetadata;
    // The extraction step paraphrases, so grounding-support text spans no longer match
    // the claims. Cite the grounded URLs explicitly instead of relying on span overlap.
    const groundedSourceList = (grounding?.groundingChunks ?? [])
      .flatMap((chunk) => (chunk.web?.uri ? [`- ${chunk.web.title || "source"}: ${chunk.web.uri}`] : []))
      .join("\n");
    const structured = await this.generateContent({
      model: this.config.GEMINI_RESEARCH_MODEL,
      contents: `${SURGICAL_ANATOMY_MANDATE}

Convert this grounded medical research into the required structure. Use only claims that appear in the research below; do not add knowledge of your own. Preserve anatomical terminology, laterality, orientation, variants, approach dependence, and uncertainty exactly enough for a surgeon-facing reconstruction.

Every finding's sourceUrls must be copied verbatim from this list of grounded sources. Do not shorten, rewrite, or invent a URL, and drop any finding you cannot attribute to one of them.

List a question in unansweredQuestions only if it blocks safe anatomical construction: it would change identity, laterality, topology, variation, approach, which structures exist, their geometry/scale, or their relationship to a critical structure. Preserve clinically meaningful technique variation as a contradiction or question when the approved intent depends on it. Return an empty list only when the evidence is sufficient for the requested fidelity and surgical viewpoint.
${groundedSourceList}

Perspective id: ${perspective.id}
Grounded research:
${grounded.text ?? ""}`,
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: toGeminiJsonSchema(ResearchPerspectiveResultSchema),
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      },
    });
    const parsed = ResearchPerspectiveResultSchema.parse(parseJsonResponse(structured.text));
    return mergePerspectiveGrounding(
      parsed,
      grounding?.groundingChunks ?? [],
      perspective.id,
      grounding?.groundingSupports ?? [],
    );
  }

  async researchReferences(intent: IntentFrame, agenda: ResearchAgenda): Promise<ReferenceDiscovery> {
    const result = await this.generateContent({
      model: this.config.GEMINI_REFERENCE_MODEL,
      contents: `${SURGICAL_ANATOMY_MANDATE}

Use Google Image Search to find a small, diverse visual reference set for this approved surgical-anatomy intent. Search for canonical anatomical views, operative exposure, relevant cross-sections or radiology, tissue planes, branching topology, scale cues, and critical spatial relationships. Prefer peer-reviewed figures, recognized atlases, professional societies, academic medical centers, radiology references, and authoritative device sources. Avoid stock/mood imagery, unverified diagrams, mislabeled laterality, and AI-generated anatomy. Do not create a new image; return only a short textual search summary.

Approved intent: ${JSON.stringify(intent)}
Research agenda: ${JSON.stringify(agenda)}`,
      config: {
        tools: [{ googleSearch: { searchTypes: { webSearch: {}, imageSearch: {} } } }],
        responseModalities: [Modality.TEXT],
        // Gemini 3.1 Flash Image supports MINIMAL or HIGH, unlike 3.7 Flash's LOW/MEDIUM/HIGH ladder.
        thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
      },
    });
    const grounding = result.candidates?.[0]?.groundingMetadata;
    return referenceDiscoveryFromGrounding(
      grounding?.groundingChunks ?? [],
      this.config.GEMINI_REFERENCE_MODEL,
      [...(grounding?.webSearchQueries ?? []), ...(grounding?.imageSearchQueries ?? [])],
      grounding?.searchEntryPoint?.renderedContent,
    );
  }

  async synthesizeResearch(
    intent: IntentFrame,
    perspectives: ResearchPerspectiveResult[],
  ): Promise<Omit<ResearchDossier, "perspectives" | "readiness" | "generatedAt">> {
    // Grounded source URLs are opaque redirect URIs, so the model has to copy them
    // verbatim; anything it rewrites is filtered out later as ungrounded.
    const citableUrls = uniqueBy(perspectives.flatMap((result) => result.sources), (source) => source.url)
      .map((source) => `- ${source.title}: ${source.url}`)
      .join("\n");
    const result = await this.generateContent({
      model: this.config.GEMINI_PLANNER_MODEL,
      contents: `${SURGICAL_ANATOMY_MANDATE}

Synthesize these three grounded research branches into a surgeon-facing anatomical generation dossier. Do not invent or alter URLs, and do not design primitive geometry yet.

Approved intent: ${JSON.stringify(intent)}
Research branches: ${JSON.stringify(perspectives)}

Every sourceUrls entry must be copied verbatim from this list. Do not shorten, rewrite, or substitute a publisher URL, and give every object study at least one of them:
${citableUrls}

Create one object study for every required anatomical structure, pathology, instrument, implant, tissue plane, or operative landmark. Each study must explain label-independent identity markers, subcomponents, tissue/material appearance, proportions, branching/topology, attachment/containment/adjacency, laterality and orientation when relevant, source URLs, reference-image URLs, and uncertainty. Explicitly identify structures at risk and relationships that must not be reversed, disconnected, intersected, hidden, or mirrored. For every approved intent.mustHave string, create exactly one intentCoverage entry that repeats the requirement verbatim and maps it to existing object-study IDs. Merge duplicates but expose normal variants, source conflicts, and technique-dependent alternatives. A question belongs in unresolvedQuestions when it blocks accurate construction of identity, topology, laterality, approach, geometry, scale, or critical relationships. Return an empty list only when the evidence supports the requested surgical teaching objective. The brief should be concise enough for planning while retaining concrete anatomical and spatial evidence.`,
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: toGeminiJsonSchema(ResearchDossierDraftSchema),
        thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
      },
    });
    const draft = ResearchDossierDraftSchema.parse(parseJsonResponse(result.text));
    return sanitizeDossierDraft(draft, perspectives);
  }

  async research(prompt: string): Promise<ResearchBrief> {
    const grounded = await this.generateContent({
      model: this.config.GEMINI_RESEARCH_MODEL,
      contents: `${SURGICAL_ANATOMY_MANDATE}

Research this anatomy/procedure request for 3D reconstruction: ${prompt}\n
Use grounded web search. Focus on label-independent anatomical identity, laterality/orientation, surface and deep landmarks, tissue planes, topology, attachments, containment, neurovascular relationships, relative scale, requested pathology or variation, surgical approach, operative viewpoints, and clinically meaningful visual encoding. Prefer authoritative medical evidence and expose conflicts or technique dependence. Do not invent URLs. Reference-image discovery is handled by a separate image-search node.`,
      config: {
        tools: [{ googleSearch: {} }],
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      },
    });
    const structured = await this.generateContent({
      model: this.config.GEMINI_RESEARCH_MODEL,
      contents: `${SURGICAL_ANATOMY_MANDATE}

Convert this grounded medical research into a concise anatomical visual brief. Use only claims and URLs that appear below; do not add knowledge of your own and do not invent URLs. Preserve laterality, orientation, topology, critical relationships, variations, and uncertainty explicitly.

Grounded research:
${grounded.text ?? ""}`,
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: toGeminiJsonSchema(ResearchBriefSchema),
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      },
    });
    const brief = ResearchBriefSchema.parse(parseJsonResponse(structured.text));
    const chunks = grounded.candidates?.flatMap((candidate) => candidate.groundingMetadata?.groundingChunks ?? []) ?? [];
    return mergeGrounding(brief, chunks);
  }

  async generateSurgicalModule(
    prompt: string,
    research: ResearchBrief,
    intent?: IntentFrame,
    dossier?: ResearchDossier,
    referenceImages: PlannerReferenceImage[] = [],
    reusableAtlas: SurgicalAtlasLibraryEntry[] = [],
    recovery?: SurgicalModuleRecoveryContext,
  ): Promise<SurgicalModuleSource> {
    const anatomicalRegistry = anatomicalRegistryPromptReference();
    const modulePrompt = `${SURGICAL_ANATOMY_MANDATE}

Write a complete React Three Fiber surgical-atlas scene module for this surgeon request:
${prompt}

Approved intent:
${JSON.stringify(intent ?? null)}

Grounded research brief:
${JSON.stringify(research)}

Approved object studies, coverage, and contradictions:
${JSON.stringify(dossier ? {
  objectStudies: dossier.objectStudies,
  intentCoverage: dossier.intentCoverage,
  contradictions: dossier.contradictions,
} : null)}

Surgical-atlas human registration and reusable placement catalogue:
${anatomicalRegistry}

Accepted prompt-specific atlas entries retrieved from earlier surgeon-reviewed modules:
${JSON.stringify(reusableAtlas.map((entry) => ({
  title: entry.title,
  prompt: entry.prompt,
  studyIds: entry.studyIds,
  structures: entry.structures,
  placements: entry.placements,
  acceptedScores: entry.acceptedScores,
})))}

${recovery ? `This is revision ${recovery.attempt + 1} after visual QA failed.
Failed view: ${recovery.failedViewId}; failed step: ${recovery.failedStepId ?? "unspecified"}
Views that passed on the previous source: ${JSON.stringify(recovery.passedTargetIds ?? [])}
Issue: ${recovery.issue}
Visible evidence: ${recovery.evidence}
Failed criteria: ${JSON.stringify(recovery.failedCriteria)}
Runtime renderer evidence (when present, this is exact browser evidence rather than a visual-QA opinion): ${JSON.stringify(recovery.rendererEvidence ?? null)}
Previous definition and source: ${JSON.stringify(recovery.previous)}

Correct the actual construction and camera responsible for the visible failure. When runtime renderer evidence is present, fix the named JavaScript/React/Three error or readiness condition first; do not hide it with labels, delays, error swallowing, or a non-rendering fallback. Treat the previous source as the source of truth: preserve its accurate geometry, definition, step/view IDs, cameras, placements, and every previously passed view byte-for-byte wherever possible. Make the smallest coherent source change that fixes the cited pixels or runtime failure. Broader reconstruction is allowed only when the failed criteria explicitly identify a cross-scene anatomical construction defect. Do not paper over missing geometry with a label, color, or explanation.` : ""}

The returned source is procedure-specific scene code. A trusted host supplies the Canvas, camera controls, lighting, operating room, UI, and active step. Export one default React component with this exact signature:

  function Scene({ activeStepId, showLabels, transparentPatient }: SurgicalModuleProps)

Allowed source imports are only "@seein/atlas", "react", and "three". Import SurgicalModuleProps as a type from "@seein/atlas". Do not import React Three Fiber, Drei, loaders, browser APIs, URLs, external assets, CSS, or another package. Do not include a Canvas or UI panel.

Curated @seein/atlas API:
- PatientOperatingContext: calibrated full adult MakeHuman body, operating table, clothing, anaesthetic mask, and drapes. Use it in every whole-patient or regional operative module. Props: transparent, drapeOpacity, transparentOpacity, torsoAlpha.
- CalibratedInternalAnatomy: the complete transformed Surgical Atlas internal reference in its human-body registration: lungs, heart, airway, diaphragm, liver, gallbladder, stomach, duodenum, pancreas, spleen, kidneys/adrenals, aorta/cava, colon, cecum/appendix, small bowel, mesentery, omentum, bladder, rectum, pelvic reflection, and skeletal context. Exact prop: faded. Render it once in every module so whole-patient and regional views retain anatomical context; use faded=true when the target field needs an unobstructed close-up.
- CalibratedLiverSurface: the licensed HuBMAP liver capsule and porta-hepatis surface fitted once to the Surgical Atlas right-upper-quadrant centimetre frame. It is a single stable organ scaffold analogous to the MakeHuman body, not a procedure scene or a hepatobiliary aggregate. Render it inside RightUpperQuadrantFrame for normal adult hepatobiliary scenes when a research-specific liver resection, mass, cirrhosis, or congenital morphology does not require a replacement LoftedOrgan/custom mesh. Props: opacity, color, portaColor, roughness, clearcoat. The generated module must still author every gallbladder, duct, artery, vein, landmark, tissue plane, variant/pathology, exposure state, instrument, and camera. Add prompt-specific surface overlays or replace this scaffold entirely when the approved research requires altered liver morphology.
- AnatomicalRegionFrame: generic centimetre frame registered to the 175 cm MakeHuman base. Exact props: id and children; optional magnification defaults to 1 and should normally remain 1. Valid IDs are "whole-body", "central-abdomen", "right-upper-quadrant", "lower-gastrointestinal", "pelvis", "right-groin", and "thorax". Use the frame matching the researched target; never put every request in the right upper quadrant.
- RegisteredStructureFrame: positions replaceable prompt-specific geometry at a known STATIC registry centre. Props: id and children. Its id must be one of the exact structure IDs in the supplied static placement catalogue—never a research-derived ID, semantic collection ID, instrument set, port set, or dynamically computed value. This component adds the registered centre and rotation itself, so every child must be authored locally around [0,0,0] in centimetres. Never put geometry that already uses atlasPoint absolute coordinates inside it.
- atlasPoint(id, expectedFrameId?) and atlasSize(id): return registered [x,y,z] centimetre tuples and nominal extents. Reuse atlasPoint results at branch junctions and attachments so coordinates do not drift between revisions. ANATOMICAL_REGISTRY, atlasFrame, and atlasStructure are also available for uncommon registered relationships.
- RightUpperQuadrantFrame: convenience alias for the registered right-upper-quadrant frame. Use it for every procedure-specific liver, gallbladder, duct, vessel, landmark, and laparoscopic instrument in a right-hepatic-hilum module. Its child space is centimetres, with +X patient-left, +Y cephalad, and +Z anterior. One child unit is 1 cm at true scale relative to the 175 cm patient base.
- LaparoscopicCholecystectomyPorts: correctly sized and registered umbilical optical, epigastric working, right midclavicular, and right anterior axillary ports. Props: showTrajectories and showHardware. It is already registered to the patient. Render it directly; NEVER wrap it in AnatomicalRegionFrame, RegisteredStructureFrame, or another positioning group, and do not construct trocar cylinders in atlas world space. Set showHardware=true only for whole-patient/setup views and false for magnified laparoscopic views so external trocar bodies never float across the operative field.
- OrganicOrgan: organic high-segment organ surface. Props include position, rotation, scale, color, opacity, roughness, clearcoat, irregularity, seed. Combine several researched lobes only when their union reads as one recognisable organ rather than a pile of spheres.
- ProfiledOrgan: a closed research-controlled viscus surface. Exact required props: points (at least three readonly [x,y,z] tuples), radii (one readonly [radiusX,radiusZ] pair per point), color. Optional props: opacity, radialSegments, segmentsPerSpan, roughness, clearcoat, seed, capFraction. Use it for gallbladder, stomach, bowel segments, elongated solid organs, aneurysms, and any target whose silhouette needs varying elliptical cross-sections. The generated points and profiles—not a baked asset—define morphology. Order points from one terminal pole to the other and use at least 7 samples for fundus/body/infundibulum/neck; ProfiledOrgan applies a rounded terminal taper, so do not model a fundus as an open end.
- LoftedOrgan: a smooth, closed, tissue-textured volume built entirely from request-authored control rings. Required props: rings (at least three equal ordered rings, each containing at least six [x,y,z] points) and color. Optional props: opacity, segmentsPerSpan, radialSegments, roughness, clearcoat, bumpScale, irregularity, seed. Use it for asymmetric parenchymal organs and complex target surfaces—especially the liver—where a centreline tube or a union of ellipsoids would be visibly wrong. Each ring is a CLOSED CROSS-SECTION through the organ, not a named anatomical surface layer. Order cross-sections monotonically from one physical edge/pole to the opposite edge/pole along one chosen principal axis; adjacent centroids must advance in that direction and must never return toward the first ring. Preserve identical point count and winding. Encode diaphragmatic versus visceral contour, lobar asymmetry, notches, fossae, and cut/exposure boundary by changing the points around successive cross-sections. Never sequence superior dome → visceral surface → posterior bare area, because that doubles back and self-intersects into a torus/strip. The generated control rings are the anatomy; this is not a baked organ asset.
- SculptedSheet: a curved tissue surface built from model-authored measured rows. Required props: rows (at least two equal rows of at least three [x,y,z] points) and color. Optional props: opacity, roughness, clearcoat, bumpScale, seed. Use it instead of a flat polygon for liver bed, cystic plate, dissected peritoneum, exposed connective-tissue fields, organ impressions, and other surfaces whose depth must follow nearby anatomy.
- TissueTube: constant-radius Catmull-Rom tissue tube with tissue material. Exact props: points, radius, color, opacity, radialSegments, tubularSegments, clearcoat, roughness, renderOrder, endCaps. points must be a readonly array of numeric [x,y,z] tuples, never THREE.Vector3[].
- TaperedTube: variable-radius Catmull-Rom tube. Props: points, radii, color, opacity, radialSegments, segmentsPerSpan, roughness, clearcoat. Use it for arteries, veins, ducts, nerves, bowel taper, and branching structures. Branch endpoints must meet exactly.
- MembraneSheet: triangulated tissue-plane boundary for fascia, mesentery, peritoneum, ligaments, windows, and operative planes. Exact props: points, color, opacity. Pass one ordered boundary as points; do not pass vertices, indices, roughness, or clearcoat.
- AnatomyLabel: optional label anchored to actual geometry. Props: position, accent, visible, with the displayed text as required JSX children between the opening and closing tags. Do not use a text prop and do not self-close it.
- SurgicalGrasper: articulated laparoscopic shaft, hinge, paired jaws, and contact pads. Required prop: points, an ordered centimetre trajectory ending exactly at the tissue contact point. Optional props: jawOpening, jawLength, shaftRadius, handleColor, jawColor. Use it for fundic and infundibular traction instead of TissueTube shafts; position two instances at the actual fundus and Hartmann pouch contact points and vary their points/jawOpening with the operative state.
- Advanced raw context components exist for library work: ColonFrame, CecumAndAppendix, SmallBowelBed, DuodenojejunalContinuity, MesentericBed, ThoracicOrgans, SurroundingOrgans, SkeletalContext, and PelvicContext take one required boolean prop named faded. Omentum takes no props. Do not place these raw components directly in generated modules; use CalibratedInternalAnatomy, whose transform chain is already registered to the human base.
- EquipmentTube and THREE.BufferGeometry may be used for genuinely custom organs, cut surfaces, lumens, fenestrations, clips, instruments, or meshes that these helpers cannot express.

Reusable construction lessons extracted from the Surgical Atlas reference code:
- Convincing operative anatomy is constructed from continuous custom surfaces, shared branch endpoints, anatomical depth fields, subtle multiscale bump, and layered physical materials. It is never a pile of semantic primitives.
- Large parenchymal organs need one continuous asymmetrical outer silhouette plus a separately modelled visceral surface/landmark relief. Author them with LoftedOrgan or a custom THREE.BufferGeometry; never use ProfiledOrgan as a liver and never approximate a liver by overlapping OrganicOrgan ellipsoids.
- Hollow viscera may use a centreline profile only when the profile explicitly forms fundus, body, infundibulum/Hartmann pouch, neck, and attachment. Duct and vessel daughters start at the identical parent endpoint and use short collars where needed so bifurcations read as continuous ostia.
- Dissected fields and fascia are curved depth-bearing SculptedSheet surfaces with restrained microtexture and anatomical edge shape. A flat MembraneSheet is suitable only for a thin overlay, window, or simple planar boundary.
- Wet tissue uses moderate roughness, a narrow restrained clearcoat/specular response, and subtle bump. Avoid toy gloss, glowing arteries, pure colors, transparent layers stacked across the whole field, and geometric seams.
- Operative cameras must put the target surface between camera and deep anatomy. In a magnified laparoscopic view, remove the external body/drape from the sightline and fade surrounding reference organs enough that ribs, bowel, and patient shell do not dominate or cross the target.

Construction requirements:
- The placement catalogue is authoritative registration extracted from the surgical-atlas reference project. It defines stable human scale, regional frames, known centres, nominal sizes, axes, junction landmarks, and proven camera starts. It does not prescribe one scene. Instantiate only the frames and structures required by the approved surgeon request and dossier.
- Prior accepted atlas entries are reusable placement evidence, not scene templates. Reuse a prior centre/size only when its anatomy, laterality, approach, and evidence match this request. Never copy its full structure list, sequence, or visual composition into an unrelated module.
- Vary the construction from the surgeon's actual request: pathology, normal variant, operative phase, approach, tissue exposure, instruments, teaching overlays, and cameras must come from the approved intent and research. Do not emit the cholecystectomy scene, groin scene, or any other memorized template for an unrelated prompt.
- Known structures should begin at atlasPoint/atlasSize registrations. Research controls detailed morphology and may justify a bounded adjustment, but a generated revision must not silently move an organ to make a camera easier. For a newly researched structure absent from the catalogue, place it relative to at least two named registered landmarks and preserve that same local coordinate in every step.
- Bind every known structure listed in definition.structures to rendered source with RegisteredStructureFrame id="structure-id" or an explicit atlasPoint/atlasSize/atlasStructure call using that exact ID. Choose exactly one coordinate strategy per object: either local geometry around [0,0,0] inside RegisteredStructureFrame, or absolute region-centimetre geometry placed with atlasPoint outside it—never both. A research-derived structure uses an ordinary group positioned from its definition.placements centerCm and at least two registered anchors; it must never use RegisteredStructureFrame. Placement metadata without a matching source binding is rejected.
- This must look like a detailed surgical-atlas module, not a primitive diagram. Include the patient/body or anatomically appropriate regional context, relevant surrounding organs/tissue planes, all must-show structures, structures at risk, landmarks, and the requested operative corridor.
- For right hepatic hilum and laparoscopic cholecystectomy, render PatientOperatingContext once, CalibratedInternalAnatomy once, LaparoscopicCholecystectomyPorts once directly at scene root, and all generated target anatomy inside one RightUpperQuadrantFrame. The runtime deliberately does not export a fixed HepatobiliaryAtlas scene. Generate, from the approved research, the liver/visceral surface, gallbladder fundus-body-infundibulum-neck continuum, cystic duct, common hepatic duct, common bile duct, cystic artery and terminal branches, right hepatic artery, portal vein, porta hepatis, hepatocystic triangle tissue, Rouviere sulcus, cystic plate/CVS window, requested variants, and instruments. Each known target must start from its exact catalogue registration, while its silhouette, paths, profiles, branching, surface detail, exposure, and phase-specific changes are authored in this source. For a classic normal adult request, prefer the one calibrated CalibratedLiverSurface scaffold and generate the entire operative hilum against it; for research-specific hepatic morphology, replace it with LoftedOrgan or custom BufferGeometry. Use ProfiledOrgan for the gallbladder and other genuinely centreline-defined hollow viscera; SculptedSheet for the curved cystic plate, liver bed, and exposed tissue fields; TaperedTube for every duct/vessel branch; MembraneSheet only for thin overlays; and identical shared endpoints at every junction. Express geometry in centimetres: an adult gallbladder is roughly 7-10 local units long, its body roughly 3-4 units wide, the common bile duct roughly 0.4-0.8 units in diameter, and the cystic artery roughly 0.15-0.3 units in diameter. Never author these structures at 0.001-0.1 atlas units and never hand-build external trocar geometry.
- Anatomy must remain recognizable without labels. Build distinctive lobes, necks, ducts, lumens, branches, surfaces, attachments, windows, and depth relationships. A sphere or tube may be a construction ingredient, never the entire semantic answer.
- Use the catalogue's coherent patient coordinate frame matching PatientOperatingContext. +Y is cephalad, +X is patient-left when supine, +Z is anterior. Laterality and operative camera direction must be explicit in the definition and geometry.
- Use nested groups to preserve anatomical attachment. At every vascular or duct junction, reuse the identical endpoint coordinate. Do not let branches float, overlap blindly, or pass through unrelated organs.
- Use tissue-appropriate physical material variation, restrained cutaway opacity, and layered depth. Preserve silhouettes and avoid transparency soup.
- Each procedure step must materially change exposure, anatomy, instrument position, highlight, or teaching state using activeStepId. Do not invent a clinical maneuver not supported by the evidence.
- Include 2-8 steps and enough required QA views to verify overview, operative focus, and critical deep relationships. Each QA view maps to an existing step; camera values must frame the actual construction.
- Use atlas-world camera coordinates in the definition, never centimetre-frame coordinates. For this right-upper-quadrant patient registration: whole-patient orientation is approximately position [0.25,-7.55,22.1], target [0,0.1,-0.72], fov 41; regional cutaway is approximately position [-0.15,-2.2,6.4], target [-0.45,1.65,-0.95], fov 38; laparoscopic exposure is approximately position [-0.35,0.05,1.35], target [-0.45,1.58,-0.94], fov 34-38; Calot/CVS macro is approximately position [-0.25,0.58,0.95], target [-0.43,1.54,-0.93], fov 30-34. Required QA views must include at least one regional or whole-patient orientation and at least two operative close-ups.
- A regional cutaway may be a transition step or optional QA view. Every required QA view whose purpose is subhepatic exposure, Calot dissection, CVS, or a danger-zone relationship must use a laparoscopic camera no more than 3.6 atlas units from its target; never assign the distant regional camera to an operative-field QA view.
- Whole-patient and regional-overview steps must set showLabels=false. Close-up steps may show at most four spatial labels at once, spread around the anatomy rather than stacked on one point; labels must never be the only representation of a structure.
- In the opaque whole-patient setup step, internal RightUpperQuadrantFrame geometry must remain anatomically recessed and be occluded by the body/drape; do not make the liver or gallbladder float on the skin or chest. The calibrated external ports remain visible. Regional and laparoscopic steps may reveal the internals by using transparentPatient and step-specific tissue visibility. In magnified laparoscopic steps, set PatientOperatingContext transparentOpacity and torsoAlpha at or below 0.035 and set LaparoscopicCholecystectomyPorts showHardware=false; the shell, ribs, abdominal wall, and external trocar bodies must not cross the operative field.
- Set CalibratedInternalAnatomy faded=true in every magnified operative step so surrounding organs do not mask the target field. For those steps set PatientOperatingContext drapeOpacity=0 or nearly zero; a drape sheet must never cross a required laparoscopic QA view.
- Every definition.structures entry must represent geometry actually present in source, and its studyId must be one of the approved dossier object-study IDs. Cover every intent must-have requirement.
- Every definition.structures entry must have exactly one definition.placements entry. Every placement, including registered entries, must list at least two stable anatomical anchorIds; never return an empty or one-item anchorIds array. Use basis="registered" when its centre/size comes from the surgical-atlas catalogue or a matching accepted entry. Use basis="research-derived" for a new part and explain its evidence-grounded relative placement. The source geometry must use the same frame and coordinates recorded in metadata.
- Use showLabels only to toggle AnatomyLabel components. Use transparentPatient to control body/cutaway exposure.
- The source must be self-contained, deterministic, compile as TSX, and normally be 7,000-100,000 characters. No placeholders, TODOs, fake anatomy, remote calls, hidden fallbacks, or fixed procedure-scene aggregate.
${referenceImages.length > 0 ? `
Approved reference images follow. Use them to reconstruct silhouette, topology, branching, tissue planes, relative scale, exposure, and operative viewpoint. Do not trace a single view blindly; resolve it through the approved dossier and preserve stated variation.` : ""}`;
    const result = await this.generateContent({
      model: this.config.GEMINI_PLANNER_MODEL,
      contents: [{
        role: "user",
        parts: [
          { text: modulePrompt },
          ...referenceImages.flatMap((image) => [
            { text: `Approved anatomical reference for study "${image.studyId}" (${image.studyName}):` },
            { inlineData: { data: image.data.toString("base64"), mimeType: image.mediaType } },
          ]),
        ],
      }],
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: toGeminiSurgicalModuleJsonSchema(
          dossier?.objectStudies.map((study) => study.id) ?? [],
        ),
        thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
      },
    });
    return SurgicalModuleSourceSchema.parse(parseJsonResponse(result.text));
  }


  async inspect(
    manifest: SceneManifest,
    screenshotPath: string,
    spatial?: SpatialReport,
    context?: QaInspectionContext,
    referenceImages: PlannerReferenceImage[] = [],
  ): Promise<Inspection> {
    const image = await fs.readFile(screenshotPath);
    const target = context
      ? {
          targetId: context.targetId,
          stateId: context.stateId,
          viewId: context.viewId,
          targetLabel: context.targetLabel,
          passedTargetIds: context.passedTargetIds,
          refinement: context.refinement,
        }
      : { targetId: "default", targetLabel: "default view" };
    const acceptanceBrief = {
      originalRequest: context?.requestPrompt ?? manifest.title,
      approvedIntent: context?.approvedIntent ?? null,
      research: context
        ? {
            concept: context.researchBrief.concept,
            summary: context.researchBrief.summary,
            visualNotes: context.researchBrief.visualNotes,
            objectNotes: context.researchBrief.objectNotes,
            styleKeywords: context.researchBrief.styleKeywords,
          }
        : null,
      objectStudies: context?.objectStudies ?? [],
      intentCoverage: context?.intentCoverage ?? [],
      contradictions: context?.contradictions ?? [],
    };
    const result = await this.generateContent({
      model: this.config.GEMINI_INSPECTOR_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `${SURGICAL_ANATOMY_MANDATE}

You are the visual quality controller for a surgeon-facing Three.js anatomy visualization. This is not a generic aesthetics review. Compare the rendered screenshot pixel-by-pixel and semantically against the approved acceptance brief below. The original request and approved intent define what the visualization must communicate; grounded anatomical studies define recognizable identity, landmarks, tissue planes, proportions, topology, laterality, orientation, relationships, and material encoding. Do not reward a polished render that depicts the wrong anatomy, mirrors laterality, hides a critical structure, invents a procedure step, or relies on labels/color to compensate for missing geometry.

Approved acceptance brief: ${JSON.stringify(acceptanceBrief)}
Screenshot target: ${JSON.stringify(target)}

Inspect the rendered visualization against that brief, its generated surgical-module definition, approved visual references, anatomical placement registry, and browser evidence. Judge only what is actually visible in this exact state/view. Explicitly verify label-independent anatomical recognizability; correct laterality and viewing orientation; topology, branching, attachment, containment, adjacency and scale; tissue-plane and depth readability; structures at risk; operative-corridor visibility; instrument relationships when requested; and whether the intended surgical teaching point is visible. Registered placement metadata is authoritative for known centres and nominal sizes; use the rendered screenshot for silhouette, topology, occlusion, depth ordering, tissue/material response, legibility, and semantic judgment.

Return a scored assessment on every inspection. recognizabilityScore asks whether a surgeon can identify the anatomy and operative orientation without relying on labels. domainFidelityScore asks whether landmarks, laterality, topology, relative scale, tissue planes, critical relationships, and procedural logic agree with approved evidence. visualQualityScore covers depth ordering, occlusion management, tissue/material differentiation, lighting, label legibility, and operative-view composition. constructionCompletenessScore asks whether every applicable must-show structure, structure at risk, evaluation criterion, procedure state, branch, and required view is actually present. A pass requires scores of at least ${this.config.WORKFLOW_MIN_RECOGNIZABILITY}, ${this.config.WORKFLOW_MIN_DOMAIN_FIDELITY}, ${this.config.WORKFLOW_MIN_VISUAL_QUALITY}, and ${this.config.WORKFLOW_MIN_CONSTRUCTION_COMPLETENESS} respectively, no required spatial error, and high-confidence visual evidence. Labels, color, or highlights cannot compensate for unrecognizable or missing anatomy. The issue and evidence fields must name the most consequential gap between the observed pixels and the approved acceptance brief.

Choose the highest-value correction that moves the observed render toward the approved surgical target. Use targeted-research when anatomical identity, variation, laterality, approach, proportions, topology, or a critical relationship is uncertain or contradicted. Use partial-replan for a generated-source construction, camera, visibility, material, or teaching-sequence defect. Return patch.kind none: the backend always replaces, validates, compiles, renders, and reinspects the complete TSX source. Return pass/none only when the rendered screenshot matches the approved target and every scored gate passes.

${manifest.module ? "This is a generated surgical-atlas source module. For every failure, identify the exact visible construction or camera defect and return patch.kind none. Never request a primitive-node, object-transform, or asset patch." : "The manifest is invalid because it has no generated surgical module; return a failing assessment."}

Manifest: ${JSON.stringify(manifest)} Placement evidence: ${JSON.stringify(spatial ?? null)}`,
            },
            { text: "Rendered scene screenshot — this is the candidate output to assess and correct:" },
            { inlineData: { data: image.toString("base64"), mimeType: "image/png" } },
            ...referenceImages.slice(0, 4).flatMap((reference) => [
              { text: `Approved anatomical reference for study "${reference.studyId}" (${reference.studyName}); compare identity, laterality, topology, tissue planes, and relationships against it, but do not mistake it for the rendered visualization:` },
              { inlineData: { data: reference.data.toString("base64"), mimeType: reference.mediaType } },
            ]),
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: toGeminiJsonSchema(InspectionSchema),
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      },
    });
    return InspectionSchema.parse(parseJsonResponse(result.text));
  }

  private generateContent(
    params: Parameters<GoogleGenAI["models"]["generateContent"]>[0],
  ) {
    return recordGeminiResponse(() => this.ai.models.generateContent(params));
  }
}


function mergeGrounding(brief: ResearchBrief, chunks: GroundingChunk[]): ResearchBrief {
  const sources = uniqueBy(
    chunks.flatMap((chunk) => chunk.web?.uri
      ? [{ url: chunk.web.uri, title: chunk.web.title || "Gemini grounded source", note: "Gemini Google Search grounding source" }]
      : []),
    (source) => source.url,
  );
  const references = groundedImageReferences(chunks);
  return ResearchBriefSchema.parse({
    ...brief,
    sources: sources.slice(0, 12),
    references: references.slice(0, 8),
  });
}

function referenceDiscoveryFromGrounding(
  chunks: GroundingChunk[],
  model: string,
  queries: string[],
  renderedContent?: string,
): ReferenceDiscovery {
  const references = groundedImageReferences(chunks).slice(0, 8);
  if (references.length > 0 && !renderedContent) {
    throw new Error("Gemini Image Search returned references without the required search-suggestion attribution");
  }
  return ReferenceDiscoverySchema.parse({
    references,
    ...(renderedContent
      ? { searchAttribution: { model, queries: [...new Set(queries)].slice(0, 16), renderedContent } }
      : {}),
  });
}

function groundedImageReferences(chunks: GroundingChunk[]) {
  return uniqueBy(
    chunks
      .filter((chunk): chunk is GroundingChunk & { image: { imageUri: string; sourceUri: string; title?: string; domain?: string } } =>
        Boolean(chunk.image?.imageUri && chunk.image.sourceUri),
      )
      .map((chunk) => ({
        imageUrl: chunk.image.imageUri,
        sourceUrl: chunk.image.sourceUri,
        title: chunk.image.title || chunk.image.domain || "Grounded reference image",
        relevance: "Gemini Image Search grounding reference",
      })),
    (reference) => reference.imageUrl,
  );
}

// Mirrors ResearchPerspectiveResultSchema.findings.min(2).
const MIN_GROUNDED_FINDINGS = 2;

function mergePerspectiveGrounding(
  result: ResearchPerspectiveResult,
  chunks: GroundingChunk[],
  expectedId: ResearchPerspective["id"],
  supports: GroundingSupport[],
): ResearchPerspectiveResult {
  const groundedSources = uniqueBy(
    chunks
      .filter((chunk): chunk is GroundingChunk & { web: { uri: string; title?: string } } => Boolean(chunk.web?.uri))
      .map((chunk) => ({
        url: chunk.web.uri,
        title: chunk.web.title || "Gemini grounded source",
        note: "Gemini Google Search grounding source",
      })),
    (source) => source.url,
  );
  const groundedReferences = groundedImageReferences(chunks);
  const allowedSources = new Set(groundedSources.map((source) => source.url));
  const sourceByChunkIndex = new Map(
    chunks.flatMap((chunk, index) => chunk.web?.uri ? [[index, chunk.web.uri] as const] : []),
  );
  const findings = result.findings.map((finding) => ({
    ...finding,
    sourceUrls: uniqueBy(
      [
        ...finding.sourceUrls.filter((url) => allowedSources.has(url)),
        ...supports
          .filter((support) => supportMatchesFinding(support, finding.claim, finding.whyItMatters))
          .flatMap((support) => support.groundingChunkIndices ?? [])
          .flatMap((index) => sourceByChunkIndex.get(index) ?? []),
      ],
      (url) => url,
    ).slice(0, 5),
  }));
  if (groundedSources.length === 0) throw new Error(`Research perspective ${expectedId} returned no grounded web sources`);
  // An unattributable claim carries no evidentiary weight, so it is dropped rather
  // than kept or allowed to kill the branch. The extraction step has to copy opaque
  // redirect URIs verbatim and occasionally rewrites one; losing that single claim
  // is the proportionate response. MIN_GROUNDED_FINDINGS matches the schema floor,
  // below which the branch genuinely has too little evidence to be worth keeping.
  const attributed = findings.filter((finding) => finding.sourceUrls.length > 0);
  if (attributed.length < MIN_GROUNDED_FINDINGS) {
    throw new Error(
      `Research perspective ${expectedId} produced ${attributed.length} of ${findings.length} findings with a grounded source URL, below the ${MIN_GROUNDED_FINDINGS} required`,
    );
  }
  return ResearchPerspectiveResultSchema.parse({
    ...result,
    perspectiveId: expectedId,
    findings: attributed,
    sources: groundedSources.slice(0, 12),
    references: groundedReferences.slice(0, 8),
  });
}

function supportMatchesFinding(support: GroundingSupport, claim: string, whyItMatters: string): boolean {
  const segment = normalizeEvidenceText(support.segment?.text ?? "");
  if (!segment) return false;
  const finding = normalizeEvidenceText(`${claim} ${whyItMatters}`);
  if (finding.includes(segment) || segment.includes(normalizeEvidenceText(claim))) return true;
  const segmentTokens = new Set(segment.split(" ").filter((token) => token.length >= 4));
  const findingTokens = new Set(finding.split(" ").filter((token) => token.length >= 4));
  if (segmentTokens.size === 0) return false;
  const overlap = [...segmentTokens].filter((token) => findingTokens.has(token)).length;
  return overlap / segmentTokens.size >= 0.55;
}

function normalizeEvidenceText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function sanitizeDossierDraft(
  draft: z.infer<typeof ResearchDossierDraftSchema>,
  perspectives: ResearchPerspectiveResult[],
): Omit<ResearchDossier, "perspectives" | "readiness" | "generatedAt"> {
  const sources = uniqueBy(perspectives.flatMap((result) => result.sources), (source) => source.url);
  const references = uniqueBy(perspectives.flatMap((result) => result.references), (reference) => reference.imageUrl);
  const allowedSources = new Set(sources.map((source) => source.url));
  const allowedReferences = new Set(references.map((reference) => reference.imageUrl));
  const studies = draft.objectStudies.map((study) => ({
    ...study,
    sourceUrls: study.sourceUrls.filter((url) => allowedSources.has(url)),
    referenceImageUrls: study.referenceImageUrls.filter((url) => allowedReferences.has(url)),
  }));
  // A study whose citations all fail the grounded-source filter has no provenance,
  // so keeping it would assert evidence the dossier cannot show. Drop it and let the
  // readiness gate see the gap rather than failing the run on a raw schema error.
  const grounded = studies.filter((study) => study.sourceUrls.length > 0);
  const dropped = studies.filter((study) => study.sourceUrls.length === 0);
  if (grounded.length === 0) {
    throw new Error(
      `Research synthesis returned ${studies.length} object studies but none cited a grounded source URL`,
    );
  }
  const keptStudyIds = new Set(grounded.map((study) => study.id));
  const coverage = draft.intentCoverage
    .map((entry) => ({ ...entry, objectStudyIds: entry.objectStudyIds.filter((id) => keptStudyIds.has(id)) }))
    .filter((entry) => entry.objectStudyIds.length > 0);
  if (coverage.length === 0) {
    throw new Error("Research synthesis left no approved requirement covered by a grounded object study");
  }
  return ResearchDossierDraftSchema.parse({
    ...draft,
    brief: {
      ...draft.brief,
      sources: sources.slice(0, 12),
      references: references.slice(0, 8),
    },
    objectStudies: grounded,
    intentCoverage: coverage,
    unresolvedQuestions: [
      ...draft.unresolvedQuestions,
      ...dropped.map((study) => `${study.name} was dropped: no grounded source URL supported it.`.slice(0, 500)),
    ].slice(0, 8),
  });
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const id = key(value);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

// Gemini's responseJsonSchema rejects a request once a schema nests enough array
// item-count keywords; each one is fine alone, so the limit is on the combination.
// Fold the bounds into the description instead — the model still sees them, and
// Zod re-enforces the real constraint when the response is parsed.
function toGeminiJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return sanitizeForGemini(z.toJSONSchema(schema)) as Record<string, unknown>;
}

// Zod refinements are intentionally not emitted by z.toJSONSchema. The generated
// module is therefore parsed again with the full runtime schema before compilation.
export function toGeminiSurgicalModuleJsonSchema(approvedStudyIds: string[] = []): Record<string, unknown> {
  const schema = toGeminiJsonSchema(SurgicalModuleSourceSchema);
  const ids = [...new Set(approvedStudyIds)].sort();
  if (ids.length === 0) return schema;
  const properties = requireSchemaRecord(schema.properties, "surgical module properties");
  const definition = requireSchemaRecord(properties.definition, "surgical module definition");
  const definitionProperties = requireSchemaRecord(definition.properties, "surgical module definition properties");
  const structures = requireSchemaRecord(definitionProperties.structures, "surgical module structures");
  const structureItems = requireSchemaRecord(structures.items, "surgical module structure items");
  const structureProperties = requireSchemaRecord(structureItems.properties, "surgical module structure properties");
  setAllowedStudyIds(structureProperties.studyId, ids, "Use an approved object-study ID exactly.");
  return schema;
}


function setAllowedStudyIds(value: unknown, ids: string[], description: string): void {
  const schema = requireSchemaRecord(value, "study ID property");
  schema.enum = ids;
  schema.description = description;
}

function requireSchemaRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Gemini scene schema is missing ${label}`);
  }
  return value as Record<string, unknown>;
}

function sanitizeForGemini(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeForGemini);
  if (!node || typeof node !== "object") return node;
  // Gemini also rejects a request once a schema carries enough prefixItems tuples.
  // Collapse homogeneous tuples to a plain typed array and state the arity in
  // the description; Zod re-enforces the real tuple length when parsing the response.
  const tuple = (node as Record<string, unknown>).prefixItems;
  if (Array.isArray(tuple) && tuple.length > 0) {
    const kinds = new Set(tuple.map((entry) => (entry as Record<string, unknown> | null)?.type));
    if (kinds.size === 1) {
      const { prefixItems, items, minItems: tupleMin, maxItems: tupleMax, description, ...keep } =
        node as Record<string, unknown>;
      const arity = `Provide exactly ${tuple.length} items.`;
      return {
        ...Object.fromEntries(Object.entries(keep).map(([key, value]) => [key, sanitizeForGemini(value)])),
        type: "array",
        items: { type: [...kinds][0] },
        description: typeof description === "string" ? `${description} ${arity}` : arity,
      };
    }
  }
  const source = node as Record<string, unknown>;
  const hasConst = Object.hasOwn(source, "const");
  const { const: literalValue, minItems, maxItems, ...rest } = source;
  const sanitized: Record<string, unknown> = Object.fromEntries(
    Object.entries(rest).map(([key, value]) => [key, sanitizeForGemini(value)]),
  );
  // Zod emits z.literal() as JSON Schema `const`, but Gemini's
  // responseJsonSchema subset does not support that keyword. A singleton enum
  // expresses the same constraint and, critically, preserves discriminators.
  if (hasConst) {
    if (typeof literalValue !== "string" && typeof literalValue !== "number") {
      throw new Error("Gemini JSON Schema only supports string or number literal enums");
    }
    sanitized.enum = [literalValue];
  }
  const bound = describeItemBound(minItems, maxItems);
  if (bound) {
    const existing = typeof sanitized.description === "string" ? `${sanitized.description} ` : "";
    sanitized.description = `${existing}${bound}`;
  }
  return sanitized;
}

function describeItemBound(minItems: unknown, maxItems: unknown): string {
  const min = typeof minItems === "number" ? minItems : undefined;
  const max = typeof maxItems === "number" ? maxItems : undefined;
  if (min !== undefined && max !== undefined) return `Provide ${min}-${max} items.`;
  if (min !== undefined) return `Provide at least ${min} items.`;
  if (max !== undefined) return `Provide at most ${max} items.`;
  return "";
}

function parseJsonResponse(text: string | undefined): unknown {
  if (!text) throw new Error("Gemini returned an empty response");
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(stripped);
}
