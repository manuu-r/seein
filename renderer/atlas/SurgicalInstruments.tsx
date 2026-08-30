import { useMemo } from "react";
import * as THREE from "three";
import { TaperedTube } from "./OrganicAnatomy";
import type { AtlasPoint } from "./types";

/** An articulated laparoscopic atraumatic grasper driven by generated trajectory/contact points. */
export function SurgicalGrasper({
  points,
  jawOpening = 0.26,
  jawLength = 0.72,
  shaftRadius = 0.11,
  handleColor = "#384147",
  jawColor = "#c7cecc",
}: {
  points: readonly AtlasPoint[];
  jawOpening?: number;
  jawLength?: number;
  shaftRadius?: number;
  handleColor?: string;
  jawColor?: string;
}) {
  if (points.length < 2) throw new Error("SurgicalGrasper requires at least two trajectory points");
  const tip = points[points.length - 1]!;
  const previous = points[points.length - 2]!;
  const quaternion = useMemo(() => {
    const direction = new THREE.Vector3(
      tip[0] - previous[0],
      tip[1] - previous[1],
      tip[2] - previous[2],
    ).normalize();
    return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  }, [previous, tip]);
  const radii = useMemo(() => points.map(() => shaftRadius), [points, shaftRadius]);
  return (
    <group name="articulated-laparoscopic-grasper">
      <TaperedTube
        points={points}
        radii={radii}
        color={handleColor}
        roughness={0.24}
        clearcoat={0.32}
        radialSegments={18}
        segmentsPerSpan={14}
      />
      <group position={tip} quaternion={quaternion}>
        <mesh castShadow>
          <sphereGeometry args={[shaftRadius * 1.25, 18, 12]} />
          <meshStandardMaterial color="#899391" metalness={0.76} roughness={0.23} />
        </mesh>
        {[-1, 1].map((side) => (
          <group key={side} rotation={[0, 0, side * jawOpening]}>
            <mesh position={[side * shaftRadius * 0.62, jawLength * 0.44, 0]} castShadow>
              <capsuleGeometry args={[shaftRadius * 0.54, jawLength, 10, 16]} />
              <meshStandardMaterial color={jawColor} metalness={0.7} roughness={0.2} />
            </mesh>
            <mesh position={[side * shaftRadius * 0.62, jawLength * 0.82, 0]} scale={[1.25, 1, 0.72]}>
              <boxGeometry args={[shaftRadius * 0.92, jawLength * 0.34, shaftRadius * 0.7]} />
              <meshStandardMaterial color="#aeb7b4" metalness={0.58} roughness={0.32} />
            </mesh>
          </group>
        ))}
      </group>
    </group>
  );
}
