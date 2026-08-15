import { z } from "zod";

export const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);
export type Vec3 = z.infer<typeof Vec3Schema>;

export const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const SourceSchema = z.object({
  url: z.url(),
  title: z.string().min(1),
  note: z.string().default(""),
});

export const ReferenceCandidateSchema = z.object({
  imageUrl: z.url(),
  sourceUrl: z.url(),
  title: z.string().min(1),
  relevance: z.string().min(1),
});

export const ResearchBriefSchema = z.object({
  concept: z.string().min(1),
  summary: z.string().min(1),
  visualNotes: z.array(z.string().min(1)).max(12),
  objectNotes: z.array(z.string().min(1)).max(16),
  styleKeywords: z.array(z.string().min(1)).max(12),
  sources: z.array(SourceSchema).max(12),
  references: z.array(ReferenceCandidateSchema).max(8),
});
export type ResearchBrief = z.infer<typeof ResearchBriefSchema>;

export const PrimitiveKindSchema = z.enum([
  "box",
  "sphere",
  "cylinder",
  "cone",
  "torus",
  "plane",
]);

export const AssetPartSchema = z.object({
  name: z.string().min(1),
  primitive: PrimitiveKindSchema,
  size: Vec3Schema,
  position: Vec3Schema,
  rotation: Vec3Schema.default([0, 0, 0]),
  color: HexColorSchema,
  bevel: z.number().min(0).max(0.25).default(0.02),
});

export const AssetSpecSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  name: z.string().min(1),
  category: z.string().min(1),
  description: z.string().min(1),
  tags: z.array(z.string().min(1)).min(1).max(16),
  dimensions: Vec3Schema,
  style: z.string().min(1),
  parts: z.array(AssetPartSchema).min(1).max(16),
});
export type AssetSpec = z.infer<typeof AssetSpecSchema>;

export const LightSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["ambient", "hemisphere", "directional", "point"]),
  color: HexColorSchema,
  intensity: z.number().min(0).max(20),
  position: Vec3Schema.default([0, 0, 0]),
});

export const PlannedObjectSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  assetSpecId: z.string().min(1),
  position: Vec3Schema,
  rotation: Vec3Schema,
  scale: Vec3Schema,
  label: z.string().min(1),
  highlight: z.boolean().default(false),
});

export const RelationshipSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  type: z.enum(["on", "beside", "inside", "supports", "uses", "part-of"]),
  description: z.string().default(""),
});

export const SceneStateSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  visibleObjects: z.array(z.string()),
  highlightedObjects: z.array(z.string()),
});

export const SceneTransitionSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  durationMs: z.number().int().min(100).max(10000),
});

export const ScenePlanSchema = z.object({
  title: z.string().min(1),
  rationale: z.string().min(1),
  environment: z.object({
    background: HexColorSchema,
    groundColor: HexColorSchema,
    groundSize: z.number().min(1).max(100),
  }),
  camera: z.object({
    position: Vec3Schema,
    target: Vec3Schema,
    fov: z.number().min(20).max(90),
  }),
  lights: z.array(LightSchema).min(1).max(6),
  assets: z.array(AssetSpecSchema).min(1).max(8),
  objects: z.array(PlannedObjectSchema).min(1).max(12),
  relationships: z.array(RelationshipSchema).max(20),
  states: z.array(SceneStateSchema).max(8),
  transitions: z.array(SceneTransitionSchema).max(8),
});
export type ScenePlan = z.infer<typeof ScenePlanSchema>;

export const ResolvedAssetSchema = z.object({
  assetId: z.string().min(1),
  assetKey: z.string().min(1),
  specId: z.string().min(1),
  path: z.string().min(1),
  url: z.string().min(1),
  sha256: z.string().min(1),
  reused: z.boolean(),
  generator: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type ResolvedAsset = z.infer<typeof ResolvedAssetSchema>;

export const SceneObjectSchema = PlannedObjectSchema.omit({ assetSpecId: true }).extend({
  assetId: z.string().min(1),
  url: z.string().min(1),
  labelVisible: z.boolean().default(true),
});

export const SceneManifestSchema = z.object({
  schemaVersion: z.literal("1.0"),
  projectId: z.string().min(1),
  sceneId: z.string().min(1),
  title: z.string().min(1),
  revision: z.number().int().positive(),
  environment: ScenePlanSchema.shape.environment,
  camera: ScenePlanSchema.shape.camera,
  lights: ScenePlanSchema.shape.lights,
  objects: z.array(SceneObjectSchema),
  relationships: z.array(RelationshipSchema),
  states: z.array(SceneStateSchema),
  transitions: z.array(SceneTransitionSchema),
  generatedAt: z.iso.datetime(),
});
export type SceneManifest = z.infer<typeof SceneManifestSchema>;

export const Bounds3Schema = z.object({
  min: Vec3Schema,
  max: Vec3Schema,
});

export const SpatialObjectFactSchema = z.object({
  objectId: z.string().min(1),
  bounds: Bounds3Schema,
  floorClearance: z.number(),
  cameraDepth: z.number(),
  projectedCoverage: z.number().min(0),
  inFrame: z.boolean(),
});

export const SpatialIssueSchema = z.object({
  category: z.enum(["framing", "intersection", "floating", "scale"]),
  severity: z.enum(["info", "warning", "error"]),
  objectIds: z.array(z.string()).max(4),
  evidence: z.string().min(1),
});

export const SpatialReportSchema = z.object({
  schemaVersion: z.literal("1.0"),
  analyzer: z.string().min(1),
  sceneRevision: z.number().int().positive(),
  sceneBounds: Bounds3Schema,
  objects: z.array(SpatialObjectFactSchema),
  issues: z.array(SpatialIssueSchema),
  generatedAt: z.iso.datetime(),
});
export type SpatialReport = z.infer<typeof SpatialReportSchema>;

export const QaPatchSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("camera"),
    position: Vec3Schema,
    target: Vec3Schema,
  }),
  z.object({
    kind: z.literal("light"),
    objectId: z.string().min(1),
    position: Vec3Schema.optional(),
    intensity: z.number().min(0).max(20).optional(),
    color: HexColorSchema.optional(),
  }),
  z.object({
    kind: z.literal("object-transform"),
    objectId: z.string().min(1),
    position: Vec3Schema.optional(),
    rotation: Vec3Schema.optional(),
    scale: Vec3Schema.optional(),
  }),
  z.object({
    kind: z.literal("label"),
    objectId: z.string().min(1),
    visible: z.boolean(),
  }),
  z.object({ kind: z.literal("none") }),
]);
export type QaPatch = z.infer<typeof QaPatchSchema>;

export const InspectionSchema = z.object({
  verdict: z.enum(["pass", "fix"]),
  category: z.enum([
    "none",
    "asset-load",
    "framing",
    "intersection",
    "floating",
    "scale",
    "lighting",
    "label",
    "composition",
  ]),
  issue: z.string(),
  evidence: z.string(),
  patch: QaPatchSchema,
});
export type Inspection = z.infer<typeof InspectionSchema>;

export const WorkflowStageSchema = z.enum([
  "created",
  "researching",
  "planning",
  "resolving_assets",
  "generating_assets",
  "assembling",
  "rendering_initial",
  "inspecting",
  "refining",
  "rendering_final",
  "completed",
  "failed",
]);
export type WorkflowStage = z.infer<typeof WorkflowStageSchema>;

export const RunEventSchema = z.object({
  projectId: z.string(),
  runId: z.string(),
  sequence: z.number().int().nonnegative(),
  stage: WorkflowStageSchema,
  status: z.enum(["started", "completed", "failed", "info"]),
  detail: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.iso.datetime(),
});
export type RunEvent = z.infer<typeof RunEventSchema>;

export const ProjectRecordSchema = z.object({
  projectId: z.string(),
  runId: z.string(),
  prompt: z.string().min(1),
  slug: z.string(),
  root: z.string(),
  status: WorkflowStageSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  finalRevision: z.number().int().positive().optional(),
  error: z.string().optional(),
});
export type ProjectRecord = z.infer<typeof ProjectRecordSchema>;

export const CreateProjectRequestSchema = z.object({
  prompt: z.string().trim().min(3).max(4000),
});

export interface ReferenceArtifact {
  candidate: z.infer<typeof ReferenceCandidateSchema>;
  localPath?: string;
  sha256?: string;
  mediaType?: string;
  reused?: boolean;
  error?: string;
}
