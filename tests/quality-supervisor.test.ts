import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeterministicWorkflowAI, type QaInspectionContext } from "../src/ai/workflow-ai.js";
import { createAppServices } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { MemoryContextStore } from "../src/context/context-store.js";
import type { Inspection, SceneManifest, SpatialReport } from "../src/contracts.js";
import { ReferenceCollector } from "../src/research/reference-collector.js";
import { createInitialGraphState, transitionGraphState } from "../src/workflow/graph-state.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

function scoredAssessment(
  pass: boolean,
  action: "pass" | "direct-fix" | "targeted-research" | "partial-replan" = pass ? "pass" : "direct-fix",
) {
  return {
    recognizabilityScore: pass ? 0.95 : 0.32,
    domainFidelityScore: pass ? 0.94 : 0.44,
    visualQualityScore: pass ? 0.9 : 0.62,
    constructionCompletenessScore: pass ? 0.96 : 0.82,
    confidence: 0.96,
    failedCriteria: pass ? [] : ["The subject is not recognizable without its label."],
    strengths: pass ? ["The subject silhouette and domain landmarks are recognizable."] : ["The scene renders."],
    recommendedAction: action,
    targetStudyIds: pass ? [] : ["subject"],
    researchQuestions: pass ? [] : ["Which silhouette and component landmarks make this subject identifiable?"],
    rationale: pass ? "All scored gates pass." : "Identity evidence is inadequate and needs targeted recovery.",
  };
}

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

function testConfig(root: string, overrides: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: "test",
    DATA_ROOT: root,
    PUBLIC_BASE_URL: "http://localhost:8787",
    AI_DRIVER: "deterministic",
    REFERENCE_SEARCH_DRIVER: "none",
    CONTEXT_DRIVER: "memory",
    BLENDER_DRIVER: "deterministic",
    SCREENSHOT_DRIVER: "placeholder",
    WORKFLOW_MAX_ITERATIONS: "8",
    WORKFLOW_MAX_RUNTIME_MINUTES: "240",
    WORKFLOW_PROVIDER_RETRIES: "3",
    WORKFLOW_RETRY_BASE_MS: "0",
    ...overrides,
  });
}

describe("autonomous quality supervisor", () => {
  it("uses a short default budget and exposes only surgeon-facing launcher prompts", async () => {
    expect(loadConfig({}).WORKFLOW_MAX_RUNTIME_MINUTES).toBe(30);
    const [markup, client] = await Promise.all([
      fs.readFile(path.join(process.cwd(), "renderer", "index.html"), "utf8"),
      fs.readFile(path.join(process.cwd(), "renderer", "main.ts"), "utf8"),
    ]);

    expect(markup).toContain("SeeIn Surgical Anatomy");
    expect(markup).toContain("Anatomy or procedure");
    expect(markup).toContain("non-patient-specific");
    expect(client).toContain("laparoscopic cholecystectomy");
    expect(`${markup}\n${client}`).not.toMatch(/blacksmith|coral reef|four-stroke engine/i);
  });

  it("rejects a low-recognizability pass, researches the failure, replans, and reinspects", async () => {
    const root = await temporaryRoot("seein-self-heal-");
    class ResearchRecoveryAI extends DeterministicWorkflowAI {
      researchCalls = 0;
      planCalls = 0;
      recoveryPlans = 0;
      inspectionCalls = 0;
      inspectedScreenshots: string[] = [];
      lastInspectionContext: QaInspectionContext | undefined;

      override async research(prompt: string) {
        this.researchCalls += 1;
        return super.research(prompt);
      }

      override async plan(...args: Parameters<DeterministicWorkflowAI["plan"]>) {
        this.planCalls += 1;
        if (args[7]) this.recoveryPlans += 1;
        return super.plan(...args);
      }

      override async inspect(...args: Parameters<DeterministicWorkflowAI["inspect"]>): Promise<Inspection> {
        this.inspectionCalls += 1;
        this.inspectedScreenshots.push(args[1]);
        this.lastInspectionContext = args[4];
        if (this.recoveryPlans > 0) {
          return {
            verdict: "pass",
            category: "none",
            issue: "",
            evidence: "The researched reconstruction now has an identifiable silhouette.",
            patch: { kind: "none" },
            assessment: scoredAssessment(true),
          };
        }
        return {
          // Deliberately contradictory: the model says pass while its own score is low.
          verdict: "pass",
          category: "none",
          issue: "",
          evidence: "Labels are visible, but the shape itself remains generic.",
          patch: { kind: "none" },
          assessment: scoredAssessment(false, "targeted-research"),
        };
      }
    }

    const ai = new ResearchRecoveryAI();
    const services = await createAppServices(testConfig(root), { ai });
    try {
      const result = await services.orchestrator.run("A recognizable medical procedure visualization");

      expect(result.finalScene.revision).toBe(2);
      expect(result.qaCoverage.complete).toBe(true);
      expect(result.qaCoverage.qualityGate?.passed).toBe(true);
      expect(result.qualitySupervisor).toMatchObject({
        status: "complete",
        targetedResearchRounds: 1,
        replans: 1,
      });
      expect(ai.researchCalls).toBe(2);
      expect(ai.planCalls).toBe(2);
      expect(ai.inspectionCalls).toBe(2);
      expect(ai.inspectedScreenshots.every((screenshot) => screenshot.endsWith(".png"))).toBe(true);
      expect(ai.lastInspectionContext?.requestPrompt).toBe("A recognizable medical procedure visualization");
      expect(ai.lastInspectionContext?.researchBrief.summary).toContain("recognizable medical procedure visualization");
      expect((await services.context.findQualitySupervisorState(result.project.projectId))?.status).toBe("complete");
      expect(await fs.stat(path.join(result.project.root, "quality", "supervisor.json"))).toBeTruthy();
      expect(await fs.stat(path.join(result.project.root, "research", "recovery", "attempt-001.json"))).toBeTruthy();
    } finally {
      await services.orchestrator.close();
    }
  });

  it("detects a repeated repair cycle and escalates to research instead of looping forever", async () => {
    const root = await temporaryRoot("seein-cycle-recovery-");
    class CyclingAI extends DeterministicWorkflowAI {
      recoveryPlans = 0;
      inspections = 0;

      override async plan(...args: Parameters<DeterministicWorkflowAI["plan"]>) {
        if (args[7]) this.recoveryPlans += 1;
        return super.plan(...args);
      }

      override async inspect(_manifest: SceneManifest): Promise<Inspection> {
        this.inspections += 1;
        if (this.recoveryPlans > 0) {
          return {
            verdict: "pass",
            category: "none",
            issue: "",
            evidence: "The escalated reconstruction resolves the repeated failure.",
            patch: { kind: "none" },
            assessment: scoredAssessment(true),
          };
        }
        return {
          verdict: "fix",
          category: "framing",
          issue: "The same generic view still hides the identifying anatomy.",
          evidence: "The same failure is visible again.",
          patch: { kind: "camera", position: [6, 4, 7], target: [0, 1, 0] },
          assessment: {
            ...scoredAssessment(false, "direct-fix"),
            targetStudyIds: [],
            researchQuestions: [],
          },
        };
      }
    }

    const ai = new CyclingAI();
    const services = await createAppServices(testConfig(root), { ai });
    try {
      const result = await services.orchestrator.run("A medical scene with a repeated camera failure");

      expect(result.qaCoverage.complete).toBe(true);
      expect(result.qualitySupervisor.targetedResearchRounds).toBe(1);
      expect(result.qualitySupervisor.replans).toBe(1);
      expect(result.qualitySupervisor.attempt).toBe(2);
      expect(ai.recoveryPlans).toBe(1);
      expect(ai.inspections).toBe(3);
    } finally {
      await services.orchestrator.close();
    }
  });

  it("retries transient inspection failures without losing the autonomous run", async () => {
    const root = await temporaryRoot("seein-provider-retry-");
    class FlakyInspectionAI extends DeterministicWorkflowAI {
      calls = 0;

      override async inspect(
        _manifest: SceneManifest,
        _screenshotPath: string,
        _spatial?: SpatialReport,
      ): Promise<Inspection> {
        this.calls += 1;
        if (this.calls < 3) throw new Error("Transient Gemini transport failure");
        return {
          verdict: "pass",
          category: "none",
          issue: "",
          evidence: "The third provider attempt completed the assessment.",
          patch: { kind: "none" },
          assessment: scoredAssessment(true),
        };
      }
    }

    const ai = new FlakyInspectionAI();
    const services = await createAppServices(testConfig(root), { ai });
    try {
      const result = await services.orchestrator.run("A provider retry fixture");

      expect(result.project.status).toBe("completed");
      expect(result.qaCoverage.complete).toBe(true);
      expect(ai.calls).toBe(3);
      expect(result.qualitySupervisor.logicalAiCalls).toBe(3);
    } finally {
      await services.orchestrator.close();
    }
  });

  it("resumes a quality-blocked graph with a fresh inspection session and preserved checkpoints", async () => {
    const root = await temporaryRoot("seein-supervisor-resume-");
    class ResumableAI extends DeterministicWorkflowAI {
      accept = false;
      inspections = 0;
      inspectionContexts: QaInspectionContext[] = [];

      override async inspect(...args: Parameters<DeterministicWorkflowAI["inspect"]>): Promise<Inspection> {
        const [manifest] = args;
        this.inspections += 1;
        if (args[4]) this.inspectionContexts.push(args[4]);
        if (this.accept) {
          return {
            verdict: "pass",
            category: "none",
            issue: "",
            evidence: "The resumed inspector verifies the repaired scene.",
            patch: { kind: "none" },
            assessment: scoredAssessment(true),
          };
        }
        return {
          verdict: "fix",
          category: "framing",
          issue: "The current run remains below the recognizability threshold.",
          evidence: `Unresolved revision ${manifest.revision}.`,
          patch: { kind: "camera", position: [6 + manifest.revision, 4, 7], target: [0, 1, 0] },
          assessment: scoredAssessment(false, "direct-fix"),
        };
      }
    }

    const ai = new ResumableAI();
    const config = testConfig(root, { WORKFLOW_MAX_ITERATIONS: "2" });
    const references = new (class extends ReferenceCollector {
      override async collect() { return []; }
    })(config);
    const services = await createAppServices(config, { ai, references });
    try {
      const project = await services.orchestrator.start("A resumable medical quality fixture");
      await services.orchestrator.getActiveRun(project.projectId);
      const clarification = await services.orchestrator.getGraphState(project.projectId);
      await services.orchestrator.answerClarifications(project.projectId, {
        answers: clarification!.clarification!.questions.map((question) => ({
          questionId: question.id,
          answer: "Surgical trainees; reference-faithful anatomy and an orientation-to-operative-view sequence.",
        })),
      });
      await services.orchestrator.getActiveRun(project.projectId);
      await services.orchestrator.decideResearch(project.projectId, { decision: "approve", feedback: "" });
      await services.orchestrator.getActiveRun(project.projectId);

      const blocked = await services.orchestrator.getGraphState(project.projectId);
      expect(blocked?.currentNode).toBe("quality-blocked");
      expect(blocked?.qualitySupervisor?.status).toBe("action-exhausted");
      expect(ai.inspectionContexts[0]?.approvedIntent?.audience).toContain("Surgical trainees");
      expect(ai.inspectionContexts[0]?.objectStudies.map((study) => study.name)).toContain("Target anatomy");
      const inspectionsBeforeResume = ai.inspections;

      ai.accept = true;
      await services.orchestrator.resume(project.projectId);
      await services.orchestrator.getActiveRun(project.projectId);
      const resumed = await services.orchestrator.getGraphState(project.projectId);

      expect(resumed?.currentNode).toBe("await-feedback");
      expect(resumed?.qualitySupervisor?.status).toBe("complete");
      expect(ai.inspections).toBe(inspectionsBeforeResume + 1);
      expect(resumed?.resumeCount).toBe(1);
      expect((await fs.readdir(path.join(project.root, "quality", "checkpoints"))).length).toBeGreaterThan(1);
    } finally {
      await services.orchestrator.close();
    }
  });

  it("automatically recovers an orphaned running checkpoint after backend restart", async () => {
    const root = await temporaryRoot("seein-auto-resume-");
    const context = new MemoryContextStore();
    const firstConfig = testConfig(root, { WORKFLOW_AUTO_RESUME_INTERRUPTED: "false" });
    const first = await createAppServices(firstConfig, { context });
    const project = await first.projects.create("An interrupted medical visualization", "test-user");
    const profile = { userId: "test-user", preferences: [], updatedAt: new Date().toISOString() };
    const initial = createInitialGraphState(project, "test-user", profile);
    const running = transitionGraphState(
      initial,
      "clarify-intent",
      "running",
      "The worker stopped while preparing clarification.",
    );
    await context.storeGraphState(running);
    const checkpointDirectory = path.join(project.root, "graph", "checkpoints");
    await fs.mkdir(checkpointDirectory, { recursive: true });
    await fs.writeFile(
      path.join(checkpointDirectory, "0001-clarify-intent.json"),
      `${JSON.stringify(running)}\n`,
    );
    await first.orchestrator.close();

    const secondConfig = testConfig(root, { WORKFLOW_AUTO_RESUME_INTERRUPTED: "true" });
    const second = await createAppServices(secondConfig, { context });
    try {
      await second.orchestrator.getActiveRun(project.projectId);
      const recovered = await second.orchestrator.getGraphState(project.projectId);

      expect(recovered?.currentNode).toBe("await-clarification");
      expect(recovered?.status).toBe("waiting");
      expect(recovered?.resumeCount).toBe(1);
    } finally {
      await second.orchestrator.close();
    }
  });
});
