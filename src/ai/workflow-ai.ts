import fs from "node:fs/promises";
import {
  GoogleGenAI,
  Modality,
  ThinkingLevel,
  type GroundingChunk,
  type GroundingSupport,
} from "@google/genai";
import { z } from "zod";
import type { Config } from "../config.js";
import { boundsSize, recipeBounds } from "../scene/geometry-bounds.js";
import { validateProceduralReferences } from "../scene/procedural-analyzer.js";
import {
  InspectionSchema,
  ResearchBriefSchema,
  ScenePlanSchema,
  type Inspection,
  type ResearchBrief,
  type ReusableProceduralComponent,
  type SceneManifest,
  type ScenePlan,
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

export interface PlanRecoveryContext {
  attempt: number;
  reason: string;
  targetStudyIds: string[];
  failedTargetIds: string[];
  previousPlan: ScenePlan;
  inspection: Inspection;
}

export interface WorkflowAI {
  readonly identity: string;
  readonly researchIdentity: string;
  readonly planningIdentity: string;
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
  plan(
    prompt: string,
    research: ResearchBrief,
    maxObjects: number,
    intent?: IntentFrame,
    dossier?: ResearchDossier,
    referenceImages?: PlannerReferenceImage[],
    reusableProcedural?: ReusableProceduralComponent[],
    recovery?: PlanRecoveryContext,
  ): Promise<ScenePlan>;
  inspect(
    manifest: SceneManifest,
    screenshotPath: string,
    spatial?: SpatialReport,
    plan?: ScenePlan,
    context?: QaInspectionContext,
    referenceImages?: PlannerReferenceImage[],
  ): Promise<Inspection>;
}

export class GeminiWorkflowAI implements WorkflowAI {
  readonly identity: string;
  readonly researchIdentity: string;
  readonly planningIdentity: string;
  readonly inspectionIdentity: string;
  readonly clarificationIdentity: string;
  readonly deepResearchIdentity: string;
  readonly referenceResearchIdentity: string;
  private readonly ai: GoogleGenAI;

  constructor(private readonly config: Config) {
    if (!config.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is required for AI_DRIVER=gemini");
    this.ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
    this.identity = `gemini:${config.GEMINI_RESEARCH_MODEL}:${config.GEMINI_REFERENCE_MODEL}:${config.GEMINI_PLANNER_MODEL}:${config.GEMINI_INSPECTOR_MODEL}`;
    this.researchIdentity = `gemini-research:${config.GEMINI_RESEARCH_MODEL}:${config.GEMINI_REFERENCE_MODEL}:surgical-anatomy-v5`;
    this.planningIdentity = `gemini-planning:${config.GEMINI_RESEARCH_MODEL}:${config.GEMINI_PLANNER_MODEL}:surgical-anatomy-self-heal-v4`;
    this.inspectionIdentity = `gemini-inspection:${config.GEMINI_INSPECTOR_MODEL}:surgical-visual-target-comparison-v4`;
    this.clarificationIdentity = `gemini-clarification:${config.GEMINI_PLANNER_MODEL}:surgical-anatomy-v2`;
    this.deepResearchIdentity = `gemini-perspective-research:${config.GEMINI_RESEARCH_MODEL}:surgical-anatomy-v4`;
    this.referenceResearchIdentity = `gemini-reference-research:${config.GEMINI_REFERENCE_MODEL}:surgical-anatomy-v2`;
  }

  async clarify(prompt: string, profile: UserPreferenceProfile): Promise<ClarificationTurn> {
    const result = await this.ai.models.generateContent({
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
    const result = await this.ai.models.generateContent({
      model: this.config.GEMINI_PLANNER_MODEL,
      contents: `${SURGICAL_ANATOMY_MANDATE}

Convert this anatomy/procedure request and clarification exchange into an explicit surgeon-facing visual intent and a three-perspective research agenda. This is research planning only: do not design Blender primitives or place scene structures.

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
    const grounded = await this.ai.models.generateContent({
      model: this.config.GEMINI_RESEARCH_MODEL,
      contents: `${SURGICAL_ANATOMY_MANDATE}

Research one evidence branch for a surgeon-facing anatomy visualization. Answer the supplied self-questions using grounded web search before drawing conclusions. This branch is evidence collection only: do not generate a scene plan or Blender recipe.

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
    const structured = await this.ai.models.generateContent({
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
    const result = await this.ai.models.generateContent({
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
    const result = await this.ai.models.generateContent({
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
    const grounded = await this.ai.models.generateContent({
      model: this.config.GEMINI_RESEARCH_MODEL,
      contents: `${SURGICAL_ANATOMY_MANDATE}

Research this anatomy/procedure request for 3D reconstruction: ${prompt}\n
Use grounded web search. Focus on label-independent anatomical identity, laterality/orientation, surface and deep landmarks, tissue planes, topology, attachments, containment, neurovascular relationships, relative scale, requested pathology or variation, surgical approach, operative viewpoints, and clinically meaningful visual encoding. Prefer authoritative medical evidence and expose conflicts or technique dependence. Do not invent URLs. Reference-image discovery is handled by a separate image-search node.`,
      config: {
        tools: [{ googleSearch: {} }],
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      },
    });
    const structured = await this.ai.models.generateContent({
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

  async plan(
    prompt: string,
    research: ResearchBrief,
    maxObjects: number,
    intent?: IntentFrame,
    dossier?: ResearchDossier,
    referenceImages: PlannerReferenceImage[] = [],
    reusableProcedural: ReusableProceduralComponent[] = [],
    recovery?: PlanRecoveryContext,
  ): Promise<ScenePlan> {
    const planPrompt = `${SURGICAL_ANATOMY_MANDATE}

Create a compact, deterministic, surgeon-facing Three.js anatomy visualization plan for this request:\n${prompt}\n
Approved intent:\n${JSON.stringify(intent ?? null)}\n
Research brief:\n${JSON.stringify(research)}\n
Approved object studies and intent coverage:\n${JSON.stringify(dossier ? {
  objectStudies: dossier.objectStudies,
  intentCoverage: dossier.intentCoverage,
  contradictions: dossier.contradictions,
} : null)}\n
Reusable procedural components retrieved from prior revisions:
${JSON.stringify(reusableProcedural.map((component) => ({
  componentKey: component.componentKey,
  node: component.node,
  material: component.material,
  landmarks: component.landmarks,
})))}\n
${recovery ? `Self-healing revision request:
Attempt: ${recovery.attempt}
Reason: ${recovery.reason}
Affected object studies: ${JSON.stringify(recovery.targetStudyIds)}
Failed state/view targets: ${JSON.stringify(recovery.failedTargetIds)}
Previous inspection: ${JSON.stringify(recovery.inspection)}
Previous plan: ${JSON.stringify(recovery.previousPlan)}

Preserve correct entities and IDs. Change only the construction, assets, materials, views, or states needed to resolve the evidenced failure. Do not merely restate the previous plan.` : ""}

Constraints:
- Return actual scene geometry. The plan must contain at least one imported object, a procedural program, or both; never return an empty objects array while omitting procedural.
- Anatomical fidelity outranks decoration. Do not add generic platforms, markers, furniture, scenery, or contextual props unless the approved intent explicitly requires them.
- Preserve laterality and use a documented anatomical/operative orientation. Never mirror anatomy implicitly. Include orientation cues in labels or view names when ambiguity is possible.
- Model every critical structure and relationship required by the approved intent. A label, color, glow, or highlight cannot substitute for missing or unrecognizable geometry.
- Use tissue-appropriate, distinguishable materials and restrained transparency/cutaways to expose deep relationships without making anatomy unreadable. Do not rely on color alone to distinguish adjacent structures.
- Use shared landmarks and invariants for branches, lumens, attachments, containment, safe corridors, and structure-at-risk proximity. Do not allow vessels, nerves, ducts, or tissue layers to terminate, intersect, float, or pass through anatomy without evidence.
- Required views should include an orientation overview plus the operative or diagnostic views needed to verify the requested teaching point. Add cross-sectional, endoscopic, or approach-aligned views when supported by the intent.
- Procedure states must show meaningful anatomical exposure or instrument/structure changes in evidence-supported order. Do not invent a maneuver. Alternatives and complications are included only when requested or grounded.
- Author a declarative procedural program whenever the concept contains connected paths, layered structures, repeated forms, cutaways, flows, or state-dependent construction. The backend owns this program; never return JavaScript.
- Use imported Blender assets only for isolated shapes that the procedural kernels cannot express. Use at most ${maxObjects} imported objects and ${maxObjects} asset specs; an all-procedural plan may use zero.
- Each imported asset must be expressible using 1-16 bounded Blender primitives.
- Imported dimensions, positions, scales, camera coordinates, and light positions are in meters. Procedural coordinates use coordinateFrame.units and are converted with metersPerUnit.
- Use radians for rotations.
- Keep every structure near the origin and anatomically attached, contained, adjacent, or intentionally isolated according to evidence.
- Create labels for meaningful anatomy and operative landmarks. Use labelPosition when automatic placement would obscure, overlap, or misidentify a feature.
- Prefer connected, measurable construction over decorative detail. Use shared landmarks for any endpoints that must remain connected across states or revisions.
- Give procedural nodes explicit dependency links, meaningful layers, deterministic segment counts, a realistic triangle budget, and at least two required diagnostic views when the subject benefits from more than one angle.
- Encode measurable continuity, contact, containment, distance, and required-view visibility as invariants. Do not claim an invariant that cannot be evaluated from the returned geometry.
- For a procedure or process, create an overview-to-focus state graph. visibleNodes/highlightedNodes control procedural construction while visibleObjects/highlightedObjects control imported GLBs. State mutations may deterministically override an entity's local transform or opacity; values are absolute in that entity's declared coordinate frame, not deltas. Use them for actual construction steps rather than pretending that highlight alone is a procedural change. Bind each state to a cameraViewId where useful.
- Mark transitions as normal, alternative, or complication. Give non-normal branches a concise condition and description so the construction graph preserves clinically or mechanically meaningful alternatives.
- A tube path point must have either a literal position or a landmarkId. Parent and child tubes should bind their junction endpoints to the same landmark instead of copying coordinates.
- Every procedural node.studyId and every imported asset ID must map to an approved object study when a dossier exists.
- Reuse a retrieved procedural component only when its name, tags, geometry, and material agree with current evidence. You may copy and retarget it, but the returned program must include every referenced material and landmark. Never force a mismatch merely to reuse cached work.
- Prefer recognizable anatomy, correct topology, depth cues, and tissue/material response over excessive polygon count.
- Use one ambient or hemisphere light and one directional or point light.
- IDs must use lowercase ASCII letters, digits, hyphens, or underscores and start with a letter.
- Each object must reference an asset spec ID that exists in the same response.
- When an approved dossier is present, every asset ID must equal an object-study ID. Do not introduce unresearched decorative assets.
${referenceImages.length > 0 ? `
Reference images follow this text. Each is labelled with the anatomical study it depicts.
Use them to compare silhouette, topology, branching, tissue planes, component layout,
operative exposure, and proportions. Images are evidence, not an excuse to copy a single
view blindly. When references disagree, preserve the contradiction and follow the approved
dossier; never choose an anatomical variant or laterality silently.` : ""}`;
    const result = await this.ai.models.generateContent({
      model: this.config.GEMINI_PLANNER_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            { text: planPrompt },
            ...referenceImages.flatMap((image) => [
              { text: `Anatomical reference image for study "${image.studyId}" (${image.studyName}):` },
              { inlineData: { data: image.data.toString("base64"), mimeType: image.mediaType } },
            ]),
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: toGeminiScenePlanJsonSchema(),
        thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
      },
    });
    return validatePlan(ScenePlanSchema.parse(parseJsonResponse(result.text)), maxObjects);
  }

  async inspect(
    manifest: SceneManifest,
    screenshotPath: string,
    spatial?: SpatialReport,
    plan?: ScenePlan,
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
    const result = await this.ai.models.generateContent({
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

Inspect the rendered visualization against that brief, its manifest, construction program, asset recipes, approved visual references, and measured spatial evidence. Judge only what is actually visible in this exact state/view. Explicitly verify label-independent anatomical recognizability; correct laterality and viewing orientation; topology, branching, attachment, containment, and adjacency; tissue-plane and depth readability; structures at risk; operative-corridor visibility; instrument/implant relationships when requested; and whether the intended surgical teaching point is visible. GLB bounds come from exact accessors; procedural bounds and invariant results come from the exact parameters interpreted by Three.js. Those measurements are authoritative for bounds, continuity, contact, containment, framing, floating, and intersection; use the rendered screenshot for silhouette, visible topology, occlusion, depth ordering, tissue/material response, legibility, and semantic judgment.

Return a scored assessment on every inspection. recognizabilityScore asks whether a surgeon can identify the anatomy and operative orientation without relying on labels. domainFidelityScore asks whether landmarks, laterality, topology, relative scale, tissue planes, critical relationships, and procedural logic agree with approved evidence. visualQualityScore covers depth ordering, occlusion management, tissue/material differentiation, lighting, label legibility, and operative-view composition. constructionCompletenessScore asks whether every applicable must-show structure, structure at risk, evaluation criterion, procedure state, branch, and required view is actually present. A pass requires scores of at least ${this.config.WORKFLOW_MIN_RECOGNIZABILITY}, ${this.config.WORKFLOW_MIN_DOMAIN_FIDELITY}, ${this.config.WORKFLOW_MIN_VISUAL_QUALITY}, and ${this.config.WORKFLOW_MIN_CONSTRUCTION_COMPLETENESS} respectively, no required spatial error, and high-confidence visual evidence. Labels, color, or highlights cannot compensate for unrecognizable or missing anatomy. The issue and evidence fields must name the most consequential gap between the observed pixels and the approved acceptance brief.

Choose the highest-value correction that moves the observed render toward the approved surgical target. Use direct-fix only for a truly local camera, occlusion, lighting, transform, label, single-structure geometry, or shared-landmark issue with a causally relevant patch. Use targeted-research when anatomical identity, variation, laterality, approach, proportions, topology, or a critical relationship is uncertain or contradicted. Use partial-replan when the anatomical construction, operative viewpoint, or teaching sequence is wrong. For targeted-research or partial-replan, return patch.kind none and provide targetStudyIds plus concrete medical research questions. If an imported structure is locally wrong, use asset-regenerate. If procedural anatomy is locally wrong, replace exactly one node with procedural-node or move one shared anatomical landmark with procedural-landmark; preserve IDs, dependencies, studyId, and intentional shared landmarks. Return pass/none only when the rendered screenshot matches the approved target and every scored gate passes. patch.kind must be exactly one of camera, light, object-transform, label, asset-regenerate, procedural-node, procedural-landmark, none. Manifest: ${JSON.stringify(manifest)} Asset plan: ${JSON.stringify(plan?.assets ?? [])} Spatial evidence: ${JSON.stringify(spatial ?? null)}`,
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
    return InspectionSchema.parse(normalizeInspection(parseJsonResponse(result.text)));
  }
}

export class DeterministicWorkflowAI implements WorkflowAI {
  readonly identity = "deterministic:surgical-anatomy-v2";
  readonly researchIdentity = "deterministic-research:surgical-anatomy-v2";
  readonly planningIdentity = "deterministic-planning:surgical-anatomy-v2";
  readonly inspectionIdentity = "deterministic-inspection:surgical-anatomy-v2";
  readonly clarificationIdentity = "deterministic-clarification:surgical-anatomy-v2";
  readonly deepResearchIdentity = "deterministic-perspective-research:surgical-anatomy-v2";
  readonly referenceResearchIdentity = "deterministic-reference-research:surgical-anatomy-v2";

  async clarify(prompt: string, _profile: UserPreferenceProfile): Promise<ClarificationTurn> {
    return ClarificationTurnSchema.parse({
      summary: `Before researching ${prompt}, I need to pin down the surgical teaching target, operative viewpoint, and required anatomical fidelity.`,
      uncertainties: [
        "The procedure, surgical audience, and intended teaching decision may be underspecified.",
        "Laterality, operative orientation, anatomy variant, and required fidelity may be unknown.",
      ],
      questions: [
        {
          id: "audience-purpose",
          dimension: "audience",
          question: "Which surgical audience and teaching objective should this visualization serve?",
          reason: "This changes the structures at risk, operative exposure, labels, and procedure-state sequence.",
          options: ["Surgical trainee orientation", "Procedure rehearsal explanation", "Consultant-level anatomy review"],
          allowFreeText: true,
          required: true,
        },
        {
          id: "accuracy-style",
          dimension: "accuracy",
          question: "What laterality, surgical approach/viewpoint, and fidelity should be treated as authoritative?",
          reason: "These choices control orientation, topology, critical relationships, and the acceptable degree of simplification.",
          options: ["Reference-faithful operative anatomy", "Reference-faithful orientation with simplified tissue detail", "Anatomy overview only"],
          allowFreeText: true,
          required: true,
        },
      ],
      assumptions: ["The result is an educational surgeon-facing visualization, not patient-specific planning or clinical advice."],
    });
  }

  async prepareIntent(
    prompt: string,
    _clarification: ClarificationTurn,
    answers: ClarificationAnswer[],
    additionalContext: string,
    profile: UserPreferenceProfile,
  ): Promise<IntentAndAgenda> {
    const answerText = answers.map((answer) => answer.answer).join(" ");
    return IntentAndAgendaSchema.parse({
      intent: {
        subject: prompt,
        purpose: answerText || "Explain surgically relevant anatomy through a compact interactive visualization.",
        audience: answers[0]?.answer ?? "Surgeons and surgical trainees",
        accuracy: /faithful/i.test(answerText) ? "reference-faithful" : /stylized/i.test(answerText) ? "stylized" : "plausible",
        style: profile.preferences.find((preference) => preference.key === "visual-style")?.value ?? "Clear layered surgical-anatomy visualization",
        composition: "An orientation-first anatomical composition followed by an operative focus on critical relationships.",
        mustHave: ["target anatomy", "surrounding anatomical context", "orientation and laterality cue"],
        mustAvoid: ["invented anatomy", "ambiguous laterality", "decorative non-medical objects"],
        interactionGoal: "Start with anatomical orientation, then reveal the target and structures at risk from the operative viewpoint.",
        constraints: ["Browser-renderable", "Reusable GLB assets", ...(additionalContext ? [additionalContext] : [])],
        assumptions: ["A compact scene communicates the concept better than a crowded reconstruction."],
        evaluationCriteria: [
          "The target anatomy is recognizable without relying on labels.",
          "Laterality, topology, and critical anatomical relationships are spatially plausible.",
          "The state sequence moves from orientation overview to operative focus.",
        ],
      },
      agenda: {
        rationale: "Research anatomical identity, required structures, and operative spatial evidence independently before construction.",
        perspectives: [
          {
            id: "visual-identity",
            label: "Visual identity",
            objective: "Establish canonical anatomy, landmarks, laterality, and operative orientation.",
            questions: ["Which landmarks make this anatomy recognizable?", "Which variants or adjacent structures are commonly confused?"],
            searchHints: [`${prompt} surgical anatomy landmarks`, `${prompt} operative view laterality`],
            requiredEvidence: ["Canonical anatomical view", "Distinctive landmarks and orientation cues"],
          },
          {
            id: "objects-materials",
            label: "Structures and tissue planes",
            objective: "Identify required anatomy, tissue layers, structures at risk, and clinically useful visual encoding.",
            questions: ["Which structures and tissue planes are essential?", "Which structures at risk must remain visible?"],
            searchHints: [`${prompt} tissue planes structures at risk`, `${prompt} operative anatomy`],
            requiredEvidence: ["Anatomical structure breakdown", "Tissue-plane and risk-structure evidence"],
          },
          {
            id: "scale-space",
            label: "Operative spatial relationships",
            objective: "Ground topology, attachment, containment, adjacency, relative scale, and useful operative viewpoints.",
            questions: ["Which dimensions or ratios matter?", "What attaches to, contains, crosses, or lies at risk beside each structure?"],
            searchHints: [`${prompt} anatomical relationships`, `${prompt} surgical approach view`],
            requiredEvidence: ["Relative scale", "Attachment, containment, and critical adjacency"],
          },
        ],
        completionCriteria: [
          "Every required anatomical structure has identifying references.",
          "Tissue planes, landmarks, and structures at risk are documented.",
          "Laterality, topology, scale, and operative relationships are supported by sources.",
        ],
      },
      notes: ["Deterministic fixture keeps research branches independently cacheable."],
    });
  }

  async researchPerspective(
    intent: IntentFrame,
    perspective: ResearchPerspective,
  ): Promise<ResearchPerspectiveResult> {
    const suffix = perspective.id;
    const sourceUrl = `https://${suffix}.example.org/${encodeURIComponent(intent.subject.toLowerCase().replaceAll(" ", "-"))}`;
    const secondSourceUrl = `https://archive-${suffix}.example.net/reference`;
    const imageUrl = `https://images.example.com/${suffix}.png`;
    return ResearchPerspectiveResultSchema.parse({
      perspectiveId: perspective.id,
      summary: `${perspective.label} evidence for ${intent.subject}.`,
      findings: [
        {
          claim: `${intent.subject} needs recognizable anatomical landmarks in the ${perspective.label.toLowerCase()} view.`,
          whyItMatters: "The geometry and operative camera must preserve anatomical identity and orientation.",
          sourceUrls: [sourceUrl],
          confidence: "high",
        },
        {
          claim: "Surrounding tissue context and an orientation cue prevent the target anatomy from reading as an isolated, laterality-ambiguous icon.",
          whyItMatters: "The final visualization needs measurable attachment, relative scale, and orientation.",
          sourceUrls: [secondSourceUrl],
          confidence: "medium",
        },
      ],
      objectCandidates: [
        {
          name: "Target anatomy",
          role: "Carries the primary surgical teaching target.",
          identifyingFeatures: ["Recognizable primary contour", "Distinctive anatomical landmark"],
          likelyMaterials: ["Tissue-appropriate primary material"],
          scaleNotes: ["Dominant enough to read within surrounding anatomy"],
          spatialNotes: ["Attached to surrounding tissue context and oriented by the laterality marker"],
        },
      ],
      sources: [
        { url: sourceUrl, title: `${perspective.label} primary reference`, note: "Deterministic research fixture" },
        { url: secondSourceUrl, title: `${perspective.label} archive reference`, note: "Deterministic research fixture" },
      ],
      references: [
        { imageUrl, sourceUrl, title: `${perspective.label} image`, relevance: "Shows form and spatial cues" },
      ],
      unansweredQuestions: [],
    });
  }

  async researchReferences(_intent: IntentFrame, _agenda: ResearchAgenda): Promise<ReferenceDiscovery> {
    return ReferenceDiscoverySchema.parse({ references: [] });
  }

  async synthesizeResearch(
    intent: IntentFrame,
    perspectives: ResearchPerspectiveResult[],
  ): Promise<Omit<ResearchDossier, "perspectives" | "readiness" | "generatedAt">> {
    const sources = uniqueBy(perspectives.flatMap((result) => result.sources), (source) => source.url);
    const references = uniqueBy(perspectives.flatMap((result) => result.references), (reference) => reference.imageUrl);
    return ResearchDossierDraftSchema.parse({
      brief: {
        concept: intent.subject,
        summary: `A source-grounded, orientation-first surgical anatomy visualization of ${intent.subject}.`,
        visualNotes: ["Preserve anatomical identity and laterality.", "Show attachment and relative scale.", "Use the requested operative teaching order."],
        objectNotes: ["Target anatomy", "Surrounding tissue plane", "Orientation and laterality marker"],
        styleKeywords: [intent.style, intent.accuracy],
        sources: sources.slice(0, 12),
        references: references.slice(0, 8),
      },
      objectStudies: [
        {
          id: "subject",
          name: "Target anatomy",
          role: "Carries the surgical teaching target and receives the operative focus state.",
          identityMarkers: ["Recognizable primary contour", "Distinctive anatomical landmark"],
          components: ["Primary anatomical body", "Identifying landmark"],
          materials: ["Tissue-appropriate primary material"],
          proportionAndScale: ["Dominates the focus while surrounding anatomy remains readable"],
          spatialRelationships: ["Attaches to the surrounding tissue plane and is oriented by the laterality marker"],
          sourceUrls: sources.slice(0, 3).map((source) => source.url),
          referenceImageUrls: references.slice(0, 3).map((reference) => reference.imageUrl),
          uncertainty: "Fine tissue detail is intentionally omitted in the deterministic fixture.",
        },
        {
          id: "platform",
          name: "Surrounding tissue plane",
          role: "Makes anatomical attachment explicit instead of leaving the target floating.",
          identityMarkers: ["Broad contextual tissue layer", "Visible perimeter around the target"],
          components: ["Single simplified tissue plane"],
          materials: ["Muted tissue-context material"],
          proportionAndScale: ["Wider than the target anatomy on both horizontal axes"],
          spatialRelationships: ["Supports and contextualizes the target anatomy at the origin"],
          sourceUrls: sources.slice(2, 4).map((source) => source.url),
          referenceImageUrls: references.slice(1, 2).map((reference) => reference.imageUrl),
          uncertainty: "The tissue plane is a simplified educational context rather than patient-specific anatomy.",
        },
        {
          id: "marker",
          name: "Orientation and laterality marker",
          role: "Provides an immediate orientation and relative-scale cue.",
          identityMarkers: ["Slender directional form", "Contrasting orientation color"],
          components: ["Single directional marker"],
          materials: ["Simple orientation-marker material"],
          proportionAndScale: ["Narrower than the target anatomy and similar in visible height"],
          spatialRelationships: ["Sits beside the target without intersecting anatomy"],
          sourceUrls: sources.slice(4, 6).map((source) => source.url),
          referenceImageUrls: references.slice(2, 3).map((reference) => reference.imageUrl),
          uncertainty: "The marker is a pedagogical orientation cue, not anatomy.",
        },
      ],
      intentCoverage: intent.mustHave.map((requirement, index) => ({
        requirement,
        evidence: `The ${["subject", "platform", "marker"][index] ?? "subject"} object study covers this approved requirement.`,
        objectStudyIds: [["subject", "platform", "marker"][index] ?? "subject"],
      })),
      contradictions: [],
      unresolvedQuestions: [],
    });
  }

  async research(prompt: string): Promise<ResearchBrief> {
    return {
      concept: prompt,
      summary: `A compact, orientation-first surgical anatomy visualization of ${prompt}.`,
      visualNotes: [
        "Use simple but label-independent recognizable anatomy.",
        "Keep target and surrounding structures readable from the operative view.",
        "Preserve orientation, laterality cues, attachment, and relative scale.",
      ],
      objectNotes: ["Target anatomy", "Surrounding tissue plane", "Orientation and laterality marker"],
      styleKeywords: ["surgical-anatomy", "layered", "educational"],
      sources: [],
      references: [],
    };
  }

  async plan(
    prompt: string,
    _research: ResearchBrief,
    maxObjects: number,
    _intent?: IntentFrame,
    _dossier?: ResearchDossier,
    _referenceImages?: PlannerReferenceImage[],
    _reusableProcedural?: ReusableProceduralComponent[],
    _recovery?: PlanRecoveryContext,
  ): Promise<ScenePlan> {
    const plan: ScenePlan = {
      title: prompt,
      rationale: "A deterministic three-structure surgical-anatomy fixture for offline workflow verification.",
      environment: { background: "#111827", groundColor: "#334155", groundSize: 20 },
      camera: { position: [7, 5, 8], target: [0, 1, 0], fov: 45 },
      lights: [
        { id: "ambient", type: "hemisphere", color: "#dbeafe", intensity: 1.5, position: [0, 5, 0] },
        { id: "key", type: "directional", color: "#fff1d6", intensity: 3, position: [5, 8, 4] },
      ],
      assets: [
        {
          id: "subject",
          name: "Target anatomy",
          category: "anatomy",
          description: `Simplified target-anatomy placeholder for ${prompt}`,
          tags: ["anatomy", "target", "educational", "reusable"],
          dimensions: [2, 2.4, 2],
          style: "low-poly",
          parts: [
            { name: "body", primitive: "box", size: [1.5, 1.6, 1.5], position: [0, 0.8, 0], rotation: [0, 0, 0], color: "#c96f7b", bevel: 0.08 },
            { name: "landmark", primitive: "sphere", size: [1.1, 1.1, 1.1], position: [0, 1.9, 0], rotation: [0, 0, 0], color: "#e6a0a9", bevel: 0 },
          ],
        },
        {
          id: "platform",
          name: "Surrounding tissue plane",
          category: "support-tissue",
          description: "A simplified surrounding tissue plane that makes anatomical attachment explicit",
          tags: ["tissue", "support", "anatomical-context", "reusable"],
          dimensions: [4, 0.4, 4],
          style: "low-poly",
          parts: [
            { name: "tissue-plane", primitive: "cylinder", size: [4, 0.4, 4], position: [0, 0.2, 0], rotation: [0, 0, 0], color: "#72545f", bevel: 0.04 },
          ],
        },
        {
          id: "marker",
          name: "Orientation marker",
          category: "orientation-marker",
          description: "A slim orientation and laterality marker",
          tags: ["marker", "orientation", "laterality", "reusable"],
          dimensions: [0.3, 2, 0.3],
          style: "low-poly",
          parts: [
            { name: "post", primitive: "cylinder", size: [0.25, 2, 0.25], position: [0, 1, 0], rotation: [0, 0, 0], color: "#38bdf8", bevel: 0.02 },
          ],
        },
      ],
      objects: [
        { id: "platform", assetSpecId: "platform", position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], label: "Surrounding tissue", highlight: false },
        { id: "subject", assetSpecId: "subject", position: [0, 0.4, 0], rotation: [0, 0, 0], scale: [1, 1, 1], label: "Target anatomy", highlight: true },
        { id: "marker", assetSpecId: "marker", position: [2.6, 0, -0.5], rotation: [0, 0, 0], scale: [1, 1, 1], label: "Orientation", highlight: false },
      ],
      relationships: [
        { from: "subject", to: "platform", type: "on", description: "The target anatomy is attached to the simplified surrounding tissue plane." },
        { from: "marker", to: "subject", type: "beside", description: "The marker provides orientation and laterality context." },
      ],
      states: [
        {
          id: "overview",
          label: "Anatomical orientation",
          objective: "Establish anatomy, orientation, and relative scale.",
          visibleObjects: ["platform", "subject", "marker"],
          highlightedObjects: [],
          visibleNodes: [],
          highlightedNodes: [],
          mutations: [],
        },
        {
          id: "focus",
          label: "Operative focus",
          objective: "Focus attention on the target anatomy and its critical relationship.",
          visibleObjects: ["platform", "subject", "marker"],
          highlightedObjects: ["subject"],
          visibleNodes: [],
          highlightedNodes: [],
          mutations: [],
        },
      ],
      transitions: [{ from: "overview", to: "focus", durationMs: 600, kind: "normal", description: "Move from anatomical orientation to the operative target." }],
    };
    return validatePlan(plan, maxObjects);
  }

  async inspect(
    manifest: SceneManifest,
    _screenshotPath: string,
    _spatial?: SpatialReport,
    _plan?: ScenePlan,
    _context?: QaInspectionContext,
    _referenceImages?: PlannerReferenceImage[],
  ): Promise<Inspection> {
    if (manifest.revision > 1) {
      return {
        verdict: "pass",
        category: "none",
        issue: "",
        evidence: "The deterministic anatomy correction was rerendered and reinspected from the required operative view.",
        patch: { kind: "none" },
        assessment: passingAssessment("The corrected deterministic scene satisfies the fixture."),
      };
    }
    return {
      verdict: "fix",
      category: "framing",
      issue: "The deterministic anatomy inspection requests one reproducible operative-camera refinement.",
      evidence: "Offline surgical-visualization verification fixture.",
      patch: { kind: "camera", position: [6.5, 4.8, 7.5], target: [0, 1.1, 0] },
      assessment: failingAssessment("The initial framing needs a local correction."),
    };
  }
}

function passingAssessment(rationale: string) {
  return {
    recognizabilityScore: 1,
    domainFidelityScore: 1,
    visualQualityScore: 1,
    constructionCompletenessScore: 1,
    confidence: 1,
    failedCriteria: [],
    strengths: ["Deterministic fixture requirements are satisfied."],
    recommendedAction: "pass" as const,
    targetStudyIds: [],
    researchQuestions: [],
    rationale,
  };
}

function failingAssessment(rationale: string) {
  return {
    recognizabilityScore: 0.7,
    domainFidelityScore: 0.8,
    visualQualityScore: 0.55,
    constructionCompletenessScore: 0.9,
    confidence: 1,
    failedCriteria: ["The current target does not meet the visual-quality gate."],
    strengths: ["The required construction is present."],
    recommendedAction: "direct-fix" as const,
    targetStudyIds: [],
    researchQuestions: [],
    rationale,
  };
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

// Zod refinements are intentionally not emitted by z.toJSONSchema. Express the
// scene plan's cross-field geometry invariant explicitly so structured output does
// not permit the invalid objects: [] / no-procedural combination. The general
// sanitizer removes array bounds to stay below Gemini's schema-complexity limit;
// keeping this single minItems constraint inside anyOf preserves the invariant
// without restoring all of those bounds.
export function toGeminiScenePlanJsonSchema(): Record<string, unknown> {
  return {
    ...toGeminiJsonSchema(ScenePlanSchema),
    anyOf: [
      {
        type: "object",
        title: "Procedural scene construction",
        required: ["procedural"],
      },
      {
        type: "object",
        title: "Imported scene construction",
        properties: {
          objects: { type: "array", minItems: 1 },
        },
        required: ["objects"],
      },
    ],
  };
}

function sanitizeForGemini(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeForGemini);
  if (!node || typeof node !== "object") return node;
  // Gemini also rejects a request once a schema carries enough prefixItems tuples.
  // Every Vec3 compiles to one, so a scene plan with a procedural program crosses the
  // limit. Collapse homogeneous tuples to a plain typed array and state the arity in
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
  const { minItems, maxItems, ...rest } = node as Record<string, unknown>;
  const sanitized: Record<string, unknown> = Object.fromEntries(
    Object.entries(rest).map(([key, value]) => [key, sanitizeForGemini(value)]),
  );
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

// The category and patch.kind vocabularies overlap in meaning but not in spelling
// ("lighting" vs "light"), and the model reliably copies the category across. Only
// the discriminator is canonicalised; the branch's own fields still have to fit, so
// a genuinely malformed patch continues to fail loudly.
const QA_PATCH_KIND_ALIASES: Record<string, string> = {
  lighting: "light",
  lights: "light",
  framing: "camera",
  "camera-framing": "camera",
  transform: "object-transform",
  "object-transforms": "object-transform",
  scale: "object-transform",
  labels: "label",
  regenerate: "asset-regenerate",
  "asset-regen": "asset-regenerate",
  "asset-load": "asset-regenerate",
  geometry: "asset-regenerate",
  noop: "none",
  "no-op": "none",
  pass: "none",
};

function normalizeInspection(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const inspection = value as Record<string, unknown>;
  const patch = inspection.patch;
  if (!patch || typeof patch !== "object") return value;
  const kind = (patch as Record<string, unknown>).kind;
  if (typeof kind !== "string") return value;
  const canonical = QA_PATCH_KIND_ALIASES[kind.trim().toLowerCase()];
  if (!canonical) return value;
  return { ...inspection, patch: { ...(patch as Record<string, unknown>), kind: canonical } };
}

function parseJsonResponse(text: string | undefined): unknown {
  if (!text) throw new Error("Gemini returned an empty response");
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(stripped);
}

function validatePlan(plan: ScenePlan, maxObjects: number): ScenePlan {
  const normalized = ScenePlanSchema.parse({
    ...plan,
    assets: plan.assets.map((asset) => {
      const size = boundsSize(recipeBounds(asset));
      return {
        ...asset,
        dimensions: [Math.max(size[0], 0.001), Math.max(size[1], 0.001), Math.max(size[2], 0.001)],
      };
    }),
  });
  if (normalized.objects.length > maxObjects || normalized.assets.length > maxObjects) {
    throw new Error(`Scene plan exceeds configured maximum of ${maxObjects} objects/assets`);
  }
  if (normalized.objects.length === 0 && !normalized.procedural) {
    throw new Error("Scene plan must contain imported objects, a procedural program, or both");
  }
  if (normalized.procedural) validateProceduralReferences(normalized.procedural);
  const assetIds = new Set(normalized.assets.map((asset) => asset.id));
  const objectIds = new Set([
    ...normalized.objects.map((object) => object.id),
    ...(normalized.procedural?.nodes.map((node) => node.id) ?? []),
  ]);
  if (objectIds.size !== normalized.objects.length + (normalized.procedural?.nodes.length ?? 0)) {
    throw new Error("Imported objects and procedural nodes must have unique scene-wide IDs");
  }
  for (const object of normalized.objects) {
    if (!assetIds.has(object.assetSpecId)) {
      throw new Error(`Object ${object.id} references missing asset spec ${object.assetSpecId}`);
    }
  }
  for (const relation of normalized.relationships) {
    if (!objectIds.has(relation.from) || !objectIds.has(relation.to)) {
      throw new Error(`Relationship references missing object: ${relation.from} -> ${relation.to}`);
    }
  }
  const viewIds = new Set(normalized.procedural?.views.map((view) => view.id) ?? []);
  const stateIds = new Set(normalized.states.map((state) => state.id));
  if (stateIds.size !== normalized.states.length) throw new Error("Scene states must have unique IDs");
  for (const state of normalized.states) {
    for (const id of [...state.visibleObjects, ...state.highlightedObjects, ...state.visibleNodes, ...state.highlightedNodes]) {
      if (!objectIds.has(id)) throw new Error(`State ${state.id} references missing scene entity ${id}`);
    }
    if (state.cameraViewId && !viewIds.has(state.cameraViewId)) {
      throw new Error(`State ${state.id} references missing camera view ${state.cameraViewId}`);
    }
    const mutated = new Set<string>();
    for (const mutation of state.mutations) {
      if (!objectIds.has(mutation.entityId)) {
        throw new Error(`State ${state.id} mutates missing scene entity ${mutation.entityId}`);
      }
      if (mutated.has(mutation.entityId)) {
        throw new Error(`State ${state.id} contains duplicate mutations for ${mutation.entityId}`);
      }
      mutated.add(mutation.entityId);
    }
  }
  for (const transition of normalized.transitions) {
    if (!stateIds.has(transition.from) || !stateIds.has(transition.to)) {
      throw new Error(`Transition references a missing state: ${transition.from} -> ${transition.to}`);
    }
  }
  return normalized;
}
