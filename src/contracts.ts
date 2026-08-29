import { z } from "zod";

export const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);
export type Vec3 = z.infer<typeof Vec3Schema>;
export const PositiveVec3Schema = z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]);

export const Bounds3Schema = z.object({
  min: Vec3Schema,
  max: Vec3Schema,
});
export type Bounds3 = z.infer<typeof Bounds3Schema>;

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
  references: z.array(ReferenceCandidateSchema).max(64),
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
  size: PositiveVec3Schema,
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
  dimensions: PositiveVec3Schema,
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
  labelPosition: Vec3Schema.optional(),
  highlight: z.boolean().default(false),
});

export const RelationshipSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  type: z.enum(["on", "beside", "inside", "supports", "uses", "part-of"]),
  description: z.string().default(""),
});

export const SceneStateMutationSchema = z.object({
  entityId: z.string().min(1),
  position: Vec3Schema.optional(),
  rotation: Vec3Schema.optional(),
  scale: Vec3Schema.optional(),
  opacity: z.number().min(0).max(1).optional(),
}).refine(
  (mutation) =>
    mutation.position !== undefined ||
    mutation.rotation !== undefined ||
    mutation.scale !== undefined ||
    mutation.opacity !== undefined,
  { message: "A scene-state mutation must change at least one property" },
);
export type SceneStateMutation = z.infer<typeof SceneStateMutationSchema>;

export const SceneStateSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  objective: z.string().min(1).default("Present the configured scene state."),
  visibleObjects: z.array(z.string()),
  highlightedObjects: z.array(z.string()),
  visibleNodes: z.array(z.string()).default([]),
  highlightedNodes: z.array(z.string()).default([]),
  cameraViewId: z.string().optional(),
  mutations: z.array(SceneStateMutationSchema).max(64).default([]),
});

export const SceneTransitionSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  durationMs: z.number().int().min(100).max(10000),
  kind: z.enum(["normal", "alternative", "complication"]).default("normal"),
  condition: z.string().min(1).optional(),
  description: z.string().default(""),
}).refine(
  (transition) => transition.kind === "normal" || transition.condition !== undefined,
  { message: "Alternative and complication transitions require an explicit condition", path: ["condition"] },
);

const SceneEntityIdSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/);

export const ProceduralMaterialSchema = z.object({
  id: SceneEntityIdSchema,
  name: z.string().min(1),
  color: HexColorSchema,
  roughness: z.number().min(0).max(1).default(0.7),
  metalness: z.number().min(0).max(1).default(0),
  opacity: z.number().min(0.05).max(1).default(1),
  emissive: HexColorSchema.default("#000000"),
  emissiveIntensity: z.number().min(0).max(5).default(0),
  side: z.enum(["front", "back", "double"]).default("front"),
});
export type ProceduralMaterial = z.infer<typeof ProceduralMaterialSchema>;

export const ProceduralLandmarkSchema = z.object({
  id: SceneEntityIdSchema,
  label: z.string().min(1),
  position: Vec3Schema,
  description: z.string().min(1),
});
export type ProceduralLandmark = z.infer<typeof ProceduralLandmarkSchema>;

export const ProceduralPathPointSchema = z.object({
  landmarkId: SceneEntityIdSchema.optional(),
  position: Vec3Schema.optional(),
  offset: Vec3Schema.default([0, 0, 0]),
  radius: z.number().positive().optional(),
});
export type ProceduralPathPoint = z.infer<typeof ProceduralPathPointSchema>;

const ProceduralTransformFields = {
  position: Vec3Schema.default([0, 0, 0]),
  rotation: Vec3Schema.default([0, 0, 0]),
  scale: PositiveVec3Schema.default([1, 1, 1]),
};

const ProceduralNodeBaseSchema = z.object({
  id: SceneEntityIdSchema,
  name: z.string().min(1),
  studyId: SceneEntityIdSchema,
  tags: z.array(z.string().min(1).max(80)).max(12).default([]),
  materialId: SceneEntityIdSchema,
  parentId: SceneEntityIdSchema.optional(),
  dependsOn: z.array(SceneEntityIdSchema).max(12).default([]),
  layer: z.enum([
    "context",
    "covering",
    "surface",
    "primary",
    "landmark",
    "instrument",
    "effect",
    "annotation",
  ]).default("primary"),
  label: z.string().min(1),
  labelVisible: z.boolean().default(true),
  highlight: z.boolean().default(false),
  castShadow: z.boolean().default(true),
  receiveShadow: z.boolean().default(true),
  ...ProceduralTransformFields,
});

export const ProceduralPrimitiveNodeSchema = ProceduralNodeBaseSchema.extend({
  kind: z.literal("primitive"),
  shape: z.enum(["box", "sphere", "cylinder", "cone", "torus", "capsule"]),
  size: PositiveVec3Schema,
  segments: z.number().int().min(6).max(64).default(24),
});

export const ProceduralTubeNodeSchema = ProceduralNodeBaseSchema.extend({
  kind: z.literal("tube"),
  points: z.array(ProceduralPathPointSchema).min(2).max(48),
  radius: z.number().positive(),
  radialSegments: z.number().int().min(5).max(32).default(12),
  tubularSegments: z.number().int().min(4).max(256).default(48),
  closed: z.boolean().default(false),
});

export const ProceduralExtrusionNodeSchema = ProceduralNodeBaseSchema.extend({
  kind: z.literal("extrusion"),
  outline: z.array(z.tuple([z.number(), z.number()])).min(3).max(48),
  depth: z.number().positive(),
  bevel: z.number().min(0).max(100).default(0),
});

export const ProceduralLatheNodeSchema = ProceduralNodeBaseSchema.extend({
  kind: z.literal("lathe"),
  profile: z.array(z.tuple([z.number().min(0), z.number()])).min(2).max(48),
  segments: z.number().int().min(8).max(96).default(32),
});

export const ProceduralInstanceTransformSchema = z.object({
  position: Vec3Schema,
  rotation: Vec3Schema.default([0, 0, 0]),
  scale: PositiveVec3Schema.default([1, 1, 1]),
});

export const ProceduralInstancesNodeSchema = ProceduralNodeBaseSchema.extend({
  kind: z.literal("instances"),
  shape: z.enum(["box", "sphere", "cylinder", "cone"]),
  size: PositiveVec3Schema,
  segments: z.number().int().min(6).max(32).default(16),
  instances: z.array(ProceduralInstanceTransformSchema).min(1).max(256),
});

export const ProceduralNodeSchema = z.discriminatedUnion("kind", [
  ProceduralPrimitiveNodeSchema,
  ProceduralTubeNodeSchema,
  ProceduralExtrusionNodeSchema,
  ProceduralLatheNodeSchema,
  ProceduralInstancesNodeSchema,
]);
export type ProceduralNode = z.infer<typeof ProceduralNodeSchema>;

export const ProceduralViewSchema = z.object({
  id: SceneEntityIdSchema,
  label: z.string().min(1),
  purpose: z.string().min(1),
  position: Vec3Schema,
  target: Vec3Schema,
  fov: z.number().min(15).max(100),
  required: z.boolean().default(true),
  stateIds: z.array(SceneEntityIdSchema).max(12).default([]),
});
export type ProceduralView = z.infer<typeof ProceduralViewSchema>;

export const ProceduralInvariantSchema = z.discriminatedUnion("kind", [
  z.object({
    id: SceneEntityIdSchema,
    kind: z.literal("continuity"),
    label: z.string().min(1),
    nodeA: SceneEntityIdSchema,
    endA: z.enum(["start", "end"]),
    nodeB: SceneEntityIdSchema,
    endB: z.enum(["start", "end"]),
    tolerance: z.number().positive(),
    required: z.boolean().default(true),
  }),
  z.object({
    id: SceneEntityIdSchema,
    kind: z.literal("contact"),
    label: z.string().min(1),
    nodeA: SceneEntityIdSchema,
    nodeB: SceneEntityIdSchema,
    tolerance: z.number().positive(),
    required: z.boolean().default(true),
  }),
  z.object({
    id: SceneEntityIdSchema,
    kind: z.literal("containment"),
    label: z.string().min(1),
    innerNode: SceneEntityIdSchema,
    outerNode: SceneEntityIdSchema,
    tolerance: z.number().min(0),
    required: z.boolean().default(true),
  }),
  z.object({
    id: SceneEntityIdSchema,
    kind: z.literal("distance"),
    label: z.string().min(1),
    nodeA: SceneEntityIdSchema,
    nodeB: SceneEntityIdSchema,
    min: z.number().min(0),
    max: z.number().positive(),
    required: z.boolean().default(true),
  }),
  z.object({
    id: SceneEntityIdSchema,
    kind: z.literal("visible"),
    label: z.string().min(1),
    nodeId: SceneEntityIdSchema,
    viewId: SceneEntityIdSchema,
    required: z.boolean().default(true),
  }),
]);
export type ProceduralInvariant = z.infer<typeof ProceduralInvariantSchema>;

export const ProceduralProgramSchema = z.object({
  schemaVersion: z.literal("1.0"),
  coordinateFrame: z.object({
    name: z.string().min(1),
    units: z.enum(["meters", "centimeters", "millimeters"]),
    metersPerUnit: z.number().positive().max(1),
    upAxis: z.literal("Y"),
    handedness: z.literal("right"),
    originDescription: z.string().min(1),
  }),
  landmarks: z.array(ProceduralLandmarkSchema).max(96).default([]),
  materials: z.array(ProceduralMaterialSchema).min(1).max(48),
  nodes: z.array(ProceduralNodeSchema).min(1).max(128),
  views: z.array(ProceduralViewSchema).min(1).max(12),
  invariants: z.array(ProceduralInvariantSchema).max(96).default([]),
  triangleBudget: z.number().int().min(1000).max(2_000_000).default(250_000),
});
export type ProceduralProgram = z.infer<typeof ProceduralProgramSchema>;

export const ReusableProceduralComponentSchema = z.object({
  componentKey: z.string().length(64),
  node: ProceduralNodeSchema,
  material: ProceduralMaterialSchema,
  landmarks: z.array(ProceduralLandmarkSchema).max(48),
  sourceProjectId: z.string().min(1),
  sourceRevision: z.number().int().positive(),
  createdAt: z.iso.datetime(),
});
export type ReusableProceduralComponent = z.infer<typeof ReusableProceduralComponentSchema>;

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
  assets: z.array(AssetSpecSchema).max(8).default([]),
  objects: z.array(PlannedObjectSchema).max(12).default([]),
  procedural: ProceduralProgramSchema.optional(),
  relationships: z.array(RelationshipSchema).max(20),
  states: z.array(SceneStateSchema).max(8),
  transitions: z.array(SceneTransitionSchema).max(8),
}).refine(
  (plan) => plan.objects.length > 0 || plan.procedural !== undefined,
  {
    message: "Scene plan must contain imported objects, a procedural program, or both",
    path: ["objects"],
  },
);
export type ScenePlan = z.infer<typeof ScenePlanSchema>;

export const AssetGeometrySchema = z.object({
  bounds: Bounds3Schema,
  size: Vec3Schema,
  source: z.literal("glb-accessors:v1"),
  meshInstances: z.number().int().positive(),
});
export type AssetGeometry = z.infer<typeof AssetGeometrySchema>;

export const ResolvedAssetSchema = z.object({
  assetId: z.string().min(1),
  assetKey: z.string().min(1),
  specId: z.string().min(1),
  path: z.string().min(1),
  url: z.string().min(1),
  sha256: z.string().min(1),
  reused: z.boolean(),
  generator: z.string().min(1),
  geometry: AssetGeometrySchema.optional(),
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
  procedural: ProceduralProgramSchema.optional(),
  relationships: z.array(RelationshipSchema),
  states: z.array(SceneStateSchema),
  transitions: z.array(SceneTransitionSchema),
  generatedAt: z.iso.datetime(),
});
export type SceneManifest = z.infer<typeof SceneManifestSchema>;

export const SpatialObjectFactSchema = z.object({
  objectId: z.string().min(1),
  assetId: z.string().min(1),
  assetSha256: z.string().length(64),
  geometrySource: z.enum(["glb-accessors:v1", "procedural-geometry:v2"]),
  localBounds: Bounds3Schema,
  bounds: Bounds3Schema,
  floorClearance: z.number(),
  cameraDepth: z.number(),
  projectedCoverage: z.number().min(0),
  inFrame: z.boolean(),
});

export const SpatialIssueSchema = z.object({
  category: z.enum([
    "framing",
    "intersection",
    "floating",
    "scale",
    "continuity",
    "contact",
    "containment",
    "dependency",
    "visibility",
    "performance",
  ]),
  severity: z.enum(["info", "warning", "error"]),
  objectIds: z.array(z.string()).max(4),
  evidence: z.string().min(1),
});

export const SpatialReportSchema = z.object({
  schemaVersion: z.literal("2.0"),
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
  z.object({
    kind: z.literal("asset-regenerate"),
    assetSpecId: z.string().min(1),
    description: z.string().min(1),
    parts: z.array(AssetPartSchema).min(1).max(16),
  }),
  z.object({
    kind: z.literal("procedural-node"),
    nodeId: SceneEntityIdSchema,
    node: ProceduralNodeSchema,
  }),
  z.object({
    kind: z.literal("procedural-landmark"),
    landmarkId: SceneEntityIdSchema,
    position: Vec3Schema,
  }),
  z.object({ kind: z.literal("none") }),
]);
export type QaPatch = z.infer<typeof QaPatchSchema>;

export const QualityAssessmentSchema = z.object({
  recognizabilityScore: z.number().min(0).max(1),
  domainFidelityScore: z.number().min(0).max(1),
  visualQualityScore: z.number().min(0).max(1),
  constructionCompletenessScore: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  failedCriteria: z.array(z.string().min(1).max(500)).max(12),
  strengths: z.array(z.string().min(1).max(500)).max(8),
  recommendedAction: z.enum(["pass", "direct-fix", "targeted-research", "partial-replan"]),
  targetStudyIds: z.array(SceneEntityIdSchema).max(8),
  researchQuestions: z.array(z.string().min(1).max(500)).max(8),
  rationale: z.string().min(1).max(1500),
});
export type QualityAssessment = z.infer<typeof QualityAssessmentSchema>;

const LegacyQualityAssessment = {
  recognizabilityScore: 1,
  domainFidelityScore: 1,
  visualQualityScore: 1,
  constructionCompletenessScore: 1,
  confidence: 0.5,
  failedCriteria: [],
  strengths: [],
  recommendedAction: "pass" as const,
  targetStudyIds: [],
  researchQuestions: [],
  rationale: "Legacy inspection without scored quality evidence.",
};

export const InspectionSchema = z.object({
  verdict: z.enum(["pass", "fix"]),
  category: z.enum([
    "none",
    "asset-load",
    "geometry",
    "framing",
    "intersection",
    "floating",
    "scale",
    "lighting",
    "label",
    "composition",
    "continuity",
    "containment",
    "contact",
    "performance",
  ]),
  issue: z.string(),
  evidence: z.string(),
  patch: QaPatchSchema,
  assessment: QualityAssessmentSchema.default(LegacyQualityAssessment),
  targetId: z.string().optional(),
  stateId: z.string().optional(),
  viewId: z.string().optional(),
});
export type Inspection = z.infer<typeof InspectionSchema>;

export const QaTargetSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  stateId: z.string().optional(),
  viewId: z.string().optional(),
});
export type QaTarget = z.infer<typeof QaTargetSchema>;

export const QualitySupervisorStatusSchema = z.enum([
  "running",
  "complete",
  "time-exhausted",
  "action-exhausted",
  "api-exhausted",
]);

export const QaCoverageSchema = z.object({
  sceneRevision: z.number().int().positive(),
  requiredTargets: z.array(QaTargetSchema).min(1),
  passedTargetIds: z.array(z.string()),
  unresolvedTargetIds: z.array(z.string()),
  refinements: z.number().int().nonnegative(),
  complete: z.boolean(),
  qualityGate: z.object({
    recognizabilityThreshold: z.number().min(0).max(1),
    domainFidelityThreshold: z.number().min(0).max(1),
    visualQualityThreshold: z.number().min(0).max(1),
    constructionCompletenessThreshold: z.number().min(0).max(1),
    finalAssessment: QualityAssessmentSchema,
    hardSpatialErrors: z.number().int().nonnegative(),
    browserErrors: z.number().int().nonnegative(),
    passed: z.boolean(),
  }).optional(),
  supervisorStatus: QualitySupervisorStatusSchema.optional(),
  generatedAt: z.iso.datetime(),
});
export type QaCoverage = z.infer<typeof QaCoverageSchema>;

export const QualitySupervisorStateSchema = z.object({
  schemaVersion: z.literal("1.0"),
  projectId: z.string().min(1),
  startedAt: z.iso.datetime(),
  deadlineAt: z.iso.datetime(),
  status: QualitySupervisorStatusSchema,
  attempt: z.number().int().nonnegative(),
  inspections: z.number().int().nonnegative(),
  refinements: z.number().int().nonnegative(),
  targetedResearchRounds: z.number().int().nonnegative(),
  replans: z.number().int().nonnegative(),
  logicalAiCalls: z.number().int().nonnegative(),
  currentRevision: z.number().int().positive(),
  currentTargetId: z.string().min(1).optional(),
  passedTargetIds: z.array(z.string()),
  bestScores: z.object({
    recognizability: z.number().min(0).max(1),
    domainFidelity: z.number().min(0).max(1),
    visualQuality: z.number().min(0).max(1),
    constructionCompleteness: z.number().min(0).max(1),
  }),
  recentRepairFingerprints: z.array(z.string().length(64)).max(24),
  recentQualityScores: z.array(z.number().min(0).max(1)).max(24),
  lastProgressAt: z.iso.datetime(),
  lastRecoveryReason: z.string().max(2000).default(""),
  updatedAt: z.iso.datetime(),
});
export type QualitySupervisorState = z.infer<typeof QualitySupervisorStateSchema>;

export const WorkflowStageSchema = z.enum([
  "created",
  "clarifying",
  "awaiting_clarification",
  "researching",
  "planning_research",
  "auditing_research",
  "awaiting_research_approval",
  "planning",
  "resolving_assets",
  "generating_assets",
  "assembling",
  "rendering_initial",
  "inspecting",
  "refining",
  "rendering_final",
  "awaiting_feedback",
  "awaiting_quality",
  "resumed",
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
  userId: z.string().min(1).max(128).default("local-user"),
  parentProjectId: z.string().optional(),
  slug: z.string(),
  root: z.string(),
  status: WorkflowStageSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  finalRevision: z.number().int().positive().optional(),
  finalQaVerdict: InspectionSchema.shape.verdict.optional(),
  qaExhausted: z.boolean().optional(),
  error: z.string().optional(),
});
export type ProjectRecord = z.infer<typeof ProjectRecordSchema>;

export const CreateProjectRequestSchema = z.object({
  prompt: z.string().trim().min(3).max(4000),
  userId: z.string().trim().min(1).max(128).default("local-user"),
});

export interface ReferenceArtifact {
  candidate: z.infer<typeof ReferenceCandidateSchema>;
  localPath?: string;
  sha256?: string;
  mediaType?: string;
  reused?: boolean;
  error?: string;
}
