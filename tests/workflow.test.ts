import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeterministicWorkflowAI } from "../src/ai/workflow-ai.js";
import { createAppServices } from "../src/app.js";
import { DeterministicBlenderDriver, type BlenderRequest } from "../src/blender/blender-driver.js";
import { loadConfig } from "../src/config.js";
import type { AssetRecord } from "../src/context/context-store.js";
import type { AssetSpec, Inspection, ResearchBrief, SceneManifest, SpatialReport } from "../src/contracts.js";
import { PlaceholderScreenshotDriver } from "../src/render/screenshot-driver.js";
import type { IntentFrame } from "../src/workflow/graph-contracts.js";
import { isCompatibleAssetForGenerator } from "../src/workflow/orchestrator.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("bounded local workflow", () => {
  it("never reuses a related asset from an older generator recipe", () => {
    const spec: AssetSpec = {
      id: "platform",
      name: "Platform",
      category: "support",
      description: "A reusable platform",
      tags: ["platform", "support"],
      dimensions: [4, 0.4, 4],
      style: "low-poly",
      parts: [{ name: "base", primitive: "cylinder", size: [4, 0.4, 4], position: [0, 0.2, 0], rotation: [0, 0, 0], color: "#475569", bevel: 0.04 }],
    };
    const candidate: AssetRecord = {
      spec,
      createdAt: new Date(0).toISOString(),
      resolved: {
        assetId: "old",
        assetKey: "old-key",
        specId: spec.id,
        path: "/tmp/old.glb",
        url: "/old.glb",
        sha256: "old-sha",
        reused: false,
        generator: "qwen-mm-blender:bpy-recipe-v1",
        geometry: {
          bounds: { min: [-2, 0, -2], max: [2, 0.4, 2] },
          size: [4, 0.4, 4],
          source: "glb-accessors:v1",
          meshInstances: 1,
        },
        metadata: {},
      },
    };
    expect(isCompatibleAssetForGenerator(spec, candidate, "qwen-mm-blender:bpy-recipe-v2")).toBe(false);
    expect(isCompatibleAssetForGenerator(spec, candidate, "qwen-mm-blender:bpy-recipe-v1")).toBe(true);
    const oversized = structuredClone(candidate);
    oversized.resolved.geometry = {
      bounds: { min: [-4, 0, -2], max: [4, 0.4, 2] },
      size: [8, 0.4, 4],
      source: "glb-accessors:v1",
      meshInstances: 1,
    };
    expect(isCompatibleAssetForGenerator(spec, oversized, "qwen-mm-blender:bpy-recipe-v1")).toBe(false);
  });

  it("runs research through final revision and reuses cached research/assets", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "seein-workflow-"));
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
      const first = await services.orchestrator.run("A labeled blacksmith workshop");
      expect(first.project.status).toBe("completed");
      expect(first.initialScene.revision).toBe(1);
      expect(first.finalScene.revision).toBe(2);
      expect(first.finalScene.camera.position).not.toEqual(first.initialScene.camera.position);
      expect(first.finalScene.objects).toHaveLength(3);
      expect(await fs.stat(path.join(first.project.root, "renders", "revision-002.png"))).toBeTruthy();
      expect((await services.projects.load(first.project.projectId))?.status).toBe("completed");
      expect((await services.context.findLatestScene(first.project.projectId))?.revision).toBe(2);
      expect((await services.context.listEvents(first.project.projectId)).at(-1)?.stage).toBe("completed");
      const firstEvents = await services.context.listEvents(first.project.projectId);
      const inspections = firstEvents.filter((event) => event.stage === "inspecting" && event.status === "completed");
      expect(inspections).toHaveLength(2);
      expect(inspections.at(-1)?.detail.verdict).toBe("pass");

      const second = await services.orchestrator.run("A labeled blacksmith workshop");
      const index = JSON.parse(await fs.readFile(path.join(second.project.root, "assets", "index.json"), "utf8")) as Array<{ reused: boolean }>;
      expect(index.every((asset) => asset.reused)).toBe(true);
      const events = (await fs.readFile(path.join(second.project.root, "logs", "events.ndjson"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { stage: string; detail: Record<string, unknown> });
      expect(events.find((event) => event.stage === "researching" && event.detail.cacheHit === true)).toBeTruthy();
      expect(events.at(-1)?.stage).toBe("completed");
    } finally {
      await services.orchestrator.close();
    }
  });

  it("caches AI phases and skips the second render when inspection passes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "seein-fast-path-"));
    temporaryDirectories.push(root);
    class CountingPassAI extends DeterministicWorkflowAI {
      researchCalls = 0;
      planCalls = 0;
      inspectionCalls = 0;

      override async research(prompt: string) {
        this.researchCalls += 1;
        return super.research(prompt);
      }

      override async plan(prompt: string, research: ResearchBrief, maxObjects: number, intent?: IntentFrame) {
        this.planCalls += 1;
        return super.plan(prompt, research, maxObjects, intent);
      }

      override async inspect(
        _manifest: SceneManifest,
        _screenshotPath: string,
        _spatial?: SpatialReport,
      ): Promise<Inspection> {
        this.inspectionCalls += 1;
        return { verdict: "pass", category: "none", issue: "", evidence: "No obvious issue.", patch: { kind: "none" } };
      }
    }
    class CountingScreenshotDriver extends PlaceholderScreenshotDriver {
      captures = 0;

      override async capture(viewerUrl: string, outputPath: string) {
        this.captures += 1;
        return super.capture(viewerUrl, outputPath);
      }
    }
    const ai = new CountingPassAI();
    const screenshots = new CountingScreenshotDriver();
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
    const services = await createAppServices(config, { ai, screenshots });
    try {
      const first = await services.orchestrator.run("A cached observatory scene");
      expect(first.finalScene.revision).toBe(1);
      expect(screenshots.captures).toBe(1);
      expect(await fs.stat(path.join(first.project.root, "renders", "revision-002.png")).catch(() => null)).toBeNull();

      const second = await services.orchestrator.run("A cached observatory scene");
      expect(second.finalScene.revision).toBe(1);
      expect(ai.researchCalls).toBe(1);
      expect(ai.planCalls).toBe(1);
      expect(ai.inspectionCalls).toBe(1);
      expect(screenshots.captures).toBe(1);
      const events = (await fs.readFile(path.join(second.project.root, "logs", "events.ndjson"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { stage: string; detail: Record<string, unknown> });
      expect(events.find((event) => event.stage === "planning" && event.detail.cacheHit === true)).toBeTruthy();
      expect(events.find((event) => event.stage === "rendering_initial" && event.detail.cacheHit === true)).toBeTruthy();
      expect(events.find((event) => event.stage === "inspecting" && event.detail.cacheHit === true)).toBeTruthy();
      expect(events.find((event) => event.stage === "rendering_final")).toBeUndefined();
    } finally {
      await services.orchestrator.close();
    }
  });

  it("regenerates one bad asset, rerenders it, and inspects the corrected render", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "seein-geometry-loop-"));
    temporaryDirectories.push(root);
    class GeometryRepairAI extends DeterministicWorkflowAI {
      inspectionCalls = 0;

      override async inspect(manifest: SceneManifest): Promise<Inspection> {
        this.inspectionCalls += 1;
        if (manifest.revision > 1) {
          return {
            verdict: "pass",
            category: "none",
            issue: "",
            evidence: "The regenerated asset was rerendered and verified.",
            patch: { kind: "none" },
          };
        }
        return {
          verdict: "fix",
          category: "geometry",
          issue: "The main subject silhouette is wrong.",
          evidence: "The render shows the wrong primitive construction.",
          patch: {
            kind: "asset-regenerate",
            assetSpecId: "subject",
            description: "A corrected wide subject",
            parts: [
              { name: "corrected", primitive: "box", size: [3, 1, 1], position: [0, 0.5, 0], rotation: [0, 0, 0], color: "#f59e0b", bevel: 0.04 },
            ],
          },
        };
      }
    }
    class CountingBlenderDriver extends DeterministicBlenderDriver {
      readonly batchSizes: number[] = [];

      override async generateMany(requests: BlenderRequest[]) {
        this.batchSizes.push(requests.length);
        return super.generateMany(requests);
      }
    }
    class CountingScreenshotDriver extends PlaceholderScreenshotDriver {
      captures = 0;

      override async capture(viewerUrl: string, outputPath: string) {
        this.captures += 1;
        return super.capture(viewerUrl, outputPath);
      }
    }
    const ai = new GeometryRepairAI();
    const blender = new CountingBlenderDriver();
    const screenshots = new CountingScreenshotDriver();
    const config = loadConfig({
      NODE_ENV: "test",
      DATA_ROOT: root,
      PUBLIC_BASE_URL: "http://localhost:8787",
      AI_DRIVER: "deterministic",
      REFERENCE_SEARCH_DRIVER: "none",
      CONTEXT_DRIVER: "memory",
      BLENDER_DRIVER: "deterministic",
      SCREENSHOT_DRIVER: "placeholder",
      WORKFLOW_MAX_ITERATIONS: "2",
    });
    const services = await createAppServices(config, { ai, blender, screenshots });
    try {
      const result = await services.orchestrator.run("A scene requiring geometry repair");
      const subject = result.plan.assets.find((asset) => asset.id === "subject");
      const events = await services.context.listEvents(result.project.projectId);
      const inspections = events.filter((event) => event.stage === "inspecting" && event.status === "completed");

      expect(result.finalScene.revision).toBe(2);
      expect(result.finalScene.objects.find((object) => object.id === "subject")?.assetId)
        .not.toBe(result.initialScene.objects.find((object) => object.id === "subject")?.assetId);
      expect(subject?.dimensions).toEqual([3, 1, 1]);
      expect(blender.batchSizes).toEqual([3, 1]);
      expect(screenshots.captures).toBe(2);
      expect(ai.inspectionCalls).toBe(2);
      expect(result.finalInspection.verdict).toBe("pass");
      expect(result.qaExhausted).toBe(false);
      expect(inspections.map((event) => event.detail.verdict)).toEqual(["fix", "pass"]);
      expect(await fs.stat(path.join(result.project.root, "qa", "revision-002.json"))).toBeTruthy();
      expect(events.at(-1)?.detail).toMatchObject({ finalVerdict: "pass", exhausted: false, refinements: 1 });
    } finally {
      await services.orchestrator.close();
    }
  });

  it("stops at the configured inspection bound and exposes unresolved QA", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "seein-bounded-loop-"));
    temporaryDirectories.push(root);
    class NeverSatisfiedAI extends DeterministicWorkflowAI {
      inspectionCalls = 0;

      override async inspect(manifest: SceneManifest): Promise<Inspection> {
        this.inspectionCalls += 1;
        return {
          verdict: "fix",
          category: "framing",
          issue: "The fixture remains unsatisfied.",
          evidence: `Inspection of revision ${manifest.revision}.`,
          patch: { kind: "camera", position: [10 + manifest.revision, 5, 8], target: [0, 1, 0] },
        };
      }
    }
    const ai = new NeverSatisfiedAI();
    const config = loadConfig({
      NODE_ENV: "test",
      DATA_ROOT: root,
      PUBLIC_BASE_URL: "http://localhost:8787",
      AI_DRIVER: "deterministic",
      REFERENCE_SEARCH_DRIVER: "none",
      CONTEXT_DRIVER: "memory",
      BLENDER_DRIVER: "deterministic",
      SCREENSHOT_DRIVER: "placeholder",
      WORKFLOW_MAX_ITERATIONS: "2",
    });
    const services = await createAppServices(config, { ai });
    try {
      const result = await services.orchestrator.run("A deliberately unresolved scene");

      expect(result.finalScene.revision).toBe(2);
      expect(result.finalInspection.verdict).toBe("fix");
      expect(result.qaExhausted).toBe(true);
      expect(result.project).toMatchObject({ finalQaVerdict: "fix", qaExhausted: true });
      expect(ai.inspectionCalls).toBe(2);
      expect(await fs.stat(path.join(result.project.root, "scene", "revision-003.json")).catch(() => null)).toBeNull();
    } finally {
      await services.orchestrator.close();
    }
  });
});
