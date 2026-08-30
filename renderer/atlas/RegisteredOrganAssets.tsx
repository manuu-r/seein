import { useLoader } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

/**
 * Licensed HuBMAP liver capsule registered to the Surgical Atlas centimetre
 * frame. This is a single reusable anatomical surface—not a procedure scene.
 * Generated modules remain responsible for all hilar structures, variants,
 * pathology, exposure, tissue planes, instruments, states, and cameras.
 */
export function CalibratedLiverSurface({
  opacity = 1,
  color = "#6e2c24",
  portaColor = "#3c1514",
  roughness = 0.5,
  clearcoat = 0.24,
}: {
  opacity?: number;
  color?: string;
  portaColor?: string;
  roughness?: number;
  clearcoat?: number;
}) {
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
        color: portaHepatis ? portaColor : color,
        roughness: THREE.MathUtils.clamp(portaHepatis ? roughness + 0.14 : roughness, 0.44, 0.88),
        clearcoat: THREE.MathUtils.clamp(portaHepatis ? clearcoat * 0.35 : clearcoat, 0, 0.38),
        clearcoatRoughness: 0.62,
        sheen: portaHepatis ? 0.04 : 0.14,
        sheenColor: new THREE.Color("#b96a58"),
        transparent: opacity < 1,
        opacity,
        depthWrite: opacity > 0.7,
      });
      materials.push(material);
      object.material = material;
      object.castShadow = opacity > 0.72;
      object.receiveShadow = true;
    });
    return { materials, scene };
  }, [clearcoat, color, gltf.scene, opacity, portaColor, roughness]);
  useEffect(() => () => prepared.materials.forEach((material) => material.dispose()), [prepared]);
  return (
    <group name="calibrated-hubmap-liver-surface">
      <primitive object={prepared.scene} position={[2.7, -32.3, -8.2]} scale={100} />
    </group>
  );
}
