import { z } from "zod";
import { CompiledSurgicalModuleSchema } from "./atlas/module-contracts.js";

export const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);
export type Vec3 = z.infer<typeof Vec3Schema>;

export const Bounds3Schema = z.object({
  min: Vec3Schema,
  max: Vec3Schema,
});
export type Bounds3 = z.infer<typeof Bounds3Schema>;

export const HexColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const EntityIdSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/).max(100);

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

const SceneCameraSchema = z.object({
  position: Vec3Schema,
  target: Vec3Schema,
  fov: z.number().min(20).max(90),
});

const SceneStateSchema = z.object({
  id: EntityIdSchema,
  label: z.string().min(1),
  objective: z.string().min(1),
  visibleObjects: z.array(z.string()).default([]),
  highlightedObjects: z.array(z.string()).default([]),
  visibleNodes: z.array(z.string()).default([]),
  highlightedNodes: z.array(z.string()).default([]),
  mutations: z.array(z.never()).default([]),
  cameraViewId: z.string().optional(),
});

const SceneTransitionSchema = z.object({
  from: EntityIdSchema,
  to: EntityIdSchema,
  durationMs: z.number().int().nonnegative(),
  kind: z.enum(["normal", "alternative", "complication"]).default("normal"),
  condition: z.string().optional(),
  description: z.string().optional(),
});

export const SceneManifestSchema = z.object({
  schemaVersion: z.literal("1.0"),
  projectId: z.string().min(1),
  sceneId: z.string().min(1),
  title: z.string().min(1),
  revision: z.number().int().positive(),
  environment: z.object({
    background: HexColorSchema,
    groundColor: HexColorSchema,
    groundSize: z.number().positive(),
  }),
  camera: SceneCameraSchema,
  lights: z.array(z.unknown()).default([]),
  objects: z.array(z.never()).default([]),
  module: CompiledSurgicalModuleSchema,
  relationships: z.array(z.never()).default([]),
  states: z.array(SceneStateSchema).min(1),
  transitions: z.array(SceneTransitionSchema),
  generatedAt: z.iso.datetime(),
});
export type SceneManifest = z.infer<typeof SceneManifestSchema>;

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
  objectIds: z.array(z.string()).max(8),
  evidence: z.string().min(1),
});

export const SpatialReportSchema = z.object({
  schemaVersion: z.literal("2.0"),
  analyzer: z.string().min(1),
  sceneRevision: z.number().int().positive(),
  sceneBounds: Bounds3Schema,
  objects: z.array(z.unknown()),
  issues: z.array(SpatialIssueSchema),
  generatedAt: z.iso.datetime(),
});
export type SpatialReport = z.infer<typeof SpatialReportSchema>;

export const QaPatchSchema = z.object({ kind: z.literal("none") });
export type QaPatch = z.infer<typeof QaPatchSchema>;

export const QualityAssessmentSchema = z.object({
  recognizabilityScore: z.number().min(0).max(1),
  domainFidelityScore: z.number().min(0).max(1),
  visualQualityScore: z.number().min(0).max(1),
  constructionCompletenessScore: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  failedCriteria: z.array(z.string().min(1).max(500)).max(12),
  strengths: z.array(z.string().min(1).max(500)).max(8),
  recommendedAction: z.enum(["pass", "targeted-research", "partial-replan"]),
  targetStudyIds: z.array(EntityIdSchema).max(8),
  researchQuestions: z.array(z.string().min(1).max(500)).max(8),
  rationale: z.string().min(1).max(1500),
});
export type QualityAssessment = z.infer<typeof QualityAssessmentSchema>;

export const InspectionSchema = z.object({
  verdict: z.enum(["pass", "fix"]),
  category: z.enum([
    "none",
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
  assessment: QualityAssessmentSchema,
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
  // Renderer recovery is separately bounded because it can happen before any
  // visual inspection has a screenshot to score.
  renderRecoveries: z.number().int().nonnegative().default(0),
  recentRenderFailureFingerprints: z.array(z.string().length(64)).max(12).default([]),
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
  kind: z.enum(["stage", "operation"]).default("stage"),
  operationId: z.string().optional(),
  message: z.string().max(1000).optional(),
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
