import type { ReactNode } from "react";
import { AnatomicalRegionFrame } from "./AnatomicalRegistry";
import {
  CecumAndAppendix,
  ColonFrame,
  DuodenojejunalContinuity,
  MesentericBed,
  Omentum,
  PelvicContext,
  SkeletalContext,
  SmallBowelBed,
  SurroundingOrgans,
  ThoracicOrgans,
  TissueTube,
} from "./PatientAtlas";

/**
 * Shared registration between the MakeHuman shell and generated internal anatomy.
 * Children use atlas world units inside the posed supine patient.
 */
export function PatientAnatomyFrame({ children }: { children: ReactNode }) {
  return (
    <group rotation={[-0.13, 0.035, 0]}>
      <group position={[0, 0, -0.73]}>{children}</group>
    </group>
  );
}

/**
 * Calibrated abdominal context derived from the surgical-atlas reference scene.
 * It intentionally stays subdued so procedure-specific construction remains legible.
 */
export function CalibratedInternalAnatomy({ faded = true }: { faded?: boolean }) {
  return (
    <PatientAnatomyFrame>
      <group position={[0, 0.32, -0.42]} scale={[0.36, 0.58, 0.5]}>
        <group position={[0, 0.5, 1.5]}>
          <group position={[0, 4.25, -1.75]} scale={[0.72, 0.6, 0.6]}>
            <group position={[0, -4.25, 1.75]}>
              <ThoracicOrgans faded={faded} />
            </group>
          </group>
        </group>
        <group position={[0, 0.82, 1.5]}>
          <group position={[0, 1.25, -1.72]} scale={[0.72, 0.6, 0.6]}>
            <group position={[0, -1.25, 1.72]}>
              <SurroundingOrgans faded={faded} />
              <SkeletalContext faded={faded} />
            </group>
          </group>
        </group>
        <group position={[0, 1.15, 1.5]}>
          <group position={[0, 0.1, -1.15]} scale={[0.72, 0.6, 0.6]}>
            <group position={[0, -0.1, 1.15]}>
              <ColonFrame faded={faded} />
              <CecumAndAppendix faded={faded} />
              <MesentericBed faded={faded} />
              <SmallBowelBed faded={faded} />
              <PelvicContext faded={faded} />
              {!faded && <Omentum />}
            </group>
          </group>
        </group>
        <DuodenojejunalContinuity faded={faded} />
      </group>
    </PatientAnatomyFrame>
  );
}

/**
 * Local centimetre frame for surgeon-authored right subhepatic anatomy.
 *
 * Origin: right hepatic hilum / gallbladder neck.
 * Axes: +X patient-left, +Y cephalad, +Z anterior.
 * One child-space unit is one centimetre; the wrapper registers it to the
 * calibrated atlas patient and slightly enlarges it for teaching visibility.
 */
export function RightUpperQuadrantFrame({ children }: { children: ReactNode }) {
  return <AnatomicalRegionFrame id="right-upper-quadrant">{children}</AnatomicalRegionFrame>;
}

export function CentralAbdominalFrame({ children }: { children: ReactNode }) {
  return <AnatomicalRegionFrame id="central-abdomen">{children}</AnatomicalRegionFrame>;
}

export function LowerGastrointestinalFrame({ children }: { children: ReactNode }) {
  return <AnatomicalRegionFrame id="lower-gastrointestinal">{children}</AnatomicalRegionFrame>;
}

export function PelvicFrame({ children }: { children: ReactNode }) {
  return <AnatomicalRegionFrame id="pelvis">{children}</AnatomicalRegionFrame>;
}

export function RightGroinFrame({ children }: { children: ReactNode }) {
  return <AnatomicalRegionFrame id="right-groin">{children}</AnatomicalRegionFrame>;
}

export function ThoracicFrame({ children }: { children: ReactNode }) {
  return <AnatomicalRegionFrame id="thorax">{children}</AnatomicalRegionFrame>;
}

/** Calibrated four-port layout for laparoscopic cholecystectomy. */
export function LaparoscopicCholecystectomyPorts({
  showTrajectories = false,
  showHardware = true,
}: {
  showTrajectories?: boolean;
  showHardware?: boolean;
}) {
  const ports = [
    { id: "umbilical-optical", position: [0, -0.15, 0.22] as const, radius: 0.046, color: "#4a91b8" },
    { id: "epigastric-working", position: [0.15, 1.35, 0.25] as const, radius: 0.035, color: "#c86659" },
    { id: "right-midclavicular", position: [-1.18, 0.5, 0.24] as const, radius: 0.025, color: "#d4aa55" },
    { id: "right-anterior-axillary", position: [-1.78, 1.0, 0.23] as const, radius: 0.025, color: "#4ca49a" },
  ];
  const target = [-0.35, 1.6, -0.25] as const;
  return (
    <PatientAnatomyFrame>
      <group name="calibrated-laparoscopic-cholecystectomy-ports">
        {ports.map((port) => (
          <group key={port.id}>
            {showHardware && (
              <group>
                <mesh position={[port.position[0], port.position[1], port.position[2] + 0.22]} rotation={[Math.PI / 2, 0, 0]} castShadow>
                  <cylinderGeometry args={[port.radius, port.radius, 0.62, 18]} />
                  <meshPhysicalMaterial color="#7a858d" metalness={0.72} roughness={0.24} />
                </mesh>
                <mesh position={[port.position[0], port.position[1], port.position[2] + 0.5]} rotation={[Math.PI / 2, 0, 0]}>
                  <cylinderGeometry args={[port.radius * 1.9, port.radius * 1.65, 0.15, 18]} />
                  <meshPhysicalMaterial color={port.color} metalness={0.34} roughness={0.3} clearcoat={0.28} />
                </mesh>
                <mesh position={port.position} renderOrder={20}>
                  <torusGeometry args={[port.radius * 1.45, port.radius * 0.24, 10, 32]} />
                  <meshBasicMaterial color={port.color} transparent opacity={0.88} depthTest={false} />
                </mesh>
              </group>
            )}
            {showTrajectories && (
              <TissueTube
                points={[port.position, target]}
                radius={0.008}
                color={port.color}
                opacity={0.34}
                tubularSegments={36}
                radialSegments={8}
                roughness={0.6}
              />
            )}
          </group>
        ))}
      </group>
    </PatientAnatomyFrame>
  );
}
