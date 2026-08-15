import { describe, expect, it } from "vitest";
import { DeterministicWorkflowAI } from "../src/ai/workflow-ai.js";
import type { ResolvedAsset } from "../src/contracts.js";
import { assembleScene } from "../src/scene/scene-assembler.js";
import { analyzeSpatial } from "../src/scene/spatial-analyzer.js";

describe("spatial analyzer", () => {
  it("computes deterministic bounds and respects explicit support relationships", async () => {
    const ai = new DeterministicWorkflowAI();
    const research = await ai.research("A compact workshop");
    const plan = await ai.plan("A compact workshop", research, 4);
    const resolved = new Map(
      plan.assets.map((spec): [string, ResolvedAsset] => [
        spec.id,
        {
          assetId: spec.id,
          assetKey: `${spec.id}-key`,
          specId: spec.id,
          path: `/${spec.id}.glb`,
          url: `/${spec.id}.glb`,
          sha256: "a".repeat(64),
          reused: false,
          generator: "fixture",
          metadata: {},
        },
      ]),
    );
    const manifest = assembleScene("project", plan, resolved, 1);
    const report = analyzeSpatial(plan, manifest);

    expect(report.objects).toHaveLength(3);
    expect(report.objects.every((object) => object.inFrame)).toBe(true);
    expect(report.issues.some((issue) => issue.category === "floating" && issue.objectIds.includes("subject"))).toBe(false);
    expect(report.sceneBounds.min[1]).toBeCloseTo(0);
  });

  it("reports unsupported floating geometry as evidence for QA", async () => {
    const ai = new DeterministicWorkflowAI();
    const research = await ai.research("A compact workshop");
    const plan = await ai.plan("A compact workshop", research, 4);
    const marker = plan.objects.find((object) => object.id === "marker");
    if (!marker) throw new Error("Fixture is missing marker");
    marker.position = [marker.position[0], 1, marker.position[2]];
    const resolved = new Map(
      plan.assets.map((spec): [string, ResolvedAsset] => [
        spec.id,
        {
          assetId: spec.id,
          assetKey: `${spec.id}-key`,
          specId: spec.id,
          path: `/${spec.id}.glb`,
          url: `/${spec.id}.glb`,
          sha256: "b".repeat(64),
          reused: false,
          generator: "fixture",
          metadata: {},
        },
      ]),
    );
    const report = analyzeSpatial(plan, assembleScene("project", plan, resolved, 1));

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "floating", objectIds: ["marker"], severity: "warning" }),
      ]),
    );
  });

  it("verifies declared support instead of trusting the scene graph edge", async () => {
    const ai = new DeterministicWorkflowAI();
    const research = await ai.research("A compact workshop");
    const plan = await ai.plan("A compact workshop", research, 4);
    const subject = plan.objects.find((object) => object.id === "subject");
    if (!subject) throw new Error("Fixture is missing subject");
    subject.position = [0, 2, 0];
    const resolved = new Map(
      plan.assets.map((spec): [string, ResolvedAsset] => [
        spec.id,
        {
          assetId: spec.id,
          assetKey: `${spec.id}-key`,
          specId: spec.id,
          path: `/${spec.id}.glb`,
          url: `/${spec.id}.glb`,
          sha256: "c".repeat(64),
          reused: false,
          generator: "fixture",
          metadata: {},
        },
      ]),
    );
    const report = analyzeSpatial(plan, assembleScene("project", plan, resolved, 1));

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "floating", objectIds: ["subject", "platform"], severity: "error" }),
      ]),
    );
  });
});
