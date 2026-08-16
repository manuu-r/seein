import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeterministicBlenderDriver, toBlenderPosition, toBlenderScale } from "../src/blender/blender-driver.js";
import type { AssetSpec } from "../src/contracts.js";
import { measureGlbGeometry } from "../src/scene/geometry-bounds.js";

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

  it("measures bounds from GLB POSITION data rather than the planner at inspection time", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "seein-glb-bounds-"));
    temporaryDirectories.push(root);
    const outputPath = path.join(root, "measured.glb");
    const spec: AssetSpec = {
      id: "measured",
      name: "Measured asset",
      category: "fixture",
      description: "Geometry measurement fixture",
      tags: ["measured"],
      dimensions: [2, 4, 6],
      style: "fixture",
      parts: [
        { name: "shape", primitive: "box", size: [1, 1, 1], position: [0, 3, 0], rotation: [0, 0, 0], color: "#ff8800", bevel: 0 },
      ],
    };
    await new DeterministicBlenderDriver().generate(spec, outputPath);
    const geometry = await measureGlbGeometry(outputPath);

    expect(geometry.bounds).toEqual({ min: [-1, 0, -3], max: [1, 4, 3] });
    expect(geometry.size).toEqual([2, 4, 6]);
    expect(geometry.source).toBe("glb-accessors:v1");
  });

  it("includes GLB node transforms in measured bounds", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "seein-glb-node-bounds-"));
    temporaryDirectories.push(root);
    const originalPath = path.join(root, "original.glb");
    const translatedPath = path.join(root, "translated.glb");
    const spec: AssetSpec = {
      id: "translated",
      name: "Translated asset",
      category: "fixture",
      description: "A unit mesh translated above its asset origin",
      tags: ["translated"],
      dimensions: [1, 1, 1],
      style: "fixture",
      parts: [
        { name: "shape", primitive: "box", size: [1, 1, 1], position: [0, 0, 0], rotation: [0, 0, 0], color: "#ff8800", bevel: 0 },
      ],
    };
    await new DeterministicBlenderDriver().generate(spec, originalPath);
    const translated = translateFirstGlbNode(await fs.readFile(originalPath), [0, 2.5, 0]);
    await fs.writeFile(translatedPath, translated);

    const geometry = await measureGlbGeometry(translatedPath);

    expect(geometry.bounds).toEqual({ min: [-0.5, 2.5, -0.5], max: [0.5, 3.5, 0.5] });
    expect(geometry.size).toEqual([1, 1, 1]);
  });
});

function translateFirstGlbNode(glb: Buffer, translation: [number, number, number]): Buffer {
  const originalJsonLength = glb.readUInt32LE(12);
  const document = JSON.parse(glb.toString("utf8", 20, 20 + originalJsonLength).trim()) as {
    nodes: Array<{ translation?: [number, number, number] }>;
  };
  document.nodes[0]!.translation = translation;
  const jsonText = JSON.stringify(document);
  const jsonPadding = (4 - (Buffer.byteLength(jsonText) % 4)) % 4;
  const json = Buffer.from(jsonText + " ".repeat(jsonPadding));
  const binaryChunkOffset = 20 + originalJsonLength;
  const binaryLength = glb.readUInt32LE(binaryChunkOffset);
  const binary = glb.subarray(binaryChunkOffset + 8, binaryChunkOffset + 8 + binaryLength);
  const output = Buffer.alloc(12 + 8 + json.length + 8 + binary.length);
  output.write("glTF", 0, "ascii");
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(json.length, 12);
  output.writeUInt32LE(0x4e4f534a, 16);
  json.copy(output, 20);
  const outputBinaryOffset = 20 + json.length;
  output.writeUInt32LE(binary.length, outputBinaryOffset);
  output.writeUInt32LE(0x004e4942, outputBinaryOffset + 4);
  binary.copy(output, outputBinaryOffset + 8);
  return output;
}
