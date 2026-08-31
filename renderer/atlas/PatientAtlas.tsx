// @ts-nocheck -- Imported from the working surgical-atlas reference. It is
// compiled by esbuild; the source project intentionally uses looser indexed
// access checks than SeeIn's server packages.
import { Canvas, useFrame, useLoader, useThree } from "@react-three/fiber";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import * as THREE from "three";
import { acceleratedRaycast, CENTER, MeshBVH } from "three-mesh-bvh";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import { OperatingRoom, OPERATING_ROOM_BOUNDS } from "./OperatingRoom";
import type { OperatingRoomState, OperatingRoomUpdate } from "./OperatingRoomState";

type SceneProps = {
  step: number;
  transparentWall: boolean;
  showLabels: boolean;
  resetView: number;
  roomState: OperatingRoomState;
  onRoomChange: (update: OperatingRoomUpdate) => void;
};

export type Point = readonly [number, number, number];

const PALETTE = {
  ileum: "#a8645f",
  ileumLight: "#b97870",
  colon: "#80534e",
  colonLight: "#97635c",
  mucosa: "#b92f49",
  mucosaLight: "#e15368",
  mucosaDark: "#4e0f22",
  mesentery: "#bea06d",
  mesenteryDeep: "#9b7150",
  artery: "#b8393d",
  vein: "#555f83",
  skin: "#c88f77",
  fat: "#d8b74f",
  fascia: "#d7c8b5",
  rectus: "#7b3438",
  peritoneum: "#936963",
  proximal: "#2f827a",
  distal: "#b46d43",
  drape: "#124c50",
};

// The camera sits slightly caudal of the target. With Z as the room's true up
// axis this keeps cephalad at the top of the image while allowing a genuine
// 360-degree turntable around the supine patient.
const DEFAULT_CAMERA = new THREE.Vector3(0.25, -7.55, 22.1);
const DEFAULT_TARGET = new THREE.Vector3(0, 0.1, -0.72);
// The 13.4-unit MakeHuman shell represents an approximately 175 cm adult.
// These anisotropic factors fit the 7-unit procedural abdomen into a roughly
// 34 cm transverse cavity and a 50–55 cm diaphragm-to-pelvis span.
const PROCEDURE_SCALE = 0.36;
const PROCEDURE_SCALE_Y = 0.58;
const PROCEDURE_SCALE_Z = 0.5;
const ANATOMY_CRANIAL_SHIFT = 0.32;
const ANATOMY_DEPTH_SHIFT = -0.42;
// Preserve the previously calibrated proportions while enlarging the complete
// internal-organ assembly by 20% for clearer operative context.
const INTERNAL_ORGAN_SCALE = 0.6;
const INTERNAL_ORGAN_WIDTH_SCALE = INTERNAL_ORGAN_SCALE * 1.2;
// The shell's posterior surface is -1.803 before this offset and the mattress
// top is -2.57, leaving a small compression allowance instead of an air gap.
const PATIENT_SUPPORT_Z = -0.73;
const INTERNAL_CONTENT_OFFSET: Point = [0, 0.5, 1.5];
const ABDOMINAL_CONTENT_OFFSET: Point = [0, 0.82, 1.5];
const GI_CONTENT_OFFSET: Point = [0, 1.15, 1.5];
const PELVIC_BONE_CRANIAL_SHIFT = 2.05;
const THORACIC_SCALE_PIVOT: Point = [0, 4.25, -1.75];
const ABDOMINAL_SCALE_PIVOT: Point = [0, 1.25, -1.72];
const GI_SCALE_PIVOT: Point = [0, 0.1, -1.15];
// Keep every trephine-dependent structure on one shared coordinate. Moving the
// center therefore moves the wall tract, delivered loop, mature stoma, labels,
// appliance, and continuity joins together instead of creating a skin clip.
const STOMA_CENTER: [number, number] = [-1.95, 0.7];
const MATURE_STOMA_SCALE = 0.65;
const MATURE_STOMA_SURFACE_Z = 0.53;

function makeTissueBumpTexture() {
  const size = 64;
  const values = new Uint8Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const broad = Math.sin(x * 0.61) * 13 + Math.cos(y * 0.47) * 11;
      const fine = Math.sin((x + y) * 1.73) * 7 + Math.cos((x - y) * 1.31) * 5;
      values[y * size + x] = Math.max(0, Math.min(255, 128 + broad + fine));
    }
  }
  const texture = new THREE.DataTexture(values, size, size, THREE.RedFormat, THREE.UnsignedByteType);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(4, 12);
  texture.needsUpdate = true;
  return texture;
}

const TISSUE_BUMP = makeTissueBumpTexture();

function makeDrapeWeaveTexture() {
  const size = 96;
  const values = new Uint8Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const warp = Math.sin(x * Math.PI * 0.5) * 16;
      const weft = Math.sin(y * Math.PI * 0.5) * 13;
      const softFold = Math.sin((x + y) * 0.17) * 7;
      values[y * size + x] = Math.max(0, Math.min(255, 128 + warp + weft + softFold));
    }
  }
  const texture = new THREE.DataTexture(values, size, size, THREE.RedFormat, THREE.UnsignedByteType);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(15, 24);
  texture.needsUpdate = true;
  return texture;
}

const DRAPE_WEAVE = makeDrapeWeaveTexture();

function vectors(points: readonly Point[]) {
  return points.map(([x, y, z]) => new THREE.Vector3(x, y, z));
}

function curveFrom(points: readonly Point[], closed = false) {
  return new THREE.CatmullRomCurve3(vectors(points), closed, "centripetal", 0.44);
}

function scalePointAbout([x, y, z]: Point, [px, py, pz]: Point, offset: Point = [0, 0, 0]): Point {
  return [
    offset[0] + px + (x - px) * INTERNAL_ORGAN_WIDTH_SCALE,
    offset[1] + py + (y - py) * INTERNAL_ORGAN_SCALE,
    offset[2] + pz + (z - pz) * INTERNAL_ORGAN_SCALE,
  ];
}

function scaleGiPoint(point: Point) {
  return scalePointAbout(point, GI_SCALE_PIVOT, GI_CONTENT_OFFSET);
}

function scaleGiPoints(points: readonly Point[]) {
  return points.map(scaleGiPoint);
}

function ScaleInternalContents({ pivot, children, offset = INTERNAL_CONTENT_OFFSET }: { pivot: Point; children: ReactNode; offset?: Point }) {
  return (
    <group position={offset}>
      <group position={pivot} scale={[INTERNAL_ORGAN_WIDTH_SCALE, INTERNAL_ORGAN_SCALE, INTERNAL_ORGAN_SCALE]}>
        <group position={[-pivot[0], -pivot[1], -pivot[2]]}>{children}</group>
      </group>
    </group>
  );
}

const CAMERA_PRESETS = [
  { position: DEFAULT_CAMERA, target: DEFAULT_TARGET },
  { position: new THREE.Vector3(-0.45, -0.3, 9.8), target: new THREE.Vector3(-0.68, 0.5, -0.18) },
  { position: new THREE.Vector3(-0.4, -0.3, 9.6), target: new THREE.Vector3(-0.68, 0.5, 0.25) },
  { position: new THREE.Vector3(-0.45, -0.3, 9.4), target: new THREE.Vector3(-0.68, 0.5, 0.45) },
  { position: new THREE.Vector3(-0.62, -1.0, 7.0), target: new THREE.Vector3(-0.7, 0.52, 0.72) },
  { position: new THREE.Vector3(-0.62, -1.0, 7.0), target: new THREE.Vector3(-0.7, 0.52, 0.72) },
  { position: new THREE.Vector3(-0.62, -1.0, 7.0), target: new THREE.Vector3(-0.7, 0.52, 0.72) },
  { position: new THREE.Vector3(-0.62, -1.0, 7.0), target: new THREE.Vector3(-0.7, 0.52, 0.72) },
  { position: DEFAULT_CAMERA, target: DEFAULT_TARGET },
  { position: new THREE.Vector3(-0.7, -1.8, 9.0), target: new THREE.Vector3(-0.72, -0.42, 0.3) },
] as const;

function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => setPrefersReducedMotion(query.matches);
    updatePreference();
    query.addEventListener("change", updatePreference);
    return () => query.removeEventListener("change", updatePreference);
  }, []);

  return prefersReducedMotion;
}

function CameraControls({ resetView, step }: { resetView: number; step: number }) {
  const { camera, gl } = useThree();
  const controls = useMemo(() => new OrbitControls(camera, gl.domElement), [camera, gl]);
  const prefersReducedMotion = usePrefersReducedMotion();
  const transition = useRef({
    active: false,
    elapsed: 0,
    duration: 0.9,
    startPosition: new THREE.Vector3(),
    startTarget: new THREE.Vector3(),
    endPosition: new THREE.Vector3(),
    endTarget: new THREE.Vector3(),
  });

  useEffect(() => {
    camera.up.set(0, 0, -1);
    controls.enableDamping = true;
    controls.dampingFactor = 0.075;
    controls.enablePan = false;
    controls.minDistance = 8;
    controls.maxDistance = 30;
    controls.minPolarAngle = Math.PI - 1.43;
    controls.maxPolarAngle = Math.PI - 0.08;
    controls.minAzimuthAngle = -Infinity;
    controls.maxAzimuthAngle = Infinity;
    controls.target.copy(DEFAULT_TARGET);
    controls.saveState();
    const cancelTransition = () => { transition.current.active = false; };
    controls.addEventListener("start", cancelTransition);
    return () => {
      controls.removeEventListener("start", cancelTransition);
      controls.dispose();
    };
  }, [controls]);

  useEffect(() => {
    const preset = CAMERA_PRESETS[step];
    if (prefersReducedMotion) {
      transition.current.active = false;
      camera.position.copy(preset.position);
      controls.target.copy(preset.target);
      controls.update();
      return;
    }
    transition.current.startPosition.copy(camera.position);
    transition.current.startTarget.copy(controls.target);
    transition.current.endPosition.copy(preset.position);
    transition.current.endTarget.copy(preset.target);
    transition.current.elapsed = 0;
    transition.current.duration = step === 8 ? 1.15 : 0.9;
    transition.current.active = true;
  }, [camera, controls, prefersReducedMotion, resetView, step]);

  useFrame((_, delta) => {
    const state = transition.current;
    if (state.active) {
      state.elapsed = Math.min(state.duration, state.elapsed + delta);
      const progress = state.elapsed / state.duration;
      const eased = 1 - Math.pow(1 - progress, 3);
      camera.position.lerpVectors(state.startPosition, state.endPosition, eased);
      controls.target.lerpVectors(state.startTarget, state.endTarget, eased);
      if (progress >= 1) state.active = false;
    }
    controls.update();
    // Keep the camera inside the sealed room and always above floor/table
    // level. Z-up makes azimuth a true turntable around the patient; the polar
    // ceiling ends above 90 degrees, so an underside view cannot be reached.
    camera.position.x = THREE.MathUtils.clamp(camera.position.x, -OPERATING_ROOM_BOUNDS.halfWidth + 0.8, OPERATING_ROOM_BOUNDS.halfWidth - 0.8);
    camera.position.y = THREE.MathUtils.clamp(camera.position.y, -OPERATING_ROOM_BOUNDS.halfLength + 0.8, OPERATING_ROOM_BOUNDS.halfLength - 0.8);
    camera.position.z = THREE.MathUtils.clamp(camera.position.z, controls.target.z + 4.0, OPERATING_ROOM_BOUNDS.ceilingZ - 3.0);
    controls.target.x = THREE.MathUtils.clamp(controls.target.x, -3.2, 3.2);
    controls.target.y = THREE.MathUtils.clamp(controls.target.y, -5.8, 7.7);
    controls.target.z = THREE.MathUtils.clamp(controls.target.z, -2.1, 1.6);
    camera.lookAt(controls.target);
    camera.rotateZ(Math.PI);
  });
  return null;
}

type TubeProps = {
  points: readonly Point[];
  radius: number;
  color: string;
  opacity?: number;
  radialSegments?: number;
  tubularSegments?: number;
  clearcoat?: number;
  roughness?: number;
  renderOrder?: number;
  endCaps?: boolean;
};

export function TissueTube({
  points,
  radius,
  color,
  opacity = 1,
  radialSegments = 16,
  tubularSegments = 96,
  clearcoat = 0.08,
  roughness = 0.7,
  renderOrder,
  endCaps = false,
}: TubeProps) {
  const geometry = useMemo(
    () => new THREE.TubeGeometry(curveFrom(points), tubularSegments, radius, radialSegments, false),
    [points, radius, radialSegments, tubularSegments],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <group renderOrder={renderOrder}>
      <mesh geometry={geometry} castShadow receiveShadow>
        <meshPhysicalMaterial
          color={color}
          roughness={roughness}
          clearcoat={clearcoat}
          clearcoatRoughness={0.36}
          bumpMap={TISSUE_BUMP}
          bumpScale={0.012}
          transparent={opacity < 1}
          opacity={opacity}
          depthWrite={opacity > 0.66}
        />
      </mesh>
      {endCaps && points.map((point, index) => (
        <mesh key={index} position={point} scale={[1, 1, 0.92]}>
          <sphereGeometry args={[radius, radialSegments, Math.max(8, radialSegments - 4)]} />
          <meshPhysicalMaterial color={color} roughness={roughness} clearcoat={clearcoat} transparent={opacity < 1} opacity={opacity} />
        </mesh>
      ))}
    </group>
  );
}

export function EquipmentTube({
  points,
  radius,
  color,
  opacity = 1,
  tubularSegments = 72,
  radialSegments = 12,
  closed = false,
  renderOrder,
}: {
  points: readonly Point[];
  radius: number;
  color: string;
  opacity?: number;
  tubularSegments?: number;
  radialSegments?: number;
  closed?: boolean;
  renderOrder?: number;
}) {
  const geometry = useMemo(
    () => new THREE.TubeGeometry(curveFrom(points, closed), tubularSegments, radius, radialSegments, closed),
    [closed, points, radialSegments, radius, tubularSegments],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <mesh geometry={geometry} renderOrder={renderOrder} castShadow={opacity > 0.7}>
      <meshPhysicalMaterial
        color={color}
        roughness={0.42}
        clearcoat={0.12}
        clearcoatRoughness={0.34}
        transparent={opacity < 1}
        opacity={opacity}
        depthWrite={opacity > 0.68}
      />
    </mesh>
  );
}

// Reaches just past the mattress edge at 3.6 so the sheet breaks over it.
const DRAPE_HALF_WIDTH = 3.62;
// The drape is built in world space, where the shell's soles sit at about
// y -6.55; the previous -6.48 hem stopped a whisker short of them, which is
// what left the toes out. This clears them and lets the sheet fall off the
// foot end of the table.
const DRAPE_CAUDAL_Y = -7.2;
const DRAPE_CRANIAL_Y = 0.18;
const MATTRESS_TOP_Z = -2.57;

export type PatientDrapeData = {
  geometry: THREE.BufferGeometry;
  surfacePoint: (u: number, y: number, clearance?: number) => Point;
};

const PATIENT_DRAPE_CACHE = new WeakMap<THREE.Group, PatientDrapeData | null>();
const PATIENT_RAYCAST_BVH_CACHE = new WeakMap<THREE.BufferGeometry, MeshBVH>();

function enableAcceleratedPatientRaycast(mesh: THREE.Mesh<THREE.BufferGeometry>): void {
  const geometry = mesh.geometry as THREE.BufferGeometry & { boundsTree?: MeshBVH };
  let boundsTree = PATIENT_RAYCAST_BVH_CACHE.get(geometry);
  if (!boundsTree) {
    // indirect keeps the source OBJ index order byte-for-byte intact. The BVH
    // changes only ray-query acceleration, never rendered vertex placement.
    boundsTree = new MeshBVH(geometry, { strategy: CENTER, indirect: true });
    PATIENT_RAYCAST_BVH_CACHE.set(geometry, boundsTree);
  }
  geometry.boundsTree = boundsTree;
  mesh.raycast = acceleratedRaycast;
}

export function makePatientContouredDrape(
  source: THREE.Group,
  { useBvh = true }: { useBvh?: boolean } = {},
) {
  const body = source.getObjectByName("body") as THREE.Mesh | undefined;
  if (!body || !(body.geometry instanceof THREE.BufferGeometry)) return null;

  body.geometry.computeBoundingBox();
  const bodyBox = body.geometry.boundingBox!;
  const bodySize = bodyBox.getSize(new THREE.Vector3());
  const bodyCenter = bodyBox.getCenter(new THREE.Vector3());
  const patientScale = 13.4 / bodySize.y;
  const patientMesh = new THREE.Mesh(
    body.geometry,
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
  );
  patientMesh.position.set(
    -bodyCenter.x * patientScale,
    0.15 - bodyCenter.y * patientScale,
    0.18 - 1.45 * patientScale + PATIENT_SUPPORT_Z,
  );
  patientMesh.scale.set(patientScale * 1.32, patientScale, patientScale);
  patientMesh.updateMatrixWorld(true);
  if (useBvh) enableAcceleratedPatientRaycast(patientMesh);

  const xSegments = 44;
  // Holds the previous longitudinal density over the slightly longer run.
  const ySegments = 40;
  const columns = xSegments + 1;
  const rows = ySegments + 1;
  const surfaceRows: number[][] = [];
  const rowExtents: Array<{ min: number; max: number } | null> = [];
  const raycaster = new THREE.Raycaster();
  if (useBvh) (raycaster as THREE.Raycaster & { firstHitOnly?: boolean }).firstHitOnly = true;
  const rayDirection = new THREE.Vector3(0, 0, -1);
  const vertices: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  const hitAt = (x: number, y: number) => {
    raycaster.set(new THREE.Vector3(x, y, 3.5), rayDirection);
    return raycaster.intersectObject(patientMesh, false)[0]?.point.z ?? null;
  };

  // A surgical drape is a rectangular sheet laid over the patient and hanging
  // over both sides of the table — not a cover cut to the body's outline. The
  // silhouette scan that used to set the width is gone with it, which also
  // pays for the finer lateral sampling the wider span needs.
  for (let row = 0; row < rows; row += 1) {
    rowExtents.push({ min: -DRAPE_HALF_WIDTH, max: DRAPE_HALF_WIDTH });
  }

  // A light longitudinal smoothing removes voxel-like steps from the sampled
  // silhouette while preserving the separate-leg width below the pelvis.
  const smoothedExtents = rowExtents.map((_, row) => {
    let min = 0;
    let max = 0;
    let weight = 0;
    for (let neighbor = Math.max(0, row - 2); neighbor <= Math.min(rows - 1, row + 2); neighbor += 1) {
      const localWeight = neighbor === row ? 3 : Math.abs(neighbor - row) === 1 ? 2 : 1;
      min += rowExtents[neighbor]!.min * localWeight;
      max += rowExtents[neighbor]!.max * localWeight;
      weight += localWeight;
    }
    return { min: min / weight, max: max / weight };
  });

  for (let row = 0; row < rows; row += 1) {
    const v = row / ySegments;
    const y = THREE.MathUtils.lerp(DRAPE_CAUDAL_Y, DRAPE_CRANIAL_Y, v);
    const { min: rowMinX, max: rowMaxX } = smoothedExtents[row];
    const hits: Array<number | null> = [];
    for (let column = 0; column < columns; column += 1) {
      const u = column / xSegments;
      const x = THREE.MathUtils.lerp(rowMinX, rowMaxX, u);
      const surface = hitAt(x, y);
      // Toes are small and sharply curved, so a single ray per grid point can
      // slip past their apex. Extra standoff over the foot end covers that
      // without lifting the sheet off the thighs.
      const toeClearance = 0.17 + 0.18 * (1 - THREE.MathUtils.smoothstep(v, 0.05, 0.3));
      hits.push(surface == null ? null : surface + toeClearance);
    }
    const hitColumns = hits.flatMap((value, column) => value == null ? [] : [column]);
    const firstHit = hitColumns[0];
    const lastHit = hitColumns.at(-1);
    const rowSurface: number[] = [];

    for (let column = 0; column < columns; column += 1) {
      const u = column / xSegments;
      const x = THREE.MathUtils.lerp(rowMinX, rowMaxX, u);
      let z = MATTRESS_TOP_Z + 0.07;
      if (firstHit != null && lastHit != null) {
        if (hits[column] != null) {
          z = hits[column]!;
        } else if (column > firstHit && column < lastHit) {
          let left = column - 1;
          let right = column + 1;
          while (left >= firstHit && hits[left] == null) left -= 1;
          while (right <= lastHit && hits[right] == null) right += 1;
          const gapProgress = (column - left) / (right - left);
          z = THREE.MathUtils.lerp(hits[left]!, hits[right]!, gapProgress)
            - Math.sin(gapProgress * Math.PI) * Math.min(0.16, (right - left) * 0.012);
        } else {
          const nearestColumn = column < firstHit ? firstHit : lastHit;
          const edgeX = THREE.MathUtils.lerp(rowMinX, rowMaxX, nearestColumn / xSegments);
          const fallDistance = Math.abs(x - edgeX);
          const resting = MATTRESS_TOP_Z + 0.07;
          // Falls away from the body over about a hand's width, lies on the
          // mattress, then breaks over the table edge and hangs.
          z = THREE.MathUtils.lerp(
            hits[nearestColumn]!,
            resting,
            THREE.MathUtils.smoothstep(fallDistance, 0.05, 0.95),
          );
          z -= Math.max(0, Math.abs(x) - 3.44) * 2.6;
        }
      }
      rowSurface.push(z);
    }
    surfaceRows.push(rowSurface);
  }

  // Relax the sampled skin surface into something cloth can actually do.
  //
  // Sampling the body directly shrink-wraps it: the sheet dives into every
  // hollow, and wherever the body rises between two samples it pokes through,
  // which is what read as holes torn in the fabric. Fabric instead spans from
  // high point to high point and can only descend at a limited gradient, so
  // each point is lifted to the highest neighbour it could hang from. That
  // bridges the gap between the legs and tents over the ankles by itself.
  const columnStep = 0.13;
  const rowStep = Math.abs(DRAPE_CRANIAL_Y - DRAPE_CAUDAL_Y) / ySegments;
  const maxGradient = 0.7;
  const support = 3;
  const relaxed = surfaceRows.map((rowValues, row) => rowValues.map((_, column) => {
    let highest = -Infinity;
    for (let dr = -support; dr <= support; dr += 1) {
      const nearRow = row + dr;
      if (nearRow < 0 || nearRow >= rows) continue;
      for (let dc = -support; dc <= support; dc += 1) {
        const nearColumn = column + dc;
        if (nearColumn < 0 || nearColumn >= columns) continue;
        const reach = Math.hypot(dr * rowStep, dc * columnStep) * maxGradient;
        highest = Math.max(highest, surfaceRows[nearRow][nearColumn] - reach);
      }
    }
    return highest;
  }));

  for (let row = 0; row < rows; row += 1) {
    const v = row / ySegments;
    const y = THREE.MathUtils.lerp(DRAPE_CAUDAL_Y, DRAPE_CRANIAL_Y, v);
    const { min: rowMinX, max: rowMaxX } = smoothedExtents[row];
    for (let column = 0; column < columns; column += 1) {
      const u = column / xSegments;
      const x = THREE.MathUtils.lerp(rowMinX, rowMaxX, u);
      // Slack gathers into soft longitudinal folds rather than lying flat.
      const folds = Math.sin(x * 3.1 + y * 0.42) * 0.028
        + Math.sin(x * 6.7 - y * 0.9) * 0.014
        + Math.sin(y * 2.3 + x * 0.6) * 0.02;
      surfaceRows[row][column] = relaxed[row][column] + folds;
      vertices.push(x, y, surfaceRows[row][column]);
      uvs.push(u, v);
    }
  }

  for (let row = 0; row < ySegments; row += 1) {
    for (let column = 0; column < xSegments; column += 1) {
      const a = row * columns + column;
      const b = a + 1;
      const c = a + columns;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  (patientMesh.material as THREE.Material).dispose();

  const surfacePoint = (u: number, y: number, clearance = 0) => {
    const gridX = THREE.MathUtils.clamp(u, 0, 1) * xSegments;
    const gridY = THREE.MathUtils.clamp(
      ((y - DRAPE_CAUDAL_Y) / (DRAPE_CRANIAL_Y - DRAPE_CAUDAL_Y)) * ySegments,
      0,
      ySegments,
    );
    const x0 = Math.floor(gridX);
    const x1 = Math.min(xSegments, x0 + 1);
    const y0 = Math.floor(gridY);
    const y1 = Math.min(ySegments, y0 + 1);
    const tx = gridX - x0;
    const ty = gridY - y0;
    const lower = THREE.MathUtils.lerp(surfaceRows[y0][x0], surfaceRows[y0][x1], tx);
    const upper = THREE.MathUtils.lerp(surfaceRows[y1][x0], surfaceRows[y1][x1], tx);
    const minX = THREE.MathUtils.lerp(smoothedExtents[y0].min, smoothedExtents[y1].min, ty);
    const maxX = THREE.MathUtils.lerp(smoothedExtents[y0].max, smoothedExtents[y1].max, ty);
    return [THREE.MathUtils.lerp(minX, maxX, u), y, THREE.MathUtils.lerp(lower, upper, ty) + clearance] as Point;
  };

  return { geometry, surfacePoint };
}

function cachedPatientContouredDrape(source: THREE.Group) {
  if (PATIENT_DRAPE_CACHE.has(source)) return PATIENT_DRAPE_CACHE.get(source) ?? null;
  const drape = makePatientContouredDrape(source);
  PATIENT_DRAPE_CACHE.set(source, drape);
  return drape;
}

function SurgicalDrape({ opacity = 1 }: { transparent?: boolean; opacity?: number }) {
  const source = useLoader(OBJLoader, "/viewer/models/makehuman-base.obj");
  const lowerDrape = useMemo(() => cachedPatientContouredDrape(source), [source]);
  const creaseLines = useMemo<readonly (readonly Point[])[]>(() => {
    if (!lowerDrape) return [];
    const makeCrease = (u: number, ys: readonly number[]) => ys.map((y) => lowerDrape.surfacePoint(u, y, 0.026));
    return [
      makeCrease(0.12, [0.12, -1.9, -4.35, -6.35]),
      makeCrease(0.39, [0.02, -2.1, -4.55, -6.38]),
      makeCrease(0.62, [0.07, -2.02, -4.45, -6.36]),
      makeCrease(0.88, [0.14, -1.94, -4.32, -6.32]),
    ];
  }, [lowerDrape]);
  const reinforcedEdge = useMemo<readonly Point[]>(() => {
    if (!lowerDrape) return [];
    return [0, 0.16, 0.33, 0.5, 0.67, 0.84, 1].map((u) => lowerDrape.surfacePoint(u, DRAPE_CRANIAL_Y, 0.032));
  }, [lowerDrape]);
  return (
    <group>
      <mesh position={[0, 0.35, -3.12]} receiveShadow castShadow>
        <boxGeometry args={[7.65, 16.9, 0.52, 1, 1, 2]} />
        <meshPhysicalMaterial color="#293738" roughness={0.76} clearcoat={0.05} />
      </mesh>
      <mesh position={[0, 0.35, -2.72]} receiveShadow>
        <boxGeometry args={[7.2, 16.45, 0.3, 1, 1, 2]} />
        <meshPhysicalMaterial color="#425554" roughness={0.88} clearcoat={0.02} />
      </mesh>
      <mesh position={[0, 0.15, -3.62]}>
        <boxGeometry args={[2.7, 5.2, 0.82]} />
        <meshPhysicalMaterial color="#202b2c" metalness={0.45} roughness={0.42} />
      </mesh>
      <mesh position={[0, 6.05, -2.08]} scale={[1.72, 0.82, 0.3]} receiveShadow>
        <capsuleGeometry args={[0.72, 1.25, 12, 24]} />
        <meshPhysicalMaterial color="#71817d" roughness={0.92} clearcoat={0.015} />
      </mesh>
      {[-4.02, 4.02].map((x) => (
        <group
          key={`armboard-${x}`}
          position={[x, 4.85, -2.7]}
          rotation={[0, 0, -Math.sign(x) * THREE.MathUtils.degToRad(9.25)]}
        >
          <mesh position={[0, 0, -0.12]} receiveShadow castShadow>
            <boxGeometry args={[4.86, 1.28, 0.22]} />
            <meshPhysicalMaterial color="#273637" roughness={0.72} clearcoat={0.04} />
          </mesh>
          <mesh position={[0, 0, 0.035]} receiveShadow>
            <boxGeometry args={[4.7, 1.14, 0.16]} />
            <meshPhysicalMaterial color="#657775" roughness={0.9} clearcoat={0.015} />
          </mesh>
          <mesh position={[x < 0 ? 2.0 : -2.0, 0, -0.48]}>
            <boxGeometry args={[0.22, 0.52, 0.86]} />
            <meshPhysicalMaterial color="#879494" metalness={0.72} roughness={0.3} />
          </mesh>
        </group>
      ))}
      {[-3.86, 3.86].map((x) => (
        <group key={x} position={[x, 0.2, -2.72]}>
          <mesh>
            <cylinderGeometry args={[0.06, 0.06, 10.8, 14]} />
            <meshPhysicalMaterial color="#9da8a8" metalness={0.84} roughness={0.24} />
          </mesh>
          {[-4.7, 0, 4.7].map((y) => (
            <mesh key={y} position={[x < 0 ? 0.12 : -0.12, y, -0.03]} rotation={[0, 0, Math.PI / 2]}>
              <cylinderGeometry args={[0.04, 0.04, 0.34, 10]} />
              <meshPhysicalMaterial color="#8d9999" metalness={0.82} roughness={0.26} />
            </mesh>
          ))}
        </group>
      ))}
      {lowerDrape && (
        <mesh geometry={lowerDrape.geometry} receiveShadow castShadow>
          <meshPhysicalMaterial color="#277b7d" roughness={0.93} sheen={0.22} sheenRoughness={0.82} sheenColor="#a6cac1" bumpMap={DRAPE_WEAVE} bumpScale={0.022} clearcoat={0.015} clearcoatRoughness={0.9} transparent={opacity < 1} opacity={opacity} depthWrite={opacity > 0.9} side={THREE.DoubleSide} />
        </mesh>
      )}
      {reinforcedEdge.length > 1 && <TissueTube points={reinforcedEdge} radius={0.045} color="#4d9690" opacity={0.86} tubularSegments={76} radialSegments={8} roughness={0.94} clearcoat={0} />}
      {creaseLines.map((points, index) => (
        <TissueTube key={index} points={points} radius={0.022} color={index % 2 ? "#15585c" : "#2a7475"} opacity={0.58} tubularSegments={56} radialSegments={7} roughness={0.98} clearcoat={0} />
      ))}
    </group>
  );
}

/**
 * Anaesthetic face mask.
 *
 * Built to the real article rather than as a ring on the face: a teardrop
 * body — narrow over the nose bridge, broad under the chin — a soft inflatable
 * cushion swept around that outline, a clear shell so the anaesthetist can see
 * lips and condensation, a colour-coded hook ring carrying the harness, and a
 * 22 mm connector to the breathing circuit.
 */
// Sized and seated from the posed shell rather than by eye. Sampling the head
// down the midline gives nose tip at world y 7.70 / z -1.084, bridge at
// 7.92 / -1.229, lips at 7.50 / -1.125 and chin at 7.25 / -1.175; the face is
// 1.50 wide at mouth level. An adult mask covers bridge to mental crease, so
// the seal spans y 7.33-7.93 and is 0.84 across — a little over half the face.
const MASK_NOSE_REACH = 0.3;
const MASK_CHIN_REACH = 0.3;
const MASK_HALF_WIDTH = 0.42;

// A quadratic fitted to a depth grid over that footprint — the nose excluded,
// since the seal rides the perimeter and arches over the nose rather than
// touching it — comes out as, about the centre of the seal,
//   z = -0.0594x - 0.1595y - 0.8633x² - 0.5671y²      (rms 0.021)
// The linear terms are the tilt of the face on a head resting slightly
// extended; those are absorbed into the group's rotation below, which leaves
// just the curvature for the seal to follow. This matters: the cheeks sit
// 0.13 deeper than the midline, so the flat ring this used to be could only
// ever touch at two points and read as a hoop laid on the face.
const FACE_CURVE_X = 0.8633;
const FACE_CURVE_Y = 0.5671;

/** Outline of the seal, in the mask's own frame: +y is toward the nose. */
function maskOutline(angle: number, inset = 1) {
  const s = Math.sin(angle);
  // The nose half narrows to an apex; the chin half stays broad and round.
  const narrow = 1 - 0.52 * Math.max(0, s) ** 1.4;
  return {
    x: Math.cos(angle) * MASK_HALF_WIDTH * narrow * inset,
    y: s * (s > 0 ? MASK_NOSE_REACH : MASK_CHIN_REACH) * inset,
  };
}

/** Height of the face under a point of the seal, in the mask's own frame. */
function faceDepth(x: number, y: number) {
  return -FACE_CURVE_X * x * x - FACE_CURVE_Y * y * y;
}

// The cushion is squeezed a few millimetres into the cheek, as a held mask is.
const CUSHION_RADIUS = 0.052;
const CUSHION_SEAT = 0.026;
const COLLAR_RADIUS = 0.085;
const COLLAR_Z = 0.34;

/** Clear body, lofted from the seal outline up to the connector. */
function makeMaskShellGeometry() {
  const rings = 18;
  const segments = 60;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let ring = 0; ring <= rings; ring += 1) {
    const t = ring / rings;
    const eased = t * t * (3 - 2 * t);
    for (let segment = 0; segment <= segments; segment += 1) {
      const angle = (segment / segments) * Math.PI * 2;
      const seal = maskOutline(angle, 0.93);
      // The rim starts on the face and the collar sits proud of the nose, so
      // the wall sweeps over the nose instead of through it.
      const rimZ = faceDepth(seal.x, seal.y) + CUSHION_SEAT;
      const collarX = Math.cos(angle) * COLLAR_RADIUS;
      const collarY = Math.sin(angle) * COLLAR_RADIUS - 0.01;
      positions.push(
        THREE.MathUtils.lerp(seal.x, collarX, eased),
        THREE.MathUtils.lerp(seal.y, collarY, eased),
        THREE.MathUtils.lerp(rimZ, COLLAR_Z, eased) + Math.sin(t * Math.PI) * 0.035,
      );
      uvs.push(segment / segments, t);
    }
  }
  const row = segments + 1;
  for (let ring = 0; ring < rings; ring += 1) {
    for (let segment = 0; segment < segments; segment += 1) {
      const a = ring * row + segment;
      const b = a + row;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function OxygenMask({ transparent }: { transparent: boolean }) {
  const shell = useMemo(makeMaskShellGeometry, []);
  useEffect(() => () => shell.dispose(), [shell]);

  // The cushion follows the face rather than sitting in a plane, so it meets
  // the cheeks and the chin at the same time.
  const cushionGeometry = useMemo(() => {
    const points = Array.from({ length: 73 }, (_, index) => {
      const angle = (index / 72) * Math.PI * 2;
      const { x, y } = maskOutline(angle);
      return new THREE.Vector3(x, y, faceDepth(x, y) + CUSHION_SEAT);
    });
    return new THREE.TubeGeometry(
      new THREE.CatmullRomCurve3(points, true, "centripetal", 0.5),
      144, CUSHION_RADIUS, 18, true,
    );
  }, []);
  useEffect(() => () => cushionGeometry.dispose(), [cushionGeometry]);

  // The circuit leaves through a right-angle elbow, as in theatre — it does
  // not run straight out of the mask. It clears the front of the mask before
  // turning, so the hose never cuts back across the face.
  // Seen from above the patient, anything that leaves the mask sideways reads
  // as lying on the cheek, so the elbow climbs clear of the face first and the
  // hose only turns once it is well above the head.
  const elbow = useMemo<readonly Point[]>(() => [
    [0, -0.01, 0.44], [0, 0.005, 0.57], [0.016, 0.028, 0.672],
    [0.068, 0.072, 0.742], [0.145, 0.118, 0.776], [0.228, 0.163, 0.781],
  ], []);

  const breathingCircuit = useMemo<readonly Point[]>(() => [
    [0.228, 0.163, 0.781], [0.45, 0.35, 0.86], [0.8, 0.65, 0.9],
    [1.2, 0.95, 0.86], [1.65, 1.25, 0.7], [2.1, 1.5, 0.5],
    [2.55, 1.68, 0.3], [3.0, 1.8, 0.12], [3.4, 1.88, 0.0],
    [3.75, 1.92, -0.05], [4.05, 1.932, -0.08], [4.22, 1.935, -0.086],
    // Exact inverse-transform of the anesthesia workstation circuit socket,
    // including the patient's tilt and support-height transforms.
    [4.275011, 1.936113, -0.086238],
  ], []);
  const circuitCurve = useMemo(() => curveFrom(breathingCircuit), [breathingCircuit]);
  const circuitRibs = useMemo(() => Array.from({ length: 40 }, (_, index) => {
    const t = 0.045 + (index / 39) * 0.91;
    const point = circuitCurve.getPointAt(t);
    const tangent = circuitCurve.getTangentAt(t).normalize();
    const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), tangent);
    return { position: point.toArray() as Point, quaternion };
  }), [circuitCurve]);
  const circuitCuffs = useMemo(() => [0.012, 0.988].map((t) => {
    const point = circuitCurve.getPointAt(t);
    const tangent = circuitCurve.getTangentAt(t).normalize();
    const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), tangent);
    return { position: point.toArray() as Point, quaternion };
  }), [circuitCurve]);

  return (
    // Seated on the measured face: the origin is the point of the seal centre
    // on the skin, and the rotation cancels the tilt of the face so the mask's
    // own frame lies in the plane of the seal.
    <group name="oxygen-mask" position={[0.02, 5.534, 0.287]} rotation={[-0.03, 0.024, 0]}>
      {/* Clear PVC. Refractive transmission renders the inside of the dome as
          a dark cavity from this angle, so the body is a plain transparent
          surface with a strong clearcoat: the face reads through it and the
          highlight along the dome is what makes it look like a shell. */}
      <mesh geometry={shell} renderOrder={23} castShadow={!transparent}>
        <meshPhysicalMaterial
          color="#dbebea"
          roughness={0.09}
          metalness={0}
          ior={1.45}
          clearcoat={1}
          clearcoatRoughness={0.05}
          transparent
          opacity={transparent ? 0.26 : 0.54}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>

      <mesh geometry={cushionGeometry} renderOrder={24} castShadow={!transparent}>
        <meshPhysicalMaterial
          color="#e4ecec"
          roughness={0.28}
          ior={1.41}
          clearcoat={0.55}
          clearcoatRoughness={0.24}
          transparent
          opacity={transparent ? 0.38 : 0.62}
          depthWrite={false}
        />
      </mesh>

      {/* Colour-coded hook ring: on a real mask the colour is the size. */}
      <mesh position={[0, -0.01, COLLAR_Z - 0.035]} rotation={[Math.PI / 2, 0, 0]} renderOrder={25}>
        <torusGeometry args={[0.113, 0.017, 12, 36]} />
        <meshPhysicalMaterial color="#5c8a74" roughness={0.44} clearcoat={0.2} transparent={transparent} opacity={transparent ? 0.55 : 1} />
      </mesh>

      {/* 22 mm connector to the breathing circuit. */}
      <mesh position={[0, -0.01, COLLAR_Z + 0.065]} rotation={[Math.PI / 2, 0, 0]} renderOrder={25}>
        <cylinderGeometry args={[0.076, 0.086, 0.15, 30, 1, true]} />
        <meshPhysicalMaterial color="#c8d4d2" roughness={0.3} clearcoat={0.4} transparent={transparent} opacity={transparent ? 0.55 : 1} side={THREE.DoubleSide} />
      </mesh>
      <mesh position={[0, -0.01, COLLAR_Z + 0.135]} rotation={[Math.PI / 2, 0, 0]} renderOrder={26}>
        <torusGeometry args={[0.076, 0.013, 10, 28]} />
        <meshPhysicalMaterial color="#a8bab7" roughness={0.36} transparent={transparent} opacity={transparent ? 0.55 : 1} />
      </mesh>

      {/* Cushion inflation valve, off to one side as on the real mask. */}
      <mesh position={[0.372, -0.185, -0.05]} rotation={[0, 0.5, -0.75]} renderOrder={25}>
        <cylinderGeometry args={[0.019, 0.016, 0.085, 14]} />
        <meshPhysicalMaterial color="#dfe9e6" roughness={0.4} transparent={transparent} opacity={transparent ? 0.5 : 1} />
      </mesh>

      <EquipmentTube points={elbow} radius={0.072} color="#dfe9e6" opacity={transparent ? 0.55 : 0.97} tubularSegments={60} radialSegments={16} renderOrder={26} />
      <mesh position={[0.224, 0.16, 0.781]} rotation={[Math.PI / 2, 0, -1.05]} renderOrder={27}>
        <cylinderGeometry args={[0.086, 0.086, 0.06, 24]} />
        <meshPhysicalMaterial color="#cfdedb" roughness={0.34} clearcoat={0.35} transparent={transparent} opacity={transparent ? 0.55 : 1} />
      </mesh>

      <EquipmentTube points={breathingCircuit} radius={0.088} color="#b8cac7" opacity={transparent ? 0.72 : 0.94} tubularSegments={112} radialSegments={16} renderOrder={21} />
      {circuitRibs.map((rib, index) => (
        <mesh key={index} position={rib.position} quaternion={rib.quaternion} renderOrder={22}>
          <torusGeometry args={[0.102, 0.013, 8, 24]} />
          <meshPhysicalMaterial color={index % 2 ? "#d8e4e1" : "#aebfbc"} roughness={0.43} transparent opacity={transparent ? 0.68 : 0.94} depthWrite={!transparent} />
        </mesh>
      ))}
      {circuitCuffs.map((cuff, index) => (
        <group key={index} position={cuff.position} quaternion={cuff.quaternion} renderOrder={23}>
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.112, 0.112, 0.18, 24]} />
            <meshPhysicalMaterial color="#d7e1df" roughness={0.34} clearcoat={0.28} transparent={transparent} opacity={transparent ? 0.72 : 1} />
          </mesh>
          <mesh position={[0, 0, index === 0 ? 0.085 : -0.085]}>
            <torusGeometry args={[0.113, 0.017, 10, 26]} />
            <meshPhysicalMaterial color="#849895" roughness={0.4} transparent={transparent} opacity={transparent ? 0.72 : 1} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/**
 * Fine skin detail — pores, grain and faint creases — as a tiling bump map.
 *
 * Generated rather than sourced: the shell's UVs are a MakeHuman body atlas,
 * so a photographic skin texture would need to be authored against that
 * specific layout to land correctly, and a generated tile carries no licence
 * to track. Broad tone variation is handled separately in the shader from
 * object-space position, which avoids atlas seams entirely.
 */
function makeSkinDetailTexture() {
  const size = 256;
  const values = new Uint8Array(size * size);
  let seed = 4711;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let i = 0; i < values.length; i += 1) values[i] = 128;

  // Pores: small depressions at irregular density.
  for (let p = 0; p < 9000; p += 1) {
    const cx = random() * size;
    const cy = random() * size;
    const r = 0.7 + random() * 1.5;
    const depth = 12 + random() * 26;
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        const d = Math.hypot(dx, dy);
        if (d > r) continue;
        const x = (Math.floor(cx) + dx + size) % size;
        const y = (Math.floor(cy) + dy + size) % size;
        const falloff = 1 - d / r;
        const index = y * size + x;
        values[index] = Math.max(0, values[index] - depth * falloff);
      }
    }
  }
  // Fine criss-cross creases, the tension lines skin carries everywhere.
  for (let line = 0; line < 520; line += 1) {
    let x = random() * size;
    let y = random() * size;
    const angle = (random() < 0.5 ? 0.6 : -0.7) + (random() - 0.5) * 0.5;
    const length = 8 + random() * 26;
    const strength = 6 + random() * 12;
    for (let step = 0; step < length; step += 1) {
      x += Math.cos(angle);
      y += Math.sin(angle);
      const index = ((Math.floor(y) + size) % size) * size + ((Math.floor(x) + size) % size);
      values[index] = Math.max(0, values[index] - strength);
    }
  }
  // Grain, so the surface never reads as smooth plastic between the pores.
  for (let i = 0; i < values.length; i += 1) {
    values[i] = Math.max(0, Math.min(255, values[i] + (random() - 0.5) * 14));
  }

  const texture = new THREE.DataTexture(values, size, size, THREE.RedFormat, THREE.UnsignedByteType);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(9, 26);
  texture.needsUpdate = true;
  return texture;
}

const SKIN_DETAIL = makeSkinDetailTexture();

/**
 * Object-space tone variation. Skin is never one flat colour: it mottles,
 * runs ruddier over bony prominences and cooler over soft tissue. Driving it
 * from position rather than UV keeps it continuous across the atlas seams.
 */
const SKIN_TONE_GLSL = `
  float skinHash(vec3 p) {
    return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  }
  float skinNoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = skinHash(i);
    float n100 = skinHash(i + vec3(1.0, 0.0, 0.0));
    float n010 = skinHash(i + vec3(0.0, 1.0, 0.0));
    float n110 = skinHash(i + vec3(1.0, 1.0, 0.0));
    float n001 = skinHash(i + vec3(0.0, 0.0, 1.0));
    float n101 = skinHash(i + vec3(1.0, 0.0, 1.0));
    float n011 = skinHash(i + vec3(0.0, 1.0, 1.0));
    float n111 = skinHash(i + vec3(1.0, 1.0, 1.0));
    return mix(
      mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
      mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y),
      f.z);
  }
`;

type PatientShellData = {
  geometry: THREE.BufferGeometry;
  position: THREE.Vector3;
  scale: number;
};

const PATIENT_SHELL_CACHE = new WeakMap<THREE.Group, PatientShellData | null>();

function applySmoothNormals(geometry: THREE.BufferGeometry) {
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  const index = geometry.getIndex();
  const count = index ? index.count : position.count;
  const at = (i: number) => (index ? index.getX(i) : i);

  const key = (i: number) =>
    `${Math.round(position.getX(i) * 1e4)}:${Math.round(position.getY(i) * 1e4)}:${Math.round(position.getZ(i) * 1e4)}`;

  const shared = new Map<string, THREE.Vector3>();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const face = new THREE.Vector3();

  for (let i = 0; i < count; i += 3) {
    const ia = at(i);
    const ib = at(i + 1);
    const ic = at(i + 2);
    a.fromBufferAttribute(position, ia);
    b.fromBufferAttribute(position, ib);
    c.fromBufferAttribute(position, ic);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    // Left un-normalised so larger triangles carry proportionally more weight.
    face.crossVectors(ab, ac);
    for (const vertex of [ia, ib, ic]) {
      const id = key(vertex);
      const accumulated = shared.get(id);
      if (accumulated) accumulated.add(face);
      else shared.set(id, face.clone());
    }
  }

  const normals = new Float32Array(position.count * 3);
  const normal = new THREE.Vector3();
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    const accumulated = shared.get(key(vertex));
    if (accumulated) normal.copy(accumulated).normalize();
    else normal.set(0, 0, 1);
    normals[vertex * 3] = normal.x;
    normals[vertex * 3 + 1] = normal.y;
    normals[vertex * 3 + 2] = normal.z;
  }
  geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
}

function extractPatientShellGeometry(source: THREE.Group) {
  const body = source.getObjectByName("body") as THREE.Mesh | undefined;
  if (!body || !(body.geometry instanceof THREE.BufferGeometry)) return null;
  const geometry = body.geometry.clone();
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  const shoulderY = 5.2458;
  // Rotate the source model's caudally angled arms onto bilateral armboards.
  // The resulting shoulder abduction is approximately 87 degrees: visibly
  // lateral, but still within AORN's <=90-degree positioning limit.
  const armAngle = THREE.MathUtils.degToRad(40);
  const projectToSegment = (px: number, py: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
    return {
      distance: Math.hypot(px - (ax + dx * t), py - (ay + dy * t)),
      centerDepth: THREE.MathUtils.lerp(az, bz, t),
    };
  };
  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index);
    const y = position.getY(index);
    const z = position.getZ(index);
    if (Math.abs(x) < 1.42 || y < 0.75 || y > 5.95) continue;
    const side = Math.sign(x);
    const shoulderX = side * 1.67715;
    const elbowX = side * 3.1296;
    const handX = side * 4.31185;
    const fingerX = side * 4.86;
    const projectedSegments = [
      projectToSegment(x, y, shoulderX, shoulderY, 0.16, elbowX, 3.4929, 0.26),
      projectToSegment(x, y, elbowX, 3.4929, 0.26, handX, 2.4518, 2.0),
      projectToSegment(x, y, handX, 2.4518, 2.0, fingerX, 1.55, 2.58),
    ];
    const nearestSegment = projectedSegments.reduce((nearest, candidate) => (
      candidate.distance < nearest.distance ? candidate : nearest
    ));
    const distance = nearestSegment.distance;
    const shoulderDistance = Math.hypot(x - shoulderX, y - shoulderY);
    const poseWeight = THREE.MathUtils.smoothstep(shoulderDistance, 0.18, 1.05)
      * (1 - THREE.MathUtils.smoothstep(distance, 0.7, 1.02));
    if (poseWeight <= 0) continue;
    const angle = side * armAngle;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const dx = x - shoulderX;
    const dy = y - shoulderY;
    const posedX = shoulderX + dx * cos - dy * sin;
    const posedY = shoulderY + dx * sin + dy * cos;
    const finalX = THREE.MathUtils.lerp(x, posedX, poseWeight);
    let finalY = THREE.MathUtils.lerp(y, posedY, poseWeight);
    // Rebuild the inferior shoulder contour after abduction. Without this
    // seam-aware floor, a few stationary torso vertices remain below the
    // rotating upper arm and form a pointed triangular axillary web.
    const axillaX = Math.abs(finalX);
    const axillaT = THREE.MathUtils.clamp((axillaX - 1.3) / 0.86, 0, 1);
    const axillaFloor = 3.72 + Math.sqrt(axillaT) * 1.01;
    const axillaBlend = THREE.MathUtils.smoothstep(axillaX, 1.3, 1.52)
      * (1 - THREE.MathUtils.smoothstep(axillaX, 2.08, 2.34));
    if (finalY > 3.45 && finalY < axillaFloor) {
      finalY = THREE.MathUtils.lerp(finalY, axillaFloor, axillaBlend * 0.94);
    }
    const handRestWeight = poseWeight * THREE.MathUtils.smoothstep(shoulderDistance, 0.4, 2.45);
    // Translate the arm centreline onto the armboard while retaining every
    // vertex's depth offset from that centreline. This preserves upper-arm,
    // forearm and hand thickness instead of compressing them into a flat sheet.
    const supportedCenterDepth = -0.54;
    const settledDepth = z - (nearestSegment.centerDepth - supportedCenterDepth) * handRestWeight;
    position.setXYZ(
      index,
      finalX,
      finalY,
      settledDepth,
    );
  }
  position.needsUpdate = true;
  applySmoothNormals(geometry);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const targetHeight = 13.4;
  const scale = targetHeight / size.y;
  const modelPosition = new THREE.Vector3(
    -center.x * scale,
    0.15 - center.y * scale,
    0.18 - 1.45 * scale,
  );
  return { geometry, position: modelPosition, scale };
}

function cachedPatientShellGeometry(source: THREE.Group) {
  if (PATIENT_SHELL_CACHE.has(source)) return PATIENT_SHELL_CACHE.get(source) ?? null;
  const patient = extractPatientShellGeometry(source);
  PATIENT_SHELL_CACHE.set(source, patient);
  return patient;
}

/**
 * Clothing derived from the patient shell itself rather than modelled
 * separately, so it follows the body exactly and cannot drift off it. Each
 * garment reuses the shell geometry, pushes out along the surface normal by a
 * fabric thickness, and discards every fragment outside its own region.
 *
 * Bands are expressed in the model's own coordinates: the shell spans roughly
 * y -8.45 (feet) to 8.5 (crown), with the shoulders near 5.4 and the head
 * above 6.4.
 */
function PatientGarment({
  geometry,
  region,
  shade = "",
  colour,
  offset,
  cacheKey,
  faded = false,
}: {
  geometry: THREE.BufferGeometry;
  region: string;
  shade?: string;
  colour: string;
  offset: number;
  cacheKey: string;
  faded?: boolean;
}) {
  return (
    <mesh geometry={geometry} castShadow={!faded} receiveShadow renderOrder={faded ? 13 : 2}>
      <meshPhysicalMaterial
        color={colour}
        roughness={0.92}
        sheen={0.4}
        sheenColor="#9fb0bb"
        sheenRoughness={0.75}
        clearcoat={0.04}
        transparent={faded}
        opacity={faded ? 0.66 : 1}
        depthWrite={!faded}
        side={THREE.DoubleSide}
        customProgramCacheKey={() => `${cacheKey}${faded ? "-faded" : ""}`}
        onBeforeCompile={(shader) => {
          shader.vertexShader = shader.vertexShader
            .replace("#include <common>", "#include <common>\nvarying vec3 vGarment;")
            .replace(
              "#include <begin_vertex>",
              `#include <begin_vertex>\nvGarment = position;\ntransformed += normalize(objectNormal) * ${offset.toFixed(4)};`,
            );
          shader.fragmentShader = shader.fragmentShader
            .replace("#include <common>", "#include <common>\nvarying vec3 vGarment;")
            .replace(
              "#include <clipping_planes_fragment>",
              `vec3 g = vGarment;\n${region}\nif (garmentMask < 0.5) discard;\n#include <clipping_planes_fragment>`,
            )
            .replace("#include <map_fragment>", `#include <map_fragment>\nvec3 gs = vGarment;\n${shade}`);
        }}
      />
    </mesh>
  );
}

/** Sports bra: a band across the bust with straps over both shoulders. */
const BRA_REGION = `
  float torso = 1.0 - smoothstep(1.74, 2.0, abs(g.x));
  // Scooped neckline: the top edge drops across the centre of the chest and
  // rides higher out at the sides, which is what stops it reading as tape.
  float front = smoothstep(0.5, 1.35, g.z);
  float centre = 1.0 - smoothstep(0.12, 0.88, abs(g.x));
  float topEdge = 4.56 - 0.46 * centre * front;
  float bottomEdge = 3.14 - 0.12 * front;
  float band = smoothstep(bottomEdge, bottomEdge + 0.14, g.y)
    * (1.0 - smoothstep(topEdge, topEdge + 0.13, g.y));

  // Straps sweep outward and narrow as they pass over the shoulder.
  float rise = smoothstep(4.35, 5.75, g.y);
  float strapCentre = 0.74 + 0.24 * rise;
  float strapHalf = 0.29 - 0.09 * rise;
  float strap = (1.0 - smoothstep(strapHalf - 0.07, strapHalf, abs(abs(g.x) - strapCentre)))
    * smoothstep(4.22, 4.38, g.y)
    * (1.0 - smoothstep(5.95, 6.15, g.y));

  float garmentMask = max(band, strap) * torso;
`;

/** Knitted fabric with a bound hem along both edges of the band. */
const BRA_SHADE = `
  float rib = sin(gs.y * 78.0) * 0.5 + 0.5;
  float weave = sin(gs.x * 96.0 + gs.z * 40.0) * 0.5 + 0.5;
  diffuseColor.rgb *= 0.9 + rib * 0.12 + weave * 0.06;
  float frontS = smoothstep(0.5, 1.35, gs.z);
  float centreS = 1.0 - smoothstep(0.12, 0.88, abs(gs.x));
  float topS = 4.56 - 0.46 * centreS * frontS;
  float botS = 3.14 - 0.12 * frontS;
  float hem = max(
    1.0 - smoothstep(0.0, 0.1, abs(gs.y - botS - 0.07)),
    1.0 - smoothstep(0.0, 0.09, abs(gs.y - topS + 0.05)));
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.5 + vec3(0.02), hem * 0.75);
`;

/**
 * Surgical cap: covers the crown and the back of the head, with its front edge
 * following the hairline so the face stays clear.
 */
const CAP_REGION = `
  // The temples sit almost as far forward as the brow, so keying the hem off
  // depth alone lifted it above the ears. The hem only rises across the face
  // itself, which is narrow, and stays low around the sides and back.
  float faceFront = smoothstep(0.95, 1.55, g.z) * (1.0 - smoothstep(0.52, 0.86, abs(g.x)));
  float capLine = 7.1 + 0.66 * faceFront;
  float garmentMask = smoothstep(capLine, capLine + 0.1, g.y);
`;

function RealisticPatientShell({
  transparent,
  transparentOpacity = 0.42,
  torsoAlpha = 0.18,
}: {
  transparent: boolean;
  transparentOpacity?: number;
  torsoAlpha?: number;
}) {
  const source = useLoader(OBJLoader, "/viewer/models/makehuman-base.obj");
  const patient = useMemo(() => cachedPatientShellGeometry(source), [source]);
  if (!patient) return null;
  return (
    <group position={patient.position} scale={[patient.scale * 1.32, patient.scale, patient.scale]}>
      <mesh
      geometry={patient.geometry}
      castShadow={!transparent}
      receiveShadow
      renderOrder={transparent ? 12 : 0}
    >
      <meshPhysicalMaterial
        key={transparent ? "torso-cutaway" : "opaque-body"}
        color="#bc8a72"
        roughness={0.58}
        clearcoat={0.14}
        clearcoatRoughness={0.55}
        sheen={0.35}
        sheenColor="#e8b49a"
        sheenRoughness={0.7}
        specularIntensity={0.35}
        bumpMap={SKIN_DETAIL}
        bumpScale={0.014}
        side={transparent ? THREE.DoubleSide : THREE.FrontSide}
        transparent={transparent}
        opacity={transparent ? transparentOpacity : 1}
        depthWrite={!transparent}
        customProgramCacheKey={() => transparent ? `patient-skin-cutaway-v1-${torsoAlpha.toFixed(3)}` : "patient-skin-opaque-v1"}
        onBeforeCompile={(shader) => {
          shader.vertexShader = shader.vertexShader
            .replace("#include <common>", "#include <common>\nvarying vec3 vPatientPosition;")
            .replace("#include <begin_vertex>", "#include <begin_vertex>\nvPatientPosition = position;");
          shader.fragmentShader = shader.fragmentShader
            .replace("#include <common>", `#include <common>\nvarying vec3 vPatientPosition;\n${SKIN_TONE_GLSL}`)
            .replace(
              "#include <map_fragment>",
              `#include <map_fragment>
               vec3 sp = vPatientPosition;
               float blotch = skinNoise(sp * 0.85) * 0.62 + skinNoise(sp * 2.6) * 0.26 + skinNoise(sp * 7.5) * 0.12;
               // Ruddier where skin lies over bone and at the extremities,
               // cooler and paler over soft tissue.
               float ruddy = smoothstep(0.35, 0.75, blotch);
               vec3 warmSkin = vec3(1.07, 0.93, 0.88);
               vec3 coolSkin = vec3(0.96, 1.0, 1.03);
               diffuseColor.rgb *= mix(coolSkin, warmSkin, ruddy);
               diffuseColor.rgb *= 0.92 + blotch * 0.17;`,
            );
          if (!transparent) return;
          shader.fragmentShader = shader.fragmentShader.replace(
            "#include <dithering_fragment>",
            `float torsoX = 1.0 - smoothstep(1.95, 2.35, abs(vPatientPosition.x));\nfloat torsoLower = smoothstep(-3.35, -2.8, vPatientPosition.y);\nfloat torsoUpper = 1.0 - smoothstep(4.35 - abs(vPatientPosition.x) * 0.12, 4.95 - abs(vPatientPosition.x) * 0.12, vPatientPosition.y);\nfloat torsoMask = torsoX * torsoLower * torsoUpper;\ngl_FragColor.a *= mix(0.78, ${torsoAlpha.toFixed(3)}, torsoMask);\n#include <dithering_fragment>`,
          );
        }}
        />
      </mesh>
      <PatientGarment
        geometry={patient.geometry}
        region={BRA_REGION}
        shade={BRA_SHADE}
        colour="#39424e"
        offset={0.026}
        cacheKey="patient-sports-bra-v2"
        faded={transparent}
      />
      <PatientGarment
        geometry={patient.geometry}
        region={CAP_REGION}
        colour="#4f9b92"
        offset={0.034}
        cacheKey="patient-surgical-cap-v2"
        faded={transparent}
      />
    </group>
  );
}

export function PatientOperatingContext({
  transparent = true,
  drapeOpacity = 1,
  transparentOpacity = 0.42,
  torsoAlpha = 0.18,
}: {
  transparent?: boolean;
  drapeOpacity?: number;
  transparentOpacity?: number;
  torsoAlpha?: number;
}) {
  const effectiveDrapeOpacity = transparent ? Math.min(drapeOpacity, 0.08) : drapeOpacity;
  return (
    <group rotation={[-0.13, 0.035, 0]}>
      {effectiveDrapeOpacity > 0 && <Suspense fallback={null}><SurgicalDrape opacity={effectiveDrapeOpacity} /></Suspense>}
      <group position={[0, 0, PATIENT_SUPPORT_Z]}>
        <Suspense fallback={null}><RealisticPatientShell transparent={transparent} transparentOpacity={transparentOpacity} torsoAlpha={torsoAlpha} /></Suspense>
        <OxygenMask transparent={transparent} />
      </group>
    </group>
  );
}

function RectusFibres({ open, opacity }: { open: boolean; opacity: number }) {
  const fibres = useMemo(() => Array.from({ length: 14 }, (_, index) => index), []);
  return (
    <group position={[0, 0, -0.12]}>
      {fibres.map((index) => {
        const angle = (index / fibres.length) * Math.PI * 2;
        const x = Math.cos(angle) * (open ? 0.88 : 0.44);
        const y = Math.sin(angle) * (open ? 0.92 : 0.47);
        return (
          <mesh key={index} position={[x, y, -0.05]} rotation={[0, 0, angle + Math.PI / 2]}>
            <capsuleGeometry args={[0.055, 0.72, 5, 10]} />
            <meshStandardMaterial color="#6f292e" roughness={0.92} transparent opacity={opacity * 0.9} />
          </mesh>
        );
      })}
    </group>
  );
}

function TrephineAnatomy({ step, opacity }: { step: number; opacity: number }) {
  if (step < 1) return null;
  const [x, y] = STOMA_CENTER;
  const rings = [
    { z: 0.55, major: 0.69, tube: 0.075, color: "#a9574c" },
    { z: 0.30, major: 0.64, tube: 0.085, color: "#d6b54f" },
    { z: 0.04, major: 0.61, tube: 0.052, color: PALETTE.fascia },
    { z: -0.23, major: 0.58, tube: 0.065, color: PALETTE.rectus },
    { z: -0.50, major: 0.55, tube: 0.04, color: "#b58179" },
  ];
  return (
    <group position={[x, y, -0.13]} scale={[(PROCEDURE_SCALE_Y / PROCEDURE_SCALE) * 0.45, 0.45, 0.62]}>
      <mesh position={[0, 0, -0.58]} scale={[0.61, 0.68, 1]}>
        <circleGeometry args={[1, 64]} />
        <meshBasicMaterial color="#371b21" transparent opacity={0.82} />
      </mesh>
      {rings.map((ring, index) => (
        <mesh key={ring.z} position={[0, 0, ring.z]} scale={[1, 1.08, 1]}>
          <torusGeometry args={[ring.major, ring.tube, 14, 72]} />
          <meshPhysicalMaterial color={ring.color} roughness={0.7} clearcoat={index === 0 ? 0.12 : 0} transparent opacity={opacity} />
        </mesh>
      ))}
      <RectusFibres open opacity={opacity} />
      {step === 1 && (
        <group position={[0, 0, 0.7]}>
          {[0, Math.PI / 2].map((rotation) => (
            <mesh key={rotation} rotation={[0, 0, rotation]}>
              <boxGeometry args={[1.34, 0.035, 0.025]} />
              <meshBasicMaterial color="#f5d4c0" transparent opacity={0.92} depthTest={false} />
            </mesh>
          ))}
        </group>
      )}
    </group>
  );
}


function TorsoMusculature({ transparent }: { transparent: boolean }) {
  if (!transparent) return null;
  return (
    <group position={[0, 0.75, 0.1]}>
      {[-0.72, 0.72].map((x) => (
        <mesh key={x} position={[x, 0, 0]} scale={[0.58, 1.35, 0.15]}>
          <capsuleGeometry args={[0.48, 1, 12, 24]} />
          <meshStandardMaterial color="#773338" roughness={0.9} transparent opacity={0.2} depthWrite={false} />
        </mesh>
      ))}
    </group>
  );
}

function AbdominalWall({ step, transparent }: { step: number; transparent: boolean }) {
  return (
    <group>
      <TrephineAnatomy step={step} opacity={transparent ? 0.72 : 1} />
    </group>
  );
}

const COLON_POINTS: readonly Point[] = [
  [-3.28, -1.62, -1.38], [-3.48, -0.55, -1.47], [-3.38, 0.78, -1.58], [-2.9, 2.12, -1.48],
  [-1.25, 2.62, -1.42], [0.65, 2.58, -1.44], [2.45, 2.3, -1.52], [3.27, 1.18, -1.55],
  [3.35, -0.18, -1.48], [3.05, -1.45, -1.42], [2.1, -2.12, -1.4], [1.1, -2.38, -1.44],
  [0.38, -2.84, -1.55],
];
const ILEOCECAL_JUNCTION_RAW: Point = [-2.82, -1.55, -1.08];
const ILEOCECAL_JUNCTION = scaleGiPoint(ILEOCECAL_JUNCTION_RAW);

export function ColonFrame({ faded }: { faded: boolean }) {
  const curve = useMemo(() => curveFrom(COLON_POINTS), []);
  const baseGeometry = useMemo(() => new THREE.TubeGeometry(curve, 170, 0.3, 18, false), [curve]);
  const taenia = useMemo(() => {
    const points = Array.from({ length: 90 }, (_, index) => {
      const point = curve.getPointAt(index / 89);
      point.z += 0.372;
      return [point.x, point.y, point.z] as Point;
    });
    return points;
  }, [curve]);
  const haustra = useMemo(() => Array.from({ length: 30 }, (_, index) => {
    const t = (index + 0.3) / 30.6;
    const point = curve.getPointAt(t);
    const tangent = curve.getTangentAt(t);
    return {
      point: point.toArray() as Point,
      rotation: Math.atan2(tangent.y, tangent.x),
      scale: [0.372 + (index % 3) * 0.0144, 0.324, 0.336] as Point,
    };
  }), [curve]);
  useEffect(() => () => baseGeometry.dispose(), [baseGeometry]);
  const opacity = faded ? 0.25 : 0.94;
  return (
    <group>
      <mesh geometry={baseGeometry} castShadow>
        <meshPhysicalMaterial color={PALETTE.colon} roughness={0.76} clearcoat={0.05} transparent={faded} opacity={opacity} depthWrite={!faded} />
      </mesh>
      {haustra.map((haustrum, index) => (
        <mesh key={index} position={haustrum.point} rotation={[0, 0, haustrum.rotation]} scale={haustrum.scale} castShadow>
          <sphereGeometry args={[1, 20, 14]} />
          <meshPhysicalMaterial color={PALETTE.colonLight} roughness={0.78} clearcoat={0.04} transparent opacity={faded ? opacity : 0.68} />
        </mesh>
      ))}
      <TissueTube points={taenia} radius={0.0384} color="#d9a391" opacity={faded ? 0.2 : 0.78} tubularSegments={120} roughness={0.65} />
    </group>
  );
}

export function CecumAndAppendix({ faded }: { faded: boolean }) {
  const appendix: readonly Point[] = [
    [-3.34, -1.85, -1.2], [-3.72, -2.12, -1.13], [-3.9, -2.55, -1.2], [-3.62, -2.76, -1.26],
  ];
  return (
    <group>
      <mesh position={[-3.27, -1.68, -1.31]} scale={[0.62, 0.83, 0.56]} castShadow>
        <sphereGeometry args={[0.72, 32, 24]} />
        <meshPhysicalMaterial color={PALETTE.colonLight} roughness={0.66} clearcoat={0.17} transparent={faded} opacity={faded ? 0.27 : 0.98} />
      </mesh>
      <TissueTube points={appendix} radius={0.105} color="#a85f59" opacity={faded ? 0.2 : 0.9} tubularSegments={50} endCaps />
      <mesh position={ILEOCECAL_JUNCTION_RAW} rotation={[0, 0, -0.35]} scale={[0.42, 0.15, 0.1]}>
        <sphereGeometry args={[1, 24, 14]} />
        <meshPhysicalMaterial color="#8a433e" roughness={0.62} clearcoat={0.2} transparent={faded} opacity={faded ? 0.22 : 0.9} />
      </mesh>
    </group>
  );
}

// A single continuous jejunoileal curve avoids visible capped fragments. Its
// final two points overlap the highlighted terminal-ileum segment.
const SMALL_BOWEL_PATH: readonly Point[] = [
  [1.18, 1.58, -1.02], [1.86, 1.82, -0.9], [2.42, 1.42, -0.84], [2.3, 0.94, -0.78],
  [1.58, 0.72, -0.72], [0.76, 0.94, -0.69], [-0.05, 1.32, -0.73], [-0.94, 1.42, -0.8],
  [-1.82, 1.16, -0.83], [-2.38, 0.72, -0.86], [-2.04, 0.34, -0.72], [-1.22, 0.54, -0.62],
  [-0.34, 0.76, -0.57], [0.58, 0.62, -0.55], [1.48, 0.3, -0.59], [2.14, -0.1, -0.7],
  [2.34, -0.56, -0.73], [1.72, -0.82, -0.63], [0.82, -0.58, -0.54], [-0.05, -0.3, -0.5],
  [-0.92, -0.48, -0.52], [-1.78, -0.76, -0.61], [-2.2, -1.08, -0.72], [-1.58, -1.3, -0.68],
  [-0.7, -1.12, -0.58], [0.18, -0.94, -0.54], [1.04, -1.14, -0.58], [1.62, -1.42, -0.66],
  [1.14, -1.66, -0.64], [0.34, -1.52, -0.6], [-0.28, -1.2, -0.58], [0.1, -0.86, -0.59],
  [0.55, -0.5, -0.62], [0.08, -0.35, -0.54],
];

export function SmallBowelBed({ faded }: { faded: boolean }) {
  return (
    <group>
      <TissueTube points={SMALL_BOWEL_PATH} radius={0.19} color={PALETTE.ileum} opacity={faded ? 0.23 : 0.98} tubularSegments={230} />
    </group>
  );
}

export function DuodenojejunalContinuity({ faded }: { faded: boolean }) {
  const duodenalEnd = scalePointAbout([0.72, 1.18, -1.62], ABDOMINAL_SCALE_PIVOT, ABDOMINAL_CONTENT_OFFSET);
  const jejunalStart = scaleGiPoint(SMALL_BOWEL_PATH[0]);
  const bridge: readonly Point[] = [
    duodenalEnd,
    [(duodenalEnd[0] + jejunalStart[0]) / 2, (duodenalEnd[1] + jejunalStart[1]) / 2, Math.min(duodenalEnd[2], jejunalStart[2]) - 0.08],
    jejunalStart,
  ];
  return <TissueTube points={bridge} radius={0.095} color={PALETTE.ileumLight} opacity={faded ? 0.23 : 0.98} tubularSegments={42} />;
}

function makeFanGeometry(root: Point, border: readonly Point[]) {
  const positions: number[] = [];
  for (let index = 0; index < border.length - 1; index += 1) {
    positions.push(...root, ...border[index], ...border[index + 1]);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

const MESENTERIC_LEAVES: readonly { root: Point; border: readonly Point[] }[] = [
  { root: [0.55, 0.72, -1.64], border: [[-2.58, 1.68, -1.08], [-1.6, 2.04, -0.98], [-0.52, 1.87, -0.92], [0.08, 1.46, -0.94]] },
  { root: [0.35, 0.42, -1.62], border: [[-2.62, 0.68, -0.98], [-1.72, 0.47, -0.8], [-0.78, 0.25, -0.74], [0.0, 0.58, -0.83]] },
  { root: [0.05, -0.03, -1.65], border: [[-2.18, -0.52, -0.96], [-1.66, -1.12, -0.84], [-0.76, -1.28, -0.78], [0.02, -1.25, -0.88]] },
  { root: [0.42, 0.34, -1.68], border: [[0.16, 2.04, -1.04], [1.1, 2.18, -0.95], [2.0, 1.82, -0.9], [2.25, 1.15, -0.94]] },
  { root: [0.4, -0.02, -1.66], border: [[0.18, 0.58, -0.84], [0.98, 0.58, -0.73], [1.62, 0.22, -0.73], [2.32, -0.18, -0.84]] },
  { root: [0.25, -0.36, -1.67], border: [[0.1, -1.28, -0.88], [0.72, -1.62, -0.82], [1.62, -1.5, -0.8], [2.22, -1.05, -0.84]] },
];

export function MesentericBed({ faded }: { faded: boolean }) {
  const geometries = useMemo(
    () => MESENTERIC_LEAVES.map(({ root, border }) => makeFanGeometry(root, border)),
    [],
  );
  useEffect(() => () => geometries.forEach((geometry) => geometry.dispose()), [geometries]);
  const vesselBranches: readonly (readonly Point[])[] = [
    [[0.5, 0.4, -1.48], [-0.38, 1.2, -1.2], [-1.58, 1.72, -0.98]],
    [[0.4, 0.24, -1.46], [-0.62, 0.45, -1.11], [-1.92, 0.47, -0.83]],
    [[0.3, 0.0, -1.46], [-0.55, -0.62, -1.08], [-1.65, -1.08, -0.82]],
    [[0.5, 0.45, -1.46], [0.98, 1.32, -1.14], [1.78, 1.82, -0.91]],
    [[0.45, 0.2, -1.44], [1.08, 0.4, -1.06], [1.88, 0.04, -0.78]],
    [[0.36, -0.08, -1.45], [0.9, -0.75, -1.1], [1.72, -1.42, -0.83]],
  ];
  const arcade: readonly Point[] = [
    [-1.82, 1.74, -0.93], [-1.14, 1.5, -0.88], [-0.42, 1.72, -0.89], [0.14, 1.44, -0.9],
    [0.8, 1.74, -0.87], [1.48, 1.88, -0.88], [2.02, 1.42, -0.86], [1.7, 0.78, -0.78],
    [2.14, 0.0, -0.76], [1.65, -0.72, -0.78], [1.82, -1.38, -0.82], [0.82, -1.52, -0.8],
    [0.05, -1.25, -0.8], [-0.76, -1.22, -0.77], [-1.58, -1.04, -0.8], [-1.92, -0.44, -0.84],
  ];
  const opacity = faded ? 0.1 : 0.34;
  return (
    <group>
      {geometries.map((geometry, index) => (
        <mesh key={index} geometry={geometry} renderOrder={1}>
          <meshPhysicalMaterial
            color={index % 2 ? PALETTE.mesentery : "#e0c17b"}
            roughness={0.82}
            transparent
            opacity={opacity}
            depthWrite={false}
            side={THREE.DoubleSide}
          />
        </mesh>
      ))}
      {vesselBranches.map((points, index) => (
        <TissueTube key={index} points={points} radius={index % 2 ? 0.022 : 0.029} color={index % 3 === 0 ? PALETTE.vein : PALETTE.artery} opacity={faded ? 0.1 : 0.62} tubularSegments={42} clearcoat={0.03} roughness={0.72} />
      ))}
      <TissueTube points={arcade} radius={0.022} color={PALETTE.artery} opacity={faded ? 0.08 : 0.58} tubularSegments={130} clearcoat={0.03} roughness={0.72} />
      {Array.from({ length: 18 }, (_, index) => {
        const angle = index * 2.18;
        const radius = 0.45 + (index % 5) * 0.23;
        return (
          <mesh key={index} position={[0.2 + Math.cos(angle) * radius, 0.15 + Math.sin(angle) * radius * 0.72, -1.28 + (index % 3) * 0.03]} scale={[0.1, 0.07, 0.045]}>
            <sphereGeometry args={[1, 12, 8]} />
            <meshStandardMaterial color={index % 4 === 0 ? "#bda763" : "#ac945b"} roughness={0.94} transparent opacity={faded ? 0.08 : 0.4} />
          </mesh>
        );
      })}
    </group>
  );
}

export function Omentum() {
  const geometry = useMemo(() => {
    const apron = new THREE.Shape();
    apron.moveTo(-2.5, 2.58);
    apron.bezierCurveTo(-1.7, 2.78, -0.8, 2.64, 0, 2.7);
    apron.bezierCurveTo(0.9, 2.76, 1.8, 2.62, 2.5, 2.38);
    apron.bezierCurveTo(2.25, 1.86, 1.72, 1.3, 1.4, 0.78);
    apron.bezierCurveTo(0.72, 0.58, 0.28, 0.74, -0.2, 0.54);
    apron.bezierCurveTo(-0.82, 0.78, -1.36, 0.58, -1.9, 0.86);
    apron.bezierCurveTo(-2.14, 1.42, -2.42, 1.98, -2.5, 2.58);
    apron.closePath();
    return new THREE.ShapeGeometry(apron, 64);
  }, []);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const lobules = useMemo(() => Array.from({ length: 14 }, (_, index) => {
    const column = index % 7;
    const row = Math.floor(index / 7);
    return {
      position: [-1.9 + column * 0.62 + Math.sin(index * 1.4) * 0.08, 2.24 - row * 0.56, -0.72 + row * 0.05] as Point,
      scale: [0.2 + (index % 3) * 0.025, 0.13, 0.065] as Point,
    };
  }), []);
  return (
    <group>
      <mesh geometry={geometry} position={[0, 0, -0.9]}>
        <meshPhysicalMaterial color="#b99a63" roughness={0.94} transparent opacity={0.2} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      {lobules.map((lobule, index) => (
        <mesh key={index} position={lobule.position} scale={lobule.scale}>
          <sphereGeometry args={[1, 18, 12]} />
          <meshStandardMaterial color={index % 3 ? "#baa263" : "#c6ad6e"} roughness={0.94} transparent opacity={0.48} />
        </mesh>
      ))}
      <TissueTube points={[[-2.42, 2.56, -0.8], [-1.3, 2.72, -0.8], [0.35, 2.7, -0.8], [1.72, 2.56, -0.84], [2.35, 2.34, -0.9]]} radius={0.035} color="#8e3f42" opacity={0.52} tubularSegments={90} roughness={0.78} clearcoat={0.03} />
    </group>
  );
}

export function ThoracicOrgans({ faded }: { faded: boolean }) {
  const lungOpacity = faded ? 0.08 : 0.68;
  const vascularOpacity = faded ? 0.05 : 0.42;
  return (
    <group>
      {[-1.35, 1.35].map((x, index) => (
        <group key={x} position={[x, 4.65, -1.78]} rotation={[0.04, index ? -0.08 : 0.08, index ? -0.08 : 0.08]} scale={1.2}>
          <mesh scale={[1.25, 1.48, 0.46]}>
            <sphereGeometry args={[1, 42, 30]} />
            <meshPhysicalMaterial color={index ? "#845a5c" : "#7f5558"} roughness={0.88} clearcoat={0.02} transparent opacity={lungOpacity} depthWrite={false} />
          </mesh>
          <TissueTube
            points={[[0, 0.92, 0.4], [index ? -0.18 : 0.18, 0.25, 0.43], [index ? -0.28 : 0.28, -0.82, 0.38]]}
            radius={0.025}
            color="#aa7774"
            opacity={vascularOpacity}
            tubularSegments={44}
            roughness={0.82}
            clearcoat={0.02}
          />
        </group>
      ))}
      <group position={[-0.12, 3.82, -1.18]} rotation={[0.02, 0.12, -0.32]}>
        <mesh scale={[0.58, 0.82, 0.43]}>
          <sphereGeometry args={[1, 38, 28]} />
          <meshPhysicalMaterial color="#71363b" roughness={0.78} clearcoat={0.05} transparent opacity={faded ? 0.08 : 0.78} />
        </mesh>
        <mesh position={[-0.18, 0.66, -0.04]} rotation={[0, 0, 0.2]}>
          <capsuleGeometry args={[0.13, 0.56, 10, 18]} />
          <meshStandardMaterial color="#74444a" roughness={0.82} transparent opacity={faded ? 0.06 : 0.64} />
        </mesh>
      </group>
      <TissueTube points={[[0, 5.72, -1.82], [0, 5.1, -1.78], [-0.62, 4.72, -1.7]]} radius={0.09} color="#866968" opacity={faded ? 0.05 : 0.38} tubularSegments={52} roughness={0.88} clearcoat={0.01} />
      <TissueTube points={[[0, 5.1, -1.78], [0.62, 4.72, -1.7]]} radius={0.075} color="#866968" opacity={faded ? 0.05 : 0.36} tubularSegments={34} roughness={0.88} clearcoat={0.01} />
      <mesh position={[0, 3.02, -1.88]} scale={[2.75, 0.48, 0.28]}>
        <sphereGeometry args={[1, 42, 22, 0, Math.PI * 2, 0, Math.PI * 0.58]} />
        <meshPhysicalMaterial color="#7c4c4c" roughness={0.9} transparent opacity={faded ? 0.04 : 0.2} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

export function SurroundingOrgans({ faded }: { faded: boolean }) {
  const organOpacity = faded ? 0.1 : 0.82;
  const posteriorOpacity = faded ? 0.06 : 0.56;
  const duodenum: readonly Point[] = [
    [1.32, 2.02, -1.72], [1.72, 1.55, -1.68], [1.56, 1.05, -1.68], [1.05, 0.86, -1.62], [0.72, 1.18, -1.62],
  ];
  const pancreas: readonly Point[] = [
    [-0.72, 1.55, -1.9], [0.05, 1.67, -1.86], [0.95, 1.66, -1.86], [1.85, 1.55, -1.92],
  ];
  const aorta: readonly Point[] = [[-0.23, 3.4, -2.2], [-0.2, 1.5, -2.18], [-0.18, -0.5, -2.18], [-0.75, -2.72, -2.08]];
  const cava: readonly Point[] = [[0.28, 3.4, -2.22], [0.3, 1.4, -2.2], [0.32, -0.45, -2.2], [0.82, -2.72, -2.1]];
  return (
    <group>
      <group position={[-1.55, 2.72, -1.92]}>
        <mesh scale={[2.45, 0.92, 0.46]} castShadow>
          <sphereGeometry args={[1, 42, 28]} />
          <meshPhysicalMaterial color="#684039" roughness={0.8} clearcoat={0.03} transparent opacity={organOpacity} />
        </mesh>
        <mesh position={[1.75, -0.12, 0.04]} scale={[1.42, 0.62, 0.34]} castShadow>
          <sphereGeometry args={[1, 34, 24]} />
          <meshPhysicalMaterial color="#74463d" roughness={0.8} clearcoat={0.03} transparent opacity={organOpacity} />
        </mesh>
        <mesh position={[-0.22, -0.82, 0.46]} rotation={[0, 0, 0.12]} scale={[0.22, 0.58, 0.2]}>
          <capsuleGeometry args={[0.52, 0.7, 12, 20]} />
          <meshPhysicalMaterial color="#566343" roughness={0.76} clearcoat={0.04} transparent opacity={organOpacity * 0.9} />
        </mesh>
      </group>

      <group position={[1.43, 2.08, -1.76]} rotation={[0.05, 0.16, -0.18]}>
        <mesh scale={[0.88, 1.18, 0.42]} castShadow>
          <sphereGeometry args={[1, 36, 26]} />
          <meshPhysicalMaterial color="#895a56" roughness={0.76} clearcoat={0.05} transparent opacity={organOpacity * 0.94} />
        </mesh>
        <mesh position={[-0.36, 0.72, 0.05]} scale={[0.55, 0.52, 0.33]}>
          <sphereGeometry args={[1, 28, 20]} />
          <meshPhysicalMaterial color="#96645f" roughness={0.76} clearcoat={0.05} transparent opacity={organOpacity * 0.9} />
        </mesh>
      </group>
      <TissueTube points={duodenum} radius={0.18} color="#b47b65" opacity={organOpacity * 0.82} tubularSegments={62} roughness={0.62} />
      <TissueTube points={pancreas} radius={0.15} color="#c89762" opacity={organOpacity * 0.72} tubularSegments={64} roughness={0.76} clearcoat={0.08} />

      <mesh position={[3.15, 2.32, -2.0]} rotation={[0, 0, -0.25]} scale={[0.48, 0.9, 0.27]}>
        <sphereGeometry args={[1, 32, 22]} />
        <meshPhysicalMaterial color="#594048" roughness={0.8} clearcoat={0.03} transparent opacity={organOpacity * 0.88} />
      </mesh>

      {[-2.3, 2.3].map((x, index) => (
        <group key={x} position={[x, 0.1, -2.08]} rotation={[0.08, index ? -0.2 : 0.2, index ? -0.1 : 0.1]}>
          <mesh scale={[0.56, 0.9, 0.3]}>
            <sphereGeometry args={[1, 30, 22]} />
            <meshPhysicalMaterial color="#644a43" roughness={0.82} clearcoat={0.02} transparent opacity={posteriorOpacity} />
          </mesh>
          <mesh position={[0, 0.86, 0.03]} scale={[0.34, 0.2, 0.2]}>
            <sphereGeometry args={[1, 24, 16]} />
            <meshStandardMaterial color="#c29a52" roughness={0.82} transparent opacity={posteriorOpacity * 0.8} />
          </mesh>
        </group>
      ))}
      <TissueTube points={[[-2.28, -0.62, -2.02], [-1.88, -1.55, -1.98], [-1.25, -2.45, -1.9], [-0.42, -3.08, -1.76]]} radius={0.035} color="#d0b987" opacity={posteriorOpacity * 0.7} tubularSegments={62} roughness={0.82} clearcoat={0.02} />
      <TissueTube points={[[2.28, -0.62, -2.02], [1.88, -1.55, -1.98], [1.25, -2.45, -1.9], [0.42, -3.08, -1.76]]} radius={0.035} color="#d0b987" opacity={posteriorOpacity * 0.7} tubularSegments={62} roughness={0.82} clearcoat={0.02} />
      <mesh position={[0, -3.38, -1.78]} scale={[0.72, 0.68, 0.3]}>
        <sphereGeometry args={[1, 32, 22]} />
        <meshPhysicalMaterial color="#b59272" roughness={0.66} clearcoat={0.15} transparent opacity={posteriorOpacity * 0.8} />
      </mesh>
      <TissueTube points={aorta} radius={0.085} color="#98333a" opacity={posteriorOpacity * 0.8} tubularSegments={72} roughness={0.56} clearcoat={0.14} />
      <TissueTube points={cava} radius={0.1} color="#4b5d7a" opacity={posteriorOpacity * 0.72} tubularSegments={72} roughness={0.56} clearcoat={0.14} />
    </group>
  );
}

export function SkeletalContext({ faded }: { faded: boolean }) {
  const opacity = faded ? 0.035 : 0.22;
  const ribLevels = [3.72, 3.4, 3.08, 2.78];
  return (
    <group>
      {ribLevels.map((y, index) => (
        <group key={y}>
          <TissueTube points={[[0.05, y, -2.34], [-1.15, y + 0.03, -2.3], [-2.45 - index * 0.12, y - 0.28, -2.25], [-3.55 - index * 0.08, y - 0.75, -2.2]]} radius={0.045} color="#d4c6aa" opacity={opacity} tubularSegments={50} roughness={0.78} clearcoat={0.02} />
          <TissueTube points={[[-0.05, y, -2.34], [1.15, y + 0.03, -2.3], [2.45 + index * 0.12, y - 0.28, -2.25], [3.55 + index * 0.08, y - 0.75, -2.2]]} radius={0.045} color="#d4c6aa" opacity={opacity} tubularSegments={50} roughness={0.78} clearcoat={0.02} />
        </group>
      ))}
      <group position={[0, PELVIC_BONE_CRANIAL_SHIFT, 0]}>
        <TissueTube points={[[-0.15, -3.58, -2.3], [-1.42, -3.82, -2.24], [-2.72, -3.62, -2.18], [-3.62, -3.02, -2.14]]} radius={0.12} color="#d4c6aa" opacity={opacity * 0.9} tubularSegments={58} roughness={0.8} clearcoat={0.02} />
        <TissueTube points={[[0.15, -3.58, -2.3], [1.42, -3.82, -2.24], [2.72, -3.62, -2.18], [3.62, -3.02, -2.14]]} radius={0.12} color="#d4c6aa" opacity={opacity * 0.9} tubularSegments={58} roughness={0.8} clearcoat={0.02} />
      </group>
    </group>
  );
}

export function PelvicContext({ faded }: { faded: boolean }) {
  const rectalContinuity: readonly Point[] = [
    COLON_POINTS[COLON_POINTS.length - 2], COLON_POINTS[COLON_POINTS.length - 1],
    [0.3, -2.92, -1.78], [0.25, -3.0, -2.02],
  ];
  return (
    <group>
      <mesh position={[0.2, -2.72, -1.88]} scale={[2.25, 0.82, 0.25]}>
        <sphereGeometry args={[1, 36, 20, 0, Math.PI * 2, 0, Math.PI * 0.62]} />
        <meshPhysicalMaterial color="#703d45" roughness={0.8} transparent opacity={faded ? 0.08 : 0.32} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <TissueTube points={rectalContinuity} radius={0.276} color={PALETTE.colon} opacity={faded ? 0.14 : 0.82} tubularSegments={48} roughness={0.76} />
    </group>
  );
}

const INTERNAL_SELECTED_RAW: readonly Point[] = [
  [0.55, -0.5, -0.62], [0.08, -0.35, -0.54], [-0.42, -0.46, -0.48], [-0.9, -0.62, -0.46],
  [-1.34, -0.74, -0.5], [-1.73, -0.88, -0.58], [-2.08, -1.02, -0.67], [-2.37, -1.22, -0.79],
  [-2.58, -1.4, -0.92], [-2.72, -1.51, -1.02], ILEOCECAL_JUNCTION_RAW,
];
const INTERNAL_SELECTED = scaleGiPoints(INTERNAL_SELECTED_RAW);

const DELIVERED_SELECTED_RAW: readonly Point[] = [
  [0.55, -0.5, -0.62], [0.08, -0.35, -0.54], [-0.42, -0.46, -0.48], [-0.9, -0.48, -0.45],
  [-1.36, -0.3, -0.48], [-1.7, -0.02, -0.36],
  [STOMA_CENTER[0] + 0.18, STOMA_CENTER[1] - 0.46, 0.0],
  [STOMA_CENTER[0] + 0.04, STOMA_CENTER[1] - 0.12, 0.92],
  [STOMA_CENTER[0], STOMA_CENTER[1] + 0.32, 1.78],
  [STOMA_CENTER[0] + 0.02, STOMA_CENTER[1] - 0.3, 1.72],
  [STOMA_CENTER[0] - 0.03, STOMA_CENTER[1] - 0.12, 0.9],
  [STOMA_CENTER[0] - 0.15, STOMA_CENTER[1] - 0.46, 0.0],
  [-2.58, -1.4, -0.92], ILEOCECAL_JUNCTION_RAW,
];
const DELIVERED_SELECTED: readonly Point[] = DELIVERED_SELECTED_RAW.map((point, index) => (
  // The tract starts at index 6. Scaling that point with the intra-abdominal
  // GI bed pulled the tube sideways so it appeared through intact skin.
  index <= 5 || index >= 12 ? scaleGiPoint(point) : point
));

function selectedPoints(delivered: boolean) {
  return delivered ? DELIVERED_SELECTED : INTERNAL_SELECTED;
}

function SelectedMesentery({ delivered, faded, concealed = false }: { delivered: boolean; faded: boolean; concealed?: boolean }) {
  const border = useMemo(() => {
    const raw: readonly Point[] = delivered
      ? [
        [-0.72, -0.43, -0.66], [-1.28, -0.31, -0.55], [-1.7, -0.02, -0.45],
        [STOMA_CENTER[0] + 0.15, STOMA_CENTER[1] - 0.48, -0.04],
        [STOMA_CENTER[0] + 0.05, STOMA_CENTER[1] - 0.16, 0.86],
        [STOMA_CENTER[0], STOMA_CENTER[1] + 0.02, 1.35],
        [STOMA_CENTER[0] - 0.04, STOMA_CENTER[1] - 0.18, 0.84],
        [STOMA_CENTER[0] - 0.16, STOMA_CENTER[1] - 0.48, -0.04],
        [-2.58, -1.38, -0.82],
      ]
      : [[0.18, -0.48, -0.73], [-0.54, -0.52, -0.65], [-1.28, -0.72, -0.62], [-1.94, -1.0, -0.67], [-2.55, -1.39, -0.84]];
    return delivered
      ? raw.map((point, index) => (index <= 2 || index === raw.length - 1 ? scaleGiPoint(point) : point))
      : scaleGiPoints(raw);
  }, [delivered]);
  const root = useMemo(() => scaleGiPoint([0.28, -0.28, -1.48]), []);
  const geometry = useMemo(() => makeFanGeometry(root, border), [border, root]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const branches = useMemo(() => border.slice(1, -1).map((point, index) => [root, [
    THREE.MathUtils.lerp(root[0], point[0], 0.58) + Math.sin(index) * 0.12,
    THREE.MathUtils.lerp(root[1], point[1], 0.58),
    THREE.MathUtils.lerp(root[2], point[2], 0.58) + 0.12,
  ] as Point, [point[0], point[1], point[2] + 0.08] as Point] as const), [border]);
  if (concealed) return null;
  return (
    <group>
      <mesh geometry={geometry}>
        <meshPhysicalMaterial color="#d4ad65" roughness={0.78} transparent opacity={faded ? 0.22 : 0.62} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      {branches.map((points, index) => (
        <TissueTube key={index} points={points} radius={(0.035 - index * 0.003) * INTERNAL_ORGAN_SCALE} color={index % 2 ? PALETTE.vein : PALETTE.artery} opacity={faded ? 0.2 : 0.9} tubularSegments={46} roughness={0.52} />
      ))}
      {border.map((point, index) => (
        <mesh key={index} position={[point[0], point[1] - 0.04, point[2] + 0.005]} scale={[(0.18 + (index % 2) * 0.05) * INTERNAL_ORGAN_SCALE, 0.055, 0.045]}>
          <sphereGeometry args={[1, 14, 9]} />
          <meshStandardMaterial color={index % 2 ? "#d6b652" : "#e1c66a"} roughness={0.88} transparent opacity={faded ? 0.2 : 0.86} />
        </mesh>
      ))}
    </group>
  );
}

function SelectedIleum({ delivered, faded, matured }: { delivered: boolean; faded: boolean; matured: boolean }) {
  const points = selectedPoints(delivered);
  const antimesenteric = useMemo(() => points.map((point) => [point[0], point[1] + 0.01, point[2] + 0.13] as Point), [points]);
  const matureProximal = useMemo(() => [
    ...DELIVERED_SELECTED.slice(0, 8),
    [
      STOMA_CENTER[0],
      STOMA_CENTER[1] + 0.23,
      MATURE_STOMA_SURFACE_Z + MATURE_STOMA_SCALE * 0.81,
    ] as Point,
  ], []);
  const matureDistal = useMemo(() => [
    [
      STOMA_CENTER[0],
      STOMA_CENTER[1] - 0.3,
      MATURE_STOMA_SURFACE_Z + MATURE_STOMA_SCALE * 0.92,
    ] as Point,
    ...DELIVERED_SELECTED.slice(10),
  ], []);
  if (matured) {
    return (
      <group>
        <TissueTube points={matureProximal} radius={0.11} color="#b86e67" opacity={faded ? 0.5 : 1} tubularSegments={130} radialSegments={20} clearcoat={0.12} roughness={0.68} />
        <TissueTube points={matureDistal} radius={0.11} color="#ad6863" opacity={faded ? 0.5 : 1} tubularSegments={72} radialSegments={20} clearcoat={0.1} roughness={0.7} />
      </group>
    );
  }
  return (
    <group>
      <TissueTube points={points} radius={0.11} color="#b86e67" opacity={faded ? 0.5 : 1} tubularSegments={190} radialSegments={20} clearcoat={0.12} roughness={0.68} />
      <TissueTube points={antimesenteric} radius={0.009} color="#e7a191" opacity={faded ? 0.25 : 0.72} tubularSegments={190} radialSegments={8} clearcoat={0.18} roughness={0.5} />
    </group>
  );
}

function OrientationMarkers() {
  const markers = [
    { center: [STOMA_CENTER[0] + 0.01, STOMA_CENTER[1] + 0.38, 1.78] as Point, color: PALETTE.proximal },
    { center: [STOMA_CENTER[0] - 0.02, STOMA_CENTER[1] - 0.38, 1.74] as Point, color: PALETTE.distal },
  ];
  return (
    <group>
      {markers.map((marker, index) => (
        <mesh key={index} position={marker.center} scale={[1, 0.82, 1]}>
          <torusGeometry args={[0.305, 0.035, 10, 54]} />
          <meshBasicMaterial color={marker.color} transparent opacity={0.94} depthTest={false} />
        </mesh>
      ))}
    </group>
  );
}

function PenroseSling() {
  const [x, y] = STOMA_CENTER;
  const points: readonly Point[] = [
    [x - 0.53, y + 0.12, 1.25], [x - 0.3, y - 0.32, 1.08], [x, y - 0.56, 1.12], [x + 0.27, y - 0.26, 1.11], [x + 0.49, y + 0.14, 1.22],
  ];
  return <TissueTube points={points} radius={0.055} color="#d7e2df" opacity={0.82} tubularSegments={64} roughness={0.52} clearcoat={0.16} />;
}

function SurgicalClamp({ x, y, rotation }: { x: number; y: number; rotation: number }) {
  return (
    <group position={[x, y, 2.05]} rotation={[0.12, 0, rotation]}>
      <mesh position={[0, 0.33, 0]}>
        <capsuleGeometry args={[0.025, 0.56, 5, 8]} />
        <meshPhysicalMaterial color="#bfc7c5" metalness={0.9} roughness={0.2} />
      </mesh>
      <mesh position={[0, -0.03, 0]}>
        <coneGeometry args={[0.08, 0.3, 10]} />
        <meshPhysicalMaterial color="#cdd3d1" metalness={0.88} roughness={0.22} />
      </mesh>
      <mesh position={[0, 0.7, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.09, 0.016, 6, 20]} />
        <meshPhysicalMaterial color="#bfc7c5" metalness={0.9} roughness={0.2} />
      </mesh>
    </group>
  );
}

function Enterotomy() {
  const [x, y] = STOMA_CENTER;
  const upper: readonly Point[] = [[x - 0.38, y + 0.07, 1.99], [x - 0.18, y + 0.18, 2.07], [x + 0.02, y + 0.2, 2.1], [x + 0.22, y + 0.16, 2.07], [x + 0.4, y + 0.05, 1.99]];
  const lower: readonly Point[] = [[x - 0.38, y, 1.98], [x - 0.18, y - 0.1, 2.06], [x + 0.02, y - 0.12, 2.09], [x + 0.22, y - 0.08, 2.06], [x + 0.4, y, 1.98]];
  return (
    <group>
      <mesh position={[x + 0.01, y + 0.03, 2.02]} scale={[0.44, 0.13, 1]}>
        <circleGeometry args={[1, 64]} />
        <meshBasicMaterial color={PALETTE.mucosaDark} depthTest={false} />
      </mesh>
      <TissueTube points={upper} radius={0.072} color={PALETTE.mucosaLight} tubularSegments={52} radialSegments={12} roughness={0.44} clearcoat={0.36} />
      <TissueTube points={lower} radius={0.072} color={PALETTE.mucosa} tubularSegments={52} radialSegments={12} roughness={0.44} clearcoat={0.36} />
      <SurgicalClamp x={x - 0.44} y={y + 0.02} rotation={0.28} />
      <SurgicalClamp x={x + 0.47} y={y + 0.02} rotation={-0.28} />
    </group>
  );
}

function makeOrganicTorus(major: number, tube: number, seed: number) {
  const geometry = new THREE.TorusGeometry(major, tube, 20, 84);
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index);
    const y = position.getY(index);
    const angle = Math.atan2(y, x);
    const wobble = 1 + Math.sin(angle * 5 + seed) * 0.045 + Math.sin(angle * 9 - seed) * 0.022;
    position.setXYZ(index, x * wobble, y * (1 + Math.cos(angle * 4 + seed) * 0.035), position.getZ(index));
  }
  geometry.computeVertexNormals();
  return geometry;
}

function makeStomaPlateGeometry(includeDistal: boolean) {
  const shape = new THREE.Shape();
  const segments = 96;
  for (let index = 0; index <= segments; index += 1) {
    const angle = (index / segments) * Math.PI * 2;
    const wobble = 1 + Math.sin(angle * 5 + 0.4) * 0.045 + Math.sin(angle * 9 - 0.2) * 0.022;
    const x = Math.cos(angle) * 0.66 * wobble;
    const y = Math.sin(angle) * 0.78 * wobble;
    if (index === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  shape.closePath();
  const proximalHole = new THREE.Path();
  proximalHole.absellipse(0, 0.23, 0.29, 0.25, 0, Math.PI * 2, true, 0);
  shape.holes.push(proximalHole);
  if (includeDistal) {
    const distalHole = new THREE.Path();
    distalHole.absellipse(0, -0.3, 0.15, 0.115, 0, Math.PI * 2, true, 0);
    shape.holes.push(distalHole);
  }
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.11,
    bevelEnabled: true,
    bevelSize: 0.04,
    bevelThickness: 0.035,
    bevelSegments: 3,
    curveSegments: 72,
  });
  geometry.center();
  return geometry;
}

function makeSpoutGeometry() {
  const profile = [
    new THREE.Vector2(0.51, -0.08),
    new THREE.Vector2(0.5, 0.05),
    new THREE.Vector2(0.45, 0.24),
    new THREE.Vector2(0.39, 0.48),
    new THREE.Vector2(0.34, 0.68),
    new THREE.Vector2(0.31, 0.78),
  ];
  const geometry = new THREE.LatheGeometry(profile, 72);
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index);
    const z = position.getZ(index);
    const angle = Math.atan2(z, x);
    const wobble = 1 + Math.sin(angle * 6) * 0.035 + Math.sin(angle * 11 + 0.8) * 0.018;
    position.setX(index, x * wobble);
    position.setZ(index, z * wobble);
  }
  geometry.computeVertexNormals();
  return geometry;
}

function Suture({ position, rotation = 0, length = 0.24 }: { position: Point; rotation?: number; length?: number }) {
  return (
    <group position={position} rotation={[0, 0, rotation]}>
      <mesh>
        <torusGeometry args={[0.055, 0.008, 6, 20, Math.PI * 1.55]} />
        <meshBasicMaterial color="#e9dfcf" transparent opacity={0.9} depthTest={false} />
      </mesh>
      <mesh position={[0, length * 0.42, 0]}>
        <cylinderGeometry args={[0.007, 0.007, length, 6]} />
        <meshBasicMaterial color="#e9dfcf" transparent opacity={0.9} depthTest={false} />
      </mesh>
    </group>
  );
}

function MucosalFolds({ center, spout }: { center: [number, number]; spout: boolean }) {
  const folds = useMemo(() => Array.from({ length: spout ? 9 : 6 }, (_, index) => {
    const angle = (index / (spout ? 9 : 6)) * Math.PI * 2 + 0.15;
    const inner = spout ? 0.3 : 0.14;
    const outer = spout ? 0.48 : 0.27;
    const z = spout ? 1.63 + (index % 3) * 0.02 : 0.93;
    return [
      [center[0] + Math.cos(angle) * inner, center[1] + Math.sin(angle) * inner, z] as Point,
      [center[0] + Math.cos(angle + 0.08) * ((inner + outer) / 2), center[1] + Math.sin(angle + 0.08) * ((inner + outer) / 2), z - 0.12] as Point,
      [center[0] + Math.cos(angle) * outer, center[1] + Math.sin(angle) * outer, z - 0.2] as Point,
    ] as const;
  }), [center, spout]);
  return (
    <group>
      {folds.map((points, index) => (
        <TissueTube key={index} points={points} radius={0.018} color={index % 2 ? "#8d2037" : "#ef7482"} tubularSegments={18} radialSegments={7} roughness={0.42} clearcoat={0.32} />
      ))}
    </group>
  );
}

function MatureStoma({ step }: { step: number }) {
  const proximal: [number, number] = [STOMA_CENTER[0], STOMA_CENTER[1] + 0.23];
  const distal: [number, number] = [STOMA_CENTER[0], STOMA_CENTER[1] - 0.3];
  const distalOpen = step >= 6;
  const plateGeometry = useMemo(() => makeStomaPlateGeometry(distalOpen), [distalOpen]);
  const proximalRim = useMemo(() => makeOrganicTorus(0.3, 0.085, 1.4), []);
  const distalRim = useMemo(() => makeOrganicTorus(0.18, 0.065, 2.1), []);
  const spoutGeometry = useMemo(() => makeSpoutGeometry(), []);
  useEffect(() => () => {
    plateGeometry.dispose();
    proximalRim.dispose();
    distalRim.dispose();
    spoutGeometry.dispose();
  }, [distalRim, plateGeometry, proximalRim, spoutGeometry]);
  if (step < 5) return null;
  const [x, y] = STOMA_CENTER;
  const sutures: { position: Point; rotation: number }[] = [
    { position: [x - 0.6, y + 0.22, 0.67], rotation: -0.05 },
    { position: [x - 0.44, y + 0.58, 0.68], rotation: 0.7 },
    { position: [x - 0.03, y + 0.76, 0.7], rotation: 1.4 },
    { position: [x + 0.44, y + 0.6, 0.68], rotation: 2.3 },
    { position: [x + 0.6, y + 0.21, 0.67], rotation: 3.05 },
    { position: [x + 0.47, y - 0.24, 0.66], rotation: 3.7 },
    { position: [x + 0.16, y - 0.62, 0.66], rotation: 4.5 },
    { position: [x - 0.31, y - 0.52, 0.66], rotation: 5.2 },
    { position: [x - 0.6, y - 0.21, 0.66], rotation: 5.9 },
  ];
  return (
    <group>
      <mesh geometry={plateGeometry} position={[STOMA_CENTER[0], STOMA_CENTER[1], 0.79]}>
        <meshPhysicalMaterial color="#c63a53" roughness={0.46} clearcoat={0.34} clearcoatRoughness={0.22} bumpMap={TISSUE_BUMP} bumpScale={0.008} />
      </mesh>
      <mesh geometry={spoutGeometry} position={[proximal[0], proximal[1], 0.81]} rotation={[Math.PI / 2, 0, 0]}>
        <meshPhysicalMaterial color={PALETTE.mucosa} roughness={0.43} clearcoat={0.38} clearcoatRoughness={0.2} bumpMap={TISSUE_BUMP} bumpScale={0.008} side={THREE.DoubleSide} />
      </mesh>
      <mesh geometry={proximalRim} position={[proximal[0], proximal[1], 1.61]}>
        <meshPhysicalMaterial color={PALETTE.mucosaLight} roughness={0.42} clearcoat={0.42} clearcoatRoughness={0.18} />
      </mesh>
      <mesh position={[proximal[0], proximal[1], 1.615]} scale={[0.97, 0.86, 1]}>
        <circleGeometry args={[0.25, 64]} />
        <meshBasicMaterial color={PALETTE.mucosaDark} />
      </mesh>
      <MucosalFolds center={proximal} spout />

      {step >= 6 && (
        <group>
          <mesh geometry={distalRim} position={[distal[0], distal[1], 0.92]} scale={[1.06, 0.86, 1]}>
            <meshPhysicalMaterial color="#d8475d" roughness={0.44} clearcoat={0.36} clearcoatRoughness={0.2} />
          </mesh>
          <mesh position={[distal[0], distal[1], 0.925]} scale={[1, 0.72, 1]}>
            <circleGeometry args={[0.125, 48]} />
            <meshBasicMaterial color="#571023" />
          </mesh>
          <MucosalFolds center={distal} spout={false} />
        </group>
      )}
      {sutures.slice(0, step === 5 ? 6 : sutures.length).map((suture, index) => (
        <Suture key={index} position={suture.position} rotation={suture.rotation} />
      ))}
      <TissueTube points={[[x - 0.41, y - 0.04, 0.84], [x - 0.24, y - 0.05, 0.94], [x - 0.03, y - 0.04, 1.0], [x + 0.22, y - 0.05, 0.91], [x + 0.42, y - 0.04, 0.82]]} radius={0.035} color="#8e263b" tubularSegments={46} radialSegments={8} roughness={0.44} clearcoat={0.32} />
    </group>
  );
}

function makeTextTexture(text: string, accent: string) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d")!;
  const scale = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = 380 * scale;
  canvas.height = 82 * scale;
  context.scale(scale, scale);
  context.fillStyle = "rgba(24, 31, 30, 0.94)";
  context.beginPath();
  context.roundRect(3, 3, 374, 76, 14);
  context.fill();
  context.fillStyle = accent;
  context.fillRect(18, 18, 4, 43);
  context.fillStyle = "#fffaf2";
  context.font = "600 17px Inter, Arial, sans-serif";
  context.fillText(text, 36, 38);
  context.fillStyle = "rgba(255,250,242,.62)";
  context.font = "11px Inter, Arial, sans-serif";
  context.fillText("OPERATIVE LANDMARK", 36, 58);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  return texture;
}

function LabelSprite({ text, position, accent = "#d5a84d", scale = 1 }: { text: string; position: Point; accent?: string; scale?: number }) {
  const texture = useMemo(() => makeTextTexture(text, accent), [text, accent]);
  useEffect(() => () => texture.dispose(), [texture]);
  return (
    <sprite position={position} scale={[2.2 * scale / PROCEDURE_SCALE, 0.48 * scale / PROCEDURE_SCALE_Y, 1]} renderOrder={30}>
      <spriteMaterial map={texture} transparent depthTest={false} />
    </sprite>
  );
}

function GIContinuityMarkers() {
  const ascending = scaleGiPoint([-3.38, 0.62, -1.28]);
  const transverse = scaleGiPoint([0.1, 2.58, -1.18]);
  const descending = scaleGiPoint([3.23, -0.12, -1.22]);
  const ilealArcade = scaleGiPoint([-1.58, -1.04, -0.8]);
  const landmarks: { text: string; anchor: Point; label: Point; color: string }[] = [
    { text: "ASCENDING COLON · PATIENT RIGHT", anchor: ascending, label: [-3.35, ascending[1] + 0.12, 0.7], color: PALETTE.colonLight },
    { text: "TRANSVERSE COLON", anchor: transverse, label: [0, transverse[1] + 0.54, 0.7], color: PALETTE.colonLight },
    { text: "DESCENDING · SIGMOID COLON", anchor: descending, label: [3.35, descending[1] - 0.12, 0.7], color: PALETTE.colonLight },
    { text: "TERMINAL ILEUM → MEDIAL CECUM", anchor: ILEOCECAL_JUNCTION, label: [-2.5, ILEOCECAL_JUNCTION[1] - 0.05, 0.82], color: PALETTE.distal },
    { text: "ILEAL VASCULAR ARCADES", anchor: ilealArcade, label: [0.6, ilealArcade[1] + 0.18, 0.82], color: PALETTE.artery },
  ];
  return (
    <group>
      {landmarks.map((landmark) => (
        <group key={landmark.text}>
          <mesh position={[landmark.anchor[0], landmark.anchor[1], landmark.anchor[2] + 0.24]} renderOrder={31}>
            <torusGeometry args={[0.075, 0.016, 8, 36]} />
            <meshBasicMaterial color={landmark.color} transparent opacity={0.96} depthTest={false} />
          </mesh>
          <LabelSprite text={landmark.text} position={landmark.label} accent={landmark.color} scale={0.5} />
        </group>
      ))}
    </group>
  );
}

function DirectionArrows() {
  const proximal = INTERNAL_SELECTED[1];
  const distal = INTERNAL_SELECTED[INTERNAL_SELECTED.length - 2];
  const arrows: { position: Point; rotation: number; color: string }[] = [
    { position: [proximal[0], proximal[1] + 0.08, proximal[2] + 0.3], rotation: -1.65, color: PALETTE.proximal },
    { position: [distal[0], distal[1], distal[2] + 0.26], rotation: -1.18, color: PALETTE.distal },
  ];
  return (
    <group>
      {arrows.map((arrow, index) => (
        <mesh key={index} position={arrow.position} rotation={[0, 0, arrow.rotation]}>
          <coneGeometry args={[0.085, 0.25, 18]} />
          <meshBasicMaterial color={arrow.color} transparent opacity={0.94} depthTest={false} />
        </mesh>
      ))}
    </group>
  );
}

function FlowParticles() {
  const refs = useRef<(THREE.Mesh | null)[]>([]);
  const flowCurve = useMemo(() => curveFrom([
    ...DELIVERED_SELECTED.slice(0, 9), [STOMA_CENTER[0], STOMA_CENTER[1] + 0.28, 2.4],
  ]), []);
  useFrame(({ clock }) => {
    refs.current.forEach((mesh, index) => {
      if (!mesh) return;
      const t = (clock.elapsedTime * 0.12 + index / refs.current.length) % 1;
      mesh.position.copy(flowCurve.getPointAt(t));
      mesh.scale.setScalar(0.78 + Math.sin((t + index) * Math.PI * 4) * 0.16);
    });
  });
  return (
    <group>
      {Array.from({ length: 20 }, (_, index) => (
        <mesh key={index} ref={(mesh) => { refs.current[index] = mesh; }}>
          <sphereGeometry args={[0.075, 12, 10]} />
          <meshBasicMaterial color={index % 3 ? "#f0a65d" : "#f3d070"} transparent opacity={0.88} depthTest={false} />
        </mesh>
      ))}
    </group>
  );
}

function OstomyPouch() {
  const shape = useMemo(() => {
    const pouch = new THREE.Shape();
    pouch.moveTo(-0.73, 0.84);
    pouch.quadraticCurveTo(-0.92, 0.08, -0.6, -1.26);
    pouch.quadraticCurveTo(0, -1.55, 0.6, -1.26);
    pouch.quadraticCurveTo(0.92, 0.08, 0.73, 0.84);
    pouch.closePath();
    const hole = new THREE.Path();
    hole.absellipse(0, 0.57, 0.42, 0.48, 0, Math.PI * 2, true, 0);
    pouch.holes.push(hole);
    return pouch;
  }, []);
  const geometry = useMemo(() => new THREE.ShapeGeometry(shape, 56), [shape]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <group position={[STOMA_CENTER[0], STOMA_CENTER[1], 2.18]}>
      <mesh geometry={geometry} scale={[1.13, 1.13, 1]}>
        <meshPhysicalMaterial color="#d8ded4" transparent opacity={0.23} roughness={0.24} transmission={0.16} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <mesh position={[0, 0.61, 0.03]}>
        <torusGeometry args={[0.49, 0.075, 12, 64]} />
        <meshPhysicalMaterial color="#d9d0b8" transparent opacity={0.78} roughness={0.5} />
      </mesh>
    </group>
  );
}

const STEP_ENTRY_MOTIONS = [
  { offset: [0, 0, -0.03] as Point, scale: 0.992, duration: 0.55 },
  { offset: [0, -0.04, -0.08] as Point, scale: 0.985, duration: 0.72 },
  { offset: [0, -0.1, -0.16] as Point, scale: 0.976, duration: 0.82 },
  { offset: [-0.035, 0, -0.06] as Point, scale: 0.99, duration: 0.68 },
  { offset: [0, 0.025, -0.07] as Point, scale: 0.986, duration: 0.72 },
  { offset: [0, -0.03, -0.11] as Point, scale: 0.982, duration: 0.78 },
  { offset: [0.03, 0, -0.06] as Point, scale: 0.99, duration: 0.65 },
  { offset: [-0.03, 0, -0.06] as Point, scale: 0.99, duration: 0.65 },
  { offset: [0, 0.04, -0.08] as Point, scale: 0.988, duration: 0.76 },
  { offset: [0, 0, -0.05] as Point, scale: 0.992, duration: 0.72 },
] as const;

function AnimatedProcedureStep({ step, children }: { step: number; children: ReactNode }) {
  const group = useRef<THREE.Group>(null);
  const elapsed = useRef<number>(STEP_ENTRY_MOTIONS[step].duration);
  const prefersReducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    elapsed.current = prefersReducedMotion ? STEP_ENTRY_MOTIONS[step].duration : 0;
  }, [prefersReducedMotion, step]);

  useFrame((_, delta) => {
    if (!group.current) return;
    const motion = STEP_ENTRY_MOTIONS[step];
    elapsed.current = Math.min(motion.duration, elapsed.current + delta);
    const progress = prefersReducedMotion ? 1 : elapsed.current / motion.duration;
    const eased = progress * progress * (3 - 2 * progress);
    const inverse = 1 - eased;
    group.current.position.set(
      motion.offset[0] * inverse,
      motion.offset[1] * inverse,
      motion.offset[2] * inverse,
    );
    const scale = THREE.MathUtils.lerp(motion.scale, 1, eased);
    group.current.scale.setScalar(scale);
  });

  return <group ref={group}>{children}</group>;
}

function AnatomicalScene({ step, transparentWall, showLabels }: Pick<SceneProps, "step" | "transparentWall" | "showLabels">) {
  const delivered = step >= 2;
  const inspection = step >= 8;
  return (
    <group rotation={[-0.13, 0.035, 0]}>
      <Suspense fallback={null}><SurgicalDrape transparent={transparentWall} /></Suspense>
      <group position={[0, 0, PATIENT_SUPPORT_Z]}>
        <Suspense fallback={null}><RealisticPatientShell transparent={transparentWall} /></Suspense>
        <OxygenMask transparent={transparentWall} />
        <AnimatedProcedureStep step={step}>
          <group position={[0, ANATOMY_CRANIAL_SHIFT, ANATOMY_DEPTH_SHIFT]} scale={[PROCEDURE_SCALE, PROCEDURE_SCALE_Y, PROCEDURE_SCALE_Z]}>
            {transparentWall && (
              <ScaleInternalContents pivot={GI_SCALE_PIVOT} offset={GI_CONTENT_OFFSET}>
                <ColonFrame faded={inspection} />
                <CecumAndAppendix faded={inspection} />
                <MesentericBed faded={inspection} />
                <SmallBowelBed faded={inspection} />
              </ScaleInternalContents>
            )}
            {(transparentWall || delivered) && (
              <>
                <SelectedMesentery delivered={delivered} faded={false} concealed={step >= 5 && !transparentWall} />
                {(transparentWall || step < 5) && <SelectedIleum delivered={delivered} faded={false} matured={step >= 5} />}
              </>
            )}
            {step === 0 && transparentWall && <DirectionArrows />}
            {step >= 2 && step <= 4 && <PenroseSling />}
            {step === 3 && <OrientationMarkers />}
            {step === 4 && <Enterotomy />}
            <group position={[STOMA_CENTER[0], STOMA_CENTER[1], MATURE_STOMA_SURFACE_Z]} scale={MATURE_STOMA_SCALE}>
              <group position={[-STOMA_CENTER[0], -STOMA_CENTER[1], 0]}>
                <MatureStoma step={step} />
              </group>
            </group>
            {step === 9 && <><FlowParticles /><OstomyPouch /></>}

            {showLabels && transparentWall && step === 0 && (
              <GIContinuityMarkers />
            )}
            {showLabels && step === 1 && <LabelSprite text="TRANS-RECTUS TRACT" position={[STOMA_CENTER[0] - 0.23, STOMA_CENTER[1] + 0.05, 1.12]} accent={PALETTE.fascia} scale={0.68} />}
            {showLabels && step === 8 && (
              <>
                <LabelSprite text="UNTWISTED MESENTERIC PEDICLE" position={scaleGiPoint([-0.2, 1.5, 0.95])} accent={PALETTE.mesentery} scale={0.58} />
                <LabelSprite text="CECUM / ILEOCECAL JUNCTION" position={[-2.55, ILEOCECAL_JUNCTION[1] - 0.35, 0.72]} accent={PALETTE.distal} scale={0.56} />
              </>
            )}
          </group>
          <group position={[0, ANATOMY_CRANIAL_SHIFT, 0]} scale={[PROCEDURE_SCALE, PROCEDURE_SCALE_Y, PROCEDURE_SCALE_Z]}>
            <AbdominalWall step={step} transparent={transparentWall} />
          </group>
        </AnimatedProcedureStep>
      </group>
    </group>
  );
}

export function SurgicalScene({ step, transparentWall, showLabels, resetView, roomState, onRoomChange }: SceneProps) {
  return (
    <Canvas
      shadows
      dpr={[1, 1.35]}
      camera={{ position: DEFAULT_CAMERA.toArray(), fov: 41, near: 0.1, far: 70 }}
      gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      onCreated={({ gl }) => {
        gl.outputColorSpace = THREE.SRGBColorSpace;
        gl.toneMapping = THREE.ACESFilmicToneMapping;
        gl.toneMappingExposure = 1.02;
      }}
    >
      <color attach="background" args={["#0f4549"]} />
      <fog attach="fog" args={["#244f58", 25, 46]} />
      <ambientLight intensity={roomState.ambientLights ? 0.5 : 0.22} />
      <hemisphereLight args={["#fff2df", "#263f41", roomState.ambientLights ? 0.62 : 0.26]} />
      <spotLight position={[1.5, 7.5, 11]} intensity={roomState.surgicalLights ? 2.7 * roomState.surgicalLightIntensity : 0.5} angle={0.54} penumbra={0.72} color="#fff0dc" castShadow shadow-mapSize={[768, 768]} />
      <spotLight position={[-7, 1.5, 7]} intensity={2.1} angle={0.62} penumbra={0.8} color="#ffe0cf" />
      <directionalLight position={[6, -3, 5]} intensity={0.8} color="#c7e0de" />
      <OperatingRoom state={roomState} onChange={onRoomChange} />
      <AnatomicalScene step={step} transparentWall={transparentWall} showLabels={showLabels} />
      <CameraControls resetView={resetView} step={step} />
    </Canvas>
  );
}
