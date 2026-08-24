import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Config } from "../config.js";
import type {
  Inspection,
  AssetGeometry,
  ProjectRecord,
  ResearchBrief,
  ResolvedAsset,
  RunEvent,
  SceneManifest,
  ScenePlan,
  SpatialReport,
  WorkflowStage,
} from "../contracts.js";
import { InspectionSchema, ScenePlanSchema } from "../contracts.js";
import type { WorkflowAI } from "../ai/workflow-ai.js";
import type { BlenderDriver } from "../blender/blender-driver.js";
import type { AssetRecord, ContextStore } from "../context/context-store.js";
import { hashObject, sha256 } from "../lib/hash.js";
import { normalizePrompt } from "../lib/strings.js";
import type { ScreenshotDriver } from "../render/screenshot-driver.js";
import type { ReferenceCollector } from "../research/reference-collector.js";
import {
  applyAssetRegeneration,
  applyQaPatch,
  applyResolvedAssets,
  assembleScene,
} from "../scene/scene-assembler.js";
import { boundsSize, measureGlbBuffer, measureGlbGeometry, recipeBounds } from "../scene/geometry-bounds.js";
import { analyzeSpatial } from "../scene/spatial-analyzer.js";
import type { ArtifactStore, StoredArtifact } from "../storage/artifact-store.js";
import type { ProjectManager } from "../storage/project-manager.js";
import {
  ClarificationAnswerRequestSchema,
  ClarificationTurnSchema,
  IntentAndAgendaSchema,
  ResearchDossierDraftSchema,
  ResearchPerspectiveResultSchema,
  ResearchDecisionRequestSchema,
  UserFeedbackRequestSchema,
  UserPreferenceProfileSchema,
  WorkflowGraphStateSchema,
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
  transitionGraphState,
} from "./graph-state.js";

export interface WorkflowResult {
  project: ProjectRecord;
  research: ResearchBrief;
  plan: ScenePlan;
  initialScene: SceneManifest;
  finalScene: SceneManifest;
  finalInspection: Inspection;
  qaExhausted: boolean;
  viewerUrl: string;
}

export interface FeedbackResult {
  state: WorkflowGraphState;
  nextProject?: ProjectRecord;
}

const CachedRenderSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().length(64),
  browserErrors: z.array(z.string()),
});

const RENDERER_CACHE_IDENTITY = "three-viewer:v1";

export class Orchestrator {
  private readonly activeRuns = new Map<string, Promise<unknown>>();
  private readonly interactionLocks = new Set<string>();
  private readonly sequences = new Map<string, number>();

  constructor(
    private readonly config: Config,
    private readonly projects: ProjectManager,
    private readonly artifacts: ArtifactStore,
    private readonly context: ContextStore,
    private readonly ai: WorkflowAI,
    private readonly references: ReferenceCollector,
    private readonly blender: BlenderDriver,
    private readonly screenshots: ScreenshotDriver,
  ) {}

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
    return this.execute(project);
  }

  getActiveRun(projectId: string): Promise<unknown> | undefined {
    return this.activeRuns.get(projectId);
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
        "The evidence dossier is approved. I am now reusing or building only the assets justified by that research.",
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
    if (state.researchRound >= this.config.WORKFLOW_MAX_RESEARCH_ROUNDS) {
      throw new Error(`Research has reached the configured ${this.config.WORKFLOW_MAX_RESEARCH_ROUNDS}-round bound`);
    }
    if (!request.feedback) throw new Error("Research-more requires feedback describing the missing evidence");
    const agenda = structuredClone(state.researchAgenda);
    if (!agenda) throw new Error("Research agenda is missing");
    for (const perspective of agenda.perspectives) {
      perspective.objective = `${perspective.objective} Follow-up requested by user: ${request.feedback}`;
      perspective.searchHints = [...perspective.searchHints, request.feedback].slice(0, 8);
    }
    const next = transitionGraphState(
      state,
      "plan-research",
      "running",
      "I have added your gap to the research agenda and will run one targeted follow-up round.",
      {
        researchAgenda: agenda,
        researchRound: state.researchRound + 1,
        notes: [...state.notes, createNote("feedback", request.feedback, "research-more")],
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
        "The visualization is accepted. Your explicit preferences are saved for future projects.",
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
      `Your feedback has started a linked revision project (${nextProject.projectId}); its clarifier will focus on the requested change before invalidating research or assets.`,
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
    await Promise.all([this.blender.close(), this.screenshots.close()]);
    await this.context.close();
  }

  private track(projectId: string, task: Promise<unknown>): void {
    this.activeRuns.set(projectId, task);
    void task.finally(() => {
      if (this.activeRuns.get(projectId) === task) this.activeRuns.delete(projectId);
    }).catch(() => undefined);
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

  private async beginClarification(project: ProjectRecord, initialState: WorkflowGraphState): Promise<void> {
    let state = initialState;
    try {
      await this.emit(project, "created", "completed", { prompt: project.prompt, interactive: true });
      state = transitionGraphState(
        state,
        "clarify-intent",
        "running",
        "I am identifying only the uncertainties that could change research, assets, spatial layout, or the teaching sequence.",
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
      const cached = await this.context.findCachedStep(cacheKey);
      const parsed = ClarificationTurnSchema.safeParse(cached);
      const clarification = parsed.success
        ? parsed.data
        : await this.ai.clarify(project.prompt, state.preferenceProfile);
      if (!parsed.success) await this.context.storeCachedStep(cacheKey, "clarification", clarification);
      const notes = [
        ...state.notes,
        ...clarification.assumptions.map((assumption) => createNote("assumption", assumption, "clarifier", "project", 0.6)),
      ];
      state = transitionGraphState(
        state,
        "await-clarification",
        "waiting",
        "Answer these few questions before research. Each answer is shown with why it changes the eventual visualization.",
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
        const cachedPreparation = IntentAndAgendaSchema.safeParse(await this.context.findCachedStep(preparationKey));
        prepared = cachedPreparation.success
          ? cachedPreparation.data
          : await this.ai.prepareIntent(
              project.prompt,
              state.clarification!,
              state.answers,
              additionalContext,
              state.preferenceProfile,
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
        "Three independent research branches are running in parallel: visual identity, objects/materials, and scale/space.",
      );
      currentProject = await this.projects.update(currentProject, { status: "researching" });
      await Promise.all([
        this.persistGraphState(currentProject, state),
        this.emit(currentProject, "planning_research", "completed", {
          perspectives: prepared.agenda.perspectives.map((perspective) => perspective.id),
          round: state.researchRound,
        }),
        this.emit(currentProject, "researching", "started", { parallelBranches: 3, round: state.researchRound }),
      ]);
      const branchHits: boolean[] = [];
      const perspectives = await Promise.all(
        prepared.agenda.perspectives.map(async (perspective, index) => {
          const key = hashObject({
            intent: prepared!.intent,
            perspective,
            provider: this.ai.deepResearchIdentity,
            schema: "research-perspective-v1",
          });
          const cached = ResearchPerspectiveResultSchema.safeParse(await this.context.findCachedStep(key));
          branchHits[index] = cached.success;
          if (cached.success) return cached.data;
          const result = await this.ai.researchPerspective(prepared!.intent, perspective);
          await this.context.storeCachedStep(key, `research-perspective:${perspective.id}`, result);
          return result;
        }),
      );
      state = transitionGraphState(
        state,
        "synthesize-research",
        "running",
        "The research branches have joined. I am binding object studies to sources and checking whether generation is justified.",
      );
      currentProject = await this.projects.update(currentProject, { status: "auditing_research" });
      await Promise.all([
        this.persistGraphState(currentProject, state),
        this.emit(currentProject, "researching", "completed", { cacheHits: branchHits, round: state.researchRound }),
        this.emit(currentProject, "auditing_research", "started", {}),
      ]);
      const synthesisKey = hashObject({
        intent: prepared.intent,
        perspectives,
        provider: this.ai.planningIdentity,
        schema: "research-dossier-draft-v1",
      });
      const cachedDraft = ResearchDossierDraftSchema.safeParse(await this.context.findCachedStep(synthesisKey));
      const draft = cachedDraft.success
        ? cachedDraft.data
        : await this.ai.synthesizeResearch(prepared.intent, perspectives);
      if (!cachedDraft.success) await this.context.storeCachedStep(synthesisKey, "research-dossier-draft", draft);
      const dossier = evaluateResearchReadiness(prepared.intent, perspectives, draft);
      const researchNotes = dossier.objectStudies.map((study) =>
        createNote(
          "research-finding",
          `${study.name}: ${study.identityMarkers.join("; ")}`,
          study.sourceUrls[0] ?? "research-dossier",
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
          ? "The evidence gate passed. Review the object studies and references, then approve generation or request one targeted research round."
          : "Generation is blocked by visible evidence gaps. Request targeted research after reviewing the failed checks.",
        { waitingFor: "research-approval" },
      );
      const relativeRoot = this.projects.relativeRoot(currentProject);
      currentProject = await this.projects.update(currentProject, { status: "awaiting_research_approval" });
      await Promise.all([
        this.persistGraphState(currentProject, state),
        this.artifacts.writeJson(`${relativeRoot}/research/intent.json`, prepared.intent),
        this.artifacts.writeJson(`${relativeRoot}/research/agenda.json`, prepared.agenda),
        this.artifacts.writeJson(`${relativeRoot}/research/dossier.json`, dossier),
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
      const result = await this.execute(project, {
        research: state.researchDossier.brief,
        intent: state.intent,
        dossier: state.researchDossier,
        interactive: true,
      });
      state = transitionGraphState(
        state,
        "visual-qa",
        "running",
        "The browser render and measured spatial evidence have been inspected; the final bounded QA result is now being attached.",
      );
      await this.persistGraphState(result.project, state);
      state = transitionGraphState(
        state,
        "await-feedback",
        "waiting",
        "Explore the guided scene, then accept it or identify what should change. Explicit preferences can be carried into the next linked revision.",
        {
          waitingFor: "feedback",
          finalSceneRevision: result.finalScene.revision,
          finalInspection: result.finalInspection,
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

  private async persistGraphState(project: ProjectRecord, state: WorkflowGraphState): Promise<void> {
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
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    const latest = await this.getGraphState(project.projectId) ?? state;
    const failed = latest.currentNode === "failed"
      ? latest
      : transitionGraphState(latest, "failed", "failed", `The workflow stopped: ${message}`, {});
    await Promise.all([
      this.persistGraphState(project, failed),
      this.projects.update(project, { status: "failed", error: message }),
      this.emit(project, "failed", "failed", { error: message, graphNode: latest.currentNode }),
    ]);
  }

  private async execute(
    initialProject: ProjectRecord,
    options: {
      research?: ResearchBrief;
      intent?: IntentFrame;
      dossier?: ResearchDossier;
      interactive?: boolean;
    } = {},
  ): Promise<WorkflowResult> {
    let project = initialProject;
    const relativeRoot = this.projects.relativeRoot(project);
    try {
      if (!options.interactive) await this.emit(project, "created", "completed", { prompt: project.prompt });

      project = await this.stage(project, "researching");
      const researchKey = hashObject({
        prompt: normalizePrompt(project.prompt),
        intent: options.intent ?? null,
        schema: "research-v2",
        provider: this.ai.researchIdentity,
      });
      let research = options.research ?? await this.context.findResearch(researchKey);
      const researchCacheHit = options.research !== undefined || research !== null;
      if (!research) {
        research = await this.ai.research(project.prompt);
        await this.context.storeResearch(researchKey, project.prompt, research);
      } else if (options.research) {
        await this.context.storeResearch(researchKey, project.prompt, research);
      }
      const planKey = hashObject({
        prompt: normalizePrompt(project.prompt),
        research: hashObject(research),
        intent: options.intent ?? null,
        dossier: options.dossier ? hashObject(options.dossier) : null,
        maxObjects: this.config.WORKFLOW_MAX_OBJECTS,
        schema: "plan-v5",
        provider: this.ai.planningIdentity,
      });
      const cachedPlan = ScenePlanSchema.safeParse(await this.context.findCachedStep(planKey));
      const planCacheHit = cachedPlan.success;
      const planPromise = cachedPlan.success
        ? Promise.resolve(cachedPlan.data)
        : Promise.resolve(
            this.ai.plan(project.prompt, research, this.config.WORKFLOW_MAX_OBJECTS, options.intent, options.dossier),
          ).then(
            async (value) => {
              const parsed = ScenePlanSchema.parse(value);
              validatePlanAgainstDossier(parsed, options.dossier);
              await this.context.storeCachedStep(planKey, "scene-plan", parsed);
              return parsed;
            },
          );
      const [initialPlan, referenceArtifacts] = await Promise.all([
        planPromise,
        this.references.collect(research, path.join(project.root, "research", "references")),
        this.artifacts.writeJson(`${relativeRoot}/research/brief.json`, research),
        this.artifacts.writeJson(`${relativeRoot}/research/sources.json`, research.sources),
        this.artifacts.writeText(`${relativeRoot}/research/notes.md`, renderResearchNotes(research)),
      ]);
      let plan = initialPlan;
      validatePlanAgainstDossier(plan, options.dossier);
      await this.artifacts.writeJson(`${relativeRoot}/research/references/index.json`, referenceArtifacts);
      await this.emit(project, "researching", "completed", {
        cacheHit: researchCacheHit,
        preApprovedDossier: options.research !== undefined,
        referencesRequested: research.references.length,
        referencesDownloaded: referenceArtifacts.filter((artifact) => artifact.localPath).length,
        referencesReused: referenceArtifacts.filter((artifact) => artifact.reused).length,
      });

      project = await this.stage(project, "planning");
      await this.artifacts.writeJson(`${relativeRoot}/plan/scene-plan.json`, plan);
      await this.emit(project, "planning", "completed", {
        cacheHit: planCacheHit,
        assets: plan.assets.length,
        objects: plan.objects.length,
      });

      project = await this.stage(project, "resolving_assets");
      let resolved = await this.resolveAssets(project, plan, 1);
      await this.artifacts.writeJson(`${relativeRoot}/assets/index.json`, [...resolved.values()]);
      await this.emit(project, "resolving_assets", "completed", {
        generated: [...resolved.values()].filter((asset) => !asset.reused).length,
        reused: [...resolved.values()].filter((asset) => asset.reused).length,
      });

      project = await this.stage(project, "assembling");
      const initialScene = assembleScene(project.projectId, plan, resolved, 1);
      const initialSpatial = analyzeSpatial(plan, initialScene, resolved);
      const [initialManifest] = await Promise.all([
        this.storeScene(project, initialScene),
        this.artifacts.writeJson(`${relativeRoot}/qa/spatial-revision-001.json`, initialSpatial),
        this.context.storeSpatial(project.projectId, 1, initialSpatial),
      ]);
      await this.emit(project, "assembling", "completed", {
        revision: 1,
        spatialIssues: initialSpatial.issues.length,
      });

      project = await this.stage(project, "rendering_initial");
      const initialRenderPath = path.join(project.root, "renders", "revision-001.png");
      const initialRendered = await this.renderScene(
        project,
        initialScene,
        initialManifest,
        initialRenderPath,
        `${relativeRoot}/renders/revision-001.png`,
        "initial",
      );
      const initialRender = initialRendered.artifact;
      const initialCapture = initialRendered.capture;
      await this.emit(project, "rendering_initial", "completed", {
        cacheHit: initialRendered.cacheHit,
        browserErrors: initialCapture.browserErrors,
      });

      let currentScene = initialScene;
      let currentSpatial = initialSpatial;
      let currentManifest = initialManifest;
      let currentRender = initialRendered;
      let refinements = 0;
      let exhausted = false;
      let finalVerdict: Inspection["verdict"] = "pass";
      let finalInspection: Inspection | null = null;

      for (let iteration = 1; iteration <= this.config.WORKFLOW_MAX_ITERATIONS; iteration += 1) {
        project = await this.stage(project, "inspecting");
        const inspectionKey = hashObject({
          scene: canonicalSceneForQa(currentScene),
          planAssets: hashObject(plan.assets),
          spatial: canonicalSpatialForQa(currentSpatial),
          screenshot: currentRender.artifact.sha256,
          browserErrors: currentRender.capture.browserErrors,
          provider: this.ai.inspectionIdentity,
          renderer: this.screenshots.identity,
          schema: "inspection-v3",
        });
        const cachedInspection = InspectionSchema.safeParse(await this.context.findCachedStep(inspectionKey));
        const inspection: Inspection = cachedInspection.success
          ? cachedInspection.data
          : await this.ai.inspect(currentScene, currentRender.artifact.path, currentSpatial, plan);
        await Promise.all([
          this.artifacts.writeJson(
            `${relativeRoot}/qa/revision-${padRevision(currentScene.revision)}.json`,
            inspection,
          ),
          this.context.storeQa(project.projectId, currentScene.revision, inspection),
          cachedInspection.success
            ? Promise.resolve()
            : this.context.storeCachedStep(inspectionKey, "inspection", inspection),
        ]);
        const canRefine =
          inspection.verdict === "fix" &&
          inspection.patch.kind !== "none" &&
          iteration < this.config.WORKFLOW_MAX_ITERATIONS;
        await this.emit(project, "inspecting", "completed", {
          iteration,
          revision: currentScene.revision,
          cacheHit: cachedInspection.success,
          verdict: inspection.verdict,
          category: inspection.category,
          canRefine,
        });
        finalVerdict = inspection.verdict;
        finalInspection = inspection;
        if (!canRefine) {
          exhausted =
            inspection.verdict === "fix" &&
            inspection.patch.kind !== "none" &&
            iteration >= this.config.WORKFLOW_MAX_ITERATIONS;
          break;
        }

        project = await this.stage(project, "refining");
        const nextRevision = currentScene.revision + 1;
        if (inspection.patch.kind === "asset-regenerate") {
          plan = applyAssetRegeneration(plan, inspection.patch);
          resolved = await this.resolveAssets(project, plan, nextRevision);
          currentScene = applyResolvedAssets(currentScene, plan, resolved);
          await Promise.all([
            this.artifacts.writeJson(`${relativeRoot}/plan/scene-plan.json`, plan),
            this.artifacts.writeJson(
              `${relativeRoot}/plan/scene-plan-revision-${padRevision(nextRevision)}.json`,
              plan,
            ),
            this.artifacts.writeJson(`${relativeRoot}/assets/index.json`, [...resolved.values()]),
            this.artifacts.writeJson(
              `${relativeRoot}/assets/index-revision-${padRevision(nextRevision)}.json`,
              [...resolved.values()],
            ),
          ]);
        } else {
          currentScene = applyQaPatch(currentScene, inspection.patch);
        }
        refinements += 1;
        currentSpatial = analyzeSpatial(plan, currentScene, resolved);
        [currentManifest] = await Promise.all([
          this.storeScene(project, currentScene),
          this.artifacts.writeJson(
            `${relativeRoot}/qa/spatial-revision-${padRevision(currentScene.revision)}.json`,
            currentSpatial,
          ),
          this.context.storeSpatial(project.projectId, currentScene.revision, currentSpatial),
        ]);
        await this.emit(project, "refining", "completed", {
          iteration,
          revision: currentScene.revision,
          patch: inspection.patch.kind,
          spatialIssues: currentSpatial.issues.length,
        });

        project = await this.stage(project, "rendering_final");
        const renderPath = path.join(project.root, "renders", `revision-${padRevision(currentScene.revision)}.png`);
        currentRender = await this.renderScene(
          project,
          currentScene,
          currentManifest,
          renderPath,
          `${relativeRoot}/renders/revision-${padRevision(currentScene.revision)}.png`,
          "final",
        );
        await this.emit(project, "rendering_final", "completed", {
          iteration,
          revision: currentScene.revision,
          cacheHit: currentRender.cacheHit,
          browserErrors: currentRender.capture.browserErrors,
        });
      }

      if (currentScene.revision === 1) {
        await this.context.storeRender(project.projectId, 1, initialRender.path, initialRender.sha256, "final");
      }
      if (!finalInspection) throw new Error("Workflow completed without inspecting its final render");
      project = await this.projects.update(project, {
        status: options.interactive ? "awaiting_feedback" : "completed",
        finalRevision: currentScene.revision,
        finalQaVerdict: finalVerdict,
        qaExhausted: exhausted,
      });
      await this.emit(project, options.interactive ? "awaiting_feedback" : "completed", options.interactive ? "started" : "completed", {
        revision: currentScene.revision,
        refinements,
        finalVerdict,
        exhausted,
      });
      return {
        project,
        research,
        plan,
        initialScene,
        finalScene: currentScene,
        finalInspection,
        qaExhausted: exhausted,
        viewerUrl: this.viewerUrl(currentManifest.url),
      };
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      project = await this.projects.update(project, { status: "failed", error: message });
      await this.emit(project, "failed", "failed", { error: message });
      throw error;
    } finally {
      this.sequences.delete(project.runId);
    }
  }

  private async resolveAssets(
    project: ProjectRecord,
    plan: ScenePlan,
    revision: number,
  ): Promise<Map<string, ResolvedAsset>> {
    const results = new Map<string, ResolvedAsset>();
    const relativeRoot = this.projects.relativeRoot(project);
    const lookups = plan.assets.map((spec) => ({
      spec,
      assetKey: hashObject({ spec, generator: this.blender.identity, schema: "asset-v2" }),
    }));
    const candidates = await this.context.findAssets(lookups, 8);
    const validation = new Map<string, Promise<AssetGeometry | null>>();
    const inspect = (record: AssetRecord): Promise<AssetGeometry | null> => {
      const key = `${record.resolved.path}:${record.resolved.sha256}`;
      const existing = validation.get(key);
      if (existing) return existing;
      const pending = inspectCachedGlb(record.resolved);
      validation.set(key, pending);
      return pending;
    };
    const recordsToStore: AssetRecord[] = [];
    const missing: typeof lookups = [];

    await Promise.all(
      lookups.map(async (lookup) => {
        const available = candidates.get(lookup.assetKey);
        const possible = [available?.exact ?? null, ...(available?.related ?? [])].filter(
          (candidate): candidate is AssetRecord =>
            candidate !== null &&
            candidate.resolved.generator === this.blender.identity &&
            (candidate.resolved.assetKey === lookup.assetKey ||
              isMetadataCompatible(lookup.spec, candidate.spec)),
        );
        const measured = await Promise.all(possible.map(inspect));
        const cachedIndex = possible.findIndex((candidate, index) => {
          const geometry = measured[index];
          if (!geometry) return false;
          return candidate.resolved.assetKey === lookup.assetKey ||
            isCompatibleMeasuredAsset(lookup.spec, { ...candidate, resolved: { ...candidate.resolved, geometry } });
        });
        const cached = cachedIndex >= 0 ? possible[cachedIndex] : undefined;
        const geometry = cachedIndex >= 0 ? measured[cachedIndex] : undefined;
        if (!cached || !geometry) {
          missing.push(lookup);
          return;
        }

        const projectKey = `${relativeRoot}/assets/reused/revision-${padRevision(revision)}/${lookup.spec.id}.glb`;
        const projectArtifact = await this.artifacts.copyFile(projectKey, cached.resolved.path);
        const libraryResolved: ResolvedAsset = {
          ...cached.resolved,
          assetKey: lookup.assetKey,
          specId: lookup.spec.id,
          reused: true,
          geometry,
        };
        results.set(lookup.spec.id, {
          ...libraryResolved,
          path: projectArtifact.path,
          url: projectArtifact.url,
        });
        recordsToStore.push({ spec: lookup.spec, resolved: libraryResolved, createdAt: new Date().toISOString() });
      }),
    );
    const lookupOrder = new Map(lookups.map((lookup, index) => [lookup.spec.id, index]));
    missing.sort((left, right) =>
      (lookupOrder.get(left.spec.id) ?? Number.MAX_SAFE_INTEGER) -
      (lookupOrder.get(right.spec.id) ?? Number.MAX_SAFE_INTEGER),
    );

    if (missing.length > 0) {
      await this.emit(project, "generating_assets", "started", {
        count: missing.length,
        specIds: missing.map(({ spec }) => spec.id),
      });
      const outputs = await this.blender.generateMany(
        missing.map(({ spec }) => ({
          spec,
          outputPath: this.artifacts.absolutePath(
            `${relativeRoot}/assets/generated/revision-${padRevision(revision)}/${spec.id}.glb`,
          ),
        })),
      );
      if (outputs.length !== missing.length) {
        throw new Error(`Blender returned ${outputs.length} assets for ${missing.length} requests`);
      }
      await Promise.all(
        missing.map(async ({ spec, assetKey }, index) => {
          const output = outputs[index];
          if (!output) throw new Error(`Blender returned no output for ${spec.id}`);
          const generatedKey = `${relativeRoot}/assets/generated/revision-${padRevision(revision)}/${spec.id}.glb`;
          const projectArtifact = await artifactFromExisting(output.path, generatedKey, this.artifacts);
          const geometry = await measureGlbGeometry(projectArtifact.path);
          const libraryKey = `library/assets/${assetKey}/model.glb`;
          const libraryArtifact = await this.artifacts.copyFile(libraryKey, projectArtifact.path);
          const libraryResolved: ResolvedAsset = {
            assetId: assetKey.slice(0, 24),
            assetKey,
            specId: spec.id,
            path: libraryArtifact.path,
            url: libraryArtifact.url,
            sha256: libraryArtifact.sha256,
            reused: false,
            generator: output.generator,
            geometry,
            metadata: output.metadata,
          };
          recordsToStore.push({ spec, resolved: libraryResolved, createdAt: new Date().toISOString() });
          results.set(spec.id, { ...libraryResolved, path: projectArtifact.path, url: projectArtifact.url });
          await this.artifacts.writeJson(`library/assets/${assetKey}/metadata.json`, {
            spec,
            resolved: libraryResolved,
          });
        }),
      );
      await this.emit(project, "generating_assets", "completed", {
        count: missing.length,
        specIds: missing.map(({ spec }) => spec.id),
      });
    }
    recordsToStore.sort((left, right) => left.spec.id.localeCompare(right.spec.id));
    await this.context.storeAssets(recordsToStore);
    return new Map(
      plan.assets.map((spec) => {
        const resolved = results.get(spec.id);
        if (!resolved) throw new Error(`Asset resolution produced no result for ${spec.id}`);
        return [spec.id, resolved];
      }),
    );
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
  ): Promise<{
    artifact: StoredArtifact;
    capture: { path: string; browserErrors: string[] };
    cacheHit: boolean;
  }> {
    const cacheKey = hashObject({
      scene: canonicalSceneForQa(scene),
      renderer: RENDERER_CACHE_IDENTITY,
      capture: this.screenshots.identity,
      schema: "render-v1",
    });
    const cached = CachedRenderSchema.safeParse(await this.context.findCachedStep(cacheKey));
    const cacheHit =
      cached.success &&
      cached.data.browserErrors.length === 0 &&
      (await validFile(cached.data.path, cached.data.sha256));
    const capture = cacheHit
      ? { path: outputPath, browserErrors: cached.data.browserErrors }
      : await this.screenshots.capture(this.viewerUrl(manifest.url), outputPath);
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

  private viewerUrl(manifestUrl: string): string {
    return `${this.config.PUBLIC_BASE_URL.replace(/\/$/, "")}/viewer/?manifest=${encodeURIComponent(manifestUrl)}`;
  }

  private async stage(project: ProjectRecord, stage: WorkflowStage): Promise<ProjectRecord> {
    const next = await this.projects.markStage(project, stage);
    await this.emit(next, stage, "started", {});
    return next;
  }

  private async emit(
    project: ProjectRecord,
    stage: WorkflowStage,
    status: RunEvent["status"],
    detail: Record<string, unknown>,
  ): Promise<void> {
    const sequence = this.sequences.get(project.runId) ?? 0;
    this.sequences.set(project.runId, sequence + 1);
    const event: RunEvent = {
      projectId: project.projectId,
      runId: project.runId,
      sequence,
      stage,
      status,
      detail,
      createdAt: new Date().toISOString(),
    };
    await this.projects.writeEvent(project, event);
    await this.context.appendEvent(event);
  }
}

async function inspectCachedGlb(asset: ResolvedAsset): Promise<AssetGeometry | null> {
  try {
    const buffer = await fs.readFile(asset.path);
    if (buffer.length <= 20 || sha256(buffer) !== asset.sha256) return null;
    return measureGlbBuffer(buffer);
  } catch {
    return null;
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

function renderResearchNotes(research: ResearchBrief): string {
  return `# ${research.concept}\n\n${research.summary}\n\n## Visual notes\n\n${research.visualNotes.map((note) => `- ${note}`).join("\n")}\n\n## Object notes\n\n${research.objectNotes.map((note) => `- ${note}`).join("\n")}\n\n## Sources\n\n${research.sources.map((source) => `- [${source.title}](${source.url}) — ${source.note}`).join("\n")}\n`;
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
  return {
    ...stable,
    objects: stable.objects.map(({ url: _url, ...object }) => object),
  };
}

function canonicalSpatialForQa(report: SpatialReport): unknown {
  const { sceneRevision: _sceneRevision, generatedAt: _generatedAt, ...stable } = report;
  return stable;
}

export function validatePlanAgainstDossier(plan: ScenePlan, dossier?: ResearchDossier): void {
  if (!dossier) return;
  const studyIds = new Set(dossier.objectStudies.map((study) => study.id));
  const assetIds = new Set(plan.assets.map((asset) => asset.id));
  const unresearched = plan.assets.map((asset) => asset.id).filter((id) => !studyIds.has(id));
  if (unresearched.length > 0) {
    throw new Error(`Scene plan introduced assets without approved object studies: ${unresearched.join(", ")}`);
  }
  const uncovered = [...new Set(dossier.intentCoverage.flatMap((coverage) => coverage.objectStudyIds))]
    .filter((id) => !assetIds.has(id));
  if (uncovered.length > 0) {
    throw new Error(`Scene plan omitted approved intent-covering assets: ${uncovered.join(", ")}`);
  }
}

function isMetadataCompatible(
  requested: ScenePlan["assets"][number],
  candidate: ScenePlan["assets"][number],
): boolean {
  if (requested.category.toLowerCase() !== candidate.category.toLowerCase()) return false;
  if (requested.style.toLowerCase() !== candidate.style.toLowerCase()) return false;
  const candidateTags = new Set(candidate.tags.map((tag) => tag.toLowerCase()));
  const overlap = requested.tags.filter((tag) => candidateTags.has(tag.toLowerCase())).length;
  return overlap >= Math.min(2, requested.tags.length);
}

function isCompatibleMeasuredAsset(requested: ScenePlan["assets"][number], candidate: AssetRecord): boolean {
  if (!candidate.resolved.geometry || !isMetadataCompatible(requested, candidate.spec)) return false;
  const expected = recipeBounds(requested);
  const expectedSize = boundsSize(expected);
  const actual = candidate.resolved.geometry.bounds;
  const actualSize = candidate.resolved.geometry.size;
  return expectedSize.every((dimension, axis) => {
    const other = actualSize[axis] ?? 0;
    if (dimension <= 0.0001 || other <= 0.0001) return Math.abs(dimension - other) <= 0.01;
    const ratio = other / dimension;
    const anchorTolerance = Math.max(0.05, dimension * 0.2);
    return ratio >= 0.8 && ratio <= 1.25 &&
      Math.abs(actual.min[axis]! - expected.min[axis]!) <= anchorTolerance &&
      Math.abs(actual.max[axis]! - expected.max[axis]!) <= anchorTolerance;
  });
}

export function isCompatibleAssetForGenerator(
  requested: ScenePlan["assets"][number],
  candidate: AssetRecord,
  generatorIdentity: string,
): boolean {
  return candidate.resolved.generator === generatorIdentity && isCompatibleMeasuredAsset(requested, candidate);
}
