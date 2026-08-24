import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeterministicWorkflowAI } from "../src/ai/workflow-ai.js";
import { createAppServices } from "../src/app.js";
import { DeterministicBlenderDriver, type BlenderRequest } from "../src/blender/blender-driver.js";
import { loadConfig } from "../src/config.js";
import { ReferenceCollector } from "../src/research/reference-collector.js";
import type { ResearchPerspective, ResearchPerspectiveResult } from "../src/workflow/graph-contracts.js";
import { evaluateResearchReadiness } from "../src/workflow/graph-state.js";
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
      CONTEXT_DRIVER: "memory",
      BLENDER_DRIVER: "deterministic",
      SCREENSHOT_DRIVER: "placeholder",
    });
    class ConcurrentResearchAI extends DeterministicWorkflowAI {
      active = 0;
      maxActive = 0;
      calls = 0;

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
      expect(ai.maxActive).toBe(3);
      expect(researched?.currentNode).toBe("await-research-approval");
      expect(researched?.researchDossier?.readiness.decision).toBe("ready");
      expect(researched?.researchDossier?.objectStudies).toHaveLength(3);
      expect(researched?.researchDossier?.intentCoverage).toHaveLength(3);
      expect(blender.batches).toHaveLength(0);
      expect(await fs.stat(path.join(project.root, "research", "dossier.json"))).toBeTruthy();

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
});
