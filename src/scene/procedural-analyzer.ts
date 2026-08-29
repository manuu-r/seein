import {
  Box3,
  BufferGeometry,
  Euler,
  Matrix4,
  Quaternion,
  Vector3,
} from "three";
import type {
  Bounds3,
  ProceduralNode,
  ProceduralProgram,
  SpatialReport,
  Vec3,
} from "../contracts.js";
import { hashObject } from "../lib/hash.js";
import {
  createProceduralExtrusionGeometry,
  createProceduralLatheGeometry,
  createSizedPrimitiveGeometry,
  createTaperedTubeGeometry,
} from "./procedural-geometry.js";

type SpatialFact = SpatialReport["objects"][number];
type SpatialIssue = SpatialReport["issues"][number];

export interface ProceduralAnalysis {
  facts: SpatialFact[];
  issues: SpatialIssue[];
  boundsById: Map<string, Bounds3>;
  triangleEstimate: number;
}

/**
 * Measures the same declarative parameters consumed by the Three.js renderer.
 * Unlike an authored "dimensions" hint, these bounds are derived from the exact
 * primitive, path, profile, instance, hierarchy, and unit-scale values that build
 * the browser geometry.
 */
export function analyzeProceduralProgram(
  program: ProceduralProgram,
  project: (bounds: Bounds3) => { depth: number; coverage: number; inFrame: boolean },
): ProceduralAnalysis {
  validateProceduralReferences(program);
  const landmarks = new Map(program.landmarks.map((landmark) => [landmark.id, landmark.position]));
  const nodes = new Map(program.nodes.map((node) => [node.id, node]));
  const localBounds = new Map<string, Bounds3>();
  const worldMatrices = new Map<string, Matrix4>();
  const resolving = new Set<string>();
  let triangleEstimate = 0;

  for (const node of program.nodes) {
    localBounds.set(node.id, proceduralLocalBounds(node, landmarks));
    triangleEstimate += estimateTriangles(node);
  }

  const rootScale = new Matrix4().makeScale(
    program.coordinateFrame.metersPerUnit,
    program.coordinateFrame.metersPerUnit,
    program.coordinateFrame.metersPerUnit,
  );
  const resolveMatrix = (node: ProceduralNode): Matrix4 => {
    const cached = worldMatrices.get(node.id);
    if (cached) return cached;
    if (resolving.has(node.id)) throw new Error(`Procedural parent cycle reaches ${node.id}`);
    resolving.add(node.id);
    const local = new Matrix4().compose(
      new Vector3(...node.position),
      new Quaternion().setFromEuler(new Euler(...node.rotation, "XYZ")),
      new Vector3(...node.scale),
    );
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    const world = (parent ? resolveMatrix(parent) : rootScale).clone().multiply(local);
    resolving.delete(node.id);
    worldMatrices.set(node.id, world);
    return world;
  };

  const boundsById = new Map<string, Bounds3>();
  const facts = program.nodes.map((node) => {
    const local = localBounds.get(node.id)!;
    const worldMatrix = resolveMatrix(node);
    const bounds = transformBounds(local, worldMatrix);
    boundsById.set(node.id, bounds);
    const projected = project(bounds);
    return {
      objectId: node.id,
      assetId: `procedural:${node.id}`,
      assetSha256: hashObject({
        geometrySource: "procedural-geometry:v2",
        node,
        landmarks: referencedLandmarks(node, landmarks),
        coordinateFrame: program.coordinateFrame,
        worldMatrix: worldMatrix.toArray(),
      }),
      geometrySource: "procedural-geometry:v2" as const,
      localBounds: scaleBounds(local, program.coordinateFrame.metersPerUnit),
      bounds,
      floorClearance: bounds.min[1],
      cameraDepth: projected.depth,
      projectedCoverage: projected.coverage,
      inFrame: projected.inFrame,
    };
  });

  const issues = validateInvariants(program, boundsById, worldMatrices, landmarks);
  if (triangleEstimate > program.triangleBudget) {
    issues.push({
      category: "performance",
      severity: "error",
      objectIds: [],
      evidence: `Estimated ${triangleEstimate.toLocaleString()} triangles exceeds the ${program.triangleBudget.toLocaleString()} triangle budget.`,
    });
  }
  return { facts, issues, boundsById, triangleEstimate };
}

export function validateProceduralReferences(program: ProceduralProgram): void {
  const unique = (kind: string, ids: string[]): void => {
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    if (duplicates.length > 0) throw new Error(`Duplicate procedural ${kind} IDs: ${[...new Set(duplicates)].join(", ")}`);
  };
  unique("node", program.nodes.map((node) => node.id));
  unique("material", program.materials.map((material) => material.id));
  unique("landmark", program.landmarks.map((landmark) => landmark.id));
  unique("view", program.views.map((view) => view.id));

  const nodes = new Set(program.nodes.map((node) => node.id));
  const materials = new Set(program.materials.map((material) => material.id));
  const landmarks = new Set(program.landmarks.map((landmark) => landmark.id));
  const views = new Set(program.views.map((view) => view.id));
  for (const node of program.nodes) {
    if (!materials.has(node.materialId)) throw new Error(`Procedural node ${node.id} uses missing material ${node.materialId}`);
    if (node.parentId && !nodes.has(node.parentId)) throw new Error(`Procedural node ${node.id} uses missing parent ${node.parentId}`);
    for (const dependency of node.dependsOn) {
      if (!nodes.has(dependency)) throw new Error(`Procedural node ${node.id} depends on missing node ${dependency}`);
    }
    if (node.kind === "tube") {
      for (const [index, point] of node.points.entries()) {
        if (!point.position && !point.landmarkId) throw new Error(`Tube ${node.id} point ${index} needs a position or landmarkId`);
        if (point.landmarkId && !landmarks.has(point.landmarkId)) {
          throw new Error(`Tube ${node.id} point ${index} uses missing landmark ${point.landmarkId}`);
        }
      }
    }
  }
  for (const invariant of program.invariants) {
    const referenced = invariant.kind === "containment"
      ? [invariant.innerNode, invariant.outerNode]
      : invariant.kind === "visible"
        ? [invariant.nodeId]
        : [invariant.nodeA, invariant.nodeB];
    for (const id of referenced) if (!nodes.has(id)) throw new Error(`Invariant ${invariant.id} uses missing node ${id}`);
    if (invariant.kind === "visible" && !views.has(invariant.viewId)) {
      throw new Error(`Invariant ${invariant.id} uses missing view ${invariant.viewId}`);
    }
  }
}

function proceduralLocalBounds(node: ProceduralNode, landmarks: Map<string, Vec3>): Bounds3 {
  switch (node.kind) {
    case "primitive":
      return measuredGeometryBounds(createSizedPrimitiveGeometry(node.shape, node.size, node.segments));
    case "tube": {
      const points = resolvedTubePoints(node, landmarks);
      return measuredGeometryBounds(createTaperedTubeGeometry(
        points.map((point) => ({ position: new Vector3(...point.position), radius: point.radius })),
        node.tubularSegments,
        node.radialSegments,
        node.closed,
      ));
    }
    case "extrusion":
      return measuredGeometryBounds(createProceduralExtrusionGeometry(node.outline, node.depth, node.bevel));
    case "lathe":
      return measuredGeometryBounds(createProceduralLatheGeometry(node.profile, node.segments));
    case "instances": {
      const source = measuredGeometryBounds(createSizedPrimitiveGeometry(node.shape, node.size, node.segments));
      return combineBounds(node.instances.map((instance) => transformBounds(
        source,
        new Matrix4().compose(
          new Vector3(...instance.position),
          new Quaternion().setFromEuler(new Euler(...instance.rotation, "XYZ")),
          new Vector3(...instance.scale),
        ),
      )));
    }
  }
}

function validateInvariants(
  program: ProceduralProgram,
  bounds: Map<string, Bounds3>,
  matrices: Map<string, Matrix4>,
  landmarks: Map<string, Vec3>,
): SpatialIssue[] {
  const issues: SpatialIssue[] = [];
  const nodes = new Map(program.nodes.map((node) => [node.id, node]));
  const fail = (category: SpatialIssue["category"], ids: string[], evidence: string, required: boolean): void => {
    issues.push({ category, severity: required ? "error" : "warning", objectIds: ids.slice(0, 4), evidence });
  };
  for (const invariant of program.invariants) {
    if (invariant.kind === "continuity") {
      const nodeA = nodes.get(invariant.nodeA)!;
      const nodeB = nodes.get(invariant.nodeB)!;
      if (nodeA.kind !== "tube" || nodeB.kind !== "tube") {
        fail("dependency", [nodeA.id, nodeB.id], `${invariant.label} can only compare tube endpoints.`, invariant.required);
        continue;
      }
      const endpoint = (node: Extract<ProceduralNode, { kind: "tube" }>, end: "start" | "end"): Vector3 => {
        const points = resolvedTubePoints(node, landmarks);
        const point = end === "start" ? points[0]!.position : points.at(-1)!.position;
        return new Vector3(...point).applyMatrix4(matrices.get(node.id)!);
      };
      const distance = endpoint(nodeA, invariant.endA).distanceTo(endpoint(nodeB, invariant.endB));
      const toleranceMeters = invariant.tolerance * program.coordinateFrame.metersPerUnit;
      if (distance > toleranceMeters) {
        fail("continuity", [nodeA.id, nodeB.id], `${invariant.label} has a ${(distance * 100).toFixed(2)}cm endpoint gap; tolerance is ${(toleranceMeters * 100).toFixed(2)}cm.`, invariant.required);
      }
      continue;
    }
    if (invariant.kind === "visible") continue;
    const leftId = invariant.kind === "containment" ? invariant.innerNode : invariant.nodeA;
    const rightId = invariant.kind === "containment" ? invariant.outerNode : invariant.nodeB;
    const left = bounds.get(leftId)!;
    const right = bounds.get(rightId)!;
    if (invariant.kind === "contact") {
      const tolerance = invariant.tolerance * program.coordinateFrame.metersPerUnit;
      const distance = boundsDistance(left, right);
      if (distance > tolerance) {
        fail("contact", [leftId, rightId], `${invariant.label} has ${(distance * 100).toFixed(2)}cm separation; tolerance is ${(tolerance * 100).toFixed(2)}cm.`, invariant.required);
      }
    } else if (invariant.kind === "containment") {
      const tolerance = invariant.tolerance * program.coordinateFrame.metersPerUnit;
      const escaped = boundsEscape(left, right);
      if (escaped > tolerance) {
        fail("containment", [leftId, rightId], `${invariant.label} escapes its container bounds by ${(escaped * 100).toFixed(2)}cm.`, invariant.required);
      }
    } else {
      const distance = center(left).distanceTo(center(right));
      const min = invariant.min * program.coordinateFrame.metersPerUnit;
      const max = invariant.max * program.coordinateFrame.metersPerUnit;
      if (distance < min || distance > max) {
        fail("contact", [leftId, rightId], `${invariant.label} center distance is ${(distance * 100).toFixed(2)}cm; expected ${(min * 100).toFixed(2)}–${(max * 100).toFixed(2)}cm.`, invariant.required);
      }
    }
  }
  return issues;
}

function resolvedTubePoints(node: Extract<ProceduralNode, { kind: "tube" }>, landmarks: Map<string, Vec3>) {
  return node.points.map((point) => {
    const source = point.position ?? landmarks.get(point.landmarkId!)!;
    return {
      position: [source[0] + point.offset[0], source[1] + point.offset[1], source[2] + point.offset[2]] as Vec3,
      radius: point.radius ?? node.radius,
    };
  });
}

function referencedLandmarks(node: ProceduralNode, landmarks: Map<string, Vec3>): Record<string, Vec3> {
  if (node.kind !== "tube") return {};
  return Object.fromEntries(node.points.flatMap((point) => point.landmarkId ? [[point.landmarkId, landmarks.get(point.landmarkId)!]] : []));
}

function estimateTriangles(node: ProceduralNode): number {
  switch (node.kind) {
    case "primitive": return node.shape === "box" ? 12 : node.segments * node.segments * 2;
    case "tube": return node.tubularSegments * node.radialSegments * 2;
    case "extrusion": return Math.max(2, node.outline.length - 2) * 2 + node.outline.length * 2;
    case "lathe": return Math.max(1, node.profile.length - 1) * node.segments * 2;
    case "instances": return node.instances.length * (node.shape === "box" ? 12 : node.segments * node.segments * 2);
  }
}

function measuredGeometryBounds(geometry: BufferGeometry): Bounds3 {
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  if (!bounds) {
    geometry.dispose();
    throw new Error("Procedural geometry produced no measurable bounding box");
  }
  const result = { min: bounds.min.toArray() as Vec3, max: bounds.max.toArray() as Vec3 };
  geometry.dispose();
  return result;
}

function transformBounds(bounds: Bounds3, matrix: Matrix4): Bounds3 {
  const box = new Box3();
  for (const x of [bounds.min[0], bounds.max[0]]) for (const y of [bounds.min[1], bounds.max[1]]) {
    for (const z of [bounds.min[2], bounds.max[2]]) box.expandByPoint(new Vector3(x, y, z).applyMatrix4(matrix));
  }
  return { min: box.min.toArray() as Vec3, max: box.max.toArray() as Vec3 };
}

function scaleBounds(bounds: Bounds3, scale: number): Bounds3 {
  return { min: bounds.min.map((value) => value * scale) as Vec3, max: bounds.max.map((value) => value * scale) as Vec3 };
}

function combineBounds(bounds: Bounds3[]): Bounds3 {
  if (bounds.length === 0) return { min: [0, 0, 0], max: [0, 0, 0] };
  return {
    min: [Math.min(...bounds.map((entry) => entry.min[0])), Math.min(...bounds.map((entry) => entry.min[1])), Math.min(...bounds.map((entry) => entry.min[2]))],
    max: [Math.max(...bounds.map((entry) => entry.max[0])), Math.max(...bounds.map((entry) => entry.max[1])), Math.max(...bounds.map((entry) => entry.max[2]))],
  };
}

function boundsDistance(left: Bounds3, right: Bounds3): number {
  const axis = (minA: number, maxA: number, minB: number, maxB: number): number => Math.max(0, minB - maxA, minA - maxB);
  return Math.hypot(
    axis(left.min[0], left.max[0], right.min[0], right.max[0]),
    axis(left.min[1], left.max[1], right.min[1], right.max[1]),
    axis(left.min[2], left.max[2], right.min[2], right.max[2]),
  );
}

function boundsEscape(inner: Bounds3, outer: Bounds3): number {
  return Math.max(
    outer.min[0] - inner.min[0], inner.max[0] - outer.max[0],
    outer.min[1] - inner.min[1], inner.max[1] - outer.max[1],
    outer.min[2] - inner.min[2], inner.max[2] - outer.max[2],
    0,
  );
}

function center(bounds: Bounds3): Vector3 {
  return new Vector3(
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  );
}
