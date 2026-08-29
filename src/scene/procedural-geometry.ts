import {
  BoxGeometry,
  BufferGeometry,
  CapsuleGeometry,
  CatmullRomCurve3,
  ConeGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Float32BufferAttribute,
  LatheGeometry,
  MathUtils,
  Shape,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from "three";
import type { Vec3 } from "../contracts.js";

export type ProceduralPrimitiveShape = "box" | "sphere" | "cylinder" | "cone" | "torus" | "capsule";

export interface TaperedTubeControl {
  position: Vector3;
  radius: number;
}

/** Shared by server measurement and browser construction; one implementation is the geometry contract. */
export function createSizedPrimitiveGeometry(
  shape: ProceduralPrimitiveShape,
  size: Vec3,
  segments: number,
): BufferGeometry {
  let geometry: BufferGeometry;
  if (shape === "box") geometry = new BoxGeometry(1, 1, 1);
  else if (shape === "sphere") geometry = new SphereGeometry(0.5, segments, Math.max(6, Math.floor(segments / 2)));
  else if (shape === "cylinder") geometry = new CylinderGeometry(0.5, 0.5, 1, segments);
  else if (shape === "cone") geometry = new ConeGeometry(0.5, 1, segments);
  else if (shape === "torus") geometry = new TorusGeometry(0.34, 0.16, Math.max(6, Math.floor(segments / 2)), segments);
  else geometry = new CapsuleGeometry(0.25, 0.5, Math.max(2, Math.floor(segments / 8)), segments);
  geometry.computeBoundingBox();
  const current = geometry.boundingBox!.getSize(new Vector3());
  geometry.scale(size[0] / current.x, size[1] / current.y, size[2] / current.z);
  geometry.center();
  geometry.computeBoundingBox();
  return geometry;
}

export function createProceduralExtrusionGeometry(
  outline: Array<[number, number]>,
  depth: number,
  bevel: number,
): BufferGeometry {
  const shape = new Shape();
  shape.moveTo(outline[0]![0], outline[0]![1]);
  for (const [x, y] of outline.slice(1)) shape.lineTo(x, y);
  shape.closePath();
  const geometry = new ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: bevel > 0,
    bevelSize: bevel,
    bevelThickness: bevel,
    bevelSegments: bevel > 0 ? 2 : 0,
    curveSegments: 2,
  });
  geometry.computeBoundingBox();
  return geometry;
}

export function createProceduralLatheGeometry(profile: Array<[number, number]>, segments: number): BufferGeometry {
  const geometry = new LatheGeometry(profile.map(([radius, y]) => new Vector2(radius, y)), segments);
  geometry.computeBoundingBox();
  return geometry;
}

export function createTaperedTubeGeometry(
  controls: TaperedTubeControl[],
  tubularSegments: number,
  radialSegments: number,
  closed: boolean,
): BufferGeometry {
  const curve = new CatmullRomCurve3(controls.map((point) => point.position), closed, "centripetal");
  const frames = curve.computeFrenetFrames(tubularSegments, closed);
  const vertices: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const normal = new Vector3();
  const vertex = new Vector3();

  for (let segment = 0; segment <= tubularSegments; segment += 1) {
    const t = segment / tubularSegments;
    const point = curve.getPointAt(t);
    const sample = t * (controls.length - 1);
    const left = Math.min(controls.length - 1, Math.floor(sample));
    const right = Math.min(controls.length - 1, left + 1);
    const radius = MathUtils.lerp(controls[left]!.radius, controls[right]!.radius, sample - left);
    for (let side = 0; side <= radialSegments; side += 1) {
      const angle = (side / radialSegments) * Math.PI * 2;
      normal.copy(frames.normals[segment]!).multiplyScalar(Math.cos(angle));
      normal.addScaledVector(frames.binormals[segment]!, Math.sin(angle)).normalize();
      vertex.copy(point).addScaledVector(normal, radius);
      vertices.push(vertex.x, vertex.y, vertex.z);
      normals.push(normal.x, normal.y, normal.z);
      uvs.push(t, side / radialSegments);
    }
  }
  for (let segment = 0; segment < tubularSegments; segment += 1) {
    for (let side = 0; side < radialSegments; side += 1) {
      const a = (radialSegments + 1) * segment + side;
      const b = (radialSegments + 1) * (segment + 1) + side;
      const c = b + 1;
      const d = a + 1;
      indices.push(a, b, d, b, c, d);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setIndex(indices);
  geometry.setAttribute("position", new Float32BufferAttribute(vertices, 3));
  geometry.setAttribute("normal", new Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
