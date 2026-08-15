import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeterministicWorkflowAI, type ResearchPlan } from "../src/ai/workflow-ai.js";
import { createAppServices } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { AssetRecord } from "../src/context/context-store.js";
import type { AssetSpec, Inspection, SceneManifest, SpatialReport } from "../src/contracts.js";
import { PlaceholderScreenshotDriver } from "../src/render/screenshot-driver.js";
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
        metadata: {},
      },
    };
    expect(isCompatibleAssetForGenerator(spec, candidate, "qwen-mm-blender:bpy-recipe-v2")).toBe(false);
    expect(isCompatibleAssetForGenerator(spec, candidate, "qwen-mm-blender:bpy-recipe-v1")).toBe(true);
  });

  it("runs research through final revision and reuses cached research/assets", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "seein-workflow-"));
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
      combinedCalls = 0;
      inspectionCalls = 0;

      override async researchAndPlan(prompt: string, maxObjects: number): Promise<ResearchPlan> {
        this.combinedCalls += 1;
        return super.researchAndPlan(prompt, maxObjects);
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
      expect(ai.combinedCalls).toBe(1);
      expect(ai.inspectionCalls).toBe(1);
      expect(screenshots.captures).toBe(1);
      const events = (await fs.readFile(path.join(second.project.root, "logs", "events.ndjson"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { stage: string; detail: Record<string, unknown> });
      expect(events.find((event) => event.stage === "planning" && event.detail.cacheHit === true)).toBeTruthy();
      expect(events.find((event) => event.stage === "rendering_initial" && event.detail.cacheHit === true)).toBeTruthy();
      expect(events.find((event) => event.stage === "inspecting" && event.detail.cacheHit === true)).toBeTruthy();
      expect(events.find((event) => event.stage === "rendering_final" && event.detail.reusedInitial === true)).toBeTruthy();
    } finally {
      await services.orchestrator.close();
    }
  });
});
