import { describe, expect, it } from "vitest";
import { toGeminiScenePlanJsonSchema } from "../src/ai/workflow-ai.js";
import { ScenePlanSchema } from "../src/contracts.js";

const geometryFreePlan = {
  title: "Empty plan",
  rationale: "Fixture for the scene geometry invariant.",
  environment: { background: "#111827", groundColor: "#334155", groundSize: 20 },
  camera: { position: [7, 5, 8], target: [0, 1, 0], fov: 45 },
  lights: [
    { id: "ambient", type: "hemisphere", color: "#dbeafe", intensity: 1.5, position: [0, 5, 0] },
  ],
  assets: [],
  objects: [],
  relationships: [],
  states: [],
  transitions: [],
};

describe("Gemini scene planning contract", () => {
  it("rejects a plan with no imported or procedural geometry", () => {
    const result = ScenePlanSchema.safeParse(geometryFreePlan);

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: "Scene plan must contain imported objects, a procedural program, or both",
        path: ["objects"],
      }),
    ]));
  });

  it("exposes the cross-field geometry invariant to Gemini structured output", () => {
    const schema = toGeminiScenePlanJsonSchema();

    expect(schema.anyOf).toEqual([
      expect.objectContaining({ required: ["procedural"] }),
      expect.objectContaining({
        properties: { objects: { type: "array", minItems: 1 } },
        required: ["objects"],
      }),
    ]);
  });
});
