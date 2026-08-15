import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeterministicBlenderDriver, toBlenderPosition, toBlenderScale } from "../src/blender/blender-driver.js";
import type { AssetSpec } from "../src/contracts.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("DeterministicBlenderDriver", () => {
  it("maps Three.js Y-up asset vectors into Blender Z-up space", () => {
    expect(toBlenderPosition([2, 3, 4])).toEqual([2, -4, 3]);
    expect(toBlenderScale([2, 3, 4])).toEqual([2, 4, 3]);
  });

  it("writes a structurally valid GLB 2.0 container", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "seein-glb-"));
    temporaryDirectories.push(root);
    const outputPath = path.join(root, "model.glb");
    const spec: AssetSpec = {
      id: "cube",
      name: "Cube",
      category: "fixture",
      description: "Test cube",
      tags: ["cube"],
      dimensions: [1, 1, 1],
      style: "fixture",
      parts: [
        { name: "cube", primitive: "box", size: [1, 1, 1], position: [0, 0, 0], rotation: [0, 0, 0], color: "#ff8800", bevel: 0 },
      ],
    };
    await new DeterministicBlenderDriver().generate(spec, outputPath);
    const glb = await fs.readFile(outputPath);
    expect(glb.subarray(0, 4).toString("ascii")).toBe("glTF");
    expect(glb.readUInt32LE(4)).toBe(2);
    expect(glb.readUInt32LE(8)).toBe(glb.length);
    const jsonLength = glb.readUInt32LE(12);
    const json = JSON.parse(glb.subarray(20, 20 + jsonLength).toString("utf8").trim());
    expect(json.asset.version).toBe("2.0");
    expect(json.meshes).toHaveLength(1);
  });

  it("generates multiple requested assets in one deterministic batch", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "seein-glb-batch-"));
    temporaryDirectories.push(root);
    const spec: AssetSpec = {
      id: "cube",
      name: "Cube",
      category: "fixture",
      description: "Test cube",
      tags: ["cube"],
      dimensions: [1, 1, 1],
      style: "fixture",
      parts: [
        { name: "cube", primitive: "box", size: [1, 1, 1], position: [0, 0, 0], rotation: [0, 0, 0], color: "#ff8800", bevel: 0 },
      ],
    };
    const outputs = await new DeterministicBlenderDriver().generateMany([
      { spec, outputPath: path.join(root, "one.glb") },
      { spec: { ...spec, id: "cube-two" }, outputPath: path.join(root, "two.glb") },
    ]);
    expect(outputs).toHaveLength(2);
    expect((await fs.readFile(outputs[0]!.path)).subarray(0, 4).toString("ascii")).toBe("glTF");
    expect((await fs.readFile(outputs[1]!.path)).subarray(0, 4).toString("ascii")).toBe("glTF");
  });
});
