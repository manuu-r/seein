import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Config } from "../config.js";
import type { AssetSpec, Vec3 } from "../contracts.js";

export interface BlenderOutput {
  path: string;
  generator: string;
  metadata: Record<string, unknown>;
}

export interface BlenderRequest {
  spec: AssetSpec;
  outputPath: string;
}

export interface BlenderDriver {
  readonly identity: string;
  generate(spec: AssetSpec, outputPath: string): Promise<BlenderOutput>;
  generateMany(requests: BlenderRequest[]): Promise<BlenderOutput[]>;
  close(): Promise<void>;
}

export class QwenMcpBlenderDriver implements BlenderDriver {
  readonly identity = "qwen-mm-blender:bpy-recipe-v2";
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;

  constructor(private readonly config: Config) {}

  async generate(spec: AssetSpec, outputPath: string): Promise<BlenderOutput> {
    const output = await this.generateMany([{ spec, outputPath }]);
    if (!output[0]) throw new Error("Blender returned no output");
    return output[0];
  }

  async generateMany(requests: BlenderRequest[]): Promise<BlenderOutput[]> {
    if (requests.length === 0) return [];
    await Promise.all(requests.map((request) => fs.mkdir(path.dirname(request.outputPath), { recursive: true })));
    const client = await this.connect();
    const result = await client.callTool(
      {
        name: "execute_blender_code",
        arguments: { code: buildBlenderPythonBatch(requests) },
      },
      undefined,
      {
        // First launch may download Blender before Qwen-MM can execute the recipe.
        timeout: 15 * 60_000,
        resetTimeoutOnProgress: true,
        maxTotalTimeout: 20 * 60_000,
      },
    );
    const toolSummary = summarizeToolResult(result.content);
    if (result.isError || toolSummary.includes("Error executing code:")) {
      throw new Error(`Qwen-MM Blender tool failed: ${toolSummary}`);
    }
    return Promise.all(
      requests.map(async ({ spec, outputPath }) => {
        const stat = await fs.stat(outputPath).catch(() => null);
        if (!stat || stat.size < 20) {
          throw new Error(`Blender did not produce a valid output file at ${outputPath}. Tool response: ${toolSummary}`);
        }
        return {
          path: outputPath,
          generator: this.identity,
          metadata: { bytes: stat.size, parts: spec.parts.length, batchSize: requests.length, toolResult: toolSummary },
        };
      }),
    );
  }

  async close(): Promise<void> {
    await this.transport?.close();
    this.client = null;
    this.transport = null;
  }

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    const env = Object.fromEntries(
      Object.entries({
        ...process.env,
        QWEN_MM_AUTOLAUNCH: this.config.QWEN_MM_AUTOLAUNCH,
        BLENDER_HOST: this.config.BLENDER_HOST,
        BLENDER_PORT: String(this.config.BLENDER_PORT),
      }).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
    this.transport = new StdioClientTransport({
      command: this.config.QWEN_MCP_COMMAND,
      args: this.config.QWEN_MCP_ARGS.split(/\s+/).filter(Boolean),
      env,
      // Forward lifecycle and download diagnostics instead of leaving an unread
      // child-process pipe that could fill and stall a long Blender launch.
      stderr: "inherit",
    });
    this.client = new Client({ name: "seein-core", version: "0.1.0" });
    await this.client.connect(this.transport);
    return this.client;
  }
}

export class DeterministicBlenderDriver implements BlenderDriver {
  readonly identity = "deterministic-glb:v1";

  async generate(spec: AssetSpec, outputPath: string): Promise<BlenderOutput> {
    const output = await this.generateMany([{ spec, outputPath }]);
    if (!output[0]) throw new Error("Deterministic Blender driver returned no output");
    return output[0];
  }

  async generateMany(requests: BlenderRequest[]): Promise<BlenderOutput[]> {
    return Promise.all(requests.map(({ spec, outputPath }) => this.generateOne(spec, outputPath)));
  }

  private async generateOne(spec: AssetSpec, outputPath: string): Promise<BlenderOutput> {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const buffer = buildCubeGlb(spec.parts[0]?.color ?? "#f59e0b", spec.dimensions);
    await fs.writeFile(outputPath, buffer);
    return { path: outputPath, generator: this.identity, metadata: { bytes: buffer.length, fixture: true } };
  }

  async close(): Promise<void> {}
}

function buildBlenderPythonBatch(requests: BlenderRequest[]): string {
  const recipes = JSON.stringify(
    requests.map(({ spec, outputPath }) => ({
      ...spec,
      outputPath,
      parts: spec.parts.map((part) => ({
        ...part,
        position: toBlenderPosition(part.position),
        size: toBlenderScale(part.size),
      })),
    })),
  );
  return `import bpy, json, math, os
from mathutils import Euler, Matrix
recipes = json.loads(${JSON.stringify(recipes)})

# SeeIn/Three.js is Y-up; Blender is Z-up. This basis maps Blender vectors to
# glTF vectors as (x, z, -y). Positions/scales are pre-mapped by the backend;
# rotations are conjugated here so non-zero Euler rotations preserve intent.
blender_to_gltf = Matrix(((1, 0, 0), (0, 0, 1), (0, -1, 0)))

def material_for(color_hex):
    name = 'mat_' + color_hex.replace('#', '')
    material = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    rgb = tuple(int(color_hex[i:i+2], 16) / 255.0 for i in (1, 3, 5))
    material.diffuse_color = (*rgb, 1.0)
    material.use_nodes = True
    bsdf = material.node_tree.nodes.get('Principled BSDF')
    if bsdf:
        bsdf.inputs['Base Color'].default_value = (*rgb, 1.0)
        bsdf.inputs['Roughness'].default_value = 0.65
    return material

results = []
for recipe in recipes:
    output_path = recipe['outputPath']
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    created = []
    for part in recipe['parts']:
        primitive = part['primitive']
        size = part['size']
        if primitive == 'box':
            bpy.ops.mesh.primitive_cube_add(size=1)
        elif primitive == 'sphere':
            bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=0.5)
        elif primitive == 'cylinder':
            bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=0.5, depth=1)
        elif primitive == 'cone':
            bpy.ops.mesh.primitive_cone_add(vertices=24, radius1=0.5, radius2=0, depth=1)
        elif primitive == 'torus':
            bpy.ops.mesh.primitive_torus_add(major_radius=0.35, minor_radius=0.15, major_segments=24, minor_segments=8)
        elif primitive == 'plane':
            bpy.ops.mesh.primitive_plane_add(size=1)
        obj = bpy.context.active_object
        obj.name = part['name']
        obj.location = part['position']
        gltf_rotation = Euler(part['rotation'], 'XYZ').to_matrix()
        obj.rotation_euler = (blender_to_gltf.transposed() @ gltf_rotation @ blender_to_gltf).to_euler('XYZ')
        obj.scale = size
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        obj.data.materials.append(material_for(part['color']))
        if part.get('bevel', 0) > 0 and primitive != 'plane':
            modifier = obj.modifiers.new(name='SeeInBevel', type='BEVEL')
            modifier.width = min(part['bevel'], min(size) * 0.2)
            modifier.segments = 2
        created.append(obj)
    bpy.ops.object.select_all(action='DESELECT')
    for obj in created:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = created[0]
    bpy.ops.export_scene.gltf(filepath=output_path, export_format='GLB', use_selection=True, export_apply=True)
    results.append({'output': output_path, 'objects': len(created)})
print(json.dumps({'status': 'ok', 'results': results}))`;
}

export function toBlenderPosition([x, y, z]: Vec3): Vec3 {
  return [x, -z, y];
}

export function toBlenderScale([x, y, z]: Vec3): Vec3 {
  return [x, z, y];
}

function summarizeToolResult(content: unknown): string {
  const serialized = JSON.stringify(content);
  return serialized.length > 12_000 ? `${serialized.slice(0, 12_000)}…` : serialized;
}

function buildCubeGlb(color: string, dimensions: Vec3): Buffer {
  const [width, height, depth] = dimensions;
  const positions = new Float32Array([
    -width / 2, 0, -depth / 2, width / 2, 0, -depth / 2,
    width / 2, height, -depth / 2, -width / 2, height, -depth / 2,
    -width / 2, 0, depth / 2, width / 2, 0, depth / 2,
    width / 2, height, depth / 2, -width / 2, height, depth / 2,
  ]);
  const indices = new Uint16Array([
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1,
    3, 2, 6, 3, 6, 7, 1, 5, 6, 1, 6, 2, 0, 3, 7, 0, 7, 4,
  ]);
  const positionBytes = Buffer.from(positions.buffer);
  const indexBytes = Buffer.from(indices.buffer);
  const binary = pad4(Buffer.concat([positionBytes, indexBytes]));
  const rgb = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255);
  const gltf = {
    asset: { version: "2.0", generator: "SeeIn deterministic fixture" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "FixtureCube" }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [...rgb, 1], roughnessFactor: 0.7, metallicFactor: 0 } }],
    buffers: [{ byteLength: binary.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionBytes.length, target: 34962 },
      { buffer: 0, byteOffset: positionBytes.length, byteLength: indexBytes.length, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: "VEC3", min: [-width / 2, 0, -depth / 2], max: [width / 2, height, depth / 2] },
      { bufferView: 1, componentType: 5123, count: 36, type: "SCALAR", min: [0], max: [7] },
    ],
  };
  const json = pad4(Buffer.from(JSON.stringify(gltf)), 0x20);
  const total = 12 + 8 + json.length + 8 + binary.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(json.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binary.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, json, binHeader, binary]);
}

function pad4(buffer: Buffer, fill = 0): Buffer {
  const remainder = buffer.length % 4;
  return remainder === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(4 - remainder, fill)]);
}
