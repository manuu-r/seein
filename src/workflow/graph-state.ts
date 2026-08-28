import { randomUUID } from "node:crypto";
import type { ProjectRecord } from "../contracts.js";
import {
  NOTE_SOURCE_MAX_LENGTH,
  NOTE_TEXT_MAX_LENGTH,
  ResearchDossierSchema,
  ResearchReadinessSchema,
  WorkflowGraphStateSchema,
  type AgentNote,
  type GraphNodeId,
  type IntentFrame,
  type ResearchDossier,
  type ResearchPerspectiveResult,
  type ReferenceSearchAttribution,
  type UserPreferenceProfile,
  type WorkflowGraphState,
} from "./graph-contracts.js";

const ALLOWED_EDGES: Record<GraphNodeId, GraphNodeId[]> = {
  intake: ["clarify-intent", "failed"],
  "clarify-intent": ["await-clarification", "plan-research", "failed"],
  "await-clarification": ["plan-research", "failed"],
  "plan-research": ["research-perspectives", "failed"],
  "research-perspectives": ["synthesize-research", "failed"],
  "synthesize-research": ["await-research-approval", "plan-research", "failed"],
  "await-research-approval": ["generate-scene", "plan-research", "failed"],
  "generate-scene": ["visual-qa", "failed"],
  "visual-qa": ["await-feedback", "failed"],
  "await-feedback": ["completed", "clarify-intent", "failed"],
  completed: [],
  failed: [],
};

export type ResumeStage = "clarification" | "research" | "generation";

// Which stage owns each node. Waiting and terminal nodes own no stage: they need
// a user decision, so there is nothing to restart.
const NODE_STAGE: Record<GraphNodeId, ResumeStage | null> = {
  intake: "clarification",
  "clarify-intent": "clarification",
  "await-clarification": null,
  "plan-research": "research",
  "research-perspectives": "research",
  "synthesize-research": "research",
  "await-research-approval": null,
  "generate-scene": "generation",
  "visual-qa": "generation",
  "await-feedback": null,
  completed: null,
  failed: null,
};

// Where each stage's runner can legally be re-entered. A runner's first act is to
// traverse this node's outgoing edge, so entering anywhere else in the stage would
// make it attempt a backwards transition the graph forbids.
const STAGE_ENTRY: Record<ResumeStage, GraphNodeId> = {
  clarification: "intake",
  research: "plan-research",
  generation: "generate-scene",
};

export function resumeStageFor(node: GraphNodeId): ResumeStage | null {
  return NODE_STAGE[node];
}

export function stageEntryNode(stage: ResumeStage): GraphNodeId {
  return STAGE_ENTRY[stage];
}

// A rewind is not a graph edge: it restores a checkpoint that was already valid.
// Sequence keeps moving forward so the checkpoint history stays append-only.
export function rewindGraphState(
  current: WorkflowGraphState,
  checkpoint: WorkflowGraphState,
): WorkflowGraphState {
  const stage = resumeStageFor(checkpoint.currentNode);
  if (!stage) throw new Error(`The ${checkpoint.currentNode} checkpoint cannot be restarted automatically.`);
  const entry = stageEntryNode(stage);
  const now = new Date().toISOString();
  return WorkflowGraphStateSchema.parse({
    ...checkpoint,
    currentNode: entry,
    sequence: current.sequence + 1,
    status: "running",
    waitingFor: undefined,
    failedNode: undefined,
    failureMessage: undefined,
    resumeCount: current.resumeCount + 1,
    guidance: checkpoint.currentNode === entry
      ? `Rewound to the ${entry} checkpoint and restarting from there.`
      : `Rewound to the ${checkpoint.currentNode} checkpoint; the ${stage} stage restarts from ${entry} using the state captured there.`,
    steps: guideSteps(entry, "running"),
    updatedAt: now,
  });
}

const GUIDE_STEPS: Array<{ id: GraphNodeId; label: string }> = [
  { id: "clarify-intent", label: "Clarify what the visualization must communicate" },
  { id: "plan-research", label: "Plan the evidence search" },
  { id: "research-perspectives", label: "Research form, objects, and spatial facts" },
  { id: "synthesize-research", label: "Audit references and generation readiness" },
  { id: "generate-scene", label: "Reuse or build measured 3D assets" },
  { id: "visual-qa", label: "Render, inspect, and refine" },
  { id: "await-feedback", label: "Learn from your feedback" },
  { id: "completed", label: "Accepted visualization" },
];

const NODE_TO_STEP = new Map<GraphNodeId, GraphNodeId>([
  ["intake", "clarify-intent"],
  ["clarify-intent", "clarify-intent"],
  ["await-clarification", "clarify-intent"],
  ["plan-research", "plan-research"],
  ["research-perspectives", "research-perspectives"],
  ["synthesize-research", "synthesize-research"],
  ["await-research-approval", "synthesize-research"],
  ["generate-scene", "generate-scene"],
  ["visual-qa", "visual-qa"],
  ["await-feedback", "await-feedback"],
  ["completed", "completed"],
  ["failed", "completed"],
]);

export function createInitialGraphState(
  project: ProjectRecord,
  userId: string,
  profile?: UserPreferenceProfile,
): WorkflowGraphState {
  const now = new Date().toISOString();
  return WorkflowGraphStateSchema.parse({
    schemaVersion: "1.0",
    graphVersion: "seein-interaction-graph:v1",
    projectId: project.projectId,
    runId: project.runId,
    userId,
    sequence: 0,
    currentNode: "intake",
    status: "running",
    guidance: "I am turning the concept into a precise visual brief before spending time on research or 3D generation.",
    clarificationRound: 0,
    researchRound: 0,
    answers: [],
    notes: [],
    preferenceProfile: profile ?? { userId, preferences: [], updatedAt: now },
    steps: guideSteps("intake", "running"),
    createdAt: now,
    updatedAt: now,
  });
}

export function transitionGraphState(
  state: WorkflowGraphState,
  node: GraphNodeId,
  status: WorkflowGraphState["status"],
  guidance: string,
  update: Partial<WorkflowGraphState> = {},
): WorkflowGraphState {
  if (node !== state.currentNode && !ALLOWED_EDGES[state.currentNode].includes(node)) {
    throw new Error(`Invalid workflow graph transition: ${state.currentNode} -> ${node}`);
  }
  const now = new Date().toISOString();
  return WorkflowGraphStateSchema.parse({
    ...state,
    ...update,
    sequence: state.sequence + 1,
    currentNode: node,
    status,
    waitingFor: status === "waiting" ? update.waitingFor : undefined,
    guidance,
    steps: guideSteps(node, status),
    updatedAt: now,
  });
}

function clampNoteField(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}\u2026`;
}

export function createNote(
  kind: AgentNote["kind"],
  text: string,
  source: string,
  scope: AgentNote["scope"] = "project",
  confidence = 1,
): AgentNote {
  return {
    id: randomUUID(),
    kind,
    text: clampNoteField(text, NOTE_TEXT_MAX_LENGTH),
    source: clampNoteField(source, NOTE_SOURCE_MAX_LENGTH),
    scope,
    confidence,
    createdAt: new Date().toISOString(),
  };
}

export function evaluateResearchReadiness(
  intent: IntentFrame,
  perspectives: ResearchPerspectiveResult[],
  draft: Omit<ResearchDossier, "perspectives" | "readiness" | "generatedAt">,
  searchAttribution?: ReferenceSearchAttribution,
): ResearchDossier {
  const unresolvedQuestions = [...new Set([
    ...draft.unresolvedQuestions,
    ...perspectives.flatMap((result) => result.unansweredQuestions),
  ])];
  const auditedDraft = { ...draft, unresolvedQuestions };
  const sourceUrls = new Set(perspectives.flatMap((result) => result.sources.map((source) => source.url)));
  const sourceDomains = new Set(
    [...sourceUrls].map((url) => {
      try {
        return new URL(url).hostname;
      } catch {
        return url;
      }
    }),
  );
  // Per-object reference images are attached to the dossier after synthesis, so the
  // allowed set spans the dossier pool as well as anything a perspective grounded.
  const references = new Set([
    ...perspectives.flatMap((result) => result.references.map((reference) => reference.imageUrl)),
    ...draft.brief.references.map((reference) => reference.imageUrl),
  ]);
  const perspectiveIds = new Set(perspectives.map((result) => result.perspectiveId));
  const detailedStudies = auditedDraft.objectStudies.filter(
    (study) =>
      study.identityMarkers.length >= 2 &&
      study.components.length > 0 &&
      study.materials.length > 0 &&
      study.proportionAndScale.length > 0 &&
      study.spatialRelationships.length > 0 &&
      study.sourceUrls.length > 0,
  );
  const referencedStudies = auditedDraft.objectStudies.filter((study) => study.referenceImageUrls.length > 0);
  const boundStudies = auditedDraft.objectStudies.filter((study) =>
    study.sourceUrls.every((url) => sourceUrls.has(url)) &&
    study.referenceImageUrls.every((url) => references.has(url)),
  );
  const studyIds = new Set(auditedDraft.objectStudies.map((study) => study.id));
  const coveredRequirements = new Set(
    auditedDraft.intentCoverage
      .filter((coverage) => coverage.objectStudyIds.every((id) => studyIds.has(id)))
      .map((coverage) => coverage.requirement.trim().toLowerCase()),
  );
  const missingRequirements = intent.mustHave.filter(
    (requirement) => !coveredRequirements.has(requirement.trim().toLowerCase()),
  );
  const checks = [
    {
      id: "perspective-coverage",
      label: "All three research perspectives completed",
      passed: perspectiveIds.size === 3,
      evidence: `${perspectiveIds.size}/3 perspectives returned structured evidence.`,
    },
    {
      id: "source-diversity",
      label: "Multiple grounded sources collected",
      passed: sourceUrls.size >= 3 && perspectives.every((result) => result.sources.length > 0),
      evidence: `${sourceUrls.size} grounded sources across ${sourceDomains.size} visible URL origins and ${perspectives.filter((result) => result.sources.length > 0).length}/3 perspectives.`,
    },
    {
      id: "object-coverage",
      label: "Candidate objects have construction studies",
      passed: auditedDraft.objectStudies.length > 0 && detailedStudies.length === auditedDraft.objectStudies.length,
      evidence: `${detailedStudies.length}/${auditedDraft.objectStudies.length} object studies include identity, components, materials, scale, space, and sources.`,
    },
    {
      id: "reference-coverage",
      label: "Important objects have visual references",
      passed: referencedStudies.length === auditedDraft.objectStudies.length,
      evidence: `${referencedStudies.length}/${auditedDraft.objectStudies.length} object studies link at least one image reference.`,
    },
    {
      id: "provenance",
      label: "Object evidence resolves to retrieved sources",
      passed: boundStudies.length === auditedDraft.objectStudies.length,
      evidence: `${boundStudies.length}/${auditedDraft.objectStudies.length} studies use only retrieved source and image URLs.`,
    },
    {
      id: "intent-coverage",
      label: "The dossier covers the requested visual intent",
      passed: intent.evaluationCriteria.length > 0 && intent.mustHave.length > 0 && missingRequirements.length === 0,
      evidence: missingRequirements.length === 0
        ? `${intent.mustHave.length}/${intent.mustHave.length} must-have requirements map to existing object studies.`
        : `Missing explicit study coverage for: ${missingRequirements.join(", ")}.`,
    },
    {
      id: "open-questions",
      label: "No blocking research questions remain",
      passed: auditedDraft.unresolvedQuestions.length === 0,
      evidence: auditedDraft.unresolvedQuestions.length === 0
        ? "No unresolved questions were marked as blocking."
        : `${auditedDraft.unresolvedQuestions.length} unresolved question(s) remain.`,
    },
  ];
  const passed = checks.filter((check) => check.passed).length;
  const gaps = checks.filter((check) => !check.passed).map((check) => check.evidence);
  const readiness = ResearchReadinessSchema.parse({
    decision: gaps.length === 0 ? "ready" : "needs-research",
    score: passed / checks.length,
    checks,
    gaps,
  });
  return ResearchDossierSchema.parse({
    ...auditedDraft,
    perspectives,
    readiness,
    ...(searchAttribution ? { searchAttribution } : {}),
    generatedAt: new Date().toISOString(),
  });
}

function guideSteps(currentNode: GraphNodeId, status: WorkflowGraphState["status"]) {
  const activeId = NODE_TO_STEP.get(currentNode) ?? "completed";
  const activeIndex = GUIDE_STEPS.findIndex((step) => step.id === activeId);
  return GUIDE_STEPS.map((step, index) => ({
    ...step,
    status: index < activeIndex
      ? "completed"
      : index > activeIndex
        ? "pending"
        : status === "waiting"
          ? "waiting"
          : status === "failed"
            ? "failed"
            : status === "completed"
              ? "completed"
              : "active",
    summary: "",
  }));
}
