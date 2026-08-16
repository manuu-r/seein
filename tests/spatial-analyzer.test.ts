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
          geometry: {
            bounds: { min: [-spec.dimensions[0] / 2, 0, -spec.dimensions[2] / 2], max: [spec.dimensions[0] / 2, spec.dimensions[1], spec.dimensions[2] / 2] },
            size: spec.dimensions,
            source: "glb-accessors:v1",
            meshInstances: 1,
          },
          metadata: {},
        },
      ]),
    );
    const manifest = assembleScene("project", plan, resolved, 1);
    const report = analyzeSpatial(plan, manifest, resolved);

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
          geometry: {
            bounds: { min: [-spec.dimensions[0] / 2, 0, -spec.dimensions[2] / 2], max: [spec.dimensions[0] / 2, spec.dimensions[1], spec.dimensions[2] / 2] },
            size: spec.dimensions,
            source: "glb-accessors:v1",
            meshInstances: 1,
          },
          metadata: {},
        },
      ]),
    );
    const report = analyzeSpatial(plan, assembleScene("project", plan, resolved, 1), resolved);

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
          geometry: {
            bounds: { min: [-spec.dimensions[0] / 2, 0, -spec.dimensions[2] / 2], max: [spec.dimensions[0] / 2, spec.dimensions[1], spec.dimensions[2] / 2] },
            size: spec.dimensions,
            source: "glb-accessors:v1",
            meshInstances: 1,
          },
          metadata: {},
        },
      ]),
    );
    const report = analyzeSpatial(plan, assembleScene("project", plan, resolved, 1), resolved);

    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: "floating", objectIds: ["subject", "platform"], severity: "error" }),
      ]),
    );
  });

  it("uses measured asset bounds even when the declared dimensions disagree", async () => {
    const ai = new DeterministicWorkflowAI();
    const research = await ai.research("A compact workshop");
    const plan = await ai.plan("A compact workshop", research, 4);
    const subjectSpec = plan.assets.find((asset) => asset.id === "subject");
    if (!subjectSpec) throw new Error("Fixture is missing subject spec");
    subjectSpec.dimensions = [1, 1, 1];
    const resolved = new Map(
      plan.assets.map((spec): [string, ResolvedAsset] => [
        spec.id,
        {
          assetId: spec.id,
          assetKey: `${spec.id}-key`,
          specId: spec.id,
          path: `/${spec.id}.glb`,
          url: `/${spec.id}.glb`,
          sha256: "d".repeat(64),
          reused: false,
          generator: "fixture",
          geometry: {
            bounds: spec.id === "subject"
              ? { min: [-0.5, 0, -0.5], max: [0.5, 5, 0.5] }
              : { min: [-spec.dimensions[0] / 2, 0, -spec.dimensions[2] / 2], max: [spec.dimensions[0] / 2, spec.dimensions[1], spec.dimensions[2] / 2] },
            size: spec.id === "subject" ? [1, 5, 1] : spec.dimensions,
            source: "glb-accessors:v1",
            meshInstances: 1,
          },
          metadata: {},
        },
      ]),
    );
    const report = analyzeSpatial(plan, assembleScene("project", plan, resolved, 1), resolved);
    const subject = report.objects.find((object) => object.objectId === "subject");

    expect(subject?.localBounds.max[1]).toBe(5);
    expect(subject?.bounds.max[1]).toBeCloseTo(5.4);
    expect(subject?.assetSha256).toBe("d".repeat(64));
  });

  it("refuses to produce authoritative evidence for an unmeasured asset", async () => {
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
          sha256: "e".repeat(64),
          reused: false,
          generator: "fixture",
          metadata: {},
        },
      ]),
    );

    expect(() => analyzeSpatial(plan, assembleScene("project", plan, resolved, 1), resolved)).toThrow(
      /refuses unmeasured GLB geometry/,
    );
  });
});
