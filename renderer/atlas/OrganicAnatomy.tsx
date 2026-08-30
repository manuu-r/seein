import { Html } from "@react-three/drei";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import type { AtlasPoint } from "./types";

function vectors(points: readonly AtlasPoint[]) {
  return points.map(([x, y, z]) => new THREE.Vector3(x, y, z));
}

function tissueTexture(seedValue: number, repeat: readonly [number, number] = [4, 7]) {
  const size = 96;
  const values = new Uint8Array(size * size);
  let seed = Math.abs(Math.trunc(seedValue * 10_000)) + 1;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const coarse = Array.from({ length: 16 * 16 }, random);
  const sample = (x: number, y: number) => {
    const gridX = (x / size) * 16;
    const gridY = (y / size) * 16;
    const x0 = Math.floor(gridX) % 16;
    const y0 = Math.floor(gridY) % 16;
    const x1 = (x0 + 1) % 16;
    const y1 = (y0 + 1) % 16;
    const tx = gridX - Math.floor(gridX);
    const ty = gridY - Math.floor(gridY);
    const smoothX = tx * tx * (3 - 2 * tx);
    const smoothY = ty * ty * (3 - 2 * ty);
    const a = THREE.MathUtils.lerp(coarse[y0 * 16 + x0]!, coarse[y0 * 16 + x1]!, smoothX);
    const b = THREE.MathUtils.lerp(coarse[y1 * 16 + x0]!, coarse[y1 * 16 + x1]!, smoothX);
    return THREE.MathUtils.lerp(a, b, smoothY);
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const broad = sample(x, y);
      const vessels = Math.sin(x * 0.41 + y * 0.17 + seedValue) * 0.08;
      const fine = Math.sin((x - y) * 1.37 + seedValue * 2.1) * 0.035;
      values[y * size + x] = Math.round(THREE.MathUtils.clamp(104 + broad * 68 + (vessels + fine) * 255, 0, 255));
    }
  }
  const texture = new THREE.DataTexture(values, size, size, THREE.RedFormat, THREE.UnsignedByteType);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeat[0], repeat[1]);
  texture.needsUpdate = true;
  return texture;
}

function useTissueTexture(seed: number, repeat: readonly [number, number]) {
  const texture = useMemo(() => tissueTexture(seed, repeat), [repeat[0], repeat[1], seed]);
  useEffect(() => () => texture.dispose(), [texture]);
  return texture;
}

export function OrganicOrgan({
  position = [0, 0, 0],
  rotation = [0, 0, 0],
  scale = [1, 1, 1],
  color,
  opacity = 1,
  roughness = 0.72,
  clearcoat = 0.08,
  irregularity = 0.08,
  seed = 1,
  children,
}: {
  position?: AtlasPoint;
  rotation?: AtlasPoint;
  scale?: AtlasPoint;
  color: string;
  opacity?: number;
  roughness?: number;
  clearcoat?: number;
  irregularity?: number;
  seed?: number;
  children?: React.ReactNode;
}) {
  const texture = useTissueTexture(seed, [3, 4]);
  const geometry = useMemo(() => {
    const result = new THREE.SphereGeometry(1, 64, 40);
    const attribute = result.getAttribute("position") as THREE.BufferAttribute;
    const point = new THREE.Vector3();
    for (let index = 0; index < attribute.count; index += 1) {
      point.fromBufferAttribute(attribute, index);
      const wave = Math.sin(point.x * 5.7 + seed) * Math.cos(point.y * 4.3 - seed * 0.7)
        + Math.sin(point.z * 7.1 + seed * 1.9) * 0.55;
      point.multiplyScalar(1 + wave * irregularity * 0.08);
      attribute.setXYZ(index, point.x, point.y, point.z);
    }
    attribute.needsUpdate = true;
    result.computeVertexNormals();
    return result;
  }, [irregularity, seed]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <group position={position} rotation={rotation} scale={scale}>
      <mesh geometry={geometry} castShadow receiveShadow>
        <meshPhysicalMaterial
          color={color}
          roughness={THREE.MathUtils.clamp(roughness, 0.42, 0.94)}
          clearcoat={THREE.MathUtils.clamp(clearcoat, 0, 0.42)}
          clearcoatRoughness={0.48}
          sheen={0.16}
          sheenRoughness={0.72}
          bumpMap={texture}
          bumpScale={0.018}
          transparent={opacity < 1}
          opacity={opacity}
          depthWrite={opacity > 0.7}
          side={opacity < 1 ? THREE.DoubleSide : THREE.FrontSide}
        />
      </mesh>
      {children}
    </group>
  );
}

/**
 * A closed organic surface whose centreline and elliptical cross-section are
 * supplied by the generated module. Unlike a baked organ asset, this preserves
 * the atlas placement while allowing research-specific morphology to be fully
 * replaced on every accepted generation.
 */
export function ProfiledOrgan({
  points,
  radii,
  color,
  opacity = 1,
  radialSegments = 28,
  segmentsPerSpan = 18,
  roughness = 0.58,
  clearcoat = 0.2,
  seed = 1,
  capFraction = 0.12,
}: {
  points: readonly AtlasPoint[];
  radii: readonly (readonly [number, number])[];
  color: string;
  opacity?: number;
  radialSegments?: number;
  segmentsPerSpan?: number;
  roughness?: number;
  clearcoat?: number;
  seed?: number;
  capFraction?: number;
}) {
  if (points.length < 3 || radii.length !== points.length) {
    throw new Error("ProfiledOrgan requires at least three points and one [radiusX, radiusZ] pair per point");
  }
  const texture = useTissueTexture(seed, [3, 8]);
  const geometry = useMemo(() => {
    const curve = new THREE.CatmullRomCurve3(vectors(points), false, "centripetal", 0.45);
    const tubularSegments = Math.max(12, (points.length - 1) * segmentsPerSpan);
    const frames = curve.computeFrenetFrames(tubularSegments, false);
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const centre = new THREE.Vector3();
    const offset = new THREE.Vector3();
    for (let ring = 0; ring <= tubularSegments; ring += 1) {
      const t = ring / tubularSegments;
      curve.getPointAt(t, centre);
      const scaled = t * (radii.length - 1);
      const lower = Math.min(radii.length - 2, Math.floor(scaled));
      const blend = scaled - lower;
      const resolvedCapFraction = THREE.MathUtils.clamp(capFraction, 0.04, 0.24);
      const capProgress = Math.min(t / resolvedCapFraction, (1 - t) / resolvedCapFraction, 1);
      const capScale = Math.pow(Math.sin(Math.max(0, capProgress) * Math.PI * 0.5), 0.52);
      const radiusX = THREE.MathUtils.lerp(radii[lower]![0], radii[lower + 1]![0], blend) * capScale;
      const radiusZ = THREE.MathUtils.lerp(radii[lower]![1], radii[lower + 1]![1], blend) * capScale;
      for (let side = 0; side <= radialSegments; side += 1) {
        const angle = (side / radialSegments) * Math.PI * 2;
        offset.copy(frames.normals[ring]!).multiplyScalar(Math.cos(angle) * radiusX);
        offset.addScaledVector(frames.binormals[ring]!, Math.sin(angle) * radiusZ);
        positions.push(centre.x + offset.x, centre.y + offset.y, centre.z + offset.z);
        offset.normalize();
        normals.push(offset.x, offset.y, offset.z);
        uvs.push(t, side / radialSegments);
      }
    }
    const columns = radialSegments + 1;
    for (let ring = 0; ring < tubularSegments; ring += 1) {
      for (let side = 0; side < radialSegments; side += 1) {
        const a = ring * columns + side;
        const b = (ring + 1) * columns + side;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    const startPole = positions.length / 3;
    curve.getPointAt(0, centre);
    positions.push(centre.x, centre.y, centre.z);
    normals.push(...frames.tangents[0]!.clone().multiplyScalar(-1).toArray());
    uvs.push(0, 0.5);
    const endPole = positions.length / 3;
    curve.getPointAt(1, centre);
    positions.push(centre.x, centre.y, centre.z);
    normals.push(...frames.tangents[tubularSegments]!.toArray());
    uvs.push(1, 0.5);
    const lastRing = tubularSegments * columns;
    for (let side = 0; side < radialSegments; side += 1) {
      indices.push(startPole, side + 1, side);
      indices.push(endPole, lastRing + side, lastRing + side + 1);
    }
    const result = new THREE.BufferGeometry();
    result.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    result.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    result.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    result.setIndex(indices);
    result.computeVertexNormals();
    result.computeBoundingSphere();
    return result;
  }, [capFraction, points, radii, radialSegments, segmentsPerSpan]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh geometry={geometry} castShadow receiveShadow>
      <meshPhysicalMaterial
        color={color}
        roughness={THREE.MathUtils.clamp(roughness, 0.34, 0.92)}
        clearcoat={THREE.MathUtils.clamp(clearcoat, 0, 0.52)}
        clearcoatRoughness={0.46}
        sheen={0.14}
        sheenRoughness={0.7}
        bumpMap={texture}
        bumpScale={0.014}
        transparent={opacity < 1}
        opacity={opacity}
        depthWrite={opacity > 0.7}
        side={opacity < 1 ? THREE.DoubleSide : THREE.FrontSide}
      />
    </mesh>
  );
}

/**
 * A smooth closed volume lofted through model-authored control rings. This is
 * the general replacement surface used when a recognisable organ cannot be
 * represented by a sphere or a centreline profile. The atlas supplies scale
 * and registration; each generated module supplies all rings and therefore the
 * request-specific silhouette, asymmetry, visceral impressions, and cut edge.
 */
export function LoftedOrgan({
  rings,
  color,
  opacity = 1,
  segmentsPerSpan = 8,
  radialSegments = 48,
  roughness = 0.64,
  clearcoat = 0.16,
  bumpScale = 0.022,
  irregularity = 0.025,
  seed = 1,
}: {
  rings: readonly (readonly AtlasPoint[])[];
  color: string;
  opacity?: number;
  segmentsPerSpan?: number;
  radialSegments?: number;
  roughness?: number;
  clearcoat?: number;
  bumpScale?: number;
  irregularity?: number;
  seed?: number;
}) {
  const sides = rings[0]?.length ?? 0;
  if (rings.length < 3 || sides < 6 || rings.some((ring) => ring.length !== sides)) {
    throw new Error("LoftedOrgan requires at least three equal control rings with at least six points each");
  }
  const texture = useTissueTexture(seed, [5, 5]);
  const geometry = useMemo(() => {
    const longitudinalSegments = Math.max(12, (rings.length - 1) * segmentsPerSpan);
    const sideCurves = Array.from({ length: sides }, (_, side) =>
      new THREE.CatmullRomCurve3(
        rings.map((ring) => new THREE.Vector3(...ring[side]!)),
        false,
        "centripetal",
        0.45,
      ));
    const resolvedRadialSegments = Math.max(24, radialSegments);
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const centre = new THREE.Vector3();
    const point = new THREE.Vector3();
    const sampled = new THREE.Vector3();
    for (let span = 0; span <= longitudinalSegments; span += 1) {
      const t = span / longitudinalSegments;
      const controlRing = sideCurves.map((curve) => curve.getPointAt(t, sampled.clone()));
      const radialCurve = new THREE.CatmullRomCurve3(controlRing, true, "centripetal", 0.45);
      centre.set(0, 0, 0);
      for (const controlPoint of controlRing) centre.add(controlPoint);
      centre.multiplyScalar(1 / sides);
      for (let side = 0; side <= resolvedRadialSegments; side += 1) {
        const radialT = side / resolvedRadialSegments;
        radialCurve.getPointAt(radialT % 1, point);
        const wave = Math.sin(t * Math.PI * 7 + radialT * Math.PI * 6 + seed) * irregularity
          + Math.cos(t * Math.PI * 3 - radialT * Math.PI * 4 + seed * 0.7) * irregularity * 0.45;
        point.lerp(centre, -wave);
        positions.push(point.x, point.y, point.z);
        uvs.push(radialT, t);
      }
    }
    const columns = resolvedRadialSegments + 1;
    for (let span = 0; span < longitudinalSegments; span += 1) {
      for (let side = 0; side < resolvedRadialSegments; side += 1) {
        const a = span * columns + side;
        const b = (span + 1) * columns + side;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    const startPole = positions.length / 3;
    centre.set(0, 0, 0);
    for (const pointValue of rings[0]!) centre.add(new THREE.Vector3(...pointValue));
    centre.multiplyScalar(1 / sides);
    positions.push(centre.x, centre.y, centre.z);
    uvs.push(0.5, 0);
    const endPole = positions.length / 3;
    centre.set(0, 0, 0);
    for (const pointValue of rings[rings.length - 1]!) centre.add(new THREE.Vector3(...pointValue));
    centre.multiplyScalar(1 / sides);
    positions.push(centre.x, centre.y, centre.z);
    uvs.push(0.5, 1);
    const lastRing = longitudinalSegments * columns;
    for (let side = 0; side < resolvedRadialSegments; side += 1) {
      indices.push(startPole, side + 1, side);
      indices.push(endPole, lastRing + side, lastRing + side + 1);
    }
    const result = new THREE.BufferGeometry();
    result.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    result.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    result.setIndex(indices);
    result.computeVertexNormals();
    result.computeBoundingSphere();
    return result;
  }, [irregularity, radialSegments, rings, seed, segmentsPerSpan, sides]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh geometry={geometry} castShadow receiveShadow>
      <meshPhysicalMaterial
        color={color}
        roughness={THREE.MathUtils.clamp(roughness, 0.42, 0.94)}
        clearcoat={THREE.MathUtils.clamp(clearcoat, 0, 0.42)}
        clearcoatRoughness={0.58}
        sheen={0.13}
        sheenColor="#d58a78"
        sheenRoughness={0.74}
        bumpMap={texture}
        bumpScale={THREE.MathUtils.clamp(bumpScale, 0, 0.035)}
        transparent={opacity < 1}
        opacity={opacity}
        depthWrite={opacity > 0.7}
        side={opacity < 1 ? THREE.DoubleSide : THREE.FrontSide}
      />
    </mesh>
  );
}

/** A curved rectangular tissue field authored as anatomically measured rows. */
export function SculptedSheet({
  rows,
  color,
  opacity = 0.72,
  roughness = 0.82,
  clearcoat = 0.1,
  bumpScale = 0.014,
  seed = 1,
}: {
  rows: readonly (readonly AtlasPoint[])[];
  color: string;
  opacity?: number;
  roughness?: number;
  clearcoat?: number;
  bumpScale?: number;
  seed?: number;
}) {
  const columns = rows[0]?.length ?? 0;
  if (rows.length < 2 || columns < 3 || rows.some((row) => row.length !== columns)) {
    throw new Error("SculptedSheet requires at least two equal rows with at least three points each");
  }
  const texture = useTissueTexture(seed, [4, 4]);
  const geometry = useMemo(() => {
    const positions = rows.flatMap((row) => row.flatMap((point) => [...point]));
    const uvs: number[] = [];
    const indices: number[] = [];
    for (let row = 0; row < rows.length; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        uvs.push(column / (columns - 1), row / (rows.length - 1));
      }
    }
    for (let row = 0; row < rows.length - 1; row += 1) {
      for (let column = 0; column < columns - 1; column += 1) {
        const a = row * columns + column;
        const b = (row + 1) * columns + column;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    const result = new THREE.BufferGeometry();
    result.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    result.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    result.setIndex(indices);
    result.computeVertexNormals();
    result.computeBoundingSphere();
    return result;
  }, [columns, rows]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh geometry={geometry} receiveShadow>
      <meshPhysicalMaterial
        color={color}
        roughness={THREE.MathUtils.clamp(roughness, 0.44, 0.96)}
        clearcoat={THREE.MathUtils.clamp(clearcoat, 0, 0.4)}
        clearcoatRoughness={0.64}
        sheen={0.12}
        sheenColor="#e3a493"
        bumpMap={texture}
        bumpScale={THREE.MathUtils.clamp(bumpScale, 0, 0.03)}
        transparent={opacity < 1}
        opacity={opacity}
        depthWrite={opacity > 0.72}
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

export function TaperedTube({
  points,
  radii,
  color,
  opacity = 1,
  radialSegments = 18,
  segmentsPerSpan = 16,
  roughness = 0.55,
  clearcoat = 0.12,
  seed = 1,
}: {
  points: readonly AtlasPoint[];
  radii: readonly number[];
  color: string;
  opacity?: number;
  radialSegments?: number;
  segmentsPerSpan?: number;
  roughness?: number;
  clearcoat?: number;
  seed?: number;
}) {
  if (points.length < 2 || radii.length !== points.length) {
    throw new Error("TaperedTube requires at least two points and one radius per point");
  }
  const texture = useTissueTexture(seed, [2, 10]);
  const geometry = useMemo(() => {
    const curve = new THREE.CatmullRomCurve3(vectors(points), false, "centripetal", 0.45);
    const tubularSegments = Math.max(8, (points.length - 1) * segmentsPerSpan);
    const positions: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const frames = curve.computeFrenetFrames(tubularSegments, false);
    const sample = new THREE.Vector3();
    const normal = new THREE.Vector3();
    for (let ring = 0; ring <= tubularSegments; ring += 1) {
      const t = ring / tubularSegments;
      curve.getPointAt(t, sample);
      const scaled = t * (radii.length - 1);
      const lower = Math.min(radii.length - 2, Math.floor(scaled));
      const radius = THREE.MathUtils.lerp(radii[lower]!, radii[lower + 1]!, scaled - lower);
      for (let side = 0; side <= radialSegments; side += 1) {
        const angle = (side / radialSegments) * Math.PI * 2;
        normal.copy(frames.normals[ring]!).multiplyScalar(Math.cos(angle));
        normal.addScaledVector(frames.binormals[ring]!, Math.sin(angle)).normalize();
        positions.push(sample.x + normal.x * radius, sample.y + normal.y * radius, sample.z + normal.z * radius);
        normals.push(normal.x, normal.y, normal.z);
        uvs.push(t, side / radialSegments);
      }
    }
    const columns = radialSegments + 1;
    for (let ring = 0; ring < tubularSegments; ring += 1) {
      for (let side = 0; side < radialSegments; side += 1) {
        const a = ring * columns + side;
        const b = (ring + 1) * columns + side;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    const result = new THREE.BufferGeometry();
    result.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    result.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    result.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    result.setIndex(indices);
    result.computeBoundingSphere();
    return result;
  }, [points, radialSegments, radii, segmentsPerSpan]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh geometry={geometry} castShadow>
      <meshPhysicalMaterial
        color={color}
        roughness={THREE.MathUtils.clamp(roughness, 0.38, 0.92)}
        clearcoat={THREE.MathUtils.clamp(clearcoat, 0, 0.48)}
        clearcoatRoughness={0.52}
        sheen={0.08}
        sheenRoughness={0.68}
        bumpMap={texture}
        bumpScale={0.006}
        transparent={opacity < 1}
        opacity={opacity}
        depthWrite={opacity > 0.68}
      />
    </mesh>
  );
}

export function MembraneSheet({
  points,
  color,
  opacity = 0.32,
}: {
  points: readonly AtlasPoint[];
  color: string;
  opacity?: number;
}) {
  const geometry = useMemo(() => {
    if (points.length < 3) throw new Error("MembraneSheet requires at least three boundary points");
    const positions = points.flatMap((point) => [...point]);
    const indices: number[] = [];
    for (let index = 1; index < points.length - 1; index += 1) indices.push(0, index, index + 1);
    const result = new THREE.BufferGeometry();
    result.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    result.setIndex(indices);
    result.computeVertexNormals();
    return result;
  }, [points]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh geometry={geometry} receiveShadow>
      <meshPhysicalMaterial color={color} roughness={0.86} transparent opacity={opacity} depthWrite={false} side={THREE.DoubleSide} />
    </mesh>
  );
}

export function AnatomyLabel({
  position,
  children,
  accent = "#85d8d0",
  visible = true,
}: {
  position: AtlasPoint;
  children: React.ReactNode;
  accent?: string;
  visible?: boolean;
}) {
  if (!visible) return null;
  return (
    <Html position={position} center transform={false} occlude={false} style={{ pointerEvents: "none" }}>
      <div style={{
        color: "#eef8f6",
        background: "rgba(6, 18, 21, 0.88)",
        border: `1px solid ${accent}99`,
        borderRadius: 999,
        padding: "5px 9px",
        font: "600 11px/1.1 Inter, system-ui, sans-serif",
        letterSpacing: "0.025em",
        whiteSpace: "nowrap",
        boxShadow: "0 6px 20px rgba(0,0,0,.28)",
      }}>{children}</div>
    </Html>
  );
}
