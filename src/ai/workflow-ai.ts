import fs from "node:fs/promises";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { z } from "zod";
import type { Config } from "../config.js";
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

const ResearchPlanSchema = z.object({ research: ResearchBriefSchema, plan: ScenePlanSchema });
export type ResearchPlan = z.infer<typeof ResearchPlanSchema>;

export interface WorkflowAI {
  readonly identity: string;
  readonly researchIdentity: string;
  readonly planningIdentity: string;
  readonly inspectionIdentity: string;
  researchAndPlan(prompt: string, maxObjects: number): Promise<ResearchPlan>;
  research(prompt: string): Promise<ResearchBrief>;
  plan(prompt: string, research: ResearchBrief, maxObjects: number): Promise<ScenePlan>;
  inspect(manifest: SceneManifest, screenshotPath: string, spatial?: SpatialReport): Promise<Inspection>;
}

export class GeminiWorkflowAI implements WorkflowAI {
  readonly identity: string;
  readonly researchIdentity: string;
  readonly planningIdentity: string;
  readonly inspectionIdentity: string;
  private readonly ai: GoogleGenAI;

  constructor(private readonly config: Config) {
    if (!config.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is required for AI_DRIVER=gemini");
    this.ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
    this.identity = `gemini:${config.GEMINI_RESEARCH_MODEL}:${config.GEMINI_PLANNER_MODEL}:${config.GEMINI_INSPECTOR_MODEL}`;
    this.researchIdentity = `gemini-research:${config.GEMINI_RESEARCH_MODEL}:v2`;
    this.planningIdentity = `gemini-planning:${config.GEMINI_RESEARCH_MODEL}:${config.GEMINI_PLANNER_MODEL}:v2`;
    this.inspectionIdentity = `gemini-inspection:${config.GEMINI_INSPECTOR_MODEL}:v2`;
  }

  async researchAndPlan(prompt: string, maxObjects: number): Promise<ResearchPlan> {
    const result = await this.ai.models.generateContent({
      model: this.config.GEMINI_RESEARCH_MODEL,
      contents: `Research and plan a compact interactive 3D scene for: ${prompt}

Return both a concise grounded visual research brief and a deterministic scene plan.
- Use at most ${maxObjects} scene objects and ${maxObjects} asset specs.
- Assets must use 1-16 bounded Blender primitives with meter dimensions and radian rotations.
- Make spatial relationships explicit; place objects near the origin and on a surface or intentional support.
- Prefer recognizable silhouettes and reusable assets over fine detail.
- Include a small diverse reference set with direct image URL and containing source URL. Never invent URLs.
- IDs use lowercase ASCII letters, digits, hyphens, or underscores and start with a letter.`,
      config: {
        tools: [{ googleSearch: { searchTypes: { webSearch: {}, imageSearch: {} } } }],
        responseMimeType: "application/json",
        responseJsonSchema: z.toJSONSchema(ResearchPlanSchema),
        thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
      },
    });
    const parsed = ResearchPlanSchema.parse(parseJsonResponse(result.text));
    const chunks = result.candidates?.flatMap((candidate) => candidate.groundingMetadata?.groundingChunks ?? []) ?? [];
    return {
      research: mergeGrounding(parsed.research, chunks),
      plan: validatePlan(parsed.plan, maxObjects),
    };
  }

  async research(prompt: string): Promise<ResearchBrief> {
    const result = await this.ai.models.generateContent({
      model: this.config.GEMINI_RESEARCH_MODEL,
      contents: `Research this visual scene concept for 3D reconstruction: ${prompt}\n
Return a concise visual brief. Focus on recognizable shapes, spatial relationships, scale, materials, lighting, and historically or technically important details. Find a small diverse set of reference images. Every reference must contain both the direct image URL and the containing source page URL. Do not invent URLs.`,
      config: {
        tools: [{ googleSearch: { searchTypes: { webSearch: {}, imageSearch: {} } } }],
        responseMimeType: "application/json",
        responseJsonSchema: z.toJSONSchema(ResearchBriefSchema),
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
      },
    });
    const brief = ResearchBriefSchema.parse(parseJsonResponse(result.text));
    const chunks = result.candidates?.flatMap((candidate) => candidate.groundingMetadata?.groundingChunks ?? []) ?? [];
    return mergeGrounding(brief, chunks);
  }

  async plan(prompt: string, research: ResearchBrief, maxObjects: number): Promise<ScenePlan> {
    const result = await this.ai.models.generateContent({
      model: this.config.GEMINI_PLANNER_MODEL,
      contents: `Create a compact, deterministic Three.js scene plan for this prompt:\n${prompt}\n
Research brief:\n${JSON.stringify(research)}\n
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
- Each object must reference an asset spec ID that exists in the same response.`,
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: z.toJSONSchema(ScenePlanSchema),
        thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
      },
    });
    return validatePlan(ScenePlanSchema.parse(parseJsonResponse(result.text)), maxObjects);
  }

  async inspect(manifest: SceneManifest, screenshotPath: string, spatial?: SpatialReport): Promise<Inspection> {
    const image = await fs.readFile(screenshotPath);
    const result = await this.ai.models.generateContent({
      model: this.config.GEMINI_INSPECTOR_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Inspect this rendered scene against its manifest and local spatial evidence. Geometry evidence is authoritative for bounds, framing, floating, and intersection; use the image for visual and semantic judgment. Choose at most one obvious, high-impact issue. Return pass/none when no safe correction is justified. Only request a patch allowed by the response schema. Manifest: ${JSON.stringify(manifest)} Spatial evidence: ${JSON.stringify(spatial ?? null)}`,
            },
            { inlineData: { data: image.toString("base64"), mimeType: "image/png" } },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: z.toJSONSchema(InspectionSchema),
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

  async researchAndPlan(prompt: string, maxObjects: number): Promise<ResearchPlan> {
    const research = await this.research(prompt);
    return { research, plan: await this.plan(prompt, research, maxObjects) };
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

  async plan(prompt: string, _research: ResearchBrief, maxObjects: number): Promise<ScenePlan> {
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

  async inspect(_manifest: SceneManifest, _screenshotPath: string, _spatial?: SpatialReport): Promise<Inspection> {
    return {
      verdict: "fix",
      category: "framing",
      issue: "The deterministic inspection requests one reproducible camera refinement.",
      evidence: "Offline verification fixture.",
      patch: { kind: "camera", position: [6.5, 4.8, 7.5], target: [0, 1.1, 0] },
    };
  }
}

interface GroundingChunk {
  web?: { uri?: string; title?: string };
  image?: { imageUri?: string; sourceUri?: string; title?: string; domain?: string };
}

function mergeGrounding(brief: ResearchBrief, chunks: GroundingChunk[]): ResearchBrief {
  const merged = structuredClone(brief);
  for (const chunk of chunks) {
    if (chunk.web?.uri && chunk.web.title && !merged.sources.some((source) => source.url === chunk.web?.uri)) {
      merged.sources.push({ url: chunk.web.uri, title: chunk.web.title, note: "Gemini Google Search grounding source" });
    }
    if (
      chunk.image?.imageUri &&
      chunk.image.sourceUri &&
      !merged.references.some((reference) => reference.imageUrl === chunk.image?.imageUri)
    ) {
      merged.references.push({
        imageUrl: chunk.image.imageUri,
        sourceUrl: chunk.image.sourceUri,
        title: chunk.image.title || chunk.image.domain || "Grounded reference image",
        relevance: "Gemini image-search grounding reference",
      });
    }
  }
  return ResearchBriefSchema.parse({
    ...merged,
    sources: merged.sources.slice(0, 12),
    references: merged.references.slice(0, 8),
  });
}

function parseJsonResponse(text: string | undefined): unknown {
  if (!text) throw new Error("Gemini returned an empty response");
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(stripped);
}

function validatePlan(plan: ScenePlan, maxObjects: number): ScenePlan {
  if (plan.objects.length > maxObjects || plan.assets.length > maxObjects) {
    throw new Error(`Scene plan exceeds configured maximum of ${maxObjects} objects/assets`);
  }
  const assetIds = new Set(plan.assets.map((asset) => asset.id));
  const objectIds = new Set(plan.objects.map((object) => object.id));
  for (const object of plan.objects) {
    if (!assetIds.has(object.assetSpecId)) {
      throw new Error(`Object ${object.id} references missing asset spec ${object.assetSpecId}`);
    }
  }
  for (const relation of plan.relationships) {
    if (!objectIds.has(relation.from) || !objectIds.has(relation.to)) {
      throw new Error(`Relationship references missing object: ${relation.from} -> ${relation.to}`);
    }
  }
  return plan;
}
