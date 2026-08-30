import type { ReactNode } from "react";
import registryJson from "./anatomical-registry.json";
import type { AtlasPoint } from "./types";

export type AtlasFrameId =
  | "whole-body"
  | "central-abdomen"
  | "right-upper-quadrant"
  | "lower-gastrointestinal"
  | "pelvis"
  | "right-groin"
  | "thorax";

export type AtlasStructureRegistration = {
  id: string;
  label: string;
  frameId: AtlasFrameId;
  centerCm: AtlasPoint;
  sizeCm: AtlasPoint;
  orientation: AtlasPoint;
  landmarks: string[];
  sourceSceneId: string;
  sourceSymbol: string;
  registrationMethod: string;
};

type AtlasFrameRegistration = {
  id: AtlasFrameId;
  label: string;
  parentId: string | null;
  originPatient: AtlasPoint;
  rotation: AtlasPoint;
  scaleWorldPerCm: number;
  boundsCm: AtlasPoint;
  sourceSceneId: string;
  usage: string;
};

type AnatomicalRegistry = {
  schemaVersion: string;
  humanBase: {
    id: string;
    heightCm: number;
    heightWorldUnits: number;
    worldUnitsPerCm: number;
    axes: Record<string, string>;
    source: string;
  };
  referenceScenes: Array<{
    id: string;
    source: string;
    purpose: string;
    registrationNotes: string[];
  }>;
  frames: AtlasFrameRegistration[];
  structures: AtlasStructureRegistration[];
  cameras: Array<{
    id: string;
    frameId: AtlasFrameId;
    position: AtlasPoint;
    target: AtlasPoint;
    fov: number;
    purpose: string;
  }>;
};

/**
 * Stable patient registration extracted from the surgical-atlas reference.
 * Generated scene code may replace morphology and materials, but it should use
 * these frames, nominal sizes, and junction landmarks as its starting anatomy.
 */
// TypeScript intentionally widens JSON arrays to number[]. Runtime validation on
// the server enforces every anatomical vector as an exact three-number tuple.
export const ANATOMICAL_REGISTRY = registryJson as unknown as AnatomicalRegistry;

const frames = new Map(ANATOMICAL_REGISTRY.frames.map((frame) => [frame.id, frame]));
const structures = new Map(ANATOMICAL_REGISTRY.structures.map((structure) => [structure.id, structure]));

export function atlasFrame(id: AtlasFrameId): AtlasFrameRegistration {
  const frame = frames.get(id);
  if (!frame) throw new Error(`Unknown anatomical atlas frame: ${id}`);
  return frame;
}

export function atlasStructure(id: string): AtlasStructureRegistration {
  const structure = structures.get(id);
  if (!structure) throw new Error(`Unknown anatomical structure registration: ${id}`);
  return structure;
}

/** A fresh tuple so generated modules cannot mutate the shared registry. */
export function atlasPoint(id: string, expectedFrameId?: AtlasFrameId): AtlasPoint {
  const structure = atlasStructure(id);
  if (expectedFrameId && structure.frameId !== expectedFrameId) {
    throw new Error(`${id} belongs to ${structure.frameId}, not ${expectedFrameId}`);
  }
  return [...structure.centerCm] as AtlasPoint;
}

/** Nominal anatomical extent in centimetres, not a display magnification. */
export function atlasSize(id: string): AtlasPoint {
  return [...atlasStructure(id).sizeCm] as AtlasPoint;
}

/**
 * A centimetre-authored regional coordinate frame registered to the 175 cm
 * MakeHuman base. Default magnification is exactly 1; close-up cameras should
 * provide teaching enlargement without corrupting relative organ scale.
 */
export function AnatomicalRegionFrame({
  id,
  children,
  magnification = 1,
}: {
  id: AtlasFrameId;
  children: ReactNode;
  magnification?: number;
}) {
  const frame = atlasFrame(id);
  const scale = frame.scaleWorldPerCm * magnification;
  return (
    <group name={`anatomical-region-${id}`} rotation={frame.rotation}>
      <group position={frame.originPatient} scale={scale}>{children}</group>
    </group>
  );
}

/**
 * Positions prompt-specific geometry at a registered centre while leaving its
 * construction replaceable. The child geometry is still authored in cm.
 */
export function RegisteredStructureFrame({
  id,
  children,
}: {
  id: string;
  children: ReactNode;
}) {
  const structure = atlasStructure(id);
  return (
    <group
      name={`registered-structure-${structure.id}`}
      position={structure.centerCm}
      rotation={structure.orientation}
      userData={{
        atlasStructureId: structure.id,
        atlasFrameId: structure.frameId,
        nominalSizeCm: [...structure.sizeCm],
      }}
    >
      {children}
    </group>
  );
}
