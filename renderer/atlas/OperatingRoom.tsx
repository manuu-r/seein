// @ts-nocheck -- Imported from the working surgical-atlas reference. It is
// compiled by esbuild; the source project intentionally uses looser indexed
// access checks than SeeIn's server packages.
import { useFrame } from "@react-three/fiber";
import { Environment, RoundedBox, useCursor } from "@react-three/drei";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { ThreeEvent } from "@react-three/fiber";
import type { OperatingRoomState, OperatingRoomUpdate } from "./OperatingRoomState";

type Point = readonly [number, number, number];

type Props = {
  state: OperatingRoomState;
  onChange?: (update: OperatingRoomUpdate) => void;
  offsetY?: number;
};

const METAL = "#aab5b4";
const DARK_METAL = "#4d5d5e";
const PLASTIC = "#e3e7e2";
const SCREEN = "#06191c";
const RIGHT_EQUIPMENT_INWARD_ANGLE = THREE.MathUtils.degToRad(40);
export const OPERATING_ROOM_BOUNDS = {
  halfWidth: 22,
  halfLength: 22,
  floorZ: -4.45,
  ceilingZ: 30.5,
} as const;

function TubeBetween({ start, end, radius = 0.06, color = METAL }: { start: Point; end: Point; radius?: number; color?: string }) {
  const transform = useMemo(() => {
    const a = new THREE.Vector3(...start);
    const b = new THREE.Vector3(...end);
    const direction = b.clone().sub(a);
    return {
      position: a.clone().add(b).multiplyScalar(0.5),
      quaternion: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.clone().normalize()),
      length: direction.length(),
    };
  }, [start, end]);
  return (
    <mesh position={transform.position} quaternion={transform.quaternion}>
      <cylinderGeometry args={[radius, radius, transform.length, 10]} />
      <meshStandardMaterial color={color} metalness={0.72} roughness={0.28} />
    </mesh>
  );
}

function Caster({ position }: { position: Point }) {
  return (
    <group position={position} rotation={[Math.PI / 2, 0, 0]}>
      <mesh><torusGeometry args={[0.16, 0.055, 8, 14]} /><meshStandardMaterial color="#1b2526" roughness={0.72} /></mesh>
      <mesh><cylinderGeometry args={[0.035, 0.035, 0.18, 8]} /><meshStandardMaterial color={METAL} metalness={0.78} roughness={0.3} /></mesh>
    </group>
  );
}

function InteractiveGroup({
  label,
  onActivate,
  children,
}: {
  label: string;
  onActivate: () => void;
  children: React.ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  useCursor(hovered, "pointer", "auto");
  const handle = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    onActivate();
  };
  return (
    <group
      name={label}
      userData={{ interactive: true, label }}
      onClick={handle}
      onPointerEnter={(event) => { event.stopPropagation(); setHovered(true); }}
      onPointerLeave={() => setHovered(false)}
      scale={hovered ? 1.025 : 1}
    >
      {children}
    </group>
  );
}

function useMonitorTexture(active: boolean, ventilator = false) {
  const canvas = useMemo(() => {
    const element = document.createElement("canvas");
    element.width = 512;
    element.height = 288;
    return element;
  }, []);
  const texture = useMemo(() => {
    const next = new THREE.CanvasTexture(canvas);
    next.colorSpace = THREE.SRGBColorSpace;
    next.minFilter = THREE.LinearFilter;
    next.magFilter = THREE.LinearFilter;
    return next;
  }, [canvas]);
  const elapsed = useRef(0);
  const draw = (time: number) => {
    const context = canvas.getContext("2d");
    if (!context) return;
    context.fillStyle = SCREEN;
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (!active) {
      context.fillStyle = "#335054";
      context.font = "600 20px system-ui";
      context.fillText("STANDBY", 205, 150);
      texture.needsUpdate = true;
      return;
    }
    context.strokeStyle = "rgba(150,190,186,.14)";
    context.lineWidth = 1;
    for (let y = 48; y < 270; y += 48) {
      context.beginPath(); context.moveTo(16, y); context.lineTo(496, y); context.stroke();
    }
    const traces = ventilator
      ? [{ color: "#e6c25e", y: 88, phase: 0.8 }, { color: "#60b8d1", y: 176, phase: 1.7 }]
      : [{ color: "#75d49b", y: 76, phase: 0 }, { color: "#6bc5df", y: 158, phase: 1.2 }, { color: "#e3c566", y: 232, phase: 2.1 }];
    traces.forEach(({ color, y, phase }, index) => {
      context.strokeStyle = color;
      context.lineWidth = 3;
      context.beginPath();
      for (let x = 18; x < 390; x += 3) {
        const cursor = (x / 44 + time * (ventilator ? 0.85 : 1.45) + phase) % 8;
        const pulse = !ventilator && index === 0 && cursor < 0.75
          ? (cursor < 0.18 ? -18 * cursor / 0.18 : cursor < 0.33 ? 55 * (cursor - 0.18) / 0.15 - 18 : cursor < 0.55 ? 37 - 50 * (cursor - 0.33) / 0.22 : -13 + 13 * (cursor - 0.55) / 0.2)
          : Math.sin(cursor * Math.PI * (ventilator ? 0.5 : 1.1)) * (ventilator ? 20 : 3 + index * 2);
        const py = y - pulse;
        if (x === 18) context.moveTo(x, py); else context.lineTo(x, py);
      }
      context.stroke();
    });
    context.fillStyle = "#eaf1eb";
    context.font = "600 18px system-ui";
    context.fillText(ventilator ? "VENTILATION" : "ECG", 18, 25);
    context.fillStyle = ventilator ? "#e6c25e" : "#75d49b";
    context.font = "700 46px system-ui";
    context.fillText(ventilator ? "12" : "72", 410, 76);
    context.fillStyle = "#6bc5df";
    context.font = "700 34px system-ui";
    context.fillText(ventilator ? "500" : "98", 410, 160);
    context.fillStyle = "#91a6a5";
    context.font = "500 13px system-ui";
    context.fillText(ventilator ? "RR   mL" : "bpm   SpO₂", 409, 190);
    texture.needsUpdate = true;
  };
  useEffect(() => () => texture.dispose(), [texture]);
  useFrame((_, delta) => {
    elapsed.current += delta;
    if (elapsed.current >= 1 / 12) {
      draw(performance.now() / 1000);
      elapsed.current = 0;
    }
  });
  useEffect(() => draw(0), [active]);
  return texture;
}

function SurgicalLight({
  side,
  boomPosition,
  active,
  intensity,
  onToggle,
}: {
  side: -1 | 1;
  boomPosition: number;
  active: boolean;
  intensity: number;
  onToggle: () => void;
}) {
  const s = side;
  // The complete articulated assembly lives above the overview camera. It can
  // be seen from an oblique room view, but never masks the patient in the
  // clinically useful overhead view.
  const anchor: Point = [s * 1.65, 7.6, 30.0];
  const elbow: Point = [s * THREE.MathUtils.lerp(5.6, 4.1, boomPosition), THREE.MathUtils.lerp(8.8, 7.4, boomPosition), 29.2];
  const head: Point = [s * THREE.MathUtils.lerp(6.8, 4.15, boomPosition), THREE.MathUtils.lerp(8.15, 6.8, boomPosition), 28.1];
  return (
    <group>
      <TubeBetween start={anchor} end={elbow} radius={0.09} color="#d5dad6" />
      <TubeBetween start={elbow} end={head} radius={0.085} color="#c8cfcc" />
      <mesh position={anchor}><cylinderGeometry args={[0.28, 0.28, 0.18, 20]} /><meshStandardMaterial color={DARK_METAL} metalness={0.72} roughness={0.28} /></mesh>
      <mesh position={elbow}><sphereGeometry args={[0.16, 14, 10]} /><meshStandardMaterial color={DARK_METAL} metalness={0.74} roughness={0.25} /></mesh>
      <InteractiveGroup label={`${side < 0 ? "Left" : "Right"} surgical light`} onActivate={onToggle}>
        <group position={head} rotation={[0.1, side * 0.08, 0]}>
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.82, 0.72, 0.2, 32]} />
            <meshStandardMaterial color="#d8ded9" roughness={0.34} metalness={0.24} emissive={active ? "#fff0cf" : "#000000"} emissiveIntensity={active ? 0.22 : 0} />
          </mesh>
          <mesh position={[0, 0, -0.14]}>
            <torusGeometry args={[0.54, 0.1, 10, 32]} />
            <meshStandardMaterial color={active ? "#fff3c9" : "#768080"} emissive={active ? "#ffe9ad" : "#000"} emissiveIntensity={active ? 1.4 : 0} roughness={0.38} />
          </mesh>
          {Array.from({ length: 8 }, (_, index) => {
            const angle = index / 8 * Math.PI * 2;
            return <mesh key={index} position={[Math.cos(angle) * 0.37, Math.sin(angle) * 0.37, -0.18]}><sphereGeometry args={[0.058, 8, 6]} /><meshStandardMaterial color={active ? "#fff9dc" : "#687373"} emissive={active ? "#fff1b7" : "#000"} emissiveIntensity={active ? 2 : 0} /></mesh>;
          })}
          <mesh position={[0, 0, -0.19]}><cylinderGeometry args={[0.12, 0.12, 0.3, 12]} /><meshStandardMaterial color={DARK_METAL} metalness={0.48} roughness={0.42} /></mesh>
        </group>
      </InteractiveGroup>
      {active && <spotLight position={head} intensity={5.4 * intensity} angle={0.43} penumbra={0.84} distance={30} decay={1.7} color="#fff0d4" />}
    </group>
  );
}

function AnesthesiaWorkstation({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  const texture = useMonitorTexture(active, true);
  const bag = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (!bag.current) return;
    const breath = active ? 0.84 + (Math.sin(clock.elapsedTime * 1.55) + 1) * 0.1 : 0.82;
    bag.current.scale.set(0.78 + breath * 0.12, 0.75 + breath * 0.25, 0.78 + breath * 0.12);
  });
  return (
    <group position={[5.65, 7.2, -3.75]} rotation={[0, 0, -RIGHT_EQUIPMENT_INWARD_ANGLE]}>
      <RoundedBox args={[2.35, 1.55, 2.35]} radius={0.13} smoothness={3} position={[0, 0, 1.15]}><meshStandardMaterial color={PLASTIC} roughness={0.42} metalness={0.08} /></RoundedBox>
      {[0.45, 0.86, 1.27].map((z) => <mesh key={z} position={[0, -0.74, z]}><boxGeometry args={[1.84, 0.07, 0.3]} /><meshStandardMaterial color="#aeb9b6" metalness={0.18} roughness={0.52} /></mesh>)}
      <RoundedBox args={[2.02, 1.24, 0.38]} radius={0.08} smoothness={3} position={[0, 0.02, 2.42]}><meshStandardMaterial color="#ccd4d0" roughness={0.44} /></RoundedBox>
      <InteractiveGroup label="Anesthesia ventilator" onActivate={onToggle}>
        <group position={[0, -0.62, 3.45]} rotation={[Math.PI / 2, 0, 0]}>
          <RoundedBox args={[2.2, 1.45, 0.25]} radius={0.08} smoothness={3}><meshStandardMaterial color="#d6dcd8" roughness={0.42} /></RoundedBox>
          <mesh position={[0, 0, 0.14]}><planeGeometry args={[1.9, 1.17]} /><meshBasicMaterial map={texture} toneMapped={false} side={THREE.DoubleSide} /></mesh>
        </group>
      </InteractiveGroup>
      {([[-0.58, "#d0b248"], [0, "#8e65a5"], [0.58, "#5b9aa4"]] as const).map(([x, color]) => (
        <group key={x} position={[x, -0.66, 2.42]}>
          <mesh><cylinderGeometry args={[0.16, 0.16, 0.28, 12]} /><meshPhysicalMaterial color={color} transmission={0.3} transparent opacity={0.86} roughness={0.28} /></mesh>
        </group>
      ))}
      <mesh ref={bag} position={[-1.22, -0.45, 2.0]} rotation={[0.15, 0, -0.28]}>
        <capsuleGeometry args={[0.22, 0.55, 10, 16]} />
        <meshPhysicalMaterial color="#739f8d" transparent opacity={0.68} roughness={0.52} />
      </mesh>
      <TubeBetween start={[-1.02, -0.4, 2.28]} end={[-1.2, -0.44, 2.2]} radius={0.06} color="#71807f" />
      {/* Patient-facing 22 mm breathing-circuit socket. The hose rendered by
          OxygenMask terminates at this exact world-space point. */}
      <group position={[-1.12, -0.82, 1.95]} rotation={[Math.PI / 2, 0, 0]}>
        <mesh><cylinderGeometry args={[0.105, 0.105, 0.18, 24]} /><meshStandardMaterial color="#c4d2cf" metalness={0.18} roughness={0.4} /></mesh>
        <mesh position={[0, 0.1, 0]}><torusGeometry args={[0.105, 0.018, 9, 24]} /><meshStandardMaterial color="#879997" metalness={0.35} roughness={0.34} /></mesh>
      </group>
      <group position={[0.86, 0.72, 1.35]}>
        <mesh><cylinderGeometry args={[0.2, 0.2, 1.42, 18]} /><meshStandardMaterial color="#9ab8ad" metalness={0.62} roughness={0.3} /></mesh>
        {[0.82, 1.24, 1.66].map((z) => <mesh key={z} position={[0, -0.22, z - 1.35]} rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[0.15, 0.025, 8, 18]} /><meshStandardMaterial color="#d7e0dc" metalness={0.78} roughness={0.22} /></mesh>)}
      </group>
      <mesh position={[0, 0, 0.08]}><boxGeometry args={[2.55, 1.78, 0.14]} /><meshStandardMaterial color={DARK_METAL} metalness={0.35} roughness={0.46} /></mesh>
      {([[-0.86, -0.55, 0], [0.86, -0.55, 0], [-0.86, 0.55, 0], [0.86, 0.55, 0]] as Point[]).map((point, index) => <Caster key={index} position={point} />)}
    </group>
  );
}

function MayoStand({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <group position={[-4.75, -0.15, -3.6]} rotation={[0, 0, 0.12]}>
      <TubeBetween start={[0, 0, 0]} end={[0, 0, 2.65]} radius={0.055} />
      {/* A triangular three-caster base is stable without reading as the old
          two-legged board-on-a-stick silhouette in the overhead view. */}
      <TubeBetween start={[0, 0, 0.08]} end={[-1.18, -0.72, 0.08]} radius={0.055} />
      <TubeBetween start={[0, 0, 0.08]} end={[1.18, -0.72, 0.08]} radius={0.055} />
      <TubeBetween start={[0, 0, 0.08]} end={[0, 1.28, 0.08]} radius={0.055} />
      <Caster position={[-1.18, -0.72, 0]} />
      <Caster position={[1.18, -0.72, 0]} />
      <Caster position={[0, 1.28, 0]} />
      <InteractiveGroup label="Mayo instrument stand" onActivate={onToggle}>
        <group position={[0, 0, 2.72]}>
          <mesh><boxGeometry args={[2.7, 1.55, 0.12]} /><meshStandardMaterial color="#c1cdcb" metalness={0.75} roughness={0.2} /></mesh>
          {open ? (
            <group position={[0, 0, 0.11]}>
              {[-0.72, -0.24, 0.24, 0.72].map((x, index) => (
                <group key={x} position={[x, index % 2 ? 0.1 : -0.18, 0]} rotation={[0, 0, index % 2 ? 0.08 : -0.06]}>
                  <mesh><boxGeometry args={[0.08, 0.96, 0.035]} /><meshStandardMaterial color="#dce5e2" metalness={0.9} roughness={0.13} /></mesh>
                  <mesh position={[0, -0.55, 0]}><torusGeometry args={[0.12, 0.025, 7, 14]} /><meshStandardMaterial color="#dce5e2" metalness={0.9} roughness={0.13} /></mesh>
                </group>
              ))}
              <mesh position={[1.02, 0.08, 0]} rotation={[0, 0, -0.12]}><boxGeometry args={[0.12, 0.92, 0.04]} /><meshStandardMaterial color="#dce5e2" metalness={0.9} roughness={0.13} /></mesh>
            </group>
          ) : (
            <mesh position={[0, 0, 0.12]}><boxGeometry args={[2.58, 1.42, 0.08]} /><meshStandardMaterial color="#2b8a88" roughness={0.92} /></mesh>
          )}
        </group>
      </InteractiveGroup>
    </group>
  );
}

function VitalMonitorTower({ active, alarmMuted, onToggle }: { active: boolean; alarmMuted: boolean; onToggle: () => void }) {
  const texture = useMonitorTexture(active);
  return (
    <group position={[7.987, 5.239, -3.7]} rotation={[0, 0, -RIGHT_EQUIPMENT_INWARD_ANGLE]}>
      <RoundedBox args={[2.15, 1.4, 3.35]} radius={0.1} smoothness={3} position={[0, 0, 1.72]}>
        <meshStandardMaterial color="#d9dfdc" roughness={0.43} metalness={0.08} />
      </RoundedBox>
      {[0.68, 1.18, 1.68, 2.18].map((z, index) => (
        <group key={z} position={[0, -0.73, z]}>
          <mesh><boxGeometry args={[1.78, 0.08, 0.36]} /><meshStandardMaterial color={index === 3 ? "#445052" : "#aeb8b5"} metalness={0.22} roughness={0.45} /></mesh>
          {[-0.58, -0.36, 0.36, 0.58].map((x) => <mesh key={x} position={[x, -0.055, 0]}><cylinderGeometry args={[0.035, 0.035, 0.025, 8]} /><meshStandardMaterial color={index === 3 ? "#79b9ac" : "#677271"} emissive={index === 3 && active ? "#4ba896" : "#000"} emissiveIntensity={0.8} /></mesh>)}
        </group>
      ))}
      <InteractiveGroup label="Patient monitor tower" onActivate={onToggle}>
        <group position={[0, -0.64, 4.35]} rotation={[Math.PI / 2 - 0.42, 0, 0]}>
          <RoundedBox args={[2.5, 1.55, 0.24]} radius={0.08} smoothness={3}><meshStandardMaterial color="#d8dfdc" roughness={0.42} /></RoundedBox>
          <mesh position={[0, 0, 0.13]}><planeGeometry args={[2.18, 1.24]} /><meshBasicMaterial map={texture} toneMapped={false} side={THREE.DoubleSide} /></mesh>
          <mesh position={[1.03, 0.63, 0.16]}><sphereGeometry args={[0.055, 10, 8]} /><meshStandardMaterial color={alarmMuted ? "#6d7b79" : "#e8b34f"} emissive={alarmMuted ? "#000" : "#e8b34f"} emissiveIntensity={active && !alarmMuted ? 1.5 : 0} /></mesh>
        </group>
      </InteractiveGroup>
      <TubeBetween start={[0.92, 0.4, 2.55]} end={[1.42, 0.72, 3.15]} radius={0.035} color="#72817f" />
      <mesh position={[0, 0, 0.08]}><boxGeometry args={[2.5, 1.75, 0.14]} /><meshStandardMaterial color={DARK_METAL} metalness={0.42} roughness={0.4} /></mesh>
      {([[-0.88, -0.58, 0], [0.88, -0.58, 0], [-0.88, 0.58, 0], [0.88, 0.58, 0]] as Point[]).map((point, index) => <Caster key={index} position={point} />)}
    </group>
  );
}

/**
 * Inactive endoscopic/video display on the room-left side of the default
 * overhead view. The dark display
 * is carried on a short articulated arm over a compact equipment cart rather
 * than floating above a single pole.
 */
function VideoDisplayCart() {
  const armBase: Point = [-0.54, 0.32, 2.42];
  const armElbow: Point = [-0.54, 0.3, 3.62];
  const armKnuckle: Point = [0.25, 0.1, 4.25];
  const screenMount: Point = [1.25, -0.02, 4.25];
  return (
    <group position={[-5.85, 6.05, -3.7]} rotation={[0, 0, 0.17]} name="Left video display cart">
      <RoundedBox args={[1.82, 1.28, 2.42]} radius={0.1} smoothness={3} position={[0, 0, 1.24]}>
        <meshStandardMaterial color="#d9dfdc" roughness={0.44} metalness={0.08} />
      </RoundedBox>
      {[0.62, 1.1, 1.58].map((z, index) => (
        <group key={z} position={[0, -0.67, z]}>
          <mesh><boxGeometry args={[1.5, 0.08, 0.3]} /><meshStandardMaterial color={index === 2 ? "#3e494b" : "#aeb8b5"} metalness={0.22} roughness={0.46} /></mesh>
          {index === 2 && [-0.45, -0.22, 0.22, 0.45].map((x) => <mesh key={x} position={[x, -0.055, 0]}><cylinderGeometry args={[0.032, 0.032, 0.025, 8]} /><meshStandardMaterial color="#667372" /></mesh>)}
        </group>
      ))}

      <TubeBetween start={armBase} end={armElbow} radius={0.075} color="#aeb9b8" />
      {/* Paired links and broad pivot barrels make the support read as a
          counterbalanced medical monitor arm, not a thin bent stick. */}
      <TubeBetween start={[-0.54, 0.38, 3.62]} end={[0.25, 0.18, 4.25]} radius={0.052} color="#bec8c6" />
      <TubeBetween start={[-0.54, 0.22, 3.62]} end={[0.25, 0.02, 4.25]} radius={0.052} color="#bec8c6" />
      <TubeBetween start={[0.25, 0.18, 4.25]} end={[1.25, 0.06, 4.25]} radius={0.052} color="#bec8c6" />
      <TubeBetween start={[0.25, 0.02, 4.25]} end={[1.25, -0.1, 4.25]} radius={0.052} color="#bec8c6" />
      {[armElbow, armKnuckle, screenMount].map((position, index) => (
        <group key={index} position={position}>
          <mesh><cylinderGeometry args={[0.16, 0.16, 0.22, 18]} /><meshStandardMaterial color={DARK_METAL} metalness={0.55} roughness={0.34} /></mesh>
          <mesh position={[0, 0.12, 0]}><cylinderGeometry args={[0.075, 0.075, 0.04, 16]} /><meshStandardMaterial color="#d5dcda" metalness={0.7} roughness={0.26} /></mesh>
        </group>
      ))}
      <TubeBetween start={screenMount} end={[1.48, -0.02, 4.25]} radius={0.085} color="#657574" />

      <group position={[1.55, -0.4, 4.25]} rotation={[Math.PI / 2 - 0.52, 0, 0.02]}>
        <RoundedBox args={[3.25, 1.92, 0.27]} radius={0.11} smoothness={3}>
          <meshStandardMaterial color="#cfd7d5" roughness={0.4} metalness={0.08} />
        </RoundedBox>
        <mesh position={[0, 0, 0.145]}>
          <planeGeometry args={[2.88, 1.56]} />
          <meshBasicMaterial color="#010506" toneMapped={false} side={THREE.DoubleSide} />
        </mesh>
        <mesh position={[1.36, -0.78, 0.17]}><sphereGeometry args={[0.04, 8, 6]} /><meshBasicMaterial color="#36524d" /></mesh>
      </group>

      <mesh position={[0, 0, 0.08]}><boxGeometry args={[2.16, 1.58, 0.14]} /><meshStandardMaterial color={DARK_METAL} metalness={0.42} roughness={0.4} /></mesh>
      {([[-0.74, -0.52, 0], [0.74, -0.52, 0], [-0.74, 0.52, 0], [0.74, 0.52, 0]] as Point[]).map((point, index) => <Caster key={index} position={point} />)}
    </group>
  );
}

function CeilingPanel({ position, size = [3.2, 3.7] }: { position: Point; size?: readonly [number, number] }) {
  return (
    <group position={position}>
      <mesh><boxGeometry args={[size[0] + 0.18, size[1] + 0.18, 0.12]} /><meshStandardMaterial color="#7f969a" metalness={0.32} roughness={0.42} /></mesh>
      <mesh position={[0, 0, -0.07]}><boxGeometry args={[size[0], size[1], 0.055]} /><meshStandardMaterial color="#f2f4e8" emissive="#e8f3ed" emissiveIntensity={1.45} roughness={0.32} /></mesh>
    </group>
  );
}

function VentGrille({ position, rotation = [0, 0, 0] }: { position: Point; rotation?: Point }) {
  return (
    <group position={position} rotation={rotation}>
      <mesh><boxGeometry args={[1.8, 1.05, 0.09]} /><meshStandardMaterial color="#768d92" metalness={0.38} roughness={0.46} /></mesh>
      {[-0.55, -0.28, 0, 0.28, 0.55].map((x) => <mesh key={x} position={[x, 0, -0.055]}><boxGeometry args={[0.07, 0.82, 0.025]} /><meshStandardMaterial color="#304a4e" roughness={0.65} /></mesh>)}
    </group>
  );
}

function RoomShell({ ambientLights }: { ambientLights: boolean }) {
  const wallBlue = "#386773";
  const panelBlue = "#2f5b66";
  const floorBlue = "#759ca7";
  return (
    <group>
      <mesh position={[0, 0, OPERATING_ROOM_BOUNDS.floorZ]} receiveShadow>
        <boxGeometry args={[43.8, 43.8, 0.22]} />
        <meshPhysicalMaterial color={floorBlue} roughness={0.48} metalness={0.05} clearcoat={0.26} clearcoatRoughness={0.58} />
      </mesh>
      {[-20, -16, -12, -8, -4, 0, 4, 8, 12, 16, 20].map((x) => <mesh key={`floor-x-${x}`} position={[x, 0, -4.325]}><boxGeometry args={[0.018, 43.2, 0.008]} /><meshBasicMaterial color="#8bb0b9" transparent opacity={0.25} /></mesh>)}
      {[-20, -16, -12, -8, -4, 0, 4, 8, 12, 16, 20].map((y) => <mesh key={`floor-y-${y}`} position={[0, y, -4.324]}><boxGeometry args={[43.2, 0.018, 0.008]} /><meshBasicMaterial color="#6c909a" transparent opacity={0.2} /></mesh>)}

      <mesh position={[0, 21.9, 13.0]} receiveShadow>
        <boxGeometry args={[44, 0.28, 35]} />
        <meshStandardMaterial color={wallBlue} roughness={0.58} metalness={0.08} />
      </mesh>
      <mesh position={[0, -21.9, 13.0]} receiveShadow>
        <boxGeometry args={[44, 0.28, 35]} />
        <meshStandardMaterial color={wallBlue} roughness={0.58} metalness={0.08} />
      </mesh>
      {[-21.9, 21.9].map((x) => <mesh key={x} position={[x, 0, 13.0]} receiveShadow><boxGeometry args={[0.28, 44, 35]} /><meshStandardMaterial color={wallBlue} roughness={0.58} metalness={0.08} /></mesh>)}
      <mesh position={[0, 0, OPERATING_ROOM_BOUNDS.ceilingZ]}>
        <boxGeometry args={[44, 44, 0.24]} />
        <meshStandardMaterial color="#537885" roughness={0.54} metalness={0.08} side={THREE.DoubleSide} />
      </mesh>

      {[-20, -16, -12, -8, -4, 0, 4, 8, 12, 16, 20].map((x) => <mesh key={`far-seam-${x}`} position={[x, 21.735, 12.85]}><boxGeometry args={[0.035, 0.025, 34.2]} /><meshStandardMaterial color="#73909a" metalness={0.25} roughness={0.45} /></mesh>)}
      {[1.8, 6.8, 11.8, 16.8, 21.8, 26.8].map((z) => <mesh key={`far-horizontal-${z}`} position={[0, 21.73, z]}><boxGeometry args={[43.4, 0.028, 0.035]} /><meshStandardMaterial color="#244d58" roughness={0.55} /></mesh>)}
      {[-20, -16, -12, -8, -4, 0, 4, 8, 12, 16, 20].map((y) => <mesh key={`side-seam-${y}`} position={[-21.73, y, 12.85]}><boxGeometry args={[0.025, 0.035, 34.2]} /><meshStandardMaterial color="#73909a" metalness={0.25} roughness={0.45} /></mesh>)}

      <group position={[-6.4, 21.68, 3.2]}>
        <mesh><boxGeometry args={[6.25, 0.16, 4.2]} /><meshStandardMaterial color="#a3b2b5" metalness={0.34} roughness={0.36} /></mesh>
        <mesh position={[0, -0.1, 0]}><boxGeometry args={[5.7, 0.08, 3.68]} /><meshPhysicalMaterial color="#142d35" roughness={0.16} metalness={0.25} clearcoat={0.72} transparent opacity={0.88} /></mesh>
      </group>
      <group position={[7.2, 21.65, 2.75]}>
        <mesh><boxGeometry args={[5.4, 0.22, 6.45]} /><meshStandardMaterial color="#9eafb3" metalness={0.4} roughness={0.34} /></mesh>
        {[-1.28, 1.28].map((x) => <mesh key={x} position={[x, -0.15, 0]}><boxGeometry args={[2.38, 0.1, 5.8]} /><meshStandardMaterial color={panelBlue} roughness={0.45} metalness={0.1} /></mesh>)}
        <mesh position={[0, -0.23, 0]}><boxGeometry args={[0.09, 0.06, 5.8]} /><meshStandardMaterial color="#c4cece" metalness={0.68} roughness={0.28} /></mesh>
        {[-1.28, 1.28].map((x) => <mesh key={`door-window-${x}`} position={[x, -0.23, 1.05]}><boxGeometry args={[1.15, 0.055, 1.62]} /><meshPhysicalMaterial color="#142e37" roughness={0.14} metalness={0.24} clearcoat={0.74} /></mesh>)}
      </group>

      {[-19.2, -16.1, -13].map((x) => (
        <group key={x} position={[x, 21.52, 8.7]}>
          <RoundedBox args={[2.75, 0.56, 2.55]} radius={0.08} smoothness={2}><meshStandardMaterial color="#b9c7c7" roughness={0.48} metalness={0.12} /></RoundedBox>
          <mesh position={[0, -0.315, 0]}><boxGeometry args={[2.34, 0.045, 2.12]} /><meshStandardMaterial color="#718b90" metalness={0.25} roughness={0.48} /></mesh>
          <mesh position={[0, -0.35, -0.92]}><boxGeometry args={[0.55, 0.04, 0.045]} /><meshStandardMaterial color="#d5dddd" metalness={0.75} roughness={0.24} /></mesh>
        </group>
      ))}

      <group position={[-17.2, 21.34, -2.6]}>
        <RoundedBox args={[4.25, 1.2, 0.52]} radius={0.08} smoothness={2}><meshStandardMaterial color="#aebfc0" metalness={0.46} roughness={0.34} /></RoundedBox>
        <mesh position={[1.15, -0.62, 0.56]}><torusGeometry args={[0.38, 0.04, 8, 18, Math.PI]} /><meshStandardMaterial color={METAL} metalness={0.74} roughness={0.25} /></mesh>
      </group>

      {[-16, -8, 0, 8, 16].flatMap((x) => [-16, -8, 0, 8, 16].map((y) => <CeilingPanel key={`${x}-${y}`} position={[x, y, 30.32]} size={Math.abs(x) < 1 && Math.abs(y) < 1 ? [4.8, 5.2] : [3.2, 3.7]} />))}
      <VentGrille position={[-18.7, 18.4, 30.31]} />
      <VentGrille position={[18.7, -18.4, 30.31]} />

      {ambientLights && (
        <>
          <pointLight position={[0, 0, 27.2]} intensity={2.35} distance={48} decay={1.4} color="#dff2f0" />
          <pointLight position={[-14, -9, 21]} intensity={1.25} distance={36} decay={1.5} color="#cce8e7" />
          <pointLight position={[14, 10, 21]} intensity={1.25} distance={36} decay={1.5} color="#d9eeee" />
        </>
      )}

      {[-15.8, 0, 15.8].map((x) => <mesh key={`ceiling-rail-${x}`} position={[x, 1.2, 29.94]}><boxGeometry args={[0.13, 32.5, 0.13]} /><meshStandardMaterial color="#cbd4d3" metalness={0.58} roughness={0.3} /></mesh>)}
      {[-15.8, 15.8].map((x) => (
        <group key={`gas-panel-${x}`} position={[x, 21.5, 0.2]}>
          <RoundedBox args={[2.25, 0.46, 1.28]} radius={0.07} smoothness={2}><meshStandardMaterial color="#d1d9d7" roughness={0.48} /></RoundedBox>
          {[-0.65, -0.22, 0.22, 0.65].map((px, index) => <mesh key={px} position={[px, -0.27, 0]} rotation={[Math.PI / 2, 0, 0]}><cylinderGeometry args={[0.1, 0.1, 0.05, 12]} /><meshStandardMaterial color={["#f2f2e5", "#80b7ac", "#e5c967", "#a995c4"][index]} metalness={0.18} roughness={0.42} /></mesh>)}
        </group>
      ))}
      <mesh position={[0, 0, -4.24]}>
        <ringGeometry args={[5.6, 5.66, 4]} />
        <meshBasicMaterial color="#9ab8bb" transparent opacity={0.34} side={THREE.DoubleSide} />
      </mesh>
    </group>
  );
}

/**
 * Shared, procedural operating-room context. It intentionally uses compact
 * reusable primitives rather than another large glTF payload: the anatomy is
 * the teaching asset, while this layer supplies spatial and equipment context.
 */
export function OperatingRoom({ state, onChange, offsetY = 0 }: Props) {
  if (!state.visible) return null;
  const update = (next: OperatingRoomUpdate) => onChange?.(next);
  return (
    <group position={[0, offsetY, 0]} name="Modular operating room">
      <Suspense fallback={null}><Environment files="/viewer/environments/surgery_1k.hdr" background={false} /></Suspense>
      <RoomShell ambientLights={state.ambientLights} />
      <SurgicalLight side={-1} boomPosition={state.boomPosition} active={state.surgicalLights} intensity={state.surgicalLightIntensity} onToggle={() => update({ surgicalLights: !state.surgicalLights })} />
      <SurgicalLight side={1} boomPosition={state.boomPosition} active={state.surgicalLights} intensity={state.surgicalLightIntensity} onToggle={() => update({ surgicalLights: !state.surgicalLights })} />
      <AnesthesiaWorkstation active={state.ventilator} onToggle={() => update({ ventilator: !state.ventilator })} />
      <VitalMonitorTower active={state.monitor} alarmMuted={state.alarmMuted} onToggle={() => update({ monitor: !state.monitor })} />
      <VideoDisplayCart />
      <MayoStand open={state.trayOpen} onToggle={() => update({ trayOpen: !state.trayOpen })} />
    </group>
  );
}
