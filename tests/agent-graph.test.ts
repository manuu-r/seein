import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeterministicWorkflowAI } from "../src/ai/workflow-ai.js";
import { createAppServices } from "../src/app.js";
import { DeterministicBlenderDriver, type BlenderRequest } from "../src/blender/blender-driver.js";
import { loadConfig } from "../src/config.js";
import { ReferenceCollector } from "../src/research/reference-collector.js";
import {
  AgentNoteSchema,
  NOTE_SOURCE_MAX_LENGTH,
  NOTE_TEXT_MAX_LENGTH,
  type ResearchPerspective,
  type ResearchPerspectiveResult,
} from "../src/workflow/graph-contracts.js";
import { createNote, evaluateResearchReadiness, resumeStageFor } from "../src/workflow/graph-state.js";
import { validatePlanAgainstDossier } from "../src/workflow/orchestrator.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("interactive agent graph", () => {
  it("pauses for clarification, fans research out, and gates generation on evidence approval", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "seein-agent-graph-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      DATA_ROOT: root,
      PUBLIC_BASE_URL: "http://localhost:8787",
      AI_DRIVER: "deterministic",
      REFERENCE_SEARCH_DRIVER: "none",
      CONTEXT_DRIVER: "memory",
      BLENDER_DRIVER: "deterministic",
      SCREENSHOT_DRIVER: "placeholder",
      WORKFLOW_PROVIDER_RETRIES: "1",
      WORKFLOW_RETRY_BASE_MS: "0",
    });
    class ConcurrentResearchAI extends DeterministicWorkflowAI {
      active = 0;
      maxActive = 0;
      calls = 0;
      referenceCalls = 0;

      override async researchPerspective(
        intent: Parameters<DeterministicWorkflowAI["researchPerspective"]>[0],
        perspective: ResearchPerspective,
      ): Promise<ResearchPerspectiveResult> {
        this.calls += 1;
        this.active += 1;
        this.maxActive = Math.max(this.maxActive, this.active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        try {
          return await super.researchPerspective(intent, perspective);
        } finally {
          this.active -= 1;
        }
      }

      override async researchReferences(
        intent: Parameters<DeterministicWorkflowAI["researchReferences"]>[0],
        agenda: Parameters<DeterministicWorkflowAI["researchReferences"]>[1],
      ) {
        this.referenceCalls += 1;
        this.active += 1;
        this.maxActive = Math.max(this.maxActive, this.active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        try {
          return await super.researchReferences(intent, agenda);
        } finally {
          this.active -= 1;
        }
      }
    }
    class CountingBlender extends DeterministicBlenderDriver {
      batches: BlenderRequest[][] = [];
      override async generateMany(requests: BlenderRequest[]) {
        this.batches.push(requests);
        return super.generateMany(requests);
      }
    }
    const ai = new ConcurrentResearchAI();
    const blender = new CountingBlender();
    const references = new (class extends ReferenceCollector {
      override async collect() { return []; }
    })(config);
    const services = await createAppServices(config, { ai, blender, references });
    try {
      const project = await services.orchestrator.start("A cutaway educational steam engine", "test-user");
      await services.orchestrator.getActiveRun(project.projectId);
      const clarification = await services.orchestrator.getGraphState(project.projectId);
      expect(clarification?.currentNode).toBe("await-clarification");
      expect(clarification?.waitingFor).toBe("clarification");
      expect(blender.batches).toHaveLength(0);

      await services.orchestrator.answerClarifications(project.projectId, {
        answers: [
          { questionId: "audience-purpose", answer: "Engineering students; explain energy transfer." },
          { questionId: "accuracy-style", answer: "Reference-faithful overall proportions." },
        ],
        additionalContext: "Use a readable overview before the cutaway focus.",
      });
      await services.orchestrator.getActiveRun(project.projectId);
      const researched = await services.orchestrator.getGraphState(project.projectId);
      expect(ai.calls).toBe(3);
      expect(ai.referenceCalls).toBe(1);
      expect(ai.maxActive).toBe(4);
      expect(researched?.currentNode).toBe("await-research-approval");
      expect(researched?.researchDossier?.readiness.decision).toBe("ready");
      expect(researched?.researchDossier?.objectStudies).toHaveLength(3);
      expect(researched?.researchDossier?.intentCoverage).toHaveLength(3);
      expect(blender.batches).toHaveLength(0);
      expect(await fs.stat(path.join(project.root, "research", "dossier.json"))).toBeTruthy();
      expect(await fs.stat(path.join(project.root, "research", "reference-discovery.json"))).toBeTruthy();

      await services.orchestrator.decideResearch(project.projectId, { decision: "approve", feedback: "" });
      await services.orchestrator.getActiveRun(project.projectId);
      const awaitingFeedback = await services.orchestrator.getGraphState(project.projectId);
      expect(awaitingFeedback?.currentNode).toBe("await-feedback");
      expect(awaitingFeedback?.finalInspection?.verdict).toBe("pass");
      expect(blender.batches.length).toBeGreaterThan(0);

      const accepted = await services.orchestrator.submitFeedback(project.projectId, {
        decision: "accept",
        categories: [],
        objectIds: [],
        comment: "The overview-first sequence is right.",
        preferences: [{ key: "overview-order", value: "Overview before component focus" }],
      });
      expect(accepted.state.currentNode).toBe("completed");
      expect((await services.context.findUserPreferenceProfile("test-user"))?.preferences).toEqual(
        expect.arrayContaining([expect.objectContaining({ key: "overview-order" })]),
      );
    } finally {
      await services.orchestrator.close();
    }
  });

  it("rejects incomplete clarification and preserves the waiting checkpoint", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "seein-agent-wait-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      DATA_ROOT: root,
      PUBLIC_BASE_URL: "http://localhost:8787",
      AI_DRIVER: "deterministic",
      REFERENCE_SEARCH_DRIVER: "none",
      CONTEXT_DRIVER: "memory",
      BLENDER_DRIVER: "deterministic",
      SCREENSHOT_DRIVER: "placeholder",
    });
    const services = await createAppServices(config);
    try {
      const project = await services.orchestrator.start("A guided telescope visualization");
      await services.orchestrator.getActiveRun(project.projectId);
      await expect(services.orchestrator.answerClarifications(project.projectId, {
        answers: [{ questionId: "audience-purpose", answer: "Museum visitors" }],
      })).rejects.toThrow("Missing required clarification answers");
      expect((await services.orchestrator.getGraphState(project.projectId))?.currentNode).toBe("await-clarification");
    } finally {
      await services.orchestrator.close();
    }
  });

  it("propagates branch uncertainty and rejects planner assets absent from the dossier", async () => {
    const ai = new DeterministicWorkflowAI();
    const profile = { userId: "guard-test", preferences: [], updatedAt: new Date().toISOString() };
    const clarification = await ai.clarify("A documented waterwheel", profile);
    const prepared = await ai.prepareIntent(
      "A documented waterwheel",
      clarification,
      clarification.questions.map((question) => ({ questionId: question.id, answer: "Reference-faithful students" })),
      "",
      profile,
    );
    const perspectives = await Promise.all(
      prepared.agenda.perspectives.map((perspective) => ai.researchPerspective(prepared.intent, perspective)),
    );
    const draft = await ai.synthesizeResearch(prepared.intent, perspectives);
    const ready = evaluateResearchReadiness(prepared.intent, perspectives, draft);
    expect(ready.readiness.decision).toBe("ready");

    const uncertainPerspectives = structuredClone(perspectives);
    uncertainPerspectives[0]!.unansweredQuestions.push("The canonical blade count is unresolved.");
    const uncertain = evaluateResearchReadiness(prepared.intent, uncertainPerspectives, draft);
    expect(uncertain.readiness.decision).toBe("needs-research");
    expect(uncertain.unresolvedQuestions).toContain("The canonical blade count is unresolved.");

    const plan = await ai.plan("A documented waterwheel", ready.brief, 8, prepared.intent, ready);
    const rogue = structuredClone(plan);
    rogue.assets.push({ ...structuredClone(rogue.assets[0]!), id: "unresearched-decoration" });
    expect(() => validatePlanAgainstDossier(rogue, ready)).toThrow("without approved object studies");
  });

  it("clamps oversized note text and source so long citations cannot fail state validation", () => {
    const longUrl = `https://example.com/reference?q=${"a".repeat(NOTE_SOURCE_MAX_LENGTH)}`;
    const longText = "identity marker. ".repeat(NOTE_TEXT_MAX_LENGTH);

    const note = createNote("research-finding", longText, longUrl);

    expect(note.source.length).toBe(NOTE_SOURCE_MAX_LENGTH);
    expect(note.text.length).toBe(NOTE_TEXT_MAX_LENGTH);
    expect(() => AgentNoteSchema.parse(note)).not.toThrow();
  });

  it("rewinds a failed run to its last successful checkpoint and restarts from there", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "seein-agent-resume-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      DATA_ROOT: root,
      PUBLIC_BASE_URL: "http://localhost:8787",
      AI_DRIVER: "deterministic",
      REFERENCE_SEARCH_DRIVER: "none",
      CONTEXT_DRIVER: "memory",
      BLENDER_DRIVER: "deterministic",
      SCREENSHOT_DRIVER: "placeholder",
      WORKFLOW_PROVIDER_RETRIES: "1",
      WORKFLOW_RETRY_BASE_MS: "0",
    });

    class FlakySynthesisAI extends DeterministicWorkflowAI {
      failSynthesis = true;
      perspectiveCalls = 0;

      override async researchPerspective(
        intent: Parameters<DeterministicWorkflowAI["researchPerspective"]>[0],
        perspective: ResearchPerspective,
      ): Promise<ResearchPerspectiveResult> {
        this.perspectiveCalls += 1;
        return super.researchPerspective(intent, perspective);
      }

      override async synthesizeResearch(
        ...params: Parameters<DeterministicWorkflowAI["synthesizeResearch"]>
      ): ReturnType<DeterministicWorkflowAI["synthesizeResearch"]> {
        if (this.failSynthesis) throw new Error("synthesis exploded");
        return super.synthesizeResearch(...params);
      }
    }

    const ai = new FlakySynthesisAI();
    const services = await createAppServices(config, { ai });
    try {
      const project = await services.orchestrator.start("A cutaway educational steam engine", "test-user");
      await services.orchestrator.getActiveRun(project.projectId);
      await services.orchestrator.answerClarifications(project.projectId, {
        answers: [
          { questionId: "audience-purpose", answer: "Engineering students; explain energy transfer." },
          { questionId: "accuracy-style", answer: "Reference-faithful overall proportions." },
        ],
        additionalContext: "",
      });
      await services.orchestrator.getActiveRun(project.projectId);

      const failed = await services.orchestrator.getGraphState(project.projectId);
      expect(failed?.currentNode).toBe("failed");
      expect(failed?.failedNode).toBe("synthesize-research");
      expect(failed?.failureMessage).toContain("synthesis exploded");
      const perspectiveCallsBeforeResume = ai.perspectiveCalls;
      expect(perspectiveCallsBeforeResume).toBeGreaterThan(0);

      // The bug is fixed; the run should pick up from the last good node.
      ai.failSynthesis = false;
      const resumed = await services.orchestrator.resume(project.projectId);
      expect(resumed.resumeCount).toBe(1);
      expect(resumed.status).toBe("running");
      expect(resumed.failedNode).toBeUndefined();
      expect(resumeStageFor(resumed.currentNode)).toBe("research");

      await services.orchestrator.getActiveRun(project.projectId);
      const recovered = await services.orchestrator.getGraphState(project.projectId);
      expect(recovered?.failureMessage ?? "").toBe("");
      expect(recovered?.currentNode).toBe("await-research-approval");
      expect(recovered?.researchDossier?.objectStudies).toHaveLength(3);
      // Cached perspectives were replayed rather than regenerated.
      expect(ai.perspectiveCalls).toBe(perspectiveCallsBeforeResume);

      // Any stage-owned checkpoint is selectable, including mid-stage ones.
      const checkpoints = await services.orchestrator.listCheckpoints(project.projectId);
      expect(checkpoints[0]!.sequence).toBeGreaterThan(checkpoints.at(-1)!.sequence);
      const midStage = checkpoints.find((entry) => entry.node === "synthesize-research");
      expect(midStage?.resumable).toBe(true);
      expect(midStage?.stage).toBe("research");
      const waiting = checkpoints.find((entry) => entry.node === "await-research-approval");
      expect(waiting?.resumable).toBe(false);

      const targeted = await services.orchestrator.resume(project.projectId, { sequence: midStage!.sequence });
      // A mid-stage pick re-enters at the stage's legal entry node.
      expect(targeted.currentNode).toBe("plan-research");
      expect(targeted.resumeCount).toBe(2);
      await services.orchestrator.getActiveRun(project.projectId);
      const replayed = await services.orchestrator.getGraphState(project.projectId);
      expect(replayed?.currentNode).toBe("await-research-approval");
      expect(ai.perspectiveCalls).toBe(perspectiveCallsBeforeResume);

      await expect(
        services.orchestrator.resume(project.projectId, { sequence: 9999 }),
      ).rejects.toThrow("No checkpoint at sequence 9999");
      await expect(
        services.orchestrator.resume(project.projectId, { sequence: waiting!.sequence }),
      ).rejects.toThrow("cannot be restarted automatically");
    } finally {
      await services.orchestrator.close();
    }
  });
});
