import {
  SpatialReportSchema,
  type SceneManifest,
  type ScenePlan,
  type SpatialReport,
  type Vec3,
} from "../contracts.js";

export const SPATIAL_ANALYZER_IDENTITY = "bounds-and-camera:v1";

interface Bounds {
  min: Vec3;
  max: Vec3;
}

export function analyzeSpatial(plan: ScenePlan, manifest: SceneManifest): SpatialReport {
  const specs = new Map(plan.assets.map((spec) => [spec.id, spec]));
  const plannedObjects = new Map(plan.objects.map((object) => [object.id, object]));
  const objectBounds = new Map<string, Bounds>();
  const objects = manifest.objects.map((object) => {
    const planned = plannedObjects.get(object.id);
    const spec = planned ? specs.get(planned.assetSpecId) : undefined;
    if (!spec) throw new Error(`Spatial analysis is missing an asset specification for ${object.id}`);
    const bounds = transformedBounds(spec.dimensions, object.position, object.rotation, object.scale);
    objectBounds.set(object.id, bounds);
    const projection = projectBounds(bounds, manifest.camera.position, manifest.camera.target, manifest.camera.fov);
    return {
      objectId: object.id,
      bounds,
      floorClearance: bounds.min[1],
      cameraDepth: projection.depth,
      projectedCoverage: projection.coverage,
      inFrame: projection.inFrame,
    };
  });
  const issues: SpatialReport["issues"] = [];
  for (const object of objects) {
    const supportRelation = manifest.relationships.find(
      (relation) =>
        (relation.type === "on" && relation.from === object.objectId) ||
        (relation.type === "supports" && relation.to === object.objectId),
    );
    if (object.floorClearance > 0.08) {
      const supportId = supportRelation
        ? supportRelation.type === "on"
          ? supportRelation.to
          : supportRelation.from
        : null;
      const supportBounds = supportId ? objectBounds.get(supportId) : undefined;
      const contact = supportBounds ? supportContact(object.bounds, supportBounds) : null;
      if (!supportRelation || !supportBounds) {
        issues.push({
          category: "floating",
          severity: "warning",
          objectIds: [object.objectId],
          evidence: `${object.objectId} has ${object.floorClearance.toFixed(3)}m of unaccounted floor clearance.`,
        });
      } else if (supportId && !contact?.valid) {
        issues.push({
          category: "floating",
          severity: "error",
          objectIds: [object.objectId, supportId],
          evidence: `${object.objectId} claims support from ${supportId}, but the vertical gap is ${contact?.gap.toFixed(3) ?? "unknown"}m and footprint overlap is ${((contact?.overlapRatio ?? 0) * 100).toFixed(1)}%.`,
        });
      }
    }
    if (!object.inFrame) {
      issues.push({
        category: "framing",
        severity: "error",
        objectIds: [object.objectId],
        evidence: `${object.objectId} does not intersect the camera frustum.`,
      });
    } else if (object.projectedCoverage < 0.00005 || object.projectedCoverage > 0.8) {
      issues.push({
        category: "scale",
        severity: object.projectedCoverage > 0.8 ? "error" : "warning",
        objectIds: [object.objectId],
        evidence: `${object.objectId} covers ${(object.projectedCoverage * 100).toFixed(3)}% of the viewport.`,
      });
    }
  }
  for (let leftIndex = 0; leftIndex < objects.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < objects.length; rightIndex += 1) {
      const left = objects[leftIndex];
      const right = objects[rightIndex];
      if (!left || !right) continue;
      const leftBounds = objectBounds.get(left.objectId);
      const rightBounds = objectBounds.get(right.objectId);
      if (!leftBounds || !rightBounds) continue;
      const overlap = overlapVolume(leftBounds, rightBounds);
      const smaller = Math.min(boundsVolume(leftBounds), boundsVolume(rightBounds));
      const overlapRatio = smaller > 0 ? overlap / smaller : 0;
      const allowed = manifest.relationships.some(
        (relation) =>
          ((relation.from === left.objectId && relation.to === right.objectId) ||
            (relation.from === right.objectId && relation.to === left.objectId)) &&
          ["inside", "part-of"].includes(relation.type),
      );
      if (overlapRatio > 0.18 && !allowed) {
        issues.push({
          category: "intersection",
          severity: overlapRatio > 0.5 ? "error" : "warning",
          objectIds: [left.objectId, right.objectId],
          evidence: `${left.objectId} and ${right.objectId} overlap by ${(overlapRatio * 100).toFixed(1)}% of the smaller bounds.`,
        });
      }
    }
  }
  const sceneBounds = combineBounds([...objectBounds.values()]);
  return SpatialReportSchema.parse({
    schemaVersion: "1.0",
    analyzer: SPATIAL_ANALYZER_IDENTITY,
    sceneRevision: manifest.revision,
    sceneBounds,
    objects,
    issues,
    generatedAt: new Date().toISOString(),
  });
}

function transformedBounds(dimensions: Vec3, position: Vec3, rotation: Vec3, scale: Vec3): Bounds {
  const [width, height, depth] = dimensions.map(Math.abs) as Vec3;
  const corners: Vec3[] = [];
  for (const x of [-width / 2, width / 2]) {
    for (const y of [0, height]) {
      for (const z of [-depth / 2, depth / 2]) {
        const scaled: Vec3 = [x * Math.abs(scale[0]), y * Math.abs(scale[1]), z * Math.abs(scale[2])];
        const rotated = rotateXyz(scaled, rotation);
        corners.push([rotated[0] + position[0], rotated[1] + position[1], rotated[2] + position[2]]);
      }
    }
  }
  return boundsFromPoints(corners);
}

function rotateXyz([x, y, z]: Vec3, [rx, ry, rz]: Vec3): Vec3 {
  const cosX = Math.cos(rx);
  const sinX = Math.sin(rx);
  const y1 = y * cosX - z * sinX;
  const z1 = y * sinX + z * cosX;
  const cosY = Math.cos(ry);
  const sinY = Math.sin(ry);
  const x2 = x * cosY + z1 * sinY;
  const z2 = -x * sinY + z1 * cosY;
  const cosZ = Math.cos(rz);
  const sinZ = Math.sin(rz);
  return [x2 * cosZ - y1 * sinZ, x2 * sinZ + y1 * cosZ, z2];
}

function projectBounds(bounds: Bounds, camera: Vec3, target: Vec3, fovDegrees: number) {
  const forward = normalize(subtract(target, camera));
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  const tangent = Math.tan((fovDegrees * Math.PI) / 360);
  const aspect = 16 / 9;
  const projected: Array<[number, number]> = [];
  const depths: number[] = [];
  for (const point of boundsCorners(bounds)) {
    const relative = subtract(point, camera);
    const depth = dot(relative, forward);
    depths.push(depth);
    if (depth <= 0.01) continue;
    projected.push([dot(relative, right) / (depth * tangent * aspect), dot(relative, up) / (depth * tangent)]);
  }
  if (projected.length === 0) return { depth: Math.max(...depths), coverage: 0, inFrame: false };
  const minX = Math.min(...projected.map(([x]) => x));
  const maxX = Math.max(...projected.map(([x]) => x));
  const minY = Math.min(...projected.map(([, y]) => y));
  const maxY = Math.max(...projected.map(([, y]) => y));
  const clippedWidth = Math.max(0, Math.min(1, maxX) - Math.max(-1, minX));
  const clippedHeight = Math.max(0, Math.min(1, maxY) - Math.max(-1, minY));
  const center = midpoint(bounds.min, bounds.max);
  return {
    depth: dot(subtract(center, camera), forward),
    coverage: (clippedWidth * clippedHeight) / 4,
    inFrame: clippedWidth > 0 && clippedHeight > 0,
  };
}

function combineBounds(bounds: Bounds[]): Bounds {
  if (bounds.length === 0) return { min: [0, 0, 0], max: [0, 0, 0] };
  return {
    min: [
      Math.min(...bounds.map((value) => value.min[0])),
      Math.min(...bounds.map((value) => value.min[1])),
      Math.min(...bounds.map((value) => value.min[2])),
    ],
    max: [
      Math.max(...bounds.map((value) => value.max[0])),
      Math.max(...bounds.map((value) => value.max[1])),
      Math.max(...bounds.map((value) => value.max[2])),
    ],
  };
}

function boundsFromPoints(points: Vec3[]): Bounds {
  return combineBounds(points.map((point) => ({ min: point, max: point })));
}

function boundsCorners(bounds: Bounds): Vec3[] {
  const points: Vec3[] = [];
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) points.push([x, y, z]);
    }
  }
  return points;
}

function boundsVolume(bounds: Bounds): number {
  return Math.max(0, bounds.max[0] - bounds.min[0]) *
    Math.max(0, bounds.max[1] - bounds.min[1]) *
    Math.max(0, bounds.max[2] - bounds.min[2]);
}

function overlapVolume(left: Bounds, right: Bounds): number {
  return Math.max(0, Math.min(left.max[0], right.max[0]) - Math.max(left.min[0], right.min[0])) *
    Math.max(0, Math.min(left.max[1], right.max[1]) - Math.max(left.min[1], right.min[1])) *
    Math.max(0, Math.min(left.max[2], right.max[2]) - Math.max(left.min[2], right.min[2]));
}

function supportContact(subject: Bounds, support: Bounds): { valid: boolean; gap: number; overlapRatio: number } {
  const gap = subject.min[1] - support.max[1];
  const overlapX = Math.max(0, Math.min(subject.max[0], support.max[0]) - Math.max(subject.min[0], support.min[0]));
  const overlapZ = Math.max(0, Math.min(subject.max[2], support.max[2]) - Math.max(subject.min[2], support.min[2]));
  const subjectArea = Math.max(0, subject.max[0] - subject.min[0]) * Math.max(0, subject.max[2] - subject.min[2]);
  const overlapRatio = subjectArea > 0 ? (overlapX * overlapZ) / subjectArea : 0;
  return { valid: gap >= -0.08 && gap <= 0.12 && overlapRatio >= 0.15, gap, overlapRatio };
}

function subtract(left: Vec3, right: Vec3): Vec3 {
  return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

function midpoint(left: Vec3, right: Vec3): Vec3 {
  return [(left[0] + right[0]) / 2, (left[1] + right[1]) / 2, (left[2] + right[2]) / 2];
}

function dot(left: Vec3, right: Vec3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function cross(left: Vec3, right: Vec3): Vec3 {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0],
  ];
}

function normalize(value: Vec3): Vec3 {
  const length = Math.sqrt(dot(value, value));
  return length > 1e-9 ? [value[0] / length, value[1] / length, value[2] / length] : [1, 0, 0];
}
