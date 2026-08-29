import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeterministicWorkflowAI, type QaInspectionContext } from "../src/ai/workflow-ai.js";
import { createAppServices } from "../src/app.js";
import { DeterministicBlenderDriver, type BlenderRequest } from "../src/blender/blender-driver.js";
import { loadConfig } from "../src/config.js";
import {
  ScenePlanSchema,
  type Inspection,
  type ResearchBrief,
  type SceneManifest,
  type ScenePlan,
} from "../src/contracts.js";
import { MemoryContextStore } from "../src/context/context-store.js";
import { PlaceholderScreenshotDriver } from "../src/render/screenshot-driver.js";
import { applyQaPatch, assembleScene } from "../src/scene/scene-assembler.js";
import { analyzeSpatial } from "../src/scene/spatial-analyzer.js";
import { buildQaTargets } from "../src/workflow/orchestrator.js";

const temporaryDirectories: string[] = [];

const assessment = (pass: boolean) => ({
  recognizabilityScore: pass ? 1 : 0.65,
  domainFidelityScore: pass ? 1 : 0.7,
  visualQualityScore: pass ? 1 : 0.6,
  constructionCompletenessScore: pass ? 1 : 0.85,
  confidence: 1,
  failedCriteria: pass ? [] : ["The procedural fixture needs repair."],
  strengths: pass ? ["All procedural fixture gates pass."] : [],
  recommendedAction: pass ? "pass" as const : "direct-fix" as const,
  targetStudyIds: [],
  researchQuestions: [],
  rationale: pass ? "Target passes." : "Apply the requested node correction.",
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

function proceduralPlan(): ScenePlan {
  return ScenePlanSchema.parse({
    title: "Connected procedural construction",
    rationale: "A deterministic fixture for landmark continuity and multi-view QA.",
    environment: { background: "#101827", groundColor: "#253147", groundSize: 12 },
    camera: { position: [4, 3, 5], target: [0, 0.8, 0], fov: 45 },
    lights: [
      { id: "fill", type: "hemisphere", color: "#dbeafe", intensity: 1.2, position: [0, 5, 0] },
      { id: "key", type: "directional", color: "#fff4df", intensity: 2.5, position: [4, 6, 3] },
    ],
    assets: [],
    objects: [],
    procedural: {
      schemaVersion: "1.0",
      coordinateFrame: {
        name: "fixture-frame",
        units: "centimeters",
        metersPerUnit: 0.01,
        upAxis: "Y",
        handedness: "right",
        originDescription: "Center of the support field.",
      },
      landmarks: [
        { id: "origin", label: "Origin", position: [-20, 8, 0], description: "Start of the parent path." },
        { id: "junction", label: "Junction", position: [0, 12, 0], description: "Shared parent-child endpoint." },
        { id: "target", label: "Target", position: [24, 18, 0], description: "End of the child path." },
      ],
      materials: [
        { id: "path-material", name: "Path", color: "#dc5b5b", roughness: 0.42, metalness: 0 },
      ],
      nodes: [
        {
          id: "parent-path",
          name: "Parent path",
          studyId: "subject",
          tags: ["connected", "parent", "path"],
          materialId: "path-material",
          kind: "tube",
          label: "Parent",
          points: [{ landmarkId: "origin" }, { landmarkId: "junction" }],
          radius: 2.4,
          radialSegments: 10,
          tubularSegments: 24,
        },
        {
          id: "child-path",
          name: "Child path",
          studyId: "subject",
          tags: ["connected", "child", "path"],
          materialId: "path-material",
          kind: "tube",
          label: "Child",
          points: [{ landmarkId: "junction", radius: 2.4 }, { landmarkId: "target", radius: 1.4 }],
          radius: 2,
          radialSegments: 10,
          tubularSegments: 24,
        },
      ],
      views: [
        { id: "overview-view", label: "Overview", purpose: "Whole construction", position: [3, 2, 4], target: [0, 0.12, 0], fov: 45, required: true, stateIds: ["overview", "focus"] },
        { id: "side-view", label: "Side", purpose: "Depth and junction", position: [0, 2, 4], target: [0, 0.12, 0], fov: 38, required: true, stateIds: ["overview", "focus"] },
      ],
      invariants: [
        { id: "joined-path", kind: "continuity", label: "Parent-child continuity", nodeA: "parent-path", endA: "end", nodeB: "child-path", endB: "start", tolerance: 0.1, required: true },
      ],
      triangleBudget: 20_000,
    },
    relationships: [{ from: "child-path", to: "parent-path", type: "part-of", description: "The child continues from the parent." }],
    states: [
      { id: "overview", label: "Overview", objective: "Show the full path.", visibleObjects: [], highlightedObjects: [], visibleNodes: ["parent-path", "child-path"], highlightedNodes: [], mutations: [] },
      { id: "focus", label: "Junction", objective: "Inspect the shared junction.", visibleObjects: [], highlightedObjects: [], visibleNodes: ["parent-path", "child-path"], highlightedNodes: ["child-path"], cameraViewId: "side-view", mutations: [] },
    ],
    transitions: [{ from: "overview", to: "focus", durationMs: 400, kind: "normal", description: "Focus on the junction." }],
  });
}

describe("procedural construction", () => {
  it("measures exact procedural parameters in meters and validates shared endpoints", () => {
    const plan = proceduralPlan();
    const manifest = assembleScene("project", plan, new Map(), 1);
    const report = analyzeSpatial(plan, manifest, new Map(), { stateId: "focus", viewId: "side-view" });

    expect(report.objects).toHaveLength(2);
    expect(report.objects.every((object) => object.geometrySource === "procedural-geometry:v2")).toBe(true);
    expect(report.objects.find((object) => object.objectId === "parent-path")?.bounds.max[0]).toBeLessThan(0.04);
    expect(report.issues.some((issue) => issue.category === "continuity")).toBe(false);
    expect(report.analyzer).toContain("focus:side-view");
  });

  it("moves a shared landmark once and preserves both connected tube endpoints", () => {
    const plan = proceduralPlan();
    const manifest = assembleScene("project", plan, new Map(), 1);
    const moved = applyQaPatch(manifest, {
      kind: "procedural-landmark",
      landmarkId: "junction",
      position: [3, 15, 1],
    });
    const report = analyzeSpatial({ ...plan, procedural: moved.procedural }, moved, new Map());

    expect(moved.revision).toBe(2);
    expect(report.issues.some((issue) => issue.category === "continuity")).toBe(false);
  });

  it("measures the state mutation that the browser applies", () => {
    const plan = proceduralPlan();
    plan.states.find((state) => state.id === "focus")!.mutations = [
      { entityId: "child-path", position: [10, 0, 0] },
    ];
    const manifest = assembleScene("project", plan, new Map(), 1);
    const overview = analyzeSpatial(plan, manifest, new Map(), { stateId: "overview", viewId: "side-view" });
    const focus = analyzeSpatial(plan, manifest, new Map(), { stateId: "focus", viewId: "side-view" });
    const overviewBounds = overview.objects.find((object) => object.objectId === "child-path")!.bounds;
    const focusBounds = focus.objects.find((object) => object.objectId === "child-path")!.bounds;
    const overviewHash = overview.objects.find((object) => object.objectId === "child-path")!.assetSha256;
    const focusHash = focus.objects.find((object) => object.objectId === "child-path")!.assetSha256;

    expect(focusBounds.min[0] - overviewBounds.min[0]).toBeCloseTo(0.1, 5);
    expect(focusHash).not.toBe(overviewHash);
    expect(focus.issues.some((issue) => issue.category === "continuity")).toBe(true);
  });

  it("builds every declared state/view QA target and refuses silent truncation", () => {
    const manifest = assembleScene("project", proceduralPlan(), new Map(), 1);
    expect(buildQaTargets(manifest, 4).map((target) => target.id)).toEqual([
      "state-overview-view-overview-view",
      "state-focus-view-overview-view",
      "state-overview-view-side-view",
      "state-focus-view-side-view",
    ]);
    expect(() => buildQaTargets(manifest, 3)).toThrow(/requires 4 state\/view targets/);
  });

  it("indexes procedural components for reuse by a later plan", async () => {
    const store = new MemoryContextStore();
    const manifest = assembleScene("source-project", proceduralPlan(), new Map(), 1);
    await store.storeScene("source-project", manifest);

    const found = await store.findProceduralComponents(["connected child path"], 4);
    expect(found).toEqual(expect.arrayContaining([
      expect.objectContaining({ node: expect.objectContaining({ id: "child-path" }) }),
    ]));
  });

  it("reruns all required targets after one procedural correction", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "seein-procedural-loop-"));
    temporaryDirectories.push(root);
    const fixture = proceduralPlan();
    class ProceduralAI extends DeterministicWorkflowAI {
      calls: Array<{ revision: number; targetId: string }> = [];

      override async plan(_prompt: string, _research: ResearchBrief, _maxObjects: number): Promise<ScenePlan> {
        return structuredClone(fixture);
      }

      override async inspect(
        manifest: SceneManifest,
        _screenshotPath: string,
        _spatial: undefined,
        _plan: undefined,
        context?: QaInspectionContext,
      ): Promise<Inspection> {
        this.calls.push({ revision: manifest.revision, targetId: context?.targetId ?? "missing" });
        if (manifest.revision === 1) {
          const node = structuredClone(manifest.procedural!.nodes[1]!);
          if (node.kind !== "tube") throw new Error("Fixture node changed kind");
          node.radius = 2.2;
          return {
            verdict: "fix",
            category: "geometry",
            issue: "The child path is too thin.",
            evidence: "The first overview reveals a weak junction.",
            patch: { kind: "procedural-node", nodeId: node.id, node },
            assessment: assessment(false),
          };
        }
        return { verdict: "pass", category: "none", issue: "", evidence: "Target passes.", patch: { kind: "none" }, assessment: assessment(true) };
      }
    }
    class CountingBlender extends DeterministicBlenderDriver {
      batches: BlenderRequest[][] = [];
      override async generateMany(requests: BlenderRequest[]) {
        this.batches.push(requests);
        return super.generateMany(requests);
      }
    }
    class CountingScreenshots extends PlaceholderScreenshotDriver {
      urls: string[] = [];
      override async capture(viewerUrl: string, outputPath: string) {
        this.urls.push(viewerUrl);
        return super.capture(viewerUrl, outputPath);
      }
    }
    const ai = new ProceduralAI();
    const blender = new CountingBlender();
    const screenshots = new CountingScreenshots();
    const config = loadConfig({
      NODE_ENV: "test",
      DATA_ROOT: root,
      PUBLIC_BASE_URL: "http://localhost:8787",
      AI_DRIVER: "deterministic",
      REFERENCE_SEARCH_DRIVER: "none",
      CONTEXT_DRIVER: "memory",
      BLENDER_DRIVER: "deterministic",
      SCREENSHOT_DRIVER: "placeholder",
      WORKFLOW_MAX_ITERATIONS: "3",
    });
    const services = await createAppServices(config, { ai, blender, screenshots });
    try {
      const result = await services.orchestrator.run("A connected procedural fixture");

      expect(result.finalScene.revision).toBe(2);
      expect(result.qaCoverage.complete).toBe(true);
      expect(result.qaCoverage.passedTargetIds).toHaveLength(4);
      expect(ai.calls).toHaveLength(5);
      expect(ai.calls.slice(1).every((call) => call.revision === 2)).toBe(true);
      expect(blender.batches).toHaveLength(0);
      expect(screenshots.urls).toHaveLength(5);
      expect(screenshots.urls.every((url) => url.includes("state=") && url.includes("view="))).toBe(true);
      expect(await fs.stat(path.join(result.project.root, "qa", "coverage-revision-002.json"))).toBeTruthy();
    } finally {
      await services.orchestrator.close();
    }
  });
});
