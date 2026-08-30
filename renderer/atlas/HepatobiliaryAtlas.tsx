import { useLoader } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { AnatomyLabel, MembraneSheet, OrganicOrgan, TaperedTube } from "./OrganicAnatomy";
import { TissueTube } from "./PatientAtlas";
import type { AtlasPoint } from "./types";

export type HepatobiliaryPhase = "orientation" | "exposure" | "dissection" | "critical-view" | "danger";
export type CysticArteryVariant = "standard" | "moynihan-hump";
export type CysticDuctVariant = "angular" | "parallel" | "short";

export type HepatobiliaryAtlasProps = {
  phase: HepatobiliaryPhase;
  showLabels?: boolean;
  showInstruments?: boolean;
  cysticArteryVariant?: CysticArteryVariant;
  cysticDuctVariant?: CysticDuctVariant;
};

const LIVER = "#6e2c24";
const LIVER_DARK = "#3c1514";
const GALLBLADDER = "#638653";
const BILE_DUCT = "#a9bd72";
const ARTERY = "#c7423d";
const VEIN = "#396e91";
const FASCIA = "#d9c9a7";

function Liver({ opacity = 1 }: { opacity?: number }) {
  const gltf = useLoader(GLTFLoader, "/viewer/models/VH_M_Liver.glb");
  const prepared = useMemo(() => {
    const scene = gltf.scene.clone(true);
    const materials: THREE.Material[] = [];
    scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const capsule = object.name === "VH_M_liver_capsule";
      const portaHepatis = object.name === "VH_M_porta_hepatis";
      object.visible = capsule || portaHepatis;
      if (!object.visible) return;
      const material = new THREE.MeshPhysicalMaterial({
        color: portaHepatis ? LIVER_DARK : LIVER,
        roughness: portaHepatis ? 0.7 : 0.48,
        clearcoat: portaHepatis ? 0.08 : 0.3,
        clearcoatRoughness: 0.62,
        sheen: portaHepatis ? 0.04 : 0.18,
        sheenColor: new THREE.Color("#b96a58"),
        transparent: opacity < 1,
        opacity,
        depthWrite: opacity > 0.7,
      });
      materials.push(material);
      object.material = material;
      object.castShadow = true;
      object.receiveShadow = true;
    });
    return { materials, scene };
  }, [gltf.scene, opacity]);
  useEffect(() => () => prepared.materials.forEach((material) => material.dispose()), [prepared]);
  return (
    <group name="inferior-liver-surface-segments-ivb-v">
      {/*
        HuBMAP's source model is centred through the full liver thickness. Its
        anterior extent is about +10 cm after the scale below, whereas this
        component's hilar anatomy is authored around z=+2..+4 cm. Register the
        capsule posteriorly so the gallbladder and portal structures sit on the
        visceral surface instead of being embedded inside opaque parenchyma.
      */}
      <primitive object={prepared.scene} position={[2.7, -32.3, -8.2]} scale={100} />
      <TissueTube
        points={[[0.35, 0.7, 2.08], [0.15, 2.8, 2.36], [0.5, 5.4, 2.34], [0.95, 7.25, 1.72]]}
        radius={0.075}
        color="#3f1715"
        opacity={0.72}
        radialSegments={10}
        tubularSegments={48}
        roughness={0.75}
        endCaps
      />
      <TissueTube
        points={[[-5.9, 0.6, 0.72], [-4.7, 0.95, 1.04], [-3.35, 1.18, 1.31], [-2.25, 1.16, 1.44]]}
        radius={0.19}
        color={LIVER_DARK}
        opacity={0.96}
        radialSegments={14}
        tubularSegments={48}
        roughness={0.74}
        endCaps
      />
    </group>
  );
}

function buildViscusGeometry(points: readonly AtlasPoint[], radii: readonly [number, number][]) {
  const curve = new THREE.CatmullRomCurve3(points.map((point) => new THREE.Vector3(...point)), false, "centripetal", 0.45);
  const tubularSegments = 96;
  const radialSegments = 36;
  const frames = curve.computeFrenetFrames(tubularSegments, false);
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const center = new THREE.Vector3();
  const normal = new THREE.Vector3();
  // The distal point is emitted as one pole vertex below. Repeating an entire
  // near-zero ring at t=1 leaves coincident vertices and, from an operative
  // camera, reads as an open/forked fundus instead of a smooth closed dome.
  for (let ring = 0; ring < tubularSegments; ring += 1) {
    const t = ring / tubularSegments;
    curve.getPointAt(t, center);
    const scaled = t * (radii.length - 1);
    const lower = Math.min(radii.length - 2, Math.floor(scaled));
    const blend = scaled - lower;
    const radiusX = THREE.MathUtils.lerp(radii[lower]![0], radii[lower + 1]![0], blend);
    const radiusZ = THREE.MathUtils.lerp(radii[lower]![1], radii[lower + 1]![1], blend);
    for (let side = 0; side <= radialSegments; side += 1) {
      const angle = (side / radialSegments) * Math.PI * 2;
      const wave = 1 + Math.sin(angle * 3 + t * 8) * 0.012;
      normal.copy(frames.normals[ring]!).multiplyScalar(Math.cos(angle) * radiusX * wave);
      normal.addScaledVector(frames.binormals[ring]!, Math.sin(angle) * radiusZ * wave);
      positions.push(center.x + normal.x, center.y + normal.y, center.z + normal.z);
      normal.normalize();
      normals.push(normal.x, normal.y, normal.z);
      uvs.push(t, side / radialSegments);
    }
  }
  const columns = radialSegments + 1;
  for (let ring = 0; ring < tubularSegments - 1; ring += 1) {
    for (let side = 0; side < radialSegments; side += 1) {
      const a = ring * columns + side;
      const b = (ring + 1) * columns + side;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }

  const startCenterIndex = positions.length / 3;
  curve.getPointAt(0, center);
  positions.push(center.x, center.y, center.z);
  normal.copy(frames.tangents[0]!).multiplyScalar(-1);
  normals.push(normal.x, normal.y, normal.z);
  uvs.push(0, 0.5);

  const endCenterIndex = positions.length / 3;
  curve.getPointAt(1, center);
  positions.push(center.x, center.y, center.z);
  normal.copy(frames.tangents[tubularSegments]!);
  normals.push(normal.x, normal.y, normal.z);
  uvs.push(1, 0.5);

  const lastRing = (tubularSegments - 1) * columns;
  for (let side = 0; side < radialSegments; side += 1) {
    indices.push(startCenterIndex, side, side + 1);
    indices.push(endCenterIndex, lastRing + side + 1, lastRing + side);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function Gallbladder({ elevated }: { elevated: boolean }) {
  const points = useMemo<AtlasPoint[]>(() => elevated
    ? [
        [-1.52, 0.42, 1.25],
        [-1.82, 0.78, 1.52],
        [-2.15, 1.35, 1.8],
        [-2.55, 2.2, 2.07],
        [-2.95, 3.2, 2.3],
        [-3.35, 4.25, 2.5],
        [-3.72, 5.3, 2.75],
        [-4.0, 6.05, 2.92],
        [-4.1, 6.35, 3.0],
      ]
    : [
        [-1.52, 0.42, 1.1],
        [-1.7, 0.8, 1.28],
        [-1.95, 1.42, 1.42],
        [-2.18, 2.3, 1.5],
        [-2.42, 3.3, 1.52],
        [-2.64, 4.3, 1.49],
        [-2.82, 5.18, 1.42],
        [-2.94, 5.8, 1.36],
        [-2.98, 6.08, 1.33],
      ],
  [elevated]);
  const radii = useMemo<readonly [number, number][]>(() => [
    [0.24, 0.22],
    [0.58, 0.48],
    [0.88, 0.7],
    [1.12, 0.86],
    [1.32, 0.98],
    [1.46, 1.08],
    [1.4, 1.04],
    [0.92, 0.7],
    [0.01, 0.01],
  ], []);
  const geometry = useMemo(() => buildViscusGeometry(points, radii), [points, radii]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <group name="gallbladder-fundus-body-infundibulum-neck">
      <mesh geometry={geometry} castShadow receiveShadow>
        <meshPhysicalMaterial
          color={GALLBLADDER}
          roughness={0.36}
          clearcoat={0.5}
          clearcoatRoughness={0.36}
          sheen={0.18}
          sheenColor="#b8c594"
        />
      </mesh>
      <OrganicOrgan
        position={elevated ? [-1.98, 0.95, 1.72] : [-1.84, 0.96, 1.36]}
        rotation={[0.16, -0.18, -0.42]}
        scale={[0.88, 0.64, 0.68]}
        color="#6f925c"
        roughness={0.4}
        clearcoat={0.45}
        irregularity={0.18}
        seed={12}
      />
      <TissueTube
        points={elevated
          ? [[-1.83, 0.98, 2.3], [-2.48, 2.05, 2.86], [-3.12, 3.42, 3.25], [-3.65, 4.85, 3.42]]
          : [[-1.72, 1.0, 1.92], [-2.08, 2.15, 2.24], [-2.4, 3.5, 2.35], [-2.68, 4.7, 2.26]]}
        radius={0.035}
        color="#bf574d"
        opacity={0.72}
        radialSegments={8}
        tubularSegments={42}
        roughness={0.5}
        endCaps
      />
    </group>
  );
}

function Grasper({ points, color }: { points: readonly AtlasPoint[]; color: string }) {
  const tip = points[points.length - 1]!;
  return (
    <group>
      <TissueTube
        points={points}
        radius={0.12}
        color="#8e979c"
        opacity={1}
        radialSegments={14}
        tubularSegments={28}
        clearcoat={0.7}
        roughness={0.2}
        endCaps
      />
      <group position={tip} rotation={[0.15, 0, -0.45]}>
        <mesh position={[-0.18, 0.16, 0]} rotation={[0, 0, -0.32]} castShadow>
          <capsuleGeometry args={[0.055, 0.48, 8, 12]} />
          <meshStandardMaterial color={color} metalness={0.72} roughness={0.22} />
        </mesh>
        <mesh position={[0.18, 0.16, 0]} rotation={[0, 0, 0.32]} castShadow>
          <capsuleGeometry args={[0.055, 0.48, 8, 12]} />
          <meshStandardMaterial color={color} metalness={0.72} roughness={0.22} />
        </mesh>
      </group>
    </group>
  );
}

function FatPacket({ position, scale, opacity }: { position: AtlasPoint; scale: AtlasPoint; opacity: number }) {
  return (
    <OrganicOrgan
      position={position}
      scale={scale}
      color="#d6aa5e"
      opacity={opacity}
      roughness={0.9}
      clearcoat={0.02}
      irregularity={0.55}
      seed={position[0] * 3 + position[1] * 5}
    />
  );
}

/**
 * Calibrated normal right-hepatic-hilum construction for teaching laparoscopic
 * cholecystectomy. Coordinates are centimetres and must be rendered inside
 * RightUpperQuadrantFrame. Generated modules choose phase/variation and add
 * prompt-specific findings; they do not need to reinvent the base anatomy.
 */
export function HepatobiliaryAtlas({
  phase,
  showLabels = false,
  showInstruments = true,
  cysticArteryVariant = "standard",
  cysticDuctVariant = "angular",
}: HepatobiliaryAtlasProps) {
  const exposed = phase !== "orientation";
  const dissected = phase === "dissection" || phase === "critical-view" || phase === "danger";
  const criticalView = phase === "critical-view";
  const danger = phase === "danger";
  const gallbladderElevated = phase !== "orientation";
  const superficialOpacity = danger ? 0.34 : 1;
  const deepOpacity = danger ? 1 : dissected ? 0.76 : 0.38;
  const fatOpacity = phase === "orientation" || phase === "exposure" ? 0.82 : phase === "dissection" ? 0.28 : 0.04;

  const cysticDuct: AtlasPoint[] = cysticDuctVariant === "parallel"
    ? [[-1.52, 0.42, 1.2], [-1.0, -0.25, 1.02], [-0.42, -1.05, 0.72], [-0.08, -1.62, 0.46]]
    : cysticDuctVariant === "short"
      ? [[-1.52, 0.42, 1.2], [-0.95, 0.05, 0.94], [-0.48, -0.22, 0.72]]
      : [[-1.52, 0.42, 1.2], [-1.05, 0.08, 1.02], [-0.55, -0.22, 0.82], [-0.08, -0.38, 0.62]];
  const cysticJunction = cysticDuct[cysticDuct.length - 1]!;
  const commonHepaticDuct: AtlasPoint[] = [cysticJunction, [-0.02, 1.15, 0.58], [0.12, 2.8, 0.42], [0.2, 4.25, 0.15]];
  const commonBileDuct: AtlasPoint[] = [cysticJunction, [0.12, -1.65, 0.38], [0.35, -3.35, 0.02], [0.75, -5.0, -0.55]];
  const cysticArtery: AtlasPoint[] = cysticArteryVariant === "moynihan-hump"
    ? [[0.55, 1.72, -0.55], [-0.25, 1.4, -0.18], [-1.05, 1.65, 0.35], [-1.65, 1.16, 1.22]]
    : [[0.45, 1.72, -0.62], [-0.38, 1.45, -0.18], [-1.05, 1.15, 0.48], [-1.65, 1.0, 1.25]];

  return (
    <group name="calibrated-hepatobiliary-atlas">
      <Liver opacity={superficialOpacity} />

      <group position={[0, 0, 0.55]} name="cystic-plate-and-gallbladder-fossa">
        <MembraneSheet
          points={[[-3.8, 0.45, 1.44], [-3.2, 4.85, 1.66], [-1.2, 4.7, 1.25], [-0.72, 0.5, 0.82]]}
          color={criticalView ? "#f2e4b4" : FASCIA}
          opacity={criticalView ? 0.92 : dissected ? 0.64 : 0.28}
        />
      </group>

      <group position={[0, 0, 0.95]}>
        <Gallbladder elevated={gallbladderElevated} />
      </group>

      <group name="extrahepatic-biliary-tree" position={[0, 0, 0.95]}>
        <TaperedTube points={cysticDuct} radii={cysticDuct.map((_, index) => 0.24 - index * 0.018)} color={BILE_DUCT} opacity={superficialOpacity} radialSegments={22} segmentsPerSpan={22} roughness={0.45} clearcoat={0.32} />
        <TaperedTube points={commonHepaticDuct} radii={[0.32, 0.32, 0.3, 0.25]} color={BILE_DUCT} opacity={danger ? 0.66 : 1} radialSegments={24} segmentsPerSpan={20} roughness={0.46} clearcoat={0.28} />
        <TaperedTube points={commonBileDuct} radii={[0.34, 0.35, 0.36, 0.34]} color={BILE_DUCT} opacity={danger ? 0.72 : 1} radialSegments={24} segmentsPerSpan={20} roughness={0.46} clearcoat={0.28} />
        <TaperedTube points={[[0.2, 4.25, 0.15], [-1.35, 5.05, -0.12], [-2.75, 5.45, -0.35]]} radii={[0.25, 0.2, 0.14]} color={BILE_DUCT} opacity={deepOpacity} radialSegments={18} segmentsPerSpan={18} roughness={0.48} clearcoat={0.22} />
        <TaperedTube points={[[0.2, 4.25, 0.15], [1.65, 4.95, -0.08], [3.0, 5.2, -0.4]]} radii={[0.25, 0.2, 0.14]} color={BILE_DUCT} opacity={deepOpacity} radialSegments={18} segmentsPerSpan={18} roughness={0.48} clearcoat={0.22} />
      </group>

      <group name="hilar-arteries" position={[0, 0, 0.75]}>
        <TaperedTube points={[[0.85, -3.8, -0.95], [0.7, -1.2, -0.78], [0.45, 1.72, -0.62], [-0.7, 2.75, -0.78], [-2.7, 3.75, -1.08]]} radii={[0.31, 0.29, 0.27, 0.23, 0.18]} color={ARTERY} opacity={deepOpacity} radialSegments={20} segmentsPerSpan={18} roughness={0.42} clearcoat={0.38} />
        <TaperedTube points={cysticArtery} radii={[0.13, 0.12, 0.105, 0.085]} color={ARTERY} opacity={superficialOpacity} radialSegments={18} segmentsPerSpan={22} roughness={0.4} clearcoat={0.42} />
        <TaperedTube points={[cysticArtery[cysticArtery.length - 1]!, [-2.45, 2.18, 1.78], [-3.3, 3.65, 2.13]]} radii={[0.085, 0.06, 0.035]} color={ARTERY} opacity={superficialOpacity} radialSegments={14} segmentsPerSpan={18} roughness={0.42} clearcoat={0.36} />
        <TaperedTube points={[cysticArtery[cysticArtery.length - 1]!, [-2.25, 1.72, 0.82], [-3.0, 3.0, 1.08]]} radii={[0.08, 0.055, 0.032]} color={ARTERY} opacity={superficialOpacity} radialSegments={14} segmentsPerSpan={18} roughness={0.42} clearcoat={0.36} />
      </group>

      <group name="deep-portal-vein">
        <TaperedTube points={[[0.85, -4.7, -1.72], [0.72, -1.5, -1.58], [0.45, 1.7, -1.62], [0.15, 3.7, -1.78]]} radii={[0.58, 0.6, 0.56, 0.48]} color={VEIN} opacity={deepOpacity} radialSegments={26} segmentsPerSpan={20} roughness={0.5} clearcoat={0.25} />
        <TaperedTube points={[[0.15, 3.7, -1.78], [-1.6, 4.55, -2.05], [-3.3, 5.1, -2.32]]} radii={[0.48, 0.36, 0.24]} color={VEIN} opacity={deepOpacity} radialSegments={22} segmentsPerSpan={18} roughness={0.5} clearcoat={0.25} />
        <TaperedTube points={[[0.15, 3.7, -1.78], [1.55, 4.5, -2.0], [2.85, 5.05, -2.24]]} radii={[0.48, 0.34, 0.22]} color={VEIN} opacity={deepOpacity} radialSegments={22} segmentsPerSpan={18} roughness={0.5} clearcoat={0.25} />
      </group>

      {!dissected && (
        <group name="hepatocystic-triangle-fibrofatty-tissue" position={[0, 0, 0.88]}>
          <MembraneSheet points={[cysticJunction, [-1.52, 0.42, 1.2], [-1.65, 1.0, 1.25], [0.45, 1.72, -0.62], [-0.02, 1.15, 0.58]]} color="#d6b675" opacity={fatOpacity * 0.5} />
          <FatPacket position={[-0.82, 0.53, 0.9]} scale={[0.62, 0.4, 0.25]} opacity={fatOpacity} />
          <FatPacket position={[-0.72, 0.98, 0.7]} scale={[0.54, 0.35, 0.23]} opacity={fatOpacity} />
          <FatPacket position={[-0.25, 0.63, 0.5]} scale={[0.5, 0.32, 0.2]} opacity={fatOpacity} />
          <FatPacket position={[-1.18, 0.86, 1.02]} scale={[0.48, 0.3, 0.22]} opacity={fatOpacity} />
        </group>
      )}

      {(criticalView || danger) && (
        <group name="critical-view-window" position={[0, 0, 0.82]}>
          <MembraneSheet points={[[-1.7, 0.35, 0.76], [-2.1, 1.7, 0.92], [-0.72, 2.35, 0.35], [-0.1, 0.25, 0.45]]} color="#c9e5d2" opacity={0.18} />
          <TissueTube points={[[-1.72, 0.4, 0.78], [-1.95, 1.2, 0.84], [-2.1, 1.7, 0.92]]} radius={0.045} color="#7fe0b3" opacity={0.9} radialSegments={8} tubularSegments={26} roughness={0.45} endCaps />
        </group>
      )}

      {danger && (
        <group name="rouviere-r4u-safety-plane">
          <MembraneSheet points={[[-6.0, 0.45, 0.82], [-3.3, 1.25, 1.35], [0.4, 2.45, 0.7], [2.8, 3.25, 0.2], [2.8, 2.85, -0.05], [-3.4, 0.8, 0.95]]} color="#df9f30" opacity={0.17} />
          <TissueTube points={[[-5.9, 0.6, 0.88], [-3.35, 1.2, 1.39], [0.35, 2.42, 0.74], [2.75, 3.2, 0.25]]} radius={0.055} color="#f2b84b" opacity={0.96} radialSegments={8} tubularSegments={46} roughness={0.38} endCaps />
        </group>
      )}

      {showInstruments && exposed && (
        <group name="dual-vector-laparoscopic-retraction" position={[0, 0, 0.95]}>
          <Grasper points={[[-9.4, 10.8, 8.2], [-6.5, 8.15, 5.0], [-4.05, 5.7, 2.9]]} color="#82b7b1" />
          <Grasper points={[[-9.0, -3.6, 7.4], [-5.25, -1.3, 4.1], [-2.05, 1.0, 1.72]]} color="#e5b95c" />
        </group>
      )}

      <group position={[0, 0, 0.92]}>
        <AnatomyLabel position={[-3.3, 4.2, 3.45]} visible={showLabels}>Gallbladder body</AnatomyLabel>
        <AnatomyLabel position={[-1.45, 0.05, 1.55]} visible={showLabels}>Cystic duct</AnatomyLabel>
        <AnatomyLabel position={[-0.82, 1.32, 1.25]} accent="#e96b68" visible={showLabels && dissected}>Cystic artery</AnatomyLabel>
        <AnatomyLabel position={[0.35, -1.65, 1.0]} visible={showLabels && danger}>Common bile duct</AnatomyLabel>
      </group>
    </group>
  );
}
