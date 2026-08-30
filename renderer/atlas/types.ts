import type { ComponentType } from "react";

export type AtlasPoint = readonly [number, number, number];

export type AtlasCamera = {
  position: AtlasPoint;
  target: AtlasPoint;
  fov: number;
};

export type SurgicalModuleStep = {
  id: string;
  shortLabel: string;
  title: string;
  description: string;
  teachingFocus: string;
  camera: AtlasCamera;
  transparentPatient: boolean;
  showLabels: boolean;
};

export type SurgicalModuleDefinition = {
  schemaVersion: "1.0";
  title: string;
  subtitle: string;
  clinicalFocus: string;
  laterality: string;
  approach: string;
  disclaimer: string;
  background: string;
  showOperatingRoom: boolean;
  structures: Array<{
    id: string;
    label: string;
    category: "target" | "organ" | "artery" | "vein" | "duct" | "nerve" | "tissue" | "instrument" | "landmark";
    studyId: string;
  }>;
  placements: Array<{
    structureId: string;
    frameId: "whole-body" | "central-abdomen" | "right-upper-quadrant" | "lower-gastrointestinal" | "pelvis" | "right-groin" | "thorax";
    centerCm: AtlasPoint;
    sizeCm: AtlasPoint;
    rotation: AtlasPoint;
    basis: "registered" | "research-derived";
    anchorIds: string[];
    rationale: string;
  }>;
  steps: SurgicalModuleStep[];
  qaViews: Array<{
    id: string;
    label: string;
    stepId: string;
    required: boolean;
  }>;
};

export type SurgicalModuleProps = {
  activeStepId: string;
  showLabels: boolean;
  transparentPatient: boolean;
};

export type SurgicalSceneComponent = ComponentType<SurgicalModuleProps>;
