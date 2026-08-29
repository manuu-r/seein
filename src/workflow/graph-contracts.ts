import { z } from "zod";
import { InspectionSchema, QaCoverageSchema, QualitySupervisorStateSchema, ResearchBriefSchema, SourceSchema, ReferenceCandidateSchema } from "../contracts.js";

const IdSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/);

export const ClarificationDimensionSchema = z.enum([
  "subject",
  "purpose",
  "audience",
  "accuracy",
  "style",
  "composition",
  "objects",
  "interaction",
  "constraints",
]);

export const ClarificationQuestionSchema = z.object({
  id: IdSchema,
  dimension: ClarificationDimensionSchema,
  question: z.string().min(3).max(500),
  reason: z.string().min(3).max(500),
  options: z.array(z.string().min(1).max(160)).max(5).default([]),
  allowFreeText: z.boolean().default(true),
  required: z.boolean().default(true),
});
export type ClarificationQuestion = z.infer<typeof ClarificationQuestionSchema>;

export const ClarificationTurnSchema = z.object({
  summary: z.string().min(3).max(1200),
  uncertainties: z.array(z.string().min(1).max(400)).min(1).max(8),
  questions: z.array(ClarificationQuestionSchema).min(1).max(4),
  assumptions: z.array(z.string().min(1).max(400)).max(8).default([]),
});
export type ClarificationTurn = z.infer<typeof ClarificationTurnSchema>;

export const ClarificationAnswerSchema = z.object({
  questionId: IdSchema,
  answer: z.string().trim().min(1).max(4000),
});
export type ClarificationAnswer = z.infer<typeof ClarificationAnswerSchema>;

export const ClarificationAnswerRequestSchema = z.object({
  answers: z.array(ClarificationAnswerSchema).min(1).max(4),
  additionalContext: z.string().trim().max(4000).default(""),
});

export const IntentFrameSchema = z.object({
  subject: z.string().min(1).max(1000),
  purpose: z.string().min(1).max(1000),
  audience: z.string().min(1).max(500),
  accuracy: z.enum(["reference-faithful", "plausible", "stylized"]),
  style: z.string().min(1).max(500),
  composition: z.string().min(1).max(1000),
  mustHave: z.array(z.string().min(1).max(300)).max(12),
  mustAvoid: z.array(z.string().min(1).max(300)).max(12),
  interactionGoal: z.string().min(1).max(1000),
  constraints: z.array(z.string().min(1).max(500)).max(12),
  assumptions: z.array(z.string().min(1).max(500)).max(12),
  evaluationCriteria: z.array(z.string().min(1).max(500)).min(1).max(12),
});
export type IntentFrame = z.infer<typeof IntentFrameSchema>;

export const ResearchPerspectiveIdSchema = z.enum(["visual-identity", "objects-materials", "scale-space"]);

export const ResearchPerspectiveSchema = z.object({
  id: ResearchPerspectiveIdSchema,
  label: z.string().min(1).max(120),
  objective: z.string().min(1).max(1000),
  questions: z.array(z.string().min(1).max(500)).min(2).max(8),
  searchHints: z.array(z.string().min(1).max(300)).min(1).max(8),
  requiredEvidence: z.array(z.string().min(1).max(300)).min(1).max(8),
});
export type ResearchPerspective = z.infer<typeof ResearchPerspectiveSchema>;

export const ResearchAgendaSchema = z.object({
  rationale: z.string().min(1).max(1500),
  perspectives: z.array(ResearchPerspectiveSchema).length(3),
  completionCriteria: z.array(z.string().min(1).max(500)).min(3).max(12),
});
export type ResearchAgenda = z.infer<typeof ResearchAgendaSchema>;

export const ReferenceSearchAttributionSchema = z.object({
  model: z.string().min(1).max(160),
  queries: z.array(z.string().min(1).max(500)).max(16).default([]),
  renderedContent: z.string().min(1).max(100_000),
});
export type ReferenceSearchAttribution = z.infer<typeof ReferenceSearchAttributionSchema>;

export const ReferenceDiscoverySchema = z.object({
  references: z.array(ReferenceCandidateSchema).max(8),
  searchAttribution: ReferenceSearchAttributionSchema.optional(),
});
export type ReferenceDiscovery = z.infer<typeof ReferenceDiscoverySchema>;

export const IntentAndAgendaSchema = z.object({
  intent: IntentFrameSchema,
  agenda: ResearchAgendaSchema,
  notes: z.array(z.string().min(1).max(500)).max(12).default([]),
});
export type IntentAndAgenda = z.infer<typeof IntentAndAgendaSchema>;

export const ResearchFindingSchema = z.object({
  claim: z.string().min(1).max(1200),
  whyItMatters: z.string().min(1).max(800),
  sourceUrls: z.array(z.url()).min(1).max(5),
  confidence: z.enum(["high", "medium", "low"]),
});

export const ObjectCandidateSchema = z.object({
  name: z.string().min(1).max(160),
  role: z.string().min(1).max(500),
  identifyingFeatures: z.array(z.string().min(1).max(300)).min(1).max(8),
  likelyMaterials: z.array(z.string().min(1).max(160)).max(8),
  scaleNotes: z.array(z.string().min(1).max(300)).max(8),
  spatialNotes: z.array(z.string().min(1).max(300)).max(8),
});

export const ResearchPerspectiveResultSchema = z.object({
  perspectiveId: ResearchPerspectiveIdSchema,
  summary: z.string().min(1).max(2500),
  findings: z.array(ResearchFindingSchema).min(2).max(16),
  objectCandidates: z.array(ObjectCandidateSchema).min(1).max(12),
  sources: z.array(SourceSchema).max(12),
  references: z.array(ReferenceCandidateSchema).max(8),
  unansweredQuestions: z.array(z.string().min(1).max(500)).max(8),
});
export type ResearchPerspectiveResult = z.infer<typeof ResearchPerspectiveResultSchema>;

export const ObjectStudySchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(160),
  role: z.string().min(1).max(600),
  identityMarkers: z.array(z.string().min(1).max(300)).min(2).max(10),
  components: z.array(z.string().min(1).max(300)).min(1).max(12),
  materials: z.array(z.string().min(1).max(200)).min(1).max(10),
  proportionAndScale: z.array(z.string().min(1).max(400)).min(1).max(10),
  spatialRelationships: z.array(z.string().min(1).max(400)).min(1).max(10),
  sourceUrls: z.array(z.url()).min(1).max(8),
  referenceImageUrls: z.array(z.url()).max(6),
  uncertainty: z.string().max(800).default(""),
});
export type ObjectStudy = z.infer<typeof ObjectStudySchema>;

export const IntentCoverageSchema = z.object({
  requirement: z.string().min(1).max(300),
  evidence: z.string().min(1).max(800),
  objectStudyIds: z.array(IdSchema).min(1).max(8),
});

export const ReadinessCheckSchema = z.object({
  id: IdSchema,
  label: z.string().min(1).max(200),
  passed: z.boolean(),
  evidence: z.string().min(1).max(1000),
});

export const ResearchReadinessSchema = z.object({
  decision: z.enum(["ready", "needs-research", "needs-user"]),
  score: z.number().min(0).max(1),
  checks: z.array(ReadinessCheckSchema).min(1).max(12),
  gaps: z.array(z.string().min(1).max(500)).max(12),
});
export type ResearchReadiness = z.infer<typeof ResearchReadinessSchema>;

export const ResearchDossierDraftSchema = z.object({
  brief: ResearchBriefSchema,
  objectStudies: z.array(ObjectStudySchema).min(1).max(12),
  intentCoverage: z.array(IntentCoverageSchema).min(1).max(12),
  contradictions: z.array(z.string().min(1).max(800)).max(8),
  unresolvedQuestions: z.array(z.string().min(1).max(500)).max(8),
});

export const ResearchDossierSchema = ResearchDossierDraftSchema.extend({
  perspectives: z.array(ResearchPerspectiveResultSchema).length(3),
  readiness: ResearchReadinessSchema,
  searchAttribution: ReferenceSearchAttributionSchema.optional(),
  generatedAt: z.iso.datetime(),
});
export type ResearchDossier = z.infer<typeof ResearchDossierSchema>;

export const NOTE_TEXT_MAX_LENGTH = 2000;
export const NOTE_SOURCE_MAX_LENGTH = 300;

export const AgentNoteSchema = z.object({
  id: z.string().min(1),
  kind: z.enum([
    "user-requirement",
    "user-preference",
    "decision",
    "assumption",
    "research-finding",
    "uncertainty",
    "spatial-fact",
    "feedback",
  ]),
  text: z.string().min(1).max(NOTE_TEXT_MAX_LENGTH),
  source: z.string().min(1).max(NOTE_SOURCE_MAX_LENGTH),
  scope: z.enum(["project", "user"]),
  confidence: z.number().min(0).max(1),
  createdAt: z.iso.datetime(),
});
export type AgentNote = z.infer<typeof AgentNoteSchema>;

export const UserPreferenceSchema = z.object({
  key: z.enum([
    "accuracy-priority",
    "visual-style",
    "guidance-density",
    "overview-order",
    "label-density",
    "interaction-pace",
    "other",
  ]),
  value: z.string().min(1).max(1000),
  evidence: z.string().min(1).max(1000),
  updatedAt: z.iso.datetime(),
});
export type UserPreference = z.infer<typeof UserPreferenceSchema>;

export const UserPreferenceProfileSchema = z.object({
  userId: z.string().min(1).max(128),
  preferences: z.array(UserPreferenceSchema).max(24),
  updatedAt: z.iso.datetime(),
});
export type UserPreferenceProfile = z.infer<typeof UserPreferenceProfileSchema>;

export const GraphNodeIdSchema = z.enum([
  "intake",
  "clarify-intent",
  "await-clarification",
  "plan-research",
  "research-perspectives",
  "synthesize-research",
  "await-research-approval",
  "generate-scene",
  "visual-qa",
  "quality-blocked",
  "await-feedback",
  "completed",
  "failed",
]);
export type GraphNodeId = z.infer<typeof GraphNodeIdSchema>;

export const GuideStepSchema = z.object({
  id: GraphNodeIdSchema,
  label: z.string().min(1),
  status: z.enum(["pending", "active", "waiting", "completed", "failed"]),
  summary: z.string().max(1000).default(""),
});

// Follow-up research rounds are gated on remaining evidence gaps rather than a
// fixed count, so the stored round counter only needs a sane upper record bound.
export const MAX_RESEARCH_ROUNDS_RECORDED = 12;

export const WorkflowGraphStateSchema = z.object({
  schemaVersion: z.literal("1.0"),
  graphVersion: z.literal("seein-interaction-graph:v1"),
  projectId: z.string().min(1),
  runId: z.string().min(1),
  userId: z.string().min(1).max(128),
  sequence: z.number().int().nonnegative(),
  currentNode: GraphNodeIdSchema,
  status: z.enum(["running", "waiting", "completed", "failed"]),
  waitingFor: z.enum(["clarification", "research-approval", "quality-review", "feedback"]).optional(),
  failedNode: GraphNodeIdSchema.optional(),
  failureMessage: z.string().max(8000).optional(),
  resumeCount: z.number().int().min(0).default(0),
  guidance: z.string().min(1).max(1500),
  clarificationRound: z.number().int().min(0).max(3),
  researchRound: z.number().int().min(0).max(MAX_RESEARCH_ROUNDS_RECORDED),
  clarification: ClarificationTurnSchema.optional(),
  answers: z.array(ClarificationAnswerSchema).max(12).default([]),
  intent: IntentFrameSchema.optional(),
  researchAgenda: ResearchAgendaSchema.optional(),
  researchDossier: ResearchDossierSchema.optional(),
  notes: z.array(AgentNoteSchema).max(128).default([]),
  preferenceProfile: UserPreferenceProfileSchema,
  steps: z.array(GuideStepSchema),
  finalSceneRevision: z.number().int().positive().optional(),
  finalInspection: InspectionSchema.optional(),
  qaCoverage: QaCoverageSchema.optional(),
  qualitySupervisor: QualitySupervisorStateSchema.optional(),
  qaExhausted: z.boolean().optional(),
  nextProjectId: z.string().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type WorkflowGraphState = z.infer<typeof WorkflowGraphStateSchema>;

export const CheckpointSummarySchema = z.object({
  sequence: z.number().int().nonnegative(),
  node: GraphNodeIdSchema,
  status: z.enum(["running", "waiting", "completed", "failed"]),
  guidance: z.string(),
  resumable: z.boolean(),
  stage: z.enum(["clarification", "research", "generation"]).nullable(),
  updatedAt: z.iso.datetime(),
});
export type CheckpointSummary = z.infer<typeof CheckpointSummarySchema>;

export const ResearchDecisionRequestSchema = z.object({
  decision: z.enum(["approve", "research-more"]),
  feedback: z.string().trim().max(4000).default(""),
});

export const PreferenceInputSchema = UserPreferenceSchema.pick({ key: true, value: true });

export const UserFeedbackRequestSchema = z.object({
  decision: z.enum(["accept", "revise-scene", "revise-intent"]),
  categories: z.array(z.enum([
    "anatomy",
    "laterality",
    "identity",
    "missing-part",
    "critical-structure",
    "surgical-approach",
    "procedure-step",
    "scale",
    "layout",
    "occlusion",
    "lighting",
    "label",
    "teaching-order",
    "style",
    "other",
  ])).max(6).default([]),
  objectIds: z.array(IdSchema).max(8).default([]),
  comment: z.string().trim().max(4000).default(""),
  preferences: z.array(PreferenceInputSchema).max(8).default([]),
});
export type UserFeedbackRequest = z.infer<typeof UserFeedbackRequestSchema>;
