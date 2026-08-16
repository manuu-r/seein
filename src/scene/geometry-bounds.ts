import fs from "node:fs/promises";
import {
  AssetGeometrySchema,
  Bounds3Schema,
  type AssetGeometry,
  type AssetSpec,
  type Bounds3,
  type Vec3,
} from "../contracts.js";

type Matrix4 = [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
];

interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
  normalized?: boolean;
  sparse?: unknown;
}

interface GltfBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
}

interface GltfNode {
  mesh?: number;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}

interface GltfDocument {
  scene?: number;
  scenes?: Array<{ nodes?: number[] }>;
  nodes?: GltfNode[];
  meshes?: Array<{ primitives?: Array<{ attributes?: Record<string, number> }> }>;
  accessors?: GltfAccessor[];
  bufferViews?: GltfBufferView[];
}

export async function measureGlbGeometry(filePath: string): Promise<AssetGeometry> {
  return measureGlbBuffer(await fs.readFile(filePath));
}

export function measureGlbBuffer(buffer: Buffer): AssetGeometry {
  const { document, binary } = parseGlb(buffer);
  const nodes = document.nodes ?? [];
  const meshes = document.meshes ?? [];
  const accessors = document.accessors ?? [];
  const views = document.bufferViews ?? [];
  const childNodes = new Set(nodes.flatMap((node) => node.children ?? []));
  const sceneRoots = document.scenes?.[document.scene ?? 0]?.nodes;
  const roots = sceneRoots?.length
    ? sceneRoots
    : nodes.map((_node, index) => index).filter((index) => !childNodes.has(index));
  let measured: Bounds3 | null = null;
  let meshInstances = 0;

  const visit = (nodeIndex: number, parent: Matrix4, ancestry: Set<number>): void => {
    if (ancestry.has(nodeIndex)) throw new Error(`GLB node hierarchy contains a cycle at node ${nodeIndex}`);
    const node = nodes[nodeIndex];
    if (!node) throw new Error(`GLB references missing node ${nodeIndex}`);
    const nextAncestry = new Set(ancestry).add(nodeIndex);
    const world = multiplyMatrix(parent, nodeMatrix(node));
    if (node.mesh !== undefined) {
      const mesh = meshes[node.mesh];
      if (!mesh) throw new Error(`GLB node ${nodeIndex} references missing mesh ${node.mesh}`);
      let instanceMeasured = false;
      for (const primitive of mesh.primitives ?? []) {
        const positionAccessorIndex = primitive.attributes?.POSITION;
        if (positionAccessorIndex === undefined) continue;
        const accessor = accessors[positionAccessorIndex];
        if (!accessor) throw new Error(`GLB references missing POSITION accessor ${positionAccessorIndex}`);
        const local = accessorBounds(accessor, views, binary);
        measured = unionBounds(measured, transformBounds(local, world));
        instanceMeasured = true;
      }
      if (instanceMeasured) meshInstances += 1;
    }
    for (const child of node.children ?? []) visit(child, world, nextAncestry);
  };

  for (const root of roots) visit(root, identityMatrix(), new Set());
  if (!measured || meshInstances === 0) throw new Error("GLB contains no measurable POSITION geometry");
  return AssetGeometrySchema.parse({
    bounds: measured,
    size: boundsSize(measured),
    source: "glb-accessors:v1",
    meshInstances,
  });
}

export function recipeBounds(spec: Pick<AssetSpec, "parts">): Bounds3 {
  let measured: Bounds3 | null = null;
  for (const part of spec.parts) {
    const primitiveSize: Vec3 =
      part.primitive === "plane"
        ? [part.size[0], 0, part.size[2]]
        : part.primitive === "torus"
          ? [part.size[0], part.size[1] * 0.3, part.size[2]]
          : part.size;
    const half: Vec3 = [primitiveSize[0] / 2, primitiveSize[1] / 2, primitiveSize[2] / 2];
    const local: Bounds3 = { min: [-half[0], -half[1], -half[2]], max: half };
    measured = unionBounds(measured, transformBounds(local, matrixFromTrs(part.position, eulerQuaternion(part.rotation), [1, 1, 1])));
  }
  if (!measured) throw new Error("Asset recipe has no parts");
  return Bounds3Schema.parse(measured);
}

export function boundsSize(bounds: Bounds3): Vec3 {
  return [
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  ];
}

export function transformBounds(bounds: Bounds3, matrix: Matrix4): Bounds3 {
  let transformed: Bounds3 | null = null;
  for (const point of boundsCorners(bounds)) {
    const value = transformPoint(point, matrix);
    transformed = unionBounds(transformed, { min: value, max: value });
  }
  if (!transformed) throw new Error("Bounds contain no corners");
  return transformed;
}

export function transformBoundsByTrs(bounds: Bounds3, position: Vec3, rotation: Vec3, scale: Vec3): Bounds3 {
  return transformBounds(bounds, matrixFromTrs(position, eulerQuaternion(rotation), scale));
}

function parseGlb(buffer: Buffer): { document: GltfDocument; binary: Buffer } {
  if (buffer.length < 20 || buffer.toString("ascii", 0, 4) !== "glTF") throw new Error("Asset is not a GLB file");
  if (buffer.readUInt32LE(4) !== 2) throw new Error(`Unsupported GLB version ${buffer.readUInt32LE(4)}`);
  if (buffer.readUInt32LE(8) !== buffer.length) throw new Error("GLB header length does not match file size");
  let offset = 12;
  let document: GltfDocument | null = null;
  let binary: Buffer | null = null;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    if (end > buffer.length) throw new Error("GLB chunk exceeds file size");
    if (type === 0x4e4f534a) {
      document = JSON.parse(buffer.toString("utf8", start, end).replace(/\u0000+$/g, "").trim()) as GltfDocument;
    } else if (type === 0x004e4942) {
      binary = buffer.subarray(start, end);
    }
    offset = end;
  }
  if (!document || !binary) throw new Error("GLB must contain JSON and BIN chunks");
  return { document, binary };
}

function accessorBounds(accessor: GltfAccessor, views: GltfBufferView[], binary: Buffer): Bounds3 {
  if (accessor.type !== "VEC3") throw new Error(`POSITION accessor must be VEC3, received ${accessor.type}`);
  if (accessor.min?.length === 3 && accessor.max?.length === 3) {
    return Bounds3Schema.parse({ min: accessor.min, max: accessor.max });
  }
  if (accessor.sparse) throw new Error("Sparse POSITION accessors without min/max are not supported");
  if (accessor.bufferView === undefined) throw new Error("POSITION accessor has no buffer view");
  const view = views[accessor.bufferView];
  if (!view || view.buffer !== 0) throw new Error("GLB POSITION accessor must reference its embedded buffer");
  const componentBytes = bytesPerComponent(accessor.componentType);
  const stride = view.byteStride ?? componentBytes * 3;
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  let min: Vec3 = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  let max: Vec3 = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let index = 0; index < accessor.count; index += 1) {
    const base = start + index * stride;
    for (let axis = 0; axis < 3; axis += 1) {
      const value = readComponent(binary, base + axis * componentBytes, accessor.componentType, accessor.normalized ?? false);
      min[axis] = Math.min(min[axis]!, value);
      max[axis] = Math.max(max[axis]!, value);
    }
  }
  return Bounds3Schema.parse({ min, max });
}

function bytesPerComponent(componentType: number): number {
  if (componentType === 5120 || componentType === 5121) return 1;
  if (componentType === 5122 || componentType === 5123) return 2;
  if (componentType === 5125 || componentType === 5126) return 4;
  throw new Error(`Unsupported glTF component type ${componentType}`);
}

function readComponent(buffer: Buffer, offset: number, type: number, normalized: boolean): number {
  let value: number;
  if (type === 5120) value = buffer.readInt8(offset);
  else if (type === 5121) value = buffer.readUInt8(offset);
  else if (type === 5122) value = buffer.readInt16LE(offset);
  else if (type === 5123) value = buffer.readUInt16LE(offset);
  else if (type === 5125) value = buffer.readUInt32LE(offset);
  else if (type === 5126) return buffer.readFloatLE(offset);
  else throw new Error(`Unsupported glTF component type ${type}`);
  if (!normalized) return value;
  if (type === 5120) return Math.max(value / 127, -1);
  if (type === 5121) return value / 255;
  if (type === 5122) return Math.max(value / 32767, -1);
  if (type === 5123) return value / 65535;
  if (type === 5125) return value / 4294967295;
  return value;
}

function nodeMatrix(node: GltfNode): Matrix4 {
  if (node.matrix) {
    if (node.matrix.length !== 16) throw new Error("GLB node matrix must contain 16 values");
    return node.matrix as Matrix4;
  }
  return matrixFromTrs(
    vec3(node.translation, [0, 0, 0]),
    quaternion(node.rotation),
    vec3(node.scale, [1, 1, 1]),
  );
}

function matrixFromTrs(translation: Vec3, [x, y, z, w]: [number, number, number, number], scale: Vec3): Matrix4 {
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  return [
    (1 - (yy + zz)) * scale[0], (xy + wz) * scale[0], (xz - wy) * scale[0], 0,
    (xy - wz) * scale[1], (1 - (xx + zz)) * scale[1], (yz + wx) * scale[1], 0,
    (xz + wy) * scale[2], (yz - wx) * scale[2], (1 - (xx + yy)) * scale[2], 0,
    translation[0], translation[1], translation[2], 1,
  ];
}

function eulerQuaternion([x, y, z]: Vec3): [number, number, number, number] {
  const c1 = Math.cos(x / 2);
  const c2 = Math.cos(y / 2);
  const c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2);
  const s2 = Math.sin(y / 2);
  const s3 = Math.sin(z / 2);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3,
  ];
}

function quaternion(value: number[] | undefined): [number, number, number, number] {
  return value?.length === 4 ? [value[0]!, value[1]!, value[2]!, value[3]!] : [0, 0, 0, 1];
}

function vec3(value: number[] | undefined, fallback: Vec3): Vec3 {
  return value?.length === 3 ? [value[0]!, value[1]!, value[2]!] : fallback;
}

function identityMatrix(): Matrix4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function multiplyMatrix(left: Matrix4, right: Matrix4): Matrix4 {
  const output = Array<number>(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      for (let inner = 0; inner < 4; inner += 1) {
        output[column * 4 + row]! += left[inner * 4 + row]! * right[column * 4 + inner]!;
      }
    }
  }
  return output as Matrix4;
}

function transformPoint([x, y, z]: Vec3, matrix: Matrix4): Vec3 {
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

function boundsCorners(bounds: Bounds3): Vec3[] {
  const points: Vec3[] = [];
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) points.push([x, y, z]);
    }
  }
  return points;
}

function unionBounds(left: Bounds3 | null, right: Bounds3): Bounds3 {
  if (!left) return { min: [...right.min], max: [...right.max] };
  return {
    min: [
      Math.min(left.min[0], right.min[0]),
      Math.min(left.min[1], right.min[1]),
      Math.min(left.min[2], right.min[2]),
    ],
    max: [
      Math.max(left.max[0], right.max[0]),
      Math.max(left.max[1], right.max[1]),
      Math.max(left.max[2], right.max[2]),
    ],
  };
}
