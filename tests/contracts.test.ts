import { describe, expect, it } from "vitest";
import { SceneManifestSchema } from "../src/contracts.js";
import { applyQaPatch } from "../src/scene/scene-assembler.js";

const manifest = SceneManifestSchema.parse({
  schemaVersion: "1.0",
  projectId: "project",
  sceneId: "scene",
  title: "Scene",
  revision: 1,
  environment: { background: "#000000", groundColor: "#222222", groundSize: 10 },
  camera: { position: [5, 5, 5], target: [0, 0, 0], fov: 45 },
  lights: [{ id: "key", type: "directional", color: "#ffffff", intensity: 2, position: [3, 5, 4] }],
  objects: [
    {
      id: "subject",
      assetId: "asset",
      url: "/asset.glb",
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
      label: "Subject",
      labelVisible: true,
      highlight: false,
    },
  ],
  relationships: [],
  states: [],
  transitions: [],
  generatedAt: new Date().toISOString(),
});

describe("QA patches", () => {
  it("creates a new revision and changes only allowlisted camera values", () => {
    const next = applyQaPatch(manifest, { kind: "camera", position: [4, 4, 4], target: [0, 1, 0] });
    expect(next.revision).toBe(2);
    expect(next.camera.position).toEqual([4, 4, 4]);
    expect(next.objects).toEqual(manifest.objects);
    expect(manifest.revision).toBe(1);
  });

  it("rejects patches aimed at missing objects", () => {
    expect(() =>
      applyQaPatch(manifest, { kind: "object-transform", objectId: "missing", scale: [2, 2, 2] }),
    ).toThrow(/missing object/);
  });
});

