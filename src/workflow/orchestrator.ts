import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { SurgicalModuleCompiler } from "../atlas/module-compiler.js";
import {
  loadAnatomicalRegistry,
  validateModulePlacements,
  validateRegisteredStructureFrames,
} from "../atlas/anatomical-registry.js";
import { SurgicalAtlasLibrary } from "../atlas/module-library.js";
import {
  SurgicalModuleSourceSchema,
  type CompiledSurgicalModule,
  type SurgicalModuleRecoveryContext,
  type SurgicalModuleSource,
} from "../atlas/module-contracts.js";
import type { Config } from "../config.js";
import type {
  Inspection,
  QualityAssessment,
  QualitySupervisorState,
  QaCoverage,
  QaTarget,
  ProjectRecord,
  ResearchBrief,
  RunEvent,
  SceneManifest,
  SpatialReport,
  WorkflowStage,
  ReferenceArtifact,
} from "../contracts.js";
import { InspectionSchema, QaCoverageSchema, QualitySupervisorStateSchema, ReferenceCandidateSchema, SceneManifestSchema } from "../contracts.js";
import type { PlannerReferenceImage, WorkflowAI } from "../ai/workflow-ai.js";
import type { ContextStore } from "../context/context-store.js";
import { hashObject, sha256 } from "../lib/hash.js";
import { normalizePrompt } from "../lib/strings.js";
import {
  describeError,
  safeLogFields,
  type DiagnosticLogger,
} from "../lib/diagnostics.js";
import type { ScreenshotDriver } from "../render/screenshot-driver.js";
import type { ReferenceCollector } from "../research/reference-collector.js";
import { objectImageQuery, type ReferenceSearchDriver } from "../research/reference-search.js";
import type { ArtifactStore, StoredArtifact } from "../storage/artifact-store.js";
import type { ProjectManager } from "../storage/project-manager.js";
import {
  CheckpointSummarySchema,
  ClarificationAnswerRequestSchema,
  ClarificationTurnSchema,
  IntentAndAgendaSchema,
  NOTE_SOURCE_MAX_LENGTH,
  ReferenceDiscoverySchema,
  ResearchDossierDraftSchema,
  MAX_RESEARCH_ROUNDS_RECORDED,
  ResearchPerspectiveResultSchema,
  ResearchDecisionRequestSchema,
  UserFeedbackRequestSchema,
  UserPreferenceProfileSchema,
  WorkflowGraphStateSchema,
  type CheckpointSummary,
  type ClarificationAnswer,
  type IntentAndAgenda,
  type IntentFrame,
  type ResearchDossier,
  type UserPreference,
  type WorkflowGraphState,
} from "./graph-contracts.js";
import {
  createInitialGraphState,
  createNote,
  evaluateResearchReadiness,
  resumeStageFor,
  rewindGraphState,
  transitionGraphState,
} from "./graph-state.js";

export interface WorkflowResult {
  project: ProjectRecord;
  research: ResearchBrief;
  plan: SurgicalModuleSource;
  initialScene: SceneManifest;
  finalScene: SceneManifest;
  finalInspection: Inspection;
  qaCoverage: QaCoverage;
  qaExhausted: boolean;
  qualitySupervisor: QualitySupervisorState;
  viewerUrl: string;
}

export interface FeedbackResult {
  state: WorkflowGraphState;
  nextProject?: ProjectRecord;
}

interface ProviderOperation<T> {
  label: string;
  provider: string;
  destination: string;
  action: string;
  detail?: Record<string, unknown>;
  resultDetail?: (result: T) => Record<string, unknown>;
}

function aiDestination(_provider: string): string {
  return "Google Gemini API";
}

const CachedRenderSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().length(64),
  browserErrors: z.array(z.string()),
});

const RENDERER_CACHE_IDENTITY = "three-viewer:v1";

type ReferenceCandidate = z.infer<typeof ReferenceCandidateSchema>;

/**
 * Binds downloaded reference images back to the object study whose search produced
 * them, so the planner is told which object each image depicts rather than being
 * handed an unlabelled pile. Studies are interleaved so a per-object cap still
 * yields coverage across objects when the overall budget is tight.
 */
async function loadPlannerReferenceImages(
  artifacts: ReferenceArtifact[],
  dossier: ResearchDossier | undefined,
  perObject: number,
): Promise<PlannerReferenceImage[]> {
  if (!dossier || perObject <= 0) return [];
  const byUrl = new Map(
    artifacts.flatMap((artifact) =>
      artifact.localPath && artifact.mediaType
        ? [[artifact.candidate.imageUrl, { path: artifact.localPath, mediaType: artifact.mediaType }] as const]
        : [],
    ),
  );
  const perStudy = dossier.objectStudies.map((study) =>
    study.referenceImageUrls.flatMap((url) => {
      const found = byUrl.get(url);
      return found ? [{ study, ...found }] : [];
    }).slice(0, perObject),
  );
  const ordered: Array<{ study: ResearchDossier["objectStudies"][number]; path: string; mediaType: string }> = [];
  for (let rank = 0; rank < perObject; rank += 1) {
    for (const entries of perStudy) {
      const entry = entries[rank];
      if (entry) ordered.push(entry);
    }
  }
  return Promise.all(
    ordered.map(async (entry) => ({
      studyId: entry.study.id,
      studyName: entry.study.name,
      mediaType: entry.mediaType,
      data: await fs.readFile(entry.path),
    })),
  );
}

function uniqueReferences(candidates: ReferenceCandidate[]): ReferenceCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.imageUrl)) return false;
    seen.add(candidate.imageUrl);
    return true;
  });
}


/**
 * Keep multimodal inspection bounded while showing Gemini more than the scene
 * manifest: one visual reference per distinct object study is preferred, then
 * remaining slots are filled in input order. Recovery references are passed
 * first, so newly researched evidence displaces stale examples.
 */
function selectInspectionReferenceImages(
  images: PlannerReferenceImage[],
  limit = 4,
): PlannerReferenceImage[] {
  const selected: PlannerReferenceImage[] = [];
  const seenStudies = new Set<string>();
  const seenImages = new Set<string>();
  const add = (image: PlannerReferenceImage): void => {
    const identity = sha256(image.data);
    if (selected.length >= limit || seenImages.has(identity)) return;
    selected.push(image);
    seenStudies.add(image.studyId);
    seenImages.add(identity);
  };
  for (const image of images) {
    if (!seenStudies.has(image.studyId)) add(image);
  }
  for (const image of images) add(image);
  return selected;
}


export class RunStoppedError extends Error {
  constructor() {
    super("Stopped by you.");
    this.name = "RunStoppedError";
  }
}

export class Orchestrator {
  private readonly activeRuns = new Map<string, Promise<unknown>>();
  private readonly cancellations = new Map<string, AbortController>();
  private readonly interactionLocks = new Set<string>();
  private readonly sequences = new Map<string, number>();
  private readonly bypassCache = new Set<string>();
  private operationSequence = 0;
  private readonly atlasCompiler: SurgicalModuleCompiler;
  private readonly atlasLibrary: SurgicalAtlasLibrary;

  constructor(
    private readonly config: Config,
    private readonly projects: ProjectManager,
    private readonly artifacts: ArtifactStore,
    private readonly context: ContextStore,
    private readonly ai: WorkflowAI,
    private readonly references: ReferenceCollector,
    private readonly referenceSearch: ReferenceSearchDriver,
    private readonly screenshots: ScreenshotDriver,
    private readonly logger: DiagnosticLogger,
  ) {
    this.atlasCompiler = new SurgicalModuleCompiler(artifacts);
    this.atlasLibrary = new SurgicalAtlasLibrary(artifacts);
  }

  async start(prompt: string, userId = "local-user", parentProjectId?: string): Promise<ProjectRecord> {
    let project = await this.projects.create(prompt, userId, parentProjectId);
    const profile = await this.context.findUserPreferenceProfile(userId) ?? {
      userId,
      preferences: [],
      updatedAt: new Date().toISOString(),
    };
    const state = createInitialGraphState(project, userId, profile);
    await this.persistGraphState(project, state);
    project = await this.projects.update(project, { status: "clarifying" });
    this.track(project.projectId, this.beginClarification(project, state));
    return project;
  }

  async run(prompt: string): Promise<WorkflowResult> {
    const project = await this.projects.create(prompt);
    return this.executeAtlas(project);
  }

  /** Every persisted checkpoint, newest first, flagged with whether it can be rewound to. */
  async listCheckpoints(projectId: string): Promise<CheckpointSummary[]> {
    const project = await this.projects.load(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const states = await this.readCheckpoints(project);
    return states
      .map((state) => {
        const stage = resumeStageFor(state.currentNode);
        return CheckpointSummarySchema.parse({
          sequence: state.sequence,
          node: state.currentNode,
          status: state.status,
          guidance: state.guidance,
          stage,
          resumable: stage !== null && state.status !== "failed",
          updatedAt: state.updatedAt,
        });
      })
      .sort((a, b) => b.sequence - a.sequence);
  }

  /**
   * Rewind to a checkpoint and restart the stage that owns it. Without a target
   * sequence this picks the newest resumable checkpoint. Work already cached is
   * replayed rather than regenerated, so a fixed bug can be retried cheaply.
   */
  async resume(
    projectId: string,
    options: { sequence?: number | undefined; fresh?: boolean | undefined } = {},
  ): Promise<WorkflowGraphState> {
    return this.withInteractionLock(projectId, async () => {
      const project = await this.projects.load(projectId);
      if (!project) throw new Error(`Project not found: ${projectId}`);
      const state = await this.getGraphState(projectId);
      if (!state) throw new Error(`Project has no graph state to resume: ${projectId}`);
      if (state.status === "running" && this.activeRuns.has(projectId)) {
        throw new Error(`Project is still running at ${state.currentNode}; wait for it to settle before resuming.`);
      }

      const checkpoints = await this.readCheckpoints(project);
      const target = options.sequence === undefined
        ? [...checkpoints]
            .sort((a, b) => b.sequence - a.sequence)
            .find((candidate) => resumeStageFor(candidate.currentNode) !== null && candidate.status !== "failed")
        : checkpoints.find((candidate) => candidate.sequence === options.sequence);
      if (!target) {
        throw new Error(
          options.sequence === undefined
            ? "No successful checkpoint to rewind to; start a new run instead."
            : `No checkpoint at sequence ${options.sequence}.`,
        );
      }
      const stage = resumeStageFor(target.currentNode);
      if (!stage) throw new Error(`The ${target.currentNode} checkpoint cannot be restarted automatically.`);

      const resumed = rewindGraphState(state, target);
      const cleared = await this.projects.update(project, {
        status: stage === "generation" ? "planning" : "researching",
        error: undefined,
      });
      await Promise.all([
        this.persistGraphState(cleared, resumed),
        this.emit(cleared, "resumed", "started", {
          failedNode: state.failedNode ?? null,
          rewoundTo: target.currentNode,
          rewoundToSequence: target.sequence,
          entryNode: resumed.currentNode,
          stage,
          fresh: options.fresh === true,
          resumeCount: resumed.resumeCount,
        }),
      ]);

      if (options.fresh) this.bypassCache.add(projectId);
      const work = stage === "generation"
        ? this.runApprovedGeneration(cleared, resumed)
        : stage === "research"
          ? this.runResearchGraph(cleared, resumed, "", true)
          : this.beginClarification(cleared, resumed);
      this.track(
        projectId,
        work.finally(() => {
          this.bypassCache.delete(projectId);
        }),
      );
      return resumed;
    });
  }

  /** Parses every checkpoint file, skipping any that no longer satisfy the schema. */
  private async readCheckpoints(project: ProjectRecord): Promise<WorkflowGraphState[]> {
    const directory = path.join(project.root, "graph", "checkpoints");
    let files: string[];
    try {
      files = await fs.readdir(directory);
    } catch {
      return [];
    }
    const states: WorkflowGraphState[] = [];
    for (const file of files.filter((entry) => entry.endsWith(".json")).sort()) {
      try {
        states.push(
          WorkflowGraphStateSchema.parse(JSON.parse(await fs.readFile(path.join(directory, file), "utf8"))),
        );
      } catch {
        continue;
      }
    }
    return states;
  }

  getActiveRun(projectId: string): Promise<unknown> | undefined {
    return this.activeRuns.get(projectId);
  }

  /** Recover graph checkpoints left running by a worker/process interruption. */
  async recoverInterruptedRuns(): Promise<string[]> {
    const recovered: string[] = [];
    for (const project of await this.projects.list()) {
      if (this.activeRuns.has(project.projectId)) continue;
      const state = await this.getGraphState(project.projectId);
      if (state?.status !== "running" || resumeStageFor(state.currentNode) === null) continue;
      try {
        await this.resume(project.projectId);
        recovered.push(project.projectId);
      } catch {
        // The persisted graph remains queryable and can still be resumed explicitly.
      }
    }
    return recovered;
  }

  async deleteProject(projectId: string): Promise<void> {
    const project = await this.projects.load(projectId);
    if (!project) throw new Error("Project not found");
    // A run mid-flight still holds Chromium and provider requests and will keep writing, so
    // deleting underneath it would leave partial rows and orphaned files.
    if (this.activeRuns.has(projectId)) {
      throw new Error("This run is still working. Wait for it to finish or fail before deleting it.");
    }
    await this.context.deleteProject(projectId);
    await this.projects.delete(project);
    this.sequences.delete(projectId);
    this.bypassCache.delete(projectId);
  }

  async getGraphState(projectId: string): Promise<WorkflowGraphState | null> {
    const indexed = await this.context.findGraphState(projectId);
    if (indexed) return indexed;
    const project = await this.projects.load(projectId);
    if (!project) return null;
    try {
      const raw = await fs.readFile(path.join(project.root, "graph", "state.json"), "utf8");
      const state = WorkflowGraphStateSchema.parse(JSON.parse(raw));
      await this.context.storeGraphState(state);
      return state;
    } catch {
      return null;
    }
  }

  async answerClarifications(
    projectId: string,
    input: unknown,
  ): Promise<WorkflowGraphState> {
    return this.withInteractionLock(projectId, () => this.answerClarificationsUnlocked(projectId, input));
  }

  private async answerClarificationsUnlocked(
    projectId: string,
    input: unknown,
  ): Promise<WorkflowGraphState> {
    const request = ClarificationAnswerRequestSchema.parse(input);
    const [project, state] = await Promise.all([this.projects.load(projectId), this.getGraphState(projectId)]);
    if (!project || !state) throw new Error("Project interaction graph was not found");
    if (state.currentNode !== "await-clarification" || state.waitingFor !== "clarification" || !state.clarification) {
      throw new Error(`Project is not waiting for clarification; current node is ${state.currentNode}`);
    }
    const known = new Set(state.clarification.questions.map((question) => question.id));
    const received = new Map(request.answers.map((answer) => [answer.questionId, answer.answer]));
    for (const answer of request.answers) {
      if (!known.has(answer.questionId)) throw new Error(`Unknown clarification question ${answer.questionId}`);
    }
    const missing = state.clarification.questions
      .filter((question) => question.required && !received.has(question.id))
      .map((question) => question.id);
    if (missing.length > 0) throw new Error(`Missing required clarification answers: ${missing.join(", ")}`);
    const answers: ClarificationAnswer[] = [...state.answers, ...request.answers];
    const notes = [
      ...state.notes,
      ...request.answers.map((answer) =>
        createNote("user-requirement", `${answer.questionId}: ${answer.answer}`, "clarification-answer"),
      ),
      ...(request.additionalContext
        ? [createNote("user-requirement", request.additionalContext, "clarification-additional-context")]
        : []),
    ];
    const next = transitionGraphState(
      state,
      "plan-research",
      "running",
      "Your answers are captured. I am turning them into an explicit intent and three evidence-search perspectives.",
      { answers, notes, clarificationRound: state.clarificationRound + 1, researchRound: 1 },
    );
    await Promise.all([
      this.persistGraphState(project, next),
      this.projects.update(project, { status: "planning_research" }),
    ]);
    this.track(projectId, this.runResearchGraph(project, next, request.additionalContext));
    return next;
  }

  async decideResearch(projectId: string, input: unknown): Promise<WorkflowGraphState> {
    return this.withInteractionLock(projectId, () => this.decideResearchUnlocked(projectId, input));
  }

  private async decideResearchUnlocked(projectId: string, input: unknown): Promise<WorkflowGraphState> {
    const request = ResearchDecisionRequestSchema.parse(input);
    const [project, state] = await Promise.all([this.projects.load(projectId), this.getGraphState(projectId)]);
    if (!project || !state) throw new Error("Project interaction graph was not found");
    if (state.currentNode !== "await-research-approval" || state.waitingFor !== "research-approval" || !state.researchDossier) {
      throw new Error(`Project is not waiting for research approval; current node is ${state.currentNode}`);
    }
    if (request.decision === "approve") {
      if (state.researchDossier.readiness.decision !== "ready") {
        throw new Error("Generation is blocked until the research readiness checks pass");
      }
      const next = transitionGraphState(
        state,
        "generate-scene",
        "running",
        "The medical evidence dossier is approved. I am now reusing or building only the anatomical structures, instruments, and views justified by that research.",
        {
          notes: request.feedback
            ? [...state.notes, createNote("decision", request.feedback, "research-approval")]
            : state.notes,
        },
      );
      await Promise.all([
        this.persistGraphState(project, next),
        this.projects.update(project, { status: "planning" }),
      ]);
      this.track(projectId, this.runApprovedGeneration(project, next));
      return next;
    }
    // While the audit still reports gaps the user keeps the option of another targeted
    // round; the configured bound only caps rounds once the evidence is already clean.
    const remainingGaps = state.researchDossier.readiness.gaps;
    if (remainingGaps.length === 0 && state.researchRound >= this.config.WORKFLOW_MAX_RESEARCH_ROUNDS) {
      throw new Error(`Research has reached the configured ${this.config.WORKFLOW_MAX_RESEARCH_ROUNDS}-round bound`);
    }
    // "Research this gap" should be able to act on the gaps the audit already found,
    // so fall back to them when the user does not describe a specific follow-up.
    const focus = request.feedback || remainingGaps.join(" ");
    if (!focus) throw new Error("Research-more requires feedback describing the missing evidence");
    const searchHint = focus.slice(0, 300);
    const agenda = structuredClone(state.researchAgenda);
    if (!agenda) throw new Error("Research agenda is missing");
    for (const perspective of agenda.perspectives) {
      perspective.objective = `${perspective.objective} Follow-up requested by user: ${focus}`.slice(0, 1000);
      perspective.searchHints = [...perspective.searchHints, searchHint].slice(0, 8);
    }
    const next = transitionGraphState(
      state,
      "plan-research",
      "running",
      "I have added the anatomical or operative gap to the medical research agenda and will run one targeted follow-up round.",
      {
        researchAgenda: agenda,
        researchRound: Math.min(state.researchRound + 1, MAX_RESEARCH_ROUNDS_RECORDED),
        notes: [...state.notes, createNote("feedback", focus, "research-more")],
      },
    );
    await Promise.all([
      this.persistGraphState(project, next),
      this.projects.update(project, { status: "planning_research" }),
    ]);
    this.track(projectId, this.runResearchGraph(project, next, "", true));
    return next;
  }

  async submitFeedback(projectId: string, input: unknown): Promise<FeedbackResult> {
    return this.withInteractionLock(projectId, () => this.submitFeedbackUnlocked(projectId, input));
  }

  private async submitFeedbackUnlocked(projectId: string, input: unknown): Promise<FeedbackResult> {
    const feedback = UserFeedbackRequestSchema.parse(input);
    const [project, state] = await Promise.all([this.projects.load(projectId), this.getGraphState(projectId)]);
    if (!project || !state) throw new Error("Project interaction graph was not found");
    if (state.currentNode !== "await-feedback" || state.waitingFor !== "feedback") {
      throw new Error(`Project is not waiting for feedback; current node is ${state.currentNode}`);
    }
    const now = new Date().toISOString();
    const preferences = mergePreferences(
      state.preferenceProfile.preferences,
      feedback.preferences.map((preference) => ({
        ...preference,
        evidence: feedback.comment || `Explicit ${feedback.decision} feedback on project ${projectId}`,
        updatedAt: now,
      })),
    );
    const profile = UserPreferenceProfileSchema.parse({ userId: state.userId, preferences, updatedAt: now });
    await Promise.all([
      this.context.storeUserPreferenceProfile(profile),
      this.artifacts.writeJson(
        `${this.projects.relativeRoot(project)}/feedback/revision-${padRevision(state.finalSceneRevision ?? 1)}.json`,
        feedback,
      ),
    ]);
    const feedbackText = `${feedback.decision}: ${feedback.categories.join(", ") || "general"}${feedback.comment ? ` — ${feedback.comment}` : ""}`;
    const notes = [...state.notes, createNote("feedback", feedbackText, "user-feedback")];
    if (feedback.decision === "accept") {
      const next = transitionGraphState(
        state,
        "completed",
        "completed",
        "The surgical anatomy visualization is accepted. Your explicit viewing and teaching preferences are saved for future anatomy projects.",
        { notes, preferenceProfile: profile },
      );
      await Promise.all([
        this.persistGraphState(project, next),
        this.projects.update(project, { status: "completed" }),
      ]);
      return { state: next };
    }
    if (!feedback.comment) throw new Error("A revision request requires a short explanation of what should change");
    const revisionPrompt = `${project.prompt}\n\nExplicit user revision request: ${feedback.comment}`;
    const nextProject = await this.start(revisionPrompt, state.userId, project.projectId);
    const next = transitionGraphState(
      state,
      "completed",
      "completed",
      `Your feedback has started a linked anatomy revision (${nextProject.projectId}); its clarifier will focus on the requested anatomical, operative-view, or procedure-state change before invalidating research or structures.`,
      { notes, preferenceProfile: profile, nextProjectId: nextProject.projectId },
    );
    await Promise.all([
      this.persistGraphState(project, next),
      this.projects.update(project, { status: "completed" }),
    ]);
    return { state: next, nextProject };
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.activeRuns.values()]);
    await this.screenshots.close();
    await this.context.close();
  }

  private track(projectId: string, task: Promise<unknown>): void {
    this.activeRuns.set(projectId, task);
    this.cancellations.set(projectId, new AbortController());
    void task.finally(() => {
      if (this.activeRuns.get(projectId) === task) {
        this.activeRuns.delete(projectId);
        this.cancellations.delete(projectId);
      }
    }).catch(() => undefined);
  }

  /**
   * Cooperative cancellation. The signal is checked at every stage boundary, so a
   * stop lands as soon as the current step finishes rather than mid-write. Work
   * already in flight with a provider is abandoned and its result discarded.
   */
  private assertRunning(projectId: string): void {
    if (this.cancellations.get(projectId)?.signal.aborted) throw new RunStoppedError();
  }

  async cancelProject(projectId: string): Promise<WorkflowGraphState | null> {
    const controller = this.cancellations.get(projectId);
    if (!controller) throw new Error("This run is not currently working.");
    controller.abort();
    const [project, state] = await Promise.all([this.projects.load(projectId), this.getGraphState(projectId)]);
    if (!project || !state) return null;
    const stopped = state.currentNode === "failed"
      ? state
      : transitionGraphState(state, "failed", "failed", "You stopped this run. Nothing further will be generated.", {
          failedNode: state.currentNode,
          failureMessage: "Stopped by you.",
        });
    await Promise.all([
      this.persistGraphState(project, stopped, { force: true }),
      this.projects.update(project, { status: "failed", error: "Stopped by you." }),
      this.emit(project, "failed", "failed", { error: "Stopped by you.", graphNode: state.currentNode }),
    ]);
    return stopped;
  }

  private async withInteractionLock<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    if (this.interactionLocks.has(projectId)) {
      throw new Error("Another interaction update is already being applied to this project");
    }
    this.interactionLocks.add(projectId);
    try {
      return await work();
    } finally {
      this.interactionLocks.delete(projectId);
    }
  }

  private async attachObjectReferences(
    project: ProjectRecord,
    intent: IntentFrame,
    draft: Omit<ResearchDossier, "perspectives" | "readiness" | "generatedAt">,
  ): Promise<Omit<ResearchDossier, "perspectives" | "readiness" | "generatedAt">> {
    // With search switched off the pipeline does not manage reference images at all,
    // so whatever the dossier already carries is left untouched.
    if (this.config.REFERENCE_SEARCH_DRIVER === "none") return draft;
    const perObject = this.config.REFERENCE_IMAGES_PER_OBJECT;
    // Publisher hosts block scrapers and time out often enough that asking for exactly
    // the number needed leaves studies short, so over-fetch and keep the survivors.
    const requested = perObject * 2;
    const directory = path.join(project.root, "research", "references");
    const searched = await Promise.all(
      draft.objectStudies.map(async (study) => {
        const query = objectImageQuery(intent.subject, study.name, study.identityMarkers);
        const key = hashObject({ query, requested, provider: this.referenceSearch.identity, schema: "object-references-v2" });
        const cached = z.array(ReferenceCandidateSchema).safeParse(await this.findCachedStepFor(project.projectId, key));
        const candidates = cached.success
          ? cached.data
          : await this.withProviderRetries(
              project,
              "auditing_research",
              {
                label: `Reference image search for ${study.name}`,
                provider: this.referenceSearch.identity,
                destination: this.config.FIRECRAWL_SEARCH_URL,
                action: "POST image search",
                detail: { studyId: study.id, query, requestedImages: requested },
              },
              () => this.referenceSearch.searchImages(query, requested),
            ).catch(() => [] as ReferenceCandidate[]);
        if (!cached.success && candidates.length > 0) {
          await this.context.storeCachedStep(key, "object-references", candidates);
        }
        // A URL only counts once the bytes are on disk; otherwise the readiness gate
        // would promise the planner images it will never receive.
        const artifacts = await this.references.collectCandidates(candidates, directory);
        const downloaded = artifacts.flatMap((artifact) => (artifact.localPath ? [artifact.candidate] : []));
        return {
          study,
          searched: candidates.length,
          downloaded: downloaded.slice(0, perObject),
          failed: artifacts.length - downloaded.length,
        };
      }),
    );
    const pool = uniqueReferences([
      ...draft.brief.references,
      ...searched.flatMap((entry) => entry.downloaded),
    ]);
    await this.emit(project, "auditing_research", "info", {
      referenceDriver: this.referenceSearch.identity,
      studiesWithImages: searched.filter((entry) => entry.downloaded.length > 0).length,
      studies: searched.length,
      imagesSearched: searched.reduce((total, entry) => total + entry.searched, 0),
      imagesDownloaded: pool.length,
      downloadFailures: searched.reduce((total, entry) => total + entry.failed, 0),
    });
    return {
      ...draft,
      brief: { ...draft.brief, references: pool.slice(0, 64) },
      objectStudies: searched.map(({ study, downloaded }) => ({
        ...study,
        // Left empty on total failure so reference-coverage reports a real gap.
        referenceImageUrls: downloaded.map((candidate) => candidate.imageUrl).slice(0, 6),
      })),
    };
  }

  private async beginClarification(project: ProjectRecord, initialState: WorkflowGraphState): Promise<void> {
    let state = initialState;
    try {
      await this.emit(project, "created", "completed", { prompt: project.prompt, interactive: true });
      state = transitionGraphState(
        state,
        "clarify-intent",
        "running",
        "I am identifying only uncertainties that could change anatomy, laterality, surgical approach, structures at risk, operative views, 3D construction, or the teaching sequence.",
      );
      await Promise.all([
        this.persistGraphState(project, state),
        this.emit(project, "clarifying", "started", { round: 1 }),
      ]);
      const cacheKey = hashObject({
        prompt: normalizePrompt(project.prompt),
        profile: state.preferenceProfile.preferences,
        provider: this.ai.clarificationIdentity,
        schema: "clarification-v1",
      });
      const cached = await this.findCachedStepFor(project.projectId, cacheKey);
      const parsed = ClarificationTurnSchema.safeParse(cached);
      const clarification = parsed.success
        ? parsed.data
        : await this.withProviderRetries(
            project,
            "clarifying",
            {
              label: "Intent clarification",
              provider: this.ai.clarificationIdentity,
              destination: aiDestination(this.ai.clarificationIdentity),
              action: "models.generateContent",
            },
            () => this.ai.clarify(project.prompt, state.preferenceProfile),
          );
      if (!parsed.success) await this.context.storeCachedStep(cacheKey, "clarification", clarification);
      const notes = [
        ...state.notes,
        ...clarification.assumptions.map((assumption) => createNote("assumption", assumption, "clarifier", "project", 0.6)),
      ];
      state = transitionGraphState(
        state,
        "await-clarification",
        "waiting",
        "Answer these few questions before research. Each one controls anatomy, laterality, approach, operative viewpoint, or the intended surgical teaching point.",
        { clarification, clarificationRound: 0, notes, waitingFor: "clarification" },
      );
      await Promise.all([
        this.persistGraphState(project, state),
        this.projects.update(project, { status: "awaiting_clarification" }),
        this.emit(project, "clarifying", "completed", {
          cacheHit: parsed.success,
          questions: clarification.questions.length,
        }),
        this.emit(project, "awaiting_clarification", "started", { questions: clarification.questions.map((question) => question.id) }),
      ]);
    } catch (error) {
      await this.failGraph(project, state, error);
    }
  }

  private async runResearchGraph(
    project: ProjectRecord,
    startingState: WorkflowGraphState,
    additionalContext: string,
    reuseAgenda = false,
  ): Promise<void> {
    let state = startingState;
    let currentProject = project;
    try {
      let prepared: IntentAndAgenda | null = state.intent && state.researchAgenda
        ? { intent: state.intent, agenda: state.researchAgenda, notes: [] }
        : null;
      if (!reuseAgenda || !prepared) {
        const preparationKey = hashObject({
          prompt: normalizePrompt(project.prompt),
          clarification: state.clarification,
          answers: state.answers,
          additionalContext,
          profile: state.preferenceProfile.preferences,
          provider: this.ai.clarificationIdentity,
          schema: "intent-agenda-v1",
        });
        const cachedPreparation = IntentAndAgendaSchema.safeParse(await this.findCachedStepFor(currentProject.projectId, preparationKey));
        prepared = cachedPreparation.success
          ? cachedPreparation.data
          : await this.withProviderRetries(
              currentProject,
              "planning_research",
              {
                label: "Intent and research planning",
                provider: this.ai.clarificationIdentity,
                destination: aiDestination(this.ai.clarificationIdentity),
                action: "models.generateContent",
              },
              () => this.ai.prepareIntent(
                project.prompt,
                state.clarification!,
                state.answers,
                additionalContext,
                state.preferenceProfile,
              ),
            );
        if (!cachedPreparation.success) {
          await this.context.storeCachedStep(preparationKey, "intent-and-research-agenda", prepared);
        }
        state = { ...state, intent: prepared.intent, researchAgenda: prepared.agenda };
      }
      if (!prepared) throw new Error("Research intent and agenda were not prepared");
      const preparationNotes = prepared.notes.map((note) => createNote("decision", note, "research-planner"));
      state = transitionGraphState(
        WorkflowGraphStateSchema.parse({ ...state, notes: [...state.notes, ...preparationNotes] }),
        "research-perspectives",
        "running",
        "Three medical evidence branches and one targeted anatomical reference-image search are running in parallel.",
      );
      currentProject = await this.projects.update(currentProject, { status: "researching" });
      await Promise.all([
        this.persistGraphState(currentProject, state),
        this.emit(currentProject, "planning_research", "completed", {
          perspectives: prepared.agenda.perspectives.map((perspective) => perspective.id),
          round: state.researchRound,
        }),
        this.emit(currentProject, "researching", "started", {
          parallelBranches: 4,
          evidenceBranches: 3,
          referenceSearches: 1,
          round: state.researchRound,
        }),
      ]);
      const branchHits: boolean[] = [];
      const referenceKey = hashObject({
        intent: prepared.intent,
        agenda: prepared.agenda,
        provider: this.ai.referenceResearchIdentity,
        schema: "reference-discovery-v1",
      });
      const cachedReferences = ReferenceDiscoverySchema.safeParse(await this.findCachedStepFor(currentProject.projectId, referenceKey));
      const referencePromise = cachedReferences.success
        ? Promise.resolve(cachedReferences.data)
        : this.withProviderRetries(
            currentProject,
            "researching",
            {
              label: "Grounded reference discovery",
              provider: this.ai.referenceResearchIdentity,
              destination: aiDestination(this.ai.referenceResearchIdentity),
              action: "models.generateContent + image search grounding",
            },
            () => this.ai.researchReferences(prepared!.intent, prepared!.agenda),
          ).then(async (discovery) => {
            const parsed = ReferenceDiscoverySchema.parse(discovery);
            await this.context.storeCachedStep(referenceKey, "reference-discovery", parsed);
            return parsed;
          });
      const [rawPerspectives, referenceDiscovery] = await Promise.all([
        Promise.all(prepared.agenda.perspectives.map(async (perspective, index) => {
          const key = hashObject({
            intent: prepared!.intent,
            perspective,
            provider: this.ai.deepResearchIdentity,
            schema: "research-perspective-v2",
          });
          const cached = ResearchPerspectiveResultSchema.safeParse(await this.findCachedStepFor(currentProject.projectId, key));
          branchHits[index] = cached.success;
          if (cached.success) return cached.data;
          const result = await this.withProviderRetries(
            currentProject,
            "researching",
            {
              label: `${perspective.id} evidence research`,
              provider: this.ai.deepResearchIdentity,
              destination: aiDestination(this.ai.deepResearchIdentity),
              action: "models.generateContent + Google Search grounding",
              detail: { perspectiveId: perspective.id },
            },
            () => this.ai.researchPerspective(prepared!.intent, perspective),
          );
          await this.context.storeCachedStep(key, `research-perspective:${perspective.id}`, result);
          return result;
        })),
        referencePromise,
      ]);
      const perspectives = rawPerspectives.map((perspective, index) => ResearchPerspectiveResultSchema.parse({
        ...perspective,
        references: index === 0 && referenceDiscovery.references.length > 0
          ? referenceDiscovery.references
          : perspective.references,
      }));
      state = transitionGraphState(
        state,
        "synthesize-research",
        "running",
        "The research branches have joined. I am binding each anatomical structure and critical relationship to sources and checking whether 3D construction is justified.",
      );
      currentProject = await this.projects.update(currentProject, { status: "auditing_research" });
      await Promise.all([
        this.persistGraphState(currentProject, state),
        this.emit(currentProject, "researching", "completed", {
          cacheHits: branchHits,
          referenceCacheHit: cachedReferences.success,
          references: referenceDiscovery.references.length,
          round: state.researchRound,
        }),
        this.emit(currentProject, "auditing_research", "started", {}),
      ]);
      const synthesisKey = hashObject({
        intent: prepared.intent,
        perspectives,
        searchAttribution: referenceDiscovery.searchAttribution ?? null,
        provider: this.ai.synthesisIdentity,
        schema: "research-dossier-draft-v2",
      });
      const cachedDraft = ResearchDossierDraftSchema.safeParse(await this.findCachedStepFor(currentProject.projectId, synthesisKey));
      const draft = cachedDraft.success
        ? cachedDraft.data
        : await this.withProviderRetries(
            currentProject,
            "auditing_research",
            {
              label: "Evidence dossier synthesis",
              provider: this.ai.synthesisIdentity,
              destination: aiDestination(this.ai.synthesisIdentity),
              action: "models.generateContent",
              detail: { perspectives: perspectives.length },
            },
            () => this.ai.synthesizeResearch(prepared.intent, perspectives),
          );
      if (!cachedDraft.success) await this.context.storeCachedStep(synthesisKey, "research-dossier-draft", draft);
      // Reference images are attached per object study after synthesis, so each study
      // carries images of the thing it describes rather than of the scene in general.
      // The pipeline sets these URLs from search results; the model never invents them.
      const priorDossiers = (await this.readCheckpoints(currentProject))
        .flatMap((checkpoint) => checkpoint.researchDossier ? [checkpoint.researchDossier] : []);
      const studied = carryForwardDossierEvidence(
        priorDossiers,
        await this.attachObjectReferences(currentProject, prepared.intent, draft),
      );
      const dossier = evaluateResearchReadiness(
        prepared.intent,
        perspectives,
        studied,
        referenceDiscovery.searchAttribution,
      );
      const researchNotes = dossier.objectStudies.map((study) =>
        createNote(
          "research-finding",
          `${study.name}: ${study.identityMarkers.join("; ")}`,
          study.sourceUrls.find((url) => url.length <= NOTE_SOURCE_MAX_LENGTH) ?? "research-dossier",
          "project",
          study.uncertainty ? 0.75 : 0.9,
        ),
      );
      state = transitionGraphState(
        WorkflowGraphStateSchema.parse({
          ...state,
          intent: prepared.intent,
          researchAgenda: prepared.agenda,
          researchDossier: dossier,
          notes: [...state.notes, ...researchNotes],
        }),
        "await-research-approval",
        "waiting",
        dossier.readiness.decision === "ready"
          ? "The medical evidence gate passed. Review the anatomical structures, laterality, operative relationships, and references, then approve generation or request targeted research."
          : "Anatomy generation is blocked by visible evidence gaps. Review the failed checks and request targeted medical research.",
        { waitingFor: "research-approval" },
      );
      const relativeRoot = this.projects.relativeRoot(currentProject);
      currentProject = await this.projects.update(currentProject, { status: "awaiting_research_approval" });
      await Promise.all([
        this.persistGraphState(currentProject, state),
        this.artifacts.writeJson(`${relativeRoot}/research/intent.json`, prepared.intent),
        this.artifacts.writeJson(`${relativeRoot}/research/agenda.json`, prepared.agenda),
        this.artifacts.writeJson(`${relativeRoot}/research/dossier.json`, dossier),
        this.artifacts.writeJson(`${relativeRoot}/research/reference-discovery.json`, referenceDiscovery),
        this.artifacts.writeJson(`${relativeRoot}/research/readiness.json`, dossier.readiness),
        ...perspectives.map((result) =>
          this.artifacts.writeJson(`${relativeRoot}/research/perspectives/${result.perspectiveId}.json`, result),
        ),
        this.emit(currentProject, "auditing_research", "completed", {
          readiness: dossier.readiness.decision,
          score: dossier.readiness.score,
          sources: dossier.brief.sources.length,
          references: dossier.brief.references.length,
          objectStudies: dossier.objectStudies.length,
        }),
        this.emit(currentProject, "awaiting_research_approval", "started", {
          readiness: dossier.readiness.decision,
          gaps: dossier.readiness.gaps,
        }),
      ]);
    } catch (error) {
      await this.failGraph(currentProject, state, error);
    }
  }

  private async runApprovedGeneration(project: ProjectRecord, startingState: WorkflowGraphState): Promise<void> {
    let state = startingState;
    try {
      if (!state.researchDossier || !state.intent) throw new Error("Approved generation is missing its research dossier");
      const result = await this.executeAtlas(project, {
        research: state.researchDossier.brief,
        intent: state.intent,
        dossier: state.researchDossier,
        interactive: true,
        qualitySessionKey: `${project.projectId}:resume-${state.resumeCount}`,
      });
      state = transitionGraphState(
        state,
        "visual-qa",
        "running",
        "The backend is sending every required operative-view render to Gemini and validating anatomy, laterality, topology, critical relationships, spatial invariants, and visual clarity at one accepted revision.",
      );
      await this.persistGraphState(result.project, state);
      if (!result.qaCoverage.complete) {
        state = transitionGraphState(
          state,
          "quality-blocked",
          "waiting",
          "The anatomical construction is checkpointed but not complete. At least one required operative view, structure, relationship, or invariant remains unresolved, so the visualization cannot be accepted. Resume generation after reviewing the issue ledger.",
          {
            waitingFor: "quality-review",
            finalSceneRevision: result.finalScene.revision,
            finalInspection: result.finalInspection,
            qaCoverage: result.qaCoverage,
            qualitySupervisor: result.qualitySupervisor,
            qaExhausted: true,
          },
        );
        await Promise.all([
          this.persistGraphState(result.project, state),
          this.projects.update(result.project, { status: "awaiting_quality" }),
        ]);
        return;
      }
      state = transitionGraphState(
        state,
        "await-feedback",
        "waiting",
        "Explore every anatomy and procedure state, verify laterality and structures at risk, then accept it or identify the exact anatomical or operative change required. Explicit preferences can be carried into the next linked revision.",
        {
          waitingFor: "feedback",
          finalSceneRevision: result.finalScene.revision,
          finalInspection: result.finalInspection,
          qaCoverage: result.qaCoverage,
          qualitySupervisor: result.qualitySupervisor,
          qaExhausted: result.qaExhausted,
        },
      );
      await Promise.all([
        this.persistGraphState(result.project, state),
        this.projects.update(result.project, { status: "awaiting_feedback" }),
      ]);
    } catch (error) {
      await this.failGraph(project, state, error);
    }
  }

  private async findCachedStepFor(projectId: string, key: string): Promise<unknown | null> {
    if (this.bypassCache.has(projectId)) return null;
    return this.context.findCachedStep(key);
  }

  private async persistGraphState(
    project: ProjectRecord,
    state: WorkflowGraphState,
    options: { force?: boolean } = {},
  ): Promise<void> {
    // Every node transition lands here, which makes it the one place that can stop a
    // run from writing over a state the user already stopped. cancelProject forces
    // its own write; everything else fails fast so the stop is final.
    if (!options.force) this.assertRunning(project.projectId);
    const parsed = WorkflowGraphStateSchema.parse(state);
    const relativeRoot = this.projects.relativeRoot(project);
    await Promise.all([
      this.context.storeGraphState(parsed),
      this.artifacts.writeJson(`${relativeRoot}/graph/state.json`, parsed),
      this.artifacts.writeJson(
        `${relativeRoot}/graph/checkpoints/${String(parsed.sequence).padStart(4, "0")}-${parsed.currentNode}.json`,
        parsed,
      ),
    ]);
  }

  private async failGraph(project: ProjectRecord, state: WorkflowGraphState, error: unknown): Promise<void> {
    // cancelProject already wrote the stopped state and status.
    if (error instanceof RunStoppedError) return;
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    const latest = await this.getGraphState(project.projectId) ?? state;
    const failed = latest.currentNode === "failed"
      ? latest
      : transitionGraphState(latest, "failed", "failed", `The workflow stopped: ${message}`, {
          failedNode: latest.currentNode,
          failureMessage: message.slice(0, 8000),
        });
    await Promise.all([
      this.persistGraphState(project, failed, { force: true }),
      this.projects.update(project, { status: "failed", error: message }),
      this.emit(project, "failed", "failed", { error: message, graphNode: latest.currentNode }),
    ]);
  }

  /**
   * Production generation path: Gemini writes a procedure-specific R3F module
   * against the curated surgical-atlas kit, the backend compiles it, and every
   * required step/view is rendered and inspected. There is no alternate scene or
   * render fallback.
   */
  private async executeAtlas(
    initialProject: ProjectRecord,
    options: {
      research?: ResearchBrief;
      intent?: IntentFrame;
      dossier?: ResearchDossier;
      interactive?: boolean;
      qualitySessionKey?: string;
    } = {},
  ): Promise<WorkflowResult> {
    let project = initialProject;
    const relativeRoot = this.projects.relativeRoot(project);
    let supervisor = await this.initializeQualitySupervisor(project);
    try {
      await this.persistQualitySupervisor(project, supervisor);
      if (!options.interactive) await this.emit(project, "created", "completed", { prompt: project.prompt });

      project = await this.stage(project, "researching");
      const researchKey = hashObject({
        prompt: normalizePrompt(project.prompt),
        intent: options.intent ?? null,
        schema: "atlas-research-v1",
        provider: this.ai.researchIdentity,
      });
      let research = options.research ?? await this.context.findResearch(researchKey);
      const researchCacheHit = options.research !== undefined || research !== null;
      if (!research) {
        supervisor = this.consumeLogicalAiCall(supervisor, "atlas evidence research");
        await this.persistQualitySupervisor(project, supervisor);
        research = await this.withProviderRetries(
          project,
          "researching",
          {
            label: "Surgical module evidence research",
            provider: this.ai.researchIdentity,
            destination: aiDestination(this.ai.researchIdentity),
            action: "models.generateContent + Google Search grounding",
          },
          () => this.ai.research(project.prompt),
        );
        await this.context.storeResearch(researchKey, project.prompt, research);
      } else if (options.research) {
        await this.context.storeResearch(researchKey, project.prompt, research);
      }
      if (!research) throw new Error("Surgical module generation has no research brief");
      const [referenceArtifacts] = await Promise.all([
        this.references.collect(research, path.join(project.root, "research", "references")),
        this.artifacts.writeJson(`${relativeRoot}/research/brief.json`, research),
        this.artifacts.writeJson(`${relativeRoot}/research/sources.json`, research.sources),
        this.artifacts.writeText(`${relativeRoot}/research/notes.md`, renderResearchNotes(research)),
      ]);
      const plannerImages = await loadPlannerReferenceImages(
        referenceArtifacts,
        options.dossier,
        this.config.PLANNER_REFERENCE_IMAGES_PER_OBJECT,
      );
      const inspectionReferenceImages = selectInspectionReferenceImages(plannerImages);
      const reusableAtlas = await this.atlasLibrary.findRelevant(project.prompt, options.dossier);
      await Promise.all([
        this.artifacts.writeJson(`${relativeRoot}/research/references/index.json`, referenceArtifacts),
        this.emit(project, "researching", "completed", {
          cacheHit: researchCacheHit,
          preApprovedDossier: options.research !== undefined,
          referencesRequested: research.references.length,
          referencesDownloaded: referenceArtifacts.filter((artifact) => artifact.localPath).length,
          referencesShownToPlanner: plannerImages.length,
        }),
      ]);

      const generateAndCompile = async (
        revision: number,
        recovery?: SurgicalModuleRecoveryContext,
      ): Promise<{ source: SurgicalModuleSource; compiled: CompiledSurgicalModule }> => {
        let retryRecovery = recovery;
        supervisor = this.consumeLogicalAiCall(
          supervisor,
          recovery ? `atlas source repair ${revision}` : "initial atlas source generation",
        );
        await this.persistQualitySupervisor(project, supervisor);
        return this.withProviderRetries(
          project,
          recovery ? "refining" : "planning",
          {
            label: recovery ? `Repair and compile surgical module revision ${revision}` : "Generate and compile surgical atlas module",
            provider: `${this.ai.moduleIdentity} + ${this.atlasCompiler.identity}`,
            destination: `${aiDestination(this.ai.moduleIdentity)} → isolated browser bundle`,
            action: "models.generateContent → validate TSX → esbuild",
            detail: {
              revision,
              referenceImages: plannerImages.length,
              objectStudies: options.dossier?.objectStudies.length ?? 0,
              recoveryView: recovery?.failedViewId ?? null,
            },
            resultDetail: (result) => ({
              structures: result.source.definition.structures.length,
              steps: result.source.definition.steps.length,
              qaViews: result.source.definition.qaViews.length,
              sourceBytes: Buffer.byteLength(result.source.source),
              bundleSha256: result.compiled.bundleSha256,
            }),
          },
          async () => {
            const source = SurgicalModuleSourceSchema.parse(await this.ai.generateSurgicalModule(
              project.prompt,
              research!,
              options.intent,
              options.dossier,
              plannerImages,
              reusableAtlas,
              retryRecovery,
            ));
            try {
              validateSurgicalModuleAgainstDossier(source, options.dossier);
              validateModulePlacements(
                source.definition,
                reusableAtlas.flatMap((entry) => entry.placements),
              );
              validateProcedureAtlasContract(project.prompt, source);
              const compiled = await this.atlasCompiler.compile(relativeRoot, revision, source);
              return { source, compiled };
            } catch (error) {
              const issue = error instanceof Error ? error.message : String(error);
              retryRecovery = {
                attempt: (retryRecovery?.attempt ?? 0) + 1,
                failedViewId: retryRecovery?.failedViewId ?? "compile-validation",
                ...(retryRecovery?.failedStepId ? { failedStepId: retryRecovery.failedStepId } : {}),
                issue: issue.slice(0, 8_000),
                evidence: "The generated source was rejected before browser execution. Correct every reported compiler or atlas-contract error in the replacement source.",
                failedCriteria: ["Generated TSX must pass semantic TypeScript validation against @seein/atlas before bundling."],
                previous: source,
              };
              throw error;
            }
          },
        );
      };

      project = await this.stage(project, "planning");
      let currentRevision = 1;
      let built = await generateAndCompile(currentRevision);
      let source = built.source;
      let compiled = built.compiled;
      await Promise.all([
        this.artifacts.writeJson(`${relativeRoot}/module/definition.json`, source.definition),
        this.artifacts.writeJson(`${relativeRoot}/module/compiled.json`, compiled),
        this.emit(project, "planning", "completed", {
          generator: this.ai.moduleIdentity,
          compiler: this.atlasCompiler.identity,
          structures: source.definition.structures.length,
          steps: source.definition.steps.length,
          qaViews: source.definition.qaViews.length,
          importedAssets: 0,
        }),
      ]);

      project = await this.stage(project, "assembling");
      const initialScene = surgicalModuleManifest(project.projectId, compiled);
      let currentScene = initialScene;
      let currentManifest = await this.storeScene(project, currentScene);
      let currentSpatial = emptyModuleSpatialReport(currentScene.revision);
      await Promise.all([
        this.artifacts.writeJson(`${relativeRoot}/qa/spatial-revision-${padRevision(currentScene.revision)}.json`, currentSpatial),
        this.context.storeSpatial(project.projectId, currentScene.revision, currentSpatial),
        this.emit(project, "assembling", "completed", {
          revision: currentScene.revision,
          moduleUrl: compiled.viewerUrl,
          structures: source.definition.structures.length,
          steps: source.definition.steps.length,
        }),
      ]);

      let targets = buildQaTargets(currentScene, this.config.WORKFLOW_MAX_QA_TARGETS);
      const passedTargetIds = new Set<string>();
      let targetIndex = 0;
      let currentTarget = targets[0]!;
      let inspectionCount = 0;
      let refinements = 0;
      let finalInspection: Inspection | null = null;
      let finalVerdict: Inspection["verdict"] = "fix";
      supervisor = QualitySupervisorStateSchema.parse({
        ...supervisor,
        currentRevision,
        currentTargetId: currentTarget.id,
        passedTargetIds: [],
        updatedAt: new Date().toISOString(),
      });
      await this.persistQualitySupervisor(project, supervisor);

      project = await this.stage(project, "rendering_initial");
      let currentRender = await this.renderQaTarget(
        project,
        currentScene,
        currentManifest,
        currentTarget,
        relativeRoot,
        "initial",
      );
      const initialRender = currentRender.artifact;
      await this.emit(project, "rendering_initial", "completed", {
        targetId: currentTarget.id,
        stateId: currentTarget.stateId ?? null,
        viewId: currentTarget.viewId ?? null,
        browserErrors: currentRender.capture.browserErrors,
        generatedModule: true,
      });

      while (targetIndex < targets.length) {
        const budgetStatus = qualitySupervisorObservationBudgetStatus(supervisor, this.config);
        if (budgetStatus !== "running") {
          supervisor = QualitySupervisorStateSchema.parse({
            ...supervisor,
            status: budgetStatus,
            lastRecoveryReason: `Stopped before generated-module target ${currentTarget.id}: ${budgetStatus}.`,
            updatedAt: new Date().toISOString(),
          });
          await this.persistQualitySupervisor(project, supervisor);
          break;
        }

        inspectionCount += 1;
        project = await this.stage(project, "inspecting");
        supervisor = this.consumeLogicalAiCall(supervisor, `generated module inspection ${currentTarget.id}`);
        await this.persistQualitySupervisor(project, supervisor);
        const rawInspection = await this.withProviderRetries(
          project,
          "inspecting",
          {
            label: `Visual QA: ${currentTarget.label}`,
            provider: this.ai.inspectionIdentity,
            destination: aiDestination(this.ai.inspectionIdentity),
            action: "models.generateContent (multimodal)",
            detail: {
              targetId: currentTarget.id,
              stateId: currentTarget.stateId ?? null,
              viewId: currentTarget.viewId ?? null,
              revision: currentRevision,
              generatedModule: true,
            },
          },
          () => this.ai.inspect(
            currentScene,
            currentRender.artifact.path,
            currentSpatial,
            {
              requestPrompt: project.prompt,
              approvedIntent: options.intent,
              researchBrief: research!,
              objectStudies: options.dossier?.objectStudies ?? [],
              intentCoverage: options.dossier?.intentCoverage ?? [],
              contradictions: options.dossier?.contradictions ?? [],
              targetId: currentTarget.id,
              stateId: currentTarget.stateId,
              viewId: currentTarget.viewId,
              targetLabel: currentTarget.label,
              passedTargetIds: [...passedTargetIds],
              refinement: refinements,
            },
            inspectionReferenceImages,
          ),
        );
        let inspection = InspectionSchema.parse({
          ...rawInspection,
          targetId: currentTarget.id,
          ...(currentTarget.stateId ? { stateId: currentTarget.stateId } : {}),
          ...(currentTarget.viewId ? { viewId: currentTarget.viewId } : {}),
        });
        let qualityGate = evaluateQualityGate(inspection, currentSpatial, currentRender.capture.browserErrors, this.config);
        if (inspection.verdict === "pass" && !qualityGate.passed) {
          inspection = rejectFalsePass(inspection, qualityGate.reasons);
          qualityGate = evaluateQualityGate(inspection, currentSpatial, currentRender.capture.browserErrors, this.config);
        }
        const progress = recordQualityInspection(supervisor, inspection, currentTarget.id, this.config);
        supervisor = progress.state;
        finalInspection = inspection;
        finalVerdict = inspection.verdict;
        await Promise.all([
          this.artifacts.writeJson(qaInspectionKey(relativeRoot, currentRevision, currentTarget), inspection),
          this.context.storeQa(project.projectId, currentRevision, inspection),
          this.persistQualitySupervisor(project, supervisor),
          this.emit(project, "inspecting", "completed", {
            inspection: inspectionCount,
            refinement: refinements,
            revision: currentRevision,
            targetId: currentTarget.id,
            verdict: inspection.verdict,
            category: inspection.category,
            scores: inspection.assessment,
            generatedModule: true,
          }),
        ]);

        if (qualityGate.passed) {
          passedTargetIds.add(currentTarget.id);
          targetIndex += 1;
          if (targetIndex >= targets.length) break;
          currentTarget = targets[targetIndex]!;
          supervisor = QualitySupervisorStateSchema.parse({
            ...supervisor,
            currentTargetId: currentTarget.id,
            passedTargetIds: [...passedTargetIds],
            updatedAt: new Date().toISOString(),
          });
          await this.persistQualitySupervisor(project, supervisor);
          project = await this.stage(project, "rendering_final");
          currentRender = await this.renderQaTarget(project, currentScene, currentManifest, currentTarget, relativeRoot, "final");
          await this.emit(project, "rendering_final", "completed", {
            revision: currentRevision,
            targetId: currentTarget.id,
            browserErrors: currentRender.capture.browserErrors,
            generatedModule: true,
          });
          continue;
        }

        if (qualitySupervisorBudgetStatus(supervisor, this.config) !== "running") break;
        project = await this.stage(project, "refining");
        const failedTarget = currentTarget;
        currentRevision += 1;
        const recovery: SurgicalModuleRecoveryContext = {
          attempt: refinements + 1,
          failedViewId: currentTarget.viewId ?? currentTarget.id,
          failedStepId: currentTarget.stateId,
          issue: inspection.issue || "The generated surgical view did not pass the quality gate.",
          evidence: inspection.evidence,
          failedCriteria: inspection.assessment.failedCriteria,
          previous: source,
        };
        built = await generateAndCompile(currentRevision, recovery);
        source = built.source;
        compiled = built.compiled;
        currentScene = surgicalModuleManifest(project.projectId, compiled);
        currentManifest = await this.storeScene(project, currentScene);
        currentSpatial = emptyModuleSpatialReport(currentRevision);
        targets = buildQaTargets(currentScene, this.config.WORKFLOW_MAX_QA_TARGETS);
        const recoveryTargetIndex = targets.findIndex((target) =>
          target.id === failedTarget.id
          || (target.viewId === failedTarget.viewId && target.stateId === failedTarget.stateId),
        );
        if (recoveryTargetIndex > 0) {
          const [recoveryTarget] = targets.splice(recoveryTargetIndex, 1);
          targets.unshift(recoveryTarget!);
        }
        passedTargetIds.clear();
        targetIndex = 0;
        currentTarget = targets[0]!;
        refinements += 1;
        supervisor = QualitySupervisorStateSchema.parse({
          ...supervisor,
          attempt: supervisor.attempt + 1,
          refinements: supervisor.refinements + 1,
          replans: supervisor.replans + 1,
          currentRevision,
          currentTargetId: currentTarget.id,
          passedTargetIds: [],
          lastRecoveryReason: `Generated source repair: ${inspection.issue || inspection.assessment.rationale}`,
          updatedAt: new Date().toISOString(),
        });
        await Promise.all([
          this.artifacts.writeJson(`${relativeRoot}/module/definition.json`, source.definition),
          this.artifacts.writeJson(`${relativeRoot}/module/compiled.json`, compiled),
          this.artifacts.writeJson(`${relativeRoot}/module/definition-revision-${padRevision(currentRevision)}.json`, source.definition),
          this.artifacts.writeJson(`${relativeRoot}/qa/spatial-revision-${padRevision(currentRevision)}.json`, currentSpatial),
          this.context.storeSpatial(project.projectId, currentRevision, currentSpatial),
          this.persistQualitySupervisor(project, supervisor),
          this.emit(project, "refining", "completed", {
            revision: currentRevision,
            repair: "full-source-regeneration",
            structures: source.definition.structures.length,
            steps: source.definition.steps.length,
            resetTargets: targets.length,
          }),
        ]);
        project = await this.stage(project, "rendering_final");
        currentRender = await this.renderQaTarget(project, currentScene, currentManifest, currentTarget, relativeRoot, "final");
        await this.emit(project, "rendering_final", "completed", {
          revision: currentRevision,
          targetId: currentTarget.id,
          browserErrors: currentRender.capture.browserErrors,
          generatedModule: true,
        });
      }

      if (currentScene.revision === 1) {
        await this.context.storeRender(project.projectId, 1, initialRender.path, initialRender.sha256, "final");
      }
      if (!finalInspection) finalInspection = budgetExhaustedInspection(supervisor);
      const finalQualityGate = evaluateQualityGate(finalInspection, currentSpatial, currentRender.capture.browserErrors, this.config);
      const coverageComplete = passedTargetIds.size === targets.length && finalQualityGate.passed;
      const acceptedLibraryEntry = coverageComplete
        ? await this.atlasLibrary.storeAccepted({
            projectId: project.projectId,
            revision: currentRevision,
            prompt: project.prompt,
            module: source,
            inspection: finalInspection,
          })
        : null;
      supervisor = QualitySupervisorStateSchema.parse({
        ...supervisor,
        status: coverageComplete
          ? "complete"
          : qualitySupervisorBudgetStatus(supervisor, this.config) === "running"
            ? "action-exhausted"
            : qualitySupervisorBudgetStatus(supervisor, this.config),
        currentRevision,
        currentTargetId: coverageComplete ? undefined : currentTarget.id,
        passedTargetIds: [...passedTargetIds],
        updatedAt: new Date().toISOString(),
      });
      const qaCoverage = QaCoverageSchema.parse({
        sceneRevision: currentRevision,
        requiredTargets: targets,
        passedTargetIds: [...passedTargetIds],
        unresolvedTargetIds: targets.filter((target) => !passedTargetIds.has(target.id)).map((target) => target.id),
        refinements,
        complete: coverageComplete,
        qualityGate: {
          recognizabilityThreshold: this.config.WORKFLOW_MIN_RECOGNIZABILITY,
          domainFidelityThreshold: this.config.WORKFLOW_MIN_DOMAIN_FIDELITY,
          visualQualityThreshold: this.config.WORKFLOW_MIN_VISUAL_QUALITY,
          constructionCompletenessThreshold: this.config.WORKFLOW_MIN_CONSTRUCTION_COMPLETENESS,
          finalAssessment: finalInspection.assessment,
          hardSpatialErrors: finalQualityGate.hardSpatialErrors,
          browserErrors: finalQualityGate.browserErrors,
          passed: finalQualityGate.passed,
        },
        supervisorStatus: supervisor.status,
        generatedAt: new Date().toISOString(),
      });
      await Promise.all([
        this.artifacts.writeJson(`${relativeRoot}/qa/coverage-revision-${padRevision(currentRevision)}.json`, qaCoverage),
        this.persistQualitySupervisor(project, supervisor),
      ]);
      project = await this.projects.update(project, {
        status: qaCoverage.complete
          ? options.interactive ? "awaiting_feedback" : "completed"
          : "awaiting_quality",
        finalRevision: currentRevision,
        finalQaVerdict: finalVerdict,
        qaExhausted: !qaCoverage.complete,
      });
      const outcomeStage: WorkflowStage = qaCoverage.complete
        ? options.interactive ? "awaiting_feedback" : "completed"
        : "awaiting_quality";
      await this.emit(project, outcomeStage, qaCoverage.complete && !options.interactive ? "completed" : "started", {
        revision: currentRevision,
        refinements,
        inspections: inspectionCount,
        requiredTargets: targets.length,
        passedTargets: passedTargetIds.size,
        finalVerdict,
        generatedModule: true,
        compiler: this.atlasCompiler.identity,
        atlasLibraryEntry: acceptedLibraryEntry?.key ?? null,
        finalScores: finalInspection.assessment,
      });
      return {
        project,
        research,
        plan: source,
        initialScene,
        finalScene: currentScene,
        finalInspection,
        qaCoverage,
        qaExhausted: !qaCoverage.complete,
        qualitySupervisor: supervisor,
        viewerUrl: this.viewerUrl(currentManifest.url),
      };
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      project = await this.projects.update(project, { status: "failed", error: message });
      await this.emit(project, "failed", "failed", { error: message, generatedModule: true });
      throw error;
    } finally {
      this.sequences.delete(project.runId);
    }
  }


  private async initializeQualitySupervisor(project: ProjectRecord): Promise<QualitySupervisorState> {
    const existing = await this.context.findQualitySupervisorState(project.projectId);
    const now = Date.now();
    if (existing?.status === "running" && Date.parse(existing.deadlineAt) > now) {
      return QualitySupervisorStateSchema.parse({ ...existing, updatedAt: new Date(now).toISOString() });
    }
    const startedAt = new Date(now).toISOString();
    return QualitySupervisorStateSchema.parse({
      schemaVersion: "1.0",
      projectId: project.projectId,
      startedAt,
      deadlineAt: new Date(now + this.config.WORKFLOW_MAX_RUNTIME_MINUTES * 60_000).toISOString(),
      status: "running",
      attempt: 0,
      inspections: 0,
      refinements: 0,
      targetedResearchRounds: 0,
      replans: 0,
      logicalAiCalls: 0,
      currentRevision: existing?.currentRevision ?? 1,
      passedTargetIds: [],
      bestScores: existing?.bestScores ?? {
        recognizability: 0,
        domainFidelity: 0,
        visualQuality: 0,
        constructionCompleteness: 0,
      },
      recentRepairFingerprints: [],
      recentQualityScores: [],
      lastProgressAt: startedAt,
      lastRecoveryReason: existing ? `Restarted after ${existing.status}.` : "",
      updatedAt: startedAt,
    });
  }

  private async persistQualitySupervisor(
    project: ProjectRecord,
    state: QualitySupervisorState,
  ): Promise<void> {
    const parsed = QualitySupervisorStateSchema.parse(state);
    const relativeRoot = this.projects.relativeRoot(project);
    const checkpoint = `attempt-${String(parsed.attempt).padStart(3, "0")}-inspection-${String(parsed.inspections).padStart(4, "0")}-${parsed.updatedAt.replace(/[^0-9]/g, "")}.json`;
    await Promise.all([
      this.context.storeQualitySupervisorState(parsed),
      this.artifacts.writeJson(`${relativeRoot}/quality/supervisor.json`, parsed),
      this.artifacts.writeJson(`${relativeRoot}/quality/checkpoints/${checkpoint}`, parsed),
    ]);
  }

  private consumeLogicalAiCall(state: QualitySupervisorState, reason: string): QualitySupervisorState {
    return QualitySupervisorStateSchema.parse({
      ...state,
      logicalAiCalls: state.logicalAiCalls + 1,
      lastRecoveryReason: reason,
      updatedAt: new Date().toISOString(),
    });
  }

  private async withProviderRetries<T>(
    project: ProjectRecord,
    stage: WorkflowStage,
    call: ProviderOperation<T>,
    operation: () => Promise<T>,
  ): Promise<T> {
    const operationId = `${project.runId.slice(0, 8)}-${++this.operationSequence}`;
    const operationStartedAt = Date.now();
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.config.WORKFLOW_PROVIDER_RETRIES; attempt += 1) {
      const attemptStartedAt = Date.now();
      await this.emit(
        project,
        stage,
        "info",
        {
          phase: "started",
          label: call.label,
          provider: call.provider,
          destination: call.destination,
          action: call.action,
          attempt,
          maxAttempts: this.config.WORKFLOW_PROVIDER_RETRIES,
          ...call.detail,
        },
        {
          kind: "operation",
          operationId,
          message: `Calling ${call.label} → ${call.destination}`,
        },
      );
      try {
        const result = await operation();
        const resultDetail = call.resultDetail?.(result) ?? {};
        await this.emit(
          project,
          stage,
          "info",
          {
            phase: "completed",
            label: call.label,
            provider: call.provider,
            destination: call.destination,
            action: call.action,
            attempt,
            maxAttempts: this.config.WORKFLOW_PROVIDER_RETRIES,
            durationMs: Date.now() - attemptStartedAt,
            totalDurationMs: Date.now() - operationStartedAt,
            ...call.detail,
            ...resultDetail,
          },
          {
            kind: "operation",
            operationId,
            message: `${call.label} completed`,
          },
        );
        return result;
      } catch (error) {
        lastError = error;
        const failed = attempt >= this.config.WORKFLOW_PROVIDER_RETRIES;
        const delay = Math.min(this.config.WORKFLOW_RETRY_BASE_MS * 2 ** (attempt - 1), 30_000);
        await this.emit(
          project,
          stage,
          "info",
          {
            phase: failed ? "failed" : "retrying",
            label: call.label,
            provider: call.provider,
            destination: call.destination,
            action: call.action,
            attempt,
            maxAttempts: this.config.WORKFLOW_PROVIDER_RETRIES,
            durationMs: Date.now() - attemptStartedAt,
            totalDurationMs: Date.now() - operationStartedAt,
            ...(failed ? {} : { retryInMs: delay }),
            ...describeError(error),
            ...call.detail,
          },
          {
            kind: "operation",
            operationId,
            message: failed
              ? `${call.label} failed after ${attempt} attempt${attempt === 1 ? "" : "s"}`
              : `${call.label} failed; retrying in ${delay} ms`,
          },
        );
        if (failed) break;
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`${call.label} failed after ${this.config.WORKFLOW_PROVIDER_RETRIES} attempts: ${message}`, {
      cause: lastError,
    });
  }


  private async storeScene(project: ProjectRecord, manifest: SceneManifest): Promise<StoredArtifact> {
    const relativeRoot = this.projects.relativeRoot(project);
    const key = `${relativeRoot}/scene/revision-${padRevision(manifest.revision)}.json`;
    const artifact = await this.artifacts.writeJson(key, manifest);
    await this.context.storeScene(project.projectId, manifest, artifact.sha256, artifact.path);
    return artifact;
  }

  private async renderScene(
    project: ProjectRecord,
    scene: SceneManifest,
    manifest: StoredArtifact,
    outputPath: string,
    artifactKey: string,
    kind: "initial" | "final",
    target?: QaTarget,
  ): Promise<{
    artifact: StoredArtifact;
    capture: { path: string; browserErrors: string[] };
    cacheHit: boolean;
  }> {
    const cacheKey = hashObject({
      scene: canonicalSceneForQa(scene),
      target: target ?? null,
      renderer: RENDERER_CACHE_IDENTITY,
      capture: this.screenshots.identity,
      schema: "render-v1",
    });
    const cached = CachedRenderSchema.safeParse(await this.findCachedStepFor(project.projectId, cacheKey));
    const cacheHit =
      cached.success &&
      cached.data.browserErrors.length === 0 &&
      (await validFile(cached.data.path, cached.data.sha256));
    const capture = cacheHit
      ? { path: outputPath, browserErrors: cached.data.browserErrors }
      : await this.withProviderRetries(
          project,
          kind === "initial" ? "rendering_initial" : "rendering_final",
          {
            label: `Render ${target?.label ?? `revision ${scene.revision}`}`,
            provider: this.screenshots.identity,
            destination: this.viewerUrl(manifest.url, target),
            action: "Playwright page load + screenshot",
            detail: {
              revision: scene.revision,
              targetId: target?.id ?? null,
              stateId: target?.stateId ?? null,
              viewId: target?.viewId ?? null,
              outputPath,
            },
            resultDetail: (result) => ({
              capturedPath: result.path,
              browserErrors: result.browserErrors,
            }),
          },
          () => this.screenshots.capture(this.viewerUrl(manifest.url, target), outputPath),
        );
    const artifact = await artifactFromExisting(
      cacheHit ? cached.data.path : capture.path,
      artifactKey,
      this.artifacts,
    );
    await Promise.all([
      this.context.storeRender(project.projectId, scene.revision, artifact.path, artifact.sha256, kind),
      cacheHit || capture.browserErrors.length > 0
        ? Promise.resolve()
        : this.context.storeCachedStep(cacheKey, "render", {
            path: artifact.path,
            sha256: artifact.sha256,
            browserErrors: capture.browserErrors,
          }),
    ]);
    return { artifact, capture: { ...capture, path: artifact.path }, cacheHit };
  }

  private renderQaTarget(
    project: ProjectRecord,
    scene: SceneManifest,
    manifest: StoredArtifact,
    target: QaTarget,
    relativeRoot: string,
    kind: "initial" | "final",
  ) {
    const filename = qaRenderFilename(scene.revision, target);
    return this.renderScene(
      project,
      scene,
      manifest,
      path.join(project.root, "renders", filename),
      `${relativeRoot}/renders/${filename}`,
      kind,
      target,
    );
  }

  private viewerUrl(manifestUrl: string, target?: QaTarget): string {
    const query = new URLSearchParams({ manifest: manifestUrl });
    if (target?.stateId) query.set("state", target.stateId);
    if (target?.viewId) query.set("view", target.viewId);
    return `${this.config.PUBLIC_BASE_URL.replace(/\/$/, "")}/viewer/?${query.toString()}`;
  }

  private async stage(project: ProjectRecord, stage: WorkflowStage): Promise<ProjectRecord> {
    this.assertRunning(project.projectId);
    const next = await this.projects.markStage(project, stage);
    await this.emit(next, stage, "started", {});
    return next;
  }

  private async emit(
    project: ProjectRecord,
    stage: WorkflowStage,
    status: RunEvent["status"],
    detail: Record<string, unknown>,
    options: {
      kind?: RunEvent["kind"];
      operationId?: string;
      message?: string;
    } = {},
  ): Promise<void> {
    const sequence = this.sequences.get(project.runId) ?? 0;
    this.sequences.set(project.runId, sequence + 1);
    const event: RunEvent = {
      projectId: project.projectId,
      runId: project.runId,
      sequence,
      kind: options.kind ?? "stage",
      ...(options.operationId ? { operationId: options.operationId } : {}),
      ...(options.message ? { message: options.message } : {}),
      stage,
      status,
      detail,
      createdAt: new Date().toISOString(),
    };
    const fields = safeLogFields({
      event: event.kind === "operation" ? "provider_call" : "workflow_stage",
      projectId: event.projectId,
      runId: event.runId,
      sequence: event.sequence,
      stage: event.stage,
      status: event.status,
      ...(event.operationId ? { operationId: event.operationId } : {}),
      ...event.detail,
    });
    const message = event.message ?? `${stage.replaceAll("_", " ")} ${status}`;
    if (event.kind === "operation" && event.detail.phase === "failed") this.logger.error(fields, message);
    else if (event.kind === "operation" && event.detail.phase === "retrying") this.logger.warn(fields, message);
    else this.logger.info(fields, message);
    await Promise.all([this.projects.writeEvent(project, event), this.context.appendEvent(event)]);
  }
}


async function validFile(filePath: string, expectedSha256: string): Promise<boolean> {
  try {
    const buffer = await fs.readFile(filePath);
    return buffer.length > 20 && sha256(buffer) === expectedSha256;
  } catch {
    return false;
  }
}

async function artifactFromExisting(
  sourcePath: string,
  key: string,
  artifacts: ArtifactStore,
): Promise<StoredArtifact> {
  if (path.resolve(sourcePath) === path.resolve(artifacts.absolutePath(key))) {
    const buffer = await fs.readFile(sourcePath);
    return { key, path: sourcePath, url: artifacts.publicUrl(key), sha256: sha256(buffer), size: buffer.length };
  }
  return artifacts.copyFile(key, sourcePath);
}

function carryForwardDossierEvidence(
  previous: ResearchDossier[],
  current: Omit<ResearchDossier, "perspectives" | "readiness" | "generatedAt">,
): Omit<ResearchDossier, "perspectives" | "readiness" | "generatedAt"> {
  if (previous.length === 0) return current;
  const priorStudies = previous.flatMap((dossier) => dossier.objectStudies);
  return {
    ...current,
    brief: {
      ...current.brief,
      references: uniqueReferences([
        ...current.brief.references,
        ...previous.flatMap((dossier) => dossier.brief.references),
      ]).slice(0, 64),
    },
    objectStudies: current.objectStudies.map((study) => {
      const exact = priorStudies.find((candidate) => candidate.id === study.id);
      const currentTokens = studyMatchTokens(study.id, study.name);
      const semantic = priorStudies
        .map((candidate) => ({
          candidate,
          overlap: [...studyMatchTokens(candidate.id, candidate.name)].filter((token) => currentTokens.has(token)).length,
        }))
        .filter((match) => match.overlap >= 2)
        .sort((left, right) => right.overlap - left.overlap)[0]?.candidate;
      const prior = exact ?? semantic;
      if (!prior) return study;
      return {
        ...study,
        referenceImageUrls: [...new Set([...study.referenceImageUrls, ...prior.referenceImageUrls])].slice(0, 6),
      };
    }),
  };
}

function studyMatchTokens(id: string, name: string): Set<string> {
  const ignored = new Set(["and", "the", "with", "from", "system", "standard", "anatomy", "structure", "structures", "major"]);
  return new Set(
    `${id} ${name}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .split(/\s+/)
      .filter((token) => token.length >= 4 && !ignored.has(token)),
  );
}

export function buildQaTargets(scene: SceneManifest, maximum: number): QaTarget[] {
  if (scene.module) {
    const requested = scene.module.definition.qaViews.filter((view) => view.required);
    const views = requested.length > 0 ? requested : scene.module.definition.qaViews.slice(0, 1);
    const targets = views.map((view) => ({
      id: `state-${view.stepId}-view-${view.id}`,
      label: `${scene.module!.definition.steps.find((step) => step.id === view.stepId)?.title ?? view.stepId} · ${view.label}`,
      stateId: view.stepId,
      viewId: view.id,
    }));
    if (targets.length > maximum) {
      throw new Error(
        `Generated surgical module requires ${targets.length} QA views, above WORKFLOW_MAX_QA_TARGETS=${maximum}.`,
      );
    }
    return targets;
  }
  throw new Error("QA cannot run: scene manifest has no compiled surgical module.");
}

function surgicalModuleManifest(projectId: string, module: CompiledSurgicalModule): SceneManifest {
  const firstStep = module.definition.steps[0]!;
  return SceneManifestSchema.parse({
    schemaVersion: "1.0",
    projectId,
    sceneId: `${projectId}-atlas-${String(module.revision).padStart(3, "0")}`,
    title: module.definition.title,
    revision: module.revision,
    environment: {
      background: module.definition.background,
      groundColor: "#183b3e",
      groundSize: 44,
    },
    camera: firstStep.camera,
    lights: [
      { id: "atlas-host", type: "hemisphere", color: "#fff1df", intensity: 0.65, position: [0, 0, 8] },
    ],
    objects: [],
    module,
    relationships: [],
    states: module.definition.steps.map((step) => ({
      id: step.id,
      label: step.title,
      objective: step.teachingFocus,
      visibleObjects: [],
      highlightedObjects: [],
      visibleNodes: module.definition.structures.map((structure) => structure.id),
      highlightedNodes: [],
      mutations: [],
    })),
    transitions: module.definition.steps.slice(1).map((step, index) => ({
      from: module.definition.steps[index]!.id,
      to: step.id,
      durationMs: 700,
      kind: "normal",
      description: `Advance to ${step.title}.`,
    })),
    generatedAt: new Date().toISOString(),
  });
}

function emptyModuleSpatialReport(revision: number): SpatialReport {
  return {
    schemaVersion: "2.0",
    analyzer: "generated-atlas-module:browser-visual-qa",
    sceneRevision: revision,
    sceneBounds: { min: [0, 0, 0], max: [0, 0, 0] },
    objects: [],
    issues: [],
    generatedAt: new Date().toISOString(),
  };
}

function validateSurgicalModuleAgainstDossier(
  module: SurgicalModuleSource,
  dossier?: ResearchDossier,
): void {
  if (!dossier) return;
  const approved = new Set(dossier.objectStudies.map((study) => study.id));
  const represented = new Set(module.definition.structures.map((structure) => structure.studyId));
  const unapproved = [...represented].filter((studyId) => !approved.has(studyId));
  if (unapproved.length > 0) {
    throw new Error(`Generated surgical module uses unapproved object-study IDs: ${unapproved.join(", ")}`);
  }
  const uncovered = dossier.intentCoverage.filter((coverage) =>
    !coverage.objectStudyIds.some((studyId) => represented.has(studyId)),
  );
  if (uncovered.length > 0) {
    throw new Error(
      `Generated surgical module does not represent approved requirements: ${uncovered.map((coverage) => coverage.requirement).join(" | ")}`,
    );
  }
}

function validateProcedureAtlasContract(prompt: string, module: SurgicalModuleSource): void {
  if (!/<PatientOperatingContext(?:\s|>)/.test(module.source)) {
    throw new Error("Every surgical module must render PatientOperatingContext so internal anatomy remains registered to the human body");
  }
  if (!/<CalibratedInternalAnatomy(?:\s|>)/.test(module.source)) {
    throw new Error("Every surgical module must render CalibratedInternalAnatomy so target geometry is shown within registered internal-organ context");
  }
  const frameAliases: Record<string, string> = {
    "central-abdomen": "CentralAbdominalFrame",
    "right-upper-quadrant": "RightUpperQuadrantFrame",
    "lower-gastrointestinal": "LowerGastrointestinalFrame",
    pelvis: "PelvicFrame",
    "right-groin": "RightGroinFrame",
    thorax: "ThoracicFrame",
  };
  const usedFrames = new Set(
    module.definition.placements
      .map((placement) => placement.frameId)
      .filter((frameId) => frameId !== "whole-body"),
  );
  const unmountedFrames = [...usedFrames].filter((frameId) => {
    const alias = frameAliases[frameId];
    const usesAlias = alias ? new RegExp(`<${alias}(?:\\s|>)`).test(module.source) : false;
    const usesGenericFrame = module.source.includes("AnatomicalRegionFrame") && module.source.includes(frameId);
    return !usesAlias && !usesGenericFrame;
  });
  if (unmountedFrames.length > 0) {
    throw new Error(
      `Generated source does not mount required anatomical region frame(s): ${unmountedFrames.join(", ")}`,
    );
  }

  const registeredStructures = new Map(
    loadAnatomicalRegistry().structures.map((structure) => [structure.id, structure]),
  );
  validateRegisteredStructureFrames(module.source);
  const unboundRegistrations = module.definition.placements.filter((placement) => {
    const registration = registeredStructures.get(placement.structureId);
    if (!registration) return false;
    return !sourceUsesRegisteredPlacement(module.source, placement.structureId);
  });
  if (unboundRegistrations.length > 0) {
    throw new Error(
      "Known atlas structures must bind rendered geometry to RegisteredStructureFrame, atlasPoint, atlasSize, or atlasStructure: " +
      unboundRegistrations.map((placement) => placement.structureId).join(", "),
    );
  }

  const normalized = prompt.toLowerCase();
  const rightHepatobiliary = /(?:right hepatic|hepatic hilum|cholecyst|gallbladder|calot)/.test(normalized);
  if (!rightHepatobiliary) return;
  if (/\bHepatobiliaryAtlas\b/.test(module.source)) {
    throw new Error(
      "Hepatobiliary target anatomy must be generated from registered placements and research, not rendered from the fixed HepatobiliaryAtlas reference aggregate",
    );
  }
  const requiredJsx = [
    "PatientOperatingContext",
    "CalibratedInternalAnatomy",
    "LaparoscopicCholecystectomyPorts",
    "RightUpperQuadrantFrame",
  ];
  const missing = requiredJsx.filter((component) => !new RegExp(`<${component}(?:\\s|>)`).test(module.source));
  if (missing.length > 0) {
    throw new Error(`Right hepatobiliary modules must render the calibrated atlas frames: missing ${missing.join(", ")}`);
  }
  const requiredStructureIds = [
    "liver",
    "gallbladder",
    "gallbladder-neck",
    "cystic-duct",
    "common-hepatic-duct",
    "common-bile-duct",
    "cystic-artery",
    "hepatocystic-triangle",
    "rouviere-sulcus",
    "right-hepatic-artery",
    "portal-vein",
    "porta-hepatis",
  ];
  const representedStructureIds = new Set(module.definition.structures.map((structure) => structure.id));
  const missingStructures = requiredStructureIds.filter((structureId) => !representedStructureIds.has(structureId));
  if (missingStructures.length > 0) {
    throw new Error(
      `Right hepatobiliary modules must generate the complete registered operative anatomy: missing ${missingStructures.join(", ")}`,
    );
  }
  if (
    !/<CalibratedLiverSurface(?:\s|>)/.test(module.source) &&
    !/<LoftedOrgan(?:\s|>)/.test(module.source) &&
    !/new\s+THREE\.BufferGeometry\s*\(/.test(module.source)
  ) {
    throw new Error(
      "Right hepatobiliary modules must use the registered CalibratedLiverSurface for classic normal anatomy or author a replacement asymmetric liver with LoftedOrgan/custom THREE.BufferGeometry; ProfiledOrgan and overlapping ellipsoids are not valid liver construction",
    );
  }
  if (!/<SculptedSheet(?:\s|>)/.test(module.source) && !/new\s+THREE\.BufferGeometry\s*\(/.test(module.source)) {
    throw new Error(
      "Right hepatobiliary modules must author curved depth-bearing liver-bed/cystic-plate tissue with SculptedSheet or a custom THREE.BufferGeometry",
    );
  }
  if (!module.definition.steps.some((step) => !step.showLabels)) {
    throw new Error("Right hepatobiliary modules require at least one label-free whole-patient or regional orientation step");
  }
  const requiredViews = module.definition.qaViews.filter((view) => view.required);
  if (requiredViews.length < 3) {
    throw new Error("Right hepatobiliary modules require at least three QA views: orientation plus two operative close-ups");
  }
  const operativeViews = requiredViews.filter((view) =>
    /(?:subhepatic|operative|calot|cystic|critical|cvs|portal|danger|hilum)/i.test(view.label),
  );
  const distantViews = operativeViews.filter((view) => {
    const step = module.definition.steps.find((candidate) => candidate.id === view.stepId);
    if (!step) return true;
    const [px, py, pz] = step.camera.position;
    const [tx, ty, tz] = step.camera.target;
    return Math.hypot(px - tx, py - ty, pz - tz) > 3.6;
  });
  if (distantViews.length > 0) {
    throw new Error(
      `Required operative QA views must use a magnified laparoscopic camera within 3.6 atlas units of target: ${distantViews.map((view) => view.id).join(", ")}`,
    );
  }
  if (operativeViews.length < 2) {
    throw new Error("Right hepatobiliary modules require at least two magnified operative QA views");
  }
  const grasperCount = module.source.match(/<SurgicalGrasper(?:\s|>)/g)?.length ?? 0;
  if (grasperCount < 2) {
    throw new Error(
      "Laparoscopic cholecystectomy modules must render two articulated SurgicalGrasper instances for fundic and infundibular traction; plain tubes are not valid graspers",
    );
  }
  if (!/showHardware\s*=\s*\{[^}]*\}/.test(module.source)) {
    throw new Error(
      "LaparoscopicCholecystectomyPorts must bind showHardware to operative state so external trocar bodies are hidden in magnified views",
    );
  }
}

function sourceUsesRegisteredPlacement(source: string, structureId: string): boolean {
  const escaped = structureId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    new RegExp(`<RegisteredStructureFrame[^>]*\\bid\\s*=\\s*["']${escaped}["']`, "s"),
    new RegExp(`\\batlas(?:Point|Size|Structure)\\s*\\(\\s*["']${escaped}["']`),
  ].some((pattern) => pattern.test(source));
}

function qaTargetSuffix(target: QaTarget): string {
  return target.id === "default" ? "" : `-${target.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function qaRenderFilename(revision: number, target: QaTarget): string {
  return `revision-${padRevision(revision)}${qaTargetSuffix(target)}.png`;
}

function qaInspectionKey(relativeRoot: string, revision: number, target: QaTarget): string {
  return `${relativeRoot}/qa/revision-${padRevision(revision)}${qaTargetSuffix(target)}.json`;
}

function qaSpatialKey(relativeRoot: string, revision: number, target: QaTarget): string {
  return `${relativeRoot}/qa/spatial-revision-${padRevision(revision)}${qaTargetSuffix(target)}.json`;
}

function renderResearchNotes(research: ResearchBrief): string {
  return `# ${research.concept}\n\n${research.summary}\n\n## Anatomical visual notes\n\n${research.visualNotes.map((note) => `- ${note}`).join("\n")}\n\n## Structure and relationship notes\n\n${research.objectNotes.map((note) => `- ${note}`).join("\n")}\n\n## Medical sources\n\n${research.sources.map((source) => `- [${source.title}](${source.url}) — ${source.note}`).join("\n")}\n`;
}

function padRevision(revision: number): string {
  return String(revision).padStart(3, "0");
}

function mergePreferences(
  existing: UserPreference[],
  updates: UserPreference[],
): UserPreference[] {
  const merged = new Map(existing.map((preference) => [preference.key, preference]));
  for (const preference of updates) merged.set(preference.key, preference);
  return [...merged.values()]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, 24);
}

function canonicalSceneForQa(manifest: SceneManifest): unknown {
  const { projectId: _projectId, sceneId: _sceneId, revision: _revision, generatedAt: _generatedAt, ...stable } =
    manifest;
  return stable;
}

interface QualityGateResult {
  passed: boolean;
  reasons: string[];
  hardSpatialErrors: number;
  browserErrors: number;
}


export function evaluateQualityGate(
  inspection: Inspection,
  spatial: SpatialReport,
  browserErrors: string[],
  config: Config,
): QualityGateResult {
  const hardSpatialErrors = spatial.issues.filter((issue) => issue.severity === "error").length;
  const reasons: string[] = [];
  if (inspection.verdict !== "pass") reasons.push(inspection.issue || "The visual inspector requested a correction.");
  if (inspection.assessment.recognizabilityScore < config.WORKFLOW_MIN_RECOGNIZABILITY) {
    reasons.push(`Recognizability ${inspection.assessment.recognizabilityScore.toFixed(3)} is below ${config.WORKFLOW_MIN_RECOGNIZABILITY}.`);
  }
  if (inspection.assessment.domainFidelityScore < config.WORKFLOW_MIN_DOMAIN_FIDELITY) {
    reasons.push(`Domain fidelity ${inspection.assessment.domainFidelityScore.toFixed(3)} is below ${config.WORKFLOW_MIN_DOMAIN_FIDELITY}.`);
  }
  if (inspection.assessment.visualQualityScore < config.WORKFLOW_MIN_VISUAL_QUALITY) {
    reasons.push(`Visual quality ${inspection.assessment.visualQualityScore.toFixed(3)} is below ${config.WORKFLOW_MIN_VISUAL_QUALITY}.`);
  }
  if (inspection.assessment.constructionCompletenessScore < config.WORKFLOW_MIN_CONSTRUCTION_COMPLETENESS) {
    reasons.push(`Construction completeness ${inspection.assessment.constructionCompletenessScore.toFixed(3)} is below ${config.WORKFLOW_MIN_CONSTRUCTION_COMPLETENESS}.`);
  }
  if (inspection.assessment.confidence < 0.55) {
    reasons.push(`Inspection confidence ${inspection.assessment.confidence.toFixed(3)} is too low for autonomous acceptance.`);
  }
  if (hardSpatialErrors > 0) reasons.push(`${hardSpatialErrors} backend spatial error(s) remain.`);
  if (browserErrors.length > 0) reasons.push(`${browserErrors.length} browser/render error(s) remain.`);
  return { passed: reasons.length === 0, reasons, hardSpatialErrors, browserErrors: browserErrors.length };
}

function rejectFalsePass(inspection: Inspection, reasons: string[]): Inspection {
  const needsResearch =
    inspection.assessment.recognizabilityScore < 0.82 ||
    inspection.assessment.domainFidelityScore < 0.78;
  return InspectionSchema.parse({
    ...inspection,
    verdict: "fix",
    category: "composition",
    issue: `Backend quality gate rejected the visual pass: ${reasons.join(" ")}`,
    evidence: `${inspection.evidence} The scored backend gates remain authoritative for completion.`,
    patch: { kind: "none" },
    assessment: {
      ...inspection.assessment,
      recommendedAction: needsResearch ? "targeted-research" : "partial-replan",
      failedCriteria: [...new Set([...inspection.assessment.failedCriteria, ...reasons])].slice(0, 12),
      rationale: `The inspector returned pass, but ${reasons.join(" ")}`,
    },
  });
}

function recordQualityInspection(
  state: QualitySupervisorState,
  inspection: Inspection,
  targetId: string,
  config: Config,
): { state: QualitySupervisorState; stalled: boolean } {
  const assessment = inspection.assessment;
  const aggregate = Math.min(
    assessment.recognizabilityScore,
    assessment.domainFidelityScore,
    assessment.visualQualityScore,
    assessment.constructionCompletenessScore,
  );
  const fingerprint = hashObject({
    targetId,
    category: inspection.category,
    issue: normalizePrompt(inspection.issue),
    patch: inspection.patch,
    recommendedAction: assessment.recommendedAction,
  });
  const recentFingerprints = [...state.recentRepairFingerprints, fingerprint].slice(-24);
  const recentScores = [...state.recentQualityScores, aggregate].slice(-24);
  const window = recentScores.slice(-config.WORKFLOW_STALL_WINDOW);
  const plateau = window.length >= config.WORKFLOW_STALL_WINDOW &&
    Math.max(...window) - Math.min(...window) < config.WORKFLOW_MIN_QUALITY_DELTA;
  const repeated = recentFingerprints.filter((candidate) => candidate === fingerprint).length >= 2;
  const improved =
    assessment.recognizabilityScore > state.bestScores.recognizability + config.WORKFLOW_MIN_QUALITY_DELTA ||
    assessment.domainFidelityScore > state.bestScores.domainFidelity + config.WORKFLOW_MIN_QUALITY_DELTA ||
    assessment.visualQualityScore > state.bestScores.visualQuality + config.WORKFLOW_MIN_QUALITY_DELTA ||
    assessment.constructionCompletenessScore > state.bestScores.constructionCompleteness + config.WORKFLOW_MIN_QUALITY_DELTA;
  const now = new Date().toISOString();
  return {
    stalled: repeated || plateau,
    state: QualitySupervisorStateSchema.parse({
      ...state,
      inspections: state.inspections + 1,
      currentTargetId: targetId,
      bestScores: {
        recognizability: Math.max(state.bestScores.recognizability, assessment.recognizabilityScore),
        domainFidelity: Math.max(state.bestScores.domainFidelity, assessment.domainFidelityScore),
        visualQuality: Math.max(state.bestScores.visualQuality, assessment.visualQualityScore),
        constructionCompleteness: Math.max(
          state.bestScores.constructionCompleteness,
          assessment.constructionCompletenessScore,
        ),
      },
      recentRepairFingerprints: recentFingerprints,
      recentQualityScores: recentScores,
      lastProgressAt: improved ? now : state.lastProgressAt,
      updatedAt: now,
    }),
  };
}


function qualitySupervisorBudgetStatus(
  state: QualitySupervisorState,
  config: Config,
): QualitySupervisorState["status"] {
  if (Date.now() >= Date.parse(state.deadlineAt)) return "time-exhausted";
  if (state.attempt >= config.WORKFLOW_MAX_ITERATIONS - 1) return "action-exhausted";
  if (state.logicalAiCalls >= config.WORKFLOW_MAX_LOGICAL_AI_CALLS) return "api-exhausted";
  return "running";
}

function qualitySupervisorObservationBudgetStatus(
  state: QualitySupervisorState,
  config: Config,
): QualitySupervisorState["status"] {
  if (Date.now() >= Date.parse(state.deadlineAt)) return "time-exhausted";
  if (state.logicalAiCalls >= config.WORKFLOW_MAX_LOGICAL_AI_CALLS) return "api-exhausted";
  return "running";
}

function budgetExhaustedInspection(state: QualitySupervisorState): Inspection {
  return InspectionSchema.parse({
    verdict: "fix",
    category: "performance",
    issue: `The autonomous quality supervisor stopped at ${state.status}; no target was accepted without inspection.`,
    evidence: `Attempts=${state.attempt}, inspections=${state.inspections}, logical AI calls=${state.logicalAiCalls}.`,
    patch: { kind: "none" },
    assessment: {
      recognizabilityScore: state.bestScores.recognizability,
      domainFidelityScore: state.bestScores.domainFidelity,
      visualQualityScore: state.bestScores.visualQuality,
      constructionCompletenessScore: state.bestScores.constructionCompleteness,
      confidence: 1,
      failedCriteria: ["The complete required state/view matrix has not passed at one revision."],
      strengths: [],
      recommendedAction: "partial-replan",
      targetStudyIds: [],
      researchQuestions: [],
      rationale: "A later resume can continue from durable research, compiled-module, render, and quality checkpoints.",
    },
  });
}
