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
import {
  InspectionSchema,
  ResearchBriefSchema,
  ScenePlanSchema,
  type Inspection,
  type ResearchBrief,
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

/** A downloaded reference image, bound to the object study it depicts. */
export interface PlannerReferenceImage {
  studyId: string;
  studyName: string;
  mediaType: string;
  data: Buffer;
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
  ): Promise<ScenePlan>;
  inspect(
    manifest: SceneManifest,
    screenshotPath: string,
    spatial?: SpatialReport,
    plan?: ScenePlan,
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
    this.researchIdentity = `gemini-research:${config.GEMINI_RESEARCH_MODEL}:${config.GEMINI_REFERENCE_MODEL}:v4`;
    this.planningIdentity = `gemini-planning:${config.GEMINI_RESEARCH_MODEL}:${config.GEMINI_PLANNER_MODEL}:v2`;
    this.inspectionIdentity = `gemini-inspection:${config.GEMINI_INSPECTOR_MODEL}:v2`;
    this.clarificationIdentity = `gemini-clarification:${config.GEMINI_PLANNER_MODEL}:v1`;
    this.deepResearchIdentity = `gemini-perspective-research:${config.GEMINI_RESEARCH_MODEL}:v3`;
    this.referenceResearchIdentity = `gemini-reference-research:${config.GEMINI_REFERENCE_MODEL}:v1`;
  }

  async clarify(prompt: string, profile: UserPreferenceProfile): Promise<ClarificationTurn> {
    const result = await this.ai.models.generateContent({
      model: this.config.GEMINI_PLANNER_MODEL,
      contents: `You lead an interactive 3D visualization project. Before any research or generation, identify the few missing user facts that could materially change the research queries, object list, spatial layout, teaching sequence, or quality criteria.

Concept: ${prompt}
Explicit saved preferences: ${JSON.stringify(profile.preferences)}

Ask 1-4 concise, high-information questions. Cover the most consequential uncertainties first. Give a short reason for each question and useful options where they reduce effort, while always allowing free text. Do not ask for facts that can be found through web research. Do not plan assets or a scene yet. Record low-impact defaults as assumptions.`,
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
      contents: `Convert this concept and clarification exchange into an explicit visual intent and a three-perspective research agenda. This is research planning only: do not design Blender primitives or place scene objects.

Concept: ${prompt}
Questions and rationale: ${JSON.stringify(clarification)}
Answers: ${JSON.stringify(answers)}
Additional context: ${additionalContext || "None"}
Explicit saved preferences: ${JSON.stringify(profile.preferences)}

The agenda must contain exactly these perspective IDs:
- visual-identity: silhouette, canonical views, distinctive features, period/style cues, and failure-prone lookalikes;
- objects-materials: components, construction, materials, colors, and which objects are essential;
- scale-space: dimensions, relative scale, contact/support, layout constraints, and useful viewpoints.

For each perspective, write 2-8 self-questions and search hints whose answers would change asset selection or spatial evaluation. Evaluation criteria must be observable in the final render or measured scene graph.`,
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
      contents: `Research one evidence branch for a 3D visualization. Answer the supplied self-questions using grounded web search before drawing conclusions. This branch is research only: do not generate a scene plan or Blender recipe.

Approved intent: ${JSON.stringify(intent)}
Perspective: ${JSON.stringify(perspective)}

Requirements:
- Prefer primary, institutional, museum, manufacturer, standards, or technically authoritative sources.
- Bind every finding to one or more exact source URLs actually returned by search.
- Describe which views would reveal silhouette, construction, material, scale, or spatial relationships; a separate image-search node collects the actual images.
- Identify common visual confusions and uncertainty.
- Return object candidates only when the evidence suggests they are visually or spatially necessary.`,
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
      contents: `Convert this grounded research into the required structure. Use only claims that appear in the research below; do not add knowledge of your own.

Every finding's sourceUrls must be copied verbatim from this list of grounded sources. Do not shorten, rewrite, or invent a URL, and drop any finding you cannot attribute to one of them.

List a question in unansweredQuestions only if it blocks building the scene: it would change which objects exist, their geometry or scale, or how they are positioned relative to each other. Background, technique variation, and detail below the chosen fidelity level are not blocking; leave them out. Return an empty list when the evidence is sufficient to build the scene.
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
      contents: `Use Google Image Search to find a small, diverse visual reference set for this approved 3D visualization intent. Search for canonical views, construction details, material close-ups, scale cues, and spatial relationships. Prefer museum, institutional, manufacturer, standards, or technically authoritative source pages. Avoid mood images and AI-generated lookalikes. Do not create a new image; return only a short textual search summary.

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
      contents: `Synthesize these three grounded research branches into a generation dossier. Do not invent or alter URLs, and do not design primitive geometry yet.

Approved intent: ${JSON.stringify(intent)}
Research branches: ${JSON.stringify(perspectives)}

Every sourceUrls entry must be copied verbatim from this list. Do not shorten, rewrite, or substitute a publisher URL, and give every object study at least one of them:
${citableUrls}

Create one object study for each visually necessary object. Each study must explain identifying markers, components, materials, proportions/scale, spatial relationships, source URLs, reference-image URLs, and remaining uncertainty. For every approved intent.mustHave string, create exactly one intentCoverage entry that repeats the requirement verbatim and maps it to existing object-study IDs. Merge duplicates and expose contradictions. A question belongs in unresolvedQuestions only if it blocks generation: it would change which objects exist, their geometry or scale, or how they are positioned relative to each other. Curiosity, historical background, clinical technique variation, and detail that the chosen fidelity level omits are not blocking; leave them out. Return an empty list when the evidence is sufficient to build the scene. The brief should be concise enough for the scene planner but retain concrete visual and spatial evidence.`,
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
      contents: `Research this visual scene concept for 3D reconstruction: ${prompt}\n
Use grounded web search. Focus on recognizable shapes, spatial relationships, scale, materials, lighting, and historically or technically important details. Do not invent URLs. Reference-image discovery is handled by a separate image-search node.`,
      config: {
        tools: [{ googleSearch: {} }],
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      },
    });
    const structured = await this.ai.models.generateContent({
      model: this.config.GEMINI_RESEARCH_MODEL,
      contents: `Convert this grounded research into a concise visual brief. Use only claims and URLs that appear below; do not add knowledge of your own and do not invent URLs.

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
  ): Promise<ScenePlan> {
    const planPrompt = `Create a compact, deterministic Three.js scene plan for this prompt:\n${prompt}\n
Approved intent:\n${JSON.stringify(intent ?? null)}\n
Research brief:\n${JSON.stringify(research)}\n
Approved object studies and intent coverage:\n${JSON.stringify(dossier ? {
  objectStudies: dossier.objectStudies,
  intentCoverage: dossier.intentCoverage,
  contradictions: dossier.contradictions,
} : null)}\n
Constraints:
- Use at most ${maxObjects} scene objects and at most ${maxObjects} asset specs.
- Each missing asset must be expressible using 1-16 bounded Blender primitives.
- Dimensions, positions, and scales are in meters.
- Use radians for rotations.
- Keep every object near the origin and resting on or intentionally attached to something.
- Create labels for meaningful objects.
- Prefer recognizable silhouettes over detail.
- Use one ambient or hemisphere light and one directional or point light.
- IDs must use lowercase ASCII letters, digits, hyphens, or underscores and start with a letter.
- Each object must reference an asset spec ID that exists in the same response.
- When an approved dossier is present, every asset ID must equal an object-study ID. Do not introduce unresearched decorative assets.
${referenceImages.length > 0 ? `
Reference images follow this text. Each is labelled with the object study it depicts.
Read proportions, component layout, and characteristic silhouette from the images and
make the primitives match what you see. Where an image and the written study disagree,
trust the image for shape and proportion, and the study for naming and relationships.` : ""}`;
    const result = await this.ai.models.generateContent({
      model: this.config.GEMINI_PLANNER_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            { text: planPrompt },
            ...referenceImages.flatMap((image) => [
              { text: `Reference image for object study "${image.studyId}" (${image.studyName}):` },
              { inlineData: { data: image.data.toString("base64"), mimeType: image.mediaType } },
            ]),
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: toGeminiJsonSchema(ScenePlanSchema),
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
  ): Promise<Inspection> {
    const image = await fs.readFile(screenshotPath);
    const result = await this.ai.models.generateContent({
      model: this.config.GEMINI_INSPECTOR_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Inspect this rendered scene against its manifest, asset recipes, and measured spatial evidence. The spatial bounds were parsed from the exact GLB hashes shown in the evidence and are authoritative for bounds, framing, floating, and intersection; use the image for visual fidelity and semantic judgment. Choose at most one obvious, high-impact issue. If one asset's silhouette or construction is clearly wrong, use asset-regenerate to replace only that asset's bounded 1-16 primitive recipe. Return pass/none when no safe correction is justified. Only request a patch allowed by the response schema. Manifest: ${JSON.stringify(manifest)} Asset plan: ${JSON.stringify(plan?.assets ?? [])} Spatial evidence: ${JSON.stringify(spatial ?? null)}`,
            },
            { inlineData: { data: image.toString("base64"), mimeType: "image/png" } },
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
}

export class DeterministicWorkflowAI implements WorkflowAI {
  readonly identity = "deterministic:v1";
  readonly researchIdentity = "deterministic-research:v1";
  readonly planningIdentity = "deterministic-planning:v1";
  readonly inspectionIdentity = "deterministic-inspection:v1";
  readonly clarificationIdentity = "deterministic-clarification:v1";
  readonly deepResearchIdentity = "deterministic-perspective-research:v1";
  readonly referenceResearchIdentity = "deterministic-reference-research:v1";

  async clarify(prompt: string, _profile: UserPreferenceProfile): Promise<ClarificationTurn> {
    return ClarificationTurnSchema.parse({
      summary: `Before researching ${prompt}, I need to pin down how the visualization should teach the idea and how faithful it must be.`,
      uncertainties: [
        "The intended audience and explanation depth are unknown.",
        "The desired balance between reference fidelity and stylization is unknown.",
      ],
      questions: [
        {
          id: "audience-purpose",
          dimension: "audience",
          question: "Who is this visualization for, and what should they understand after exploring it?",
          reason: "This changes both the object emphasis and the step-by-step teaching sequence.",
          options: ["General audience", "Student", "Domain expert"],
          allowFreeText: true,
          required: true,
        },
        {
          id: "accuracy-style",
          dimension: "accuracy",
          question: "Should the scene prioritize reference fidelity, plausible simplification, or a strongly stylized look?",
          reason: "This determines the research threshold and which assets are compatible.",
          options: ["Reference-faithful", "Plausible simplification", "Strongly stylized"],
          allowFreeText: true,
          required: true,
        },
      ],
      assumptions: ["The result should remain compact enough for an interactive browser scene."],
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
        purpose: answerText || "Explain the concept through a compact interactive scene.",
        audience: answers[0]?.answer ?? "General audience",
        accuracy: /faithful/i.test(answerText) ? "reference-faithful" : /stylized/i.test(answerText) ? "stylized" : "plausible",
        style: profile.preferences.find((preference) => preference.key === "visual-style")?.value ?? "Clear low-poly educational visualization",
        composition: "An overview-first composition with a central subject and visible supporting context.",
        mustHave: ["main subject", "supporting context", "scale cue"],
        mustAvoid: ["unresearched decorative objects", "ambiguous silhouettes"],
        interactionGoal: "Start with an overview, then highlight the main subject and its important relationships.",
        constraints: ["Browser-renderable", "Reusable GLB assets", ...(additionalContext ? [additionalContext] : [])],
        assumptions: ["A compact scene communicates the concept better than a crowded reconstruction."],
        evaluationCriteria: [
          "The main subject is recognizable from silhouette and labeled parts.",
          "Relative scale and support relationships are spatially plausible.",
          "The state sequence moves from overview to focused explanation.",
        ],
      },
      agenda: {
        rationale: "Research identity, construction, and spatial evidence independently before scene planning.",
        perspectives: [
          {
            id: "visual-identity",
            label: "Visual identity",
            objective: "Establish canonical silhouette and distinguishing features.",
            questions: ["Which features make the subject recognizable?", "Which lookalikes are commonly confused with it?"],
            searchHints: [`${prompt} canonical view`, `${prompt} visual identification`],
            requiredEvidence: ["Canonical view", "Distinctive silhouette markers"],
          },
          {
            id: "objects-materials",
            label: "Objects and materials",
            objective: "Identify essential components, construction, and materials.",
            questions: ["Which components are structurally essential?", "Which materials and colors are characteristic?"],
            searchHints: [`${prompt} parts materials`, `${prompt} construction details`],
            requiredEvidence: ["Component breakdown", "Material evidence"],
          },
          {
            id: "scale-space",
            label: "Scale and spatial relationships",
            objective: "Ground dimensions, support, relative scale, and useful viewpoints.",
            questions: ["What dimensions or ratios matter?", "What supports, contains, or sits beside each object?"],
            searchHints: [`${prompt} dimensions`, `${prompt} spatial layout`],
            requiredEvidence: ["Scale cue", "Support/contact relationships"],
          },
        ],
        completionCriteria: [
          "Every important object has identifying references.",
          "Object construction and materials are documented.",
          "Scale and spatial relationships are supported by sources.",
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
          claim: `${intent.subject} needs a clear primary silhouette in the ${perspective.label.toLowerCase()} view.`,
          whyItMatters: "The asset and camera must preserve the concept's identifying form.",
          sourceUrls: [sourceUrl],
          confidence: "high",
        },
        {
          claim: "A visible support and scale cue prevents the object from reading as an arbitrary floating icon.",
          whyItMatters: "The final scene needs measurable contact and relative scale.",
          sourceUrls: [secondSourceUrl],
          confidence: "medium",
        },
      ],
      objectCandidates: [
        {
          name: "Central subject",
          role: "Carries the main visual concept.",
          identifyingFeatures: ["Strong central mass", "Distinctive upper feature"],
          likelyMaterials: ["Context-appropriate primary material"],
          scaleNotes: ["Large enough to dominate the supporting platform"],
          spatialNotes: ["Rests on the central platform and is read before the context marker"],
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
        summary: `A source-grounded, overview-first visualization of ${intent.subject}.`,
        visualNotes: ["Preserve the primary silhouette.", "Show support and relative scale.", "Use the requested teaching order."],
        objectNotes: ["Central subject", "Supporting platform", "Contextual scale marker"],
        styleKeywords: [intent.style, intent.accuracy],
        sources: sources.slice(0, 12),
        references: references.slice(0, 8),
      },
      objectStudies: [
        {
          id: "subject",
          name: "Central subject",
          role: "Carries the main visual concept and receives the focus state.",
          identityMarkers: ["Strong central mass", "Distinctive upper feature"],
          components: ["Primary body", "Upper identifying feature"],
          materials: ["Context-appropriate primary material"],
          proportionAndScale: ["Dominates the support but leaves visible negative space"],
          spatialRelationships: ["Rests on the platform and sits beside a context marker"],
          sourceUrls: sources.slice(0, 3).map((source) => source.url),
          referenceImageUrls: references.slice(0, 3).map((reference) => reference.imageUrl),
          uncertainty: "Fine surface detail is intentionally omitted in the fixture.",
        },
        {
          id: "platform",
          name: "Supporting platform",
          role: "Makes contact and support explicit instead of leaving the subject floating.",
          identityMarkers: ["Broad low base", "Visible perimeter around the subject"],
          components: ["Single stable base"],
          materials: ["Dark matte support material"],
          proportionAndScale: ["Wider than the central subject on both horizontal axes"],
          spatialRelationships: ["Supports the subject at the origin"],
          sourceUrls: sources.slice(2, 4).map((source) => source.url),
          referenceImageUrls: references.slice(1, 2).map((reference) => reference.imageUrl),
          uncertainty: "The platform is an explanatory support rather than a literal reconstruction detail.",
        },
        {
          id: "marker",
          name: "Contextual scale marker",
          role: "Provides an immediate relative-scale and spatial cue.",
          identityMarkers: ["Slender vertical form", "Contrasting cool color"],
          components: ["Single vertical post"],
          materials: ["Simple colored marker material"],
          proportionAndScale: ["Narrower than the subject and similar in visible height"],
          spatialRelationships: ["Stands beside the subject without intersecting it"],
          sourceUrls: sources.slice(4, 6).map((source) => source.url),
          referenceImageUrls: references.slice(2, 3).map((reference) => reference.imageUrl),
          uncertainty: "The marker is a pedagogical scale cue.",
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
      summary: `A compact, stylized visualization of ${prompt}.`,
      visualNotes: [
        "Use simple recognizable silhouettes.",
        "Keep the main subject centered with clear negative space.",
        "Use warm key lighting and a cooler ambient fill.",
      ],
      objectNotes: ["A raised central subject", "A supporting platform", "A contextual marker"],
      styleKeywords: ["stylized", "low-poly", "educational"],
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
  ): Promise<ScenePlan> {
    const plan: ScenePlan = {
      title: prompt,
      rationale: "A deterministic three-object composition for offline workflow verification.",
      environment: { background: "#111827", groundColor: "#334155", groundSize: 20 },
      camera: { position: [7, 5, 8], target: [0, 1, 0], fov: 45 },
      lights: [
        { id: "ambient", type: "hemisphere", color: "#dbeafe", intensity: 1.5, position: [0, 5, 0] },
        { id: "key", type: "directional", color: "#fff1d6", intensity: 3, position: [5, 8, 4] },
      ],
      assets: [
        {
          id: "subject",
          name: "Central subject",
          category: "subject",
          description: `Stylized central representation of ${prompt}`,
          tags: ["subject", "stylized", "reusable"],
          dimensions: [2, 2.4, 2],
          style: "low-poly",
          parts: [
            { name: "body", primitive: "box", size: [1.5, 1.6, 1.5], position: [0, 0.8, 0], rotation: [0, 0, 0], color: "#f59e0b", bevel: 0.08 },
            { name: "top", primitive: "sphere", size: [1.1, 1.1, 1.1], position: [0, 1.9, 0], rotation: [0, 0, 0], color: "#fbbf24", bevel: 0 },
          ],
        },
        {
          id: "platform",
          name: "Platform",
          category: "support",
          description: "A low support platform",
          tags: ["platform", "support", "reusable"],
          dimensions: [4, 0.4, 4],
          style: "low-poly",
          parts: [
            { name: "base", primitive: "cylinder", size: [4, 0.4, 4], position: [0, 0.2, 0], rotation: [0, 0, 0], color: "#475569", bevel: 0.04 },
          ],
        },
        {
          id: "marker",
          name: "Context marker",
          category: "marker",
          description: "A slim contextual marker",
          tags: ["marker", "context", "reusable"],
          dimensions: [0.3, 2, 0.3],
          style: "low-poly",
          parts: [
            { name: "post", primitive: "cylinder", size: [0.25, 2, 0.25], position: [0, 1, 0], rotation: [0, 0, 0], color: "#38bdf8", bevel: 0.02 },
          ],
        },
      ],
      objects: [
        { id: "platform", assetSpecId: "platform", position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], label: "Foundation", highlight: false },
        { id: "subject", assetSpecId: "subject", position: [0, 0.4, 0], rotation: [0, 0, 0], scale: [1, 1, 1], label: "Main concept", highlight: true },
        { id: "marker", assetSpecId: "marker", position: [2.6, 0, -0.5], rotation: [0, 0, 0], scale: [1, 1, 1], label: "Context", highlight: false },
      ],
      relationships: [
        { from: "subject", to: "platform", type: "on", description: "The subject rests on the platform." },
        { from: "marker", to: "subject", type: "beside", description: "The marker provides context." },
      ],
      states: [
        { id: "overview", label: "Overview", visibleObjects: ["platform", "subject", "marker"], highlightedObjects: [] },
        { id: "focus", label: "Focus", visibleObjects: ["platform", "subject", "marker"], highlightedObjects: ["subject"] },
      ],
      transitions: [{ from: "overview", to: "focus", durationMs: 600 }],
    };
    return validatePlan(plan, maxObjects);
  }

  async inspect(
    manifest: SceneManifest,
    _screenshotPath: string,
    _spatial?: SpatialReport,
    _plan?: ScenePlan,
  ): Promise<Inspection> {
    if (manifest.revision > 1) {
      return {
        verdict: "pass",
        category: "none",
        issue: "",
        evidence: "The deterministic correction was rerendered and reinspected.",
        patch: { kind: "none" },
      };
    }
    return {
      verdict: "fix",
      category: "framing",
      issue: "The deterministic inspection requests one reproducible camera refinement.",
      evidence: "Offline verification fixture.",
      patch: { kind: "camera", position: [6.5, 4.8, 7.5], target: [0, 1.1, 0] },
    };
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
  if (findings.some((finding) => finding.sourceUrls.length === 0)) {
    throw new Error(`Research perspective ${expectedId} contained a finding without a matching grounded source URL`);
  }
  return ResearchPerspectiveResultSchema.parse({
    ...result,
    perspectiveId: expectedId,
    findings,
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

function sanitizeForGemini(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitizeForGemini);
  if (!node || typeof node !== "object") return node;
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
  const assetIds = new Set(normalized.assets.map((asset) => asset.id));
  const objectIds = new Set(normalized.objects.map((object) => object.id));
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
  return normalized;
}
