import { z } from "zod";

const AtlasEntityIdSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/).max(80);
const AtlasVec3Schema = z.tuple([z.number(), z.number(), z.number()]);

export const SurgicalModuleCameraSchema = z.object({
  position: AtlasVec3Schema,
  target: AtlasVec3Schema,
  fov: z.number().min(20).max(80),
});

export const SurgicalModuleStepSchema = z.object({
  id: AtlasEntityIdSchema,
  shortLabel: z.string().min(1).max(32),
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(700),
  teachingFocus: z.string().min(1).max(400),
  camera: SurgicalModuleCameraSchema,
  transparentPatient: z.boolean(),
  showLabels: z.boolean(),
});

export const SurgicalModulePlacementSchema = z.object({
  structureId: AtlasEntityIdSchema,
  frameId: z.enum([
    "whole-body",
    "central-abdomen",
    "right-upper-quadrant",
    "lower-gastrointestinal",
    "pelvis",
    "right-groin",
    "thorax",
  ]),
  centerCm: AtlasVec3Schema,
  sizeCm: AtlasVec3Schema.refine((size) => size.every((value) => value > 0), "Every nominal size must be positive"),
  rotation: AtlasVec3Schema,
  basis: z.enum(["registered", "research-derived"]),
  anchorIds: z.array(z.string().min(1).max(100)).min(2).max(12),
  rationale: z.string().min(1).max(400),
});
export type SurgicalModulePlacement = z.infer<typeof SurgicalModulePlacementSchema>;

export const SurgicalModuleDefinitionSchema = z.object({
  schemaVersion: z.literal("1.0"),
  title: z.string().min(1).max(180),
  subtitle: z.string().min(1).max(220),
  clinicalFocus: z.string().min(1).max(900),
  laterality: z.string().min(1).max(80),
  approach: z.string().min(1).max(180),
  disclaimer: z.string().min(1).max(300),
  background: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  showOperatingRoom: z.boolean(),
  structures: z.array(z.object({
    id: AtlasEntityIdSchema,
    label: z.string().min(1).max(100),
    category: z.enum(["target", "organ", "artery", "vein", "duct", "nerve", "tissue", "instrument", "landmark"]),
    studyId: AtlasEntityIdSchema,
  })).min(3).max(96),
  placements: z.array(SurgicalModulePlacementSchema).min(3).max(96),
  steps: z.array(SurgicalModuleStepSchema).min(1).max(14),
  qaViews: z.array(z.object({
    id: AtlasEntityIdSchema,
    label: z.string().min(1).max(120),
    stepId: AtlasEntityIdSchema,
    required: z.boolean(),
  })).min(1).max(24),
}).superRefine((definition, context) => {
  const stepIds = new Set(definition.steps.map((step) => step.id));
  if (stepIds.size !== definition.steps.length) {
    context.addIssue({ code: "custom", message: "Step IDs must be unique", path: ["steps"] });
  }
  const structureIds = new Set(definition.structures.map((structure) => structure.id));
  if (structureIds.size !== definition.structures.length) {
    context.addIssue({ code: "custom", message: "Structure IDs must be unique", path: ["structures"] });
  }
  const placementIds = new Set(definition.placements.map((placement) => placement.structureId));
  if (placementIds.size !== definition.placements.length) {
    context.addIssue({ code: "custom", message: "Every structure may have only one placement record", path: ["placements"] });
  }
  for (const [index, structure] of definition.structures.entries()) {
    if (!placementIds.has(structure.id)) {
      context.addIssue({ code: "custom", message: `Structure ${structure.id} has no anatomical placement`, path: ["structures", index, "id"] });
    }
  }
  for (const [index, placement] of definition.placements.entries()) {
    if (!structureIds.has(placement.structureId)) {
      context.addIssue({ code: "custom", message: `Placement references unknown structure ${placement.structureId}`, path: ["placements", index, "structureId"] });
    }
  }
  for (const [index, view] of definition.qaViews.entries()) {
    if (!stepIds.has(view.stepId)) {
      context.addIssue({ code: "custom", message: `QA view references unknown step ${view.stepId}`, path: ["qaViews", index, "stepId"] });
    }
  }
  if (!definition.qaViews.some((view) => view.required)) {
    context.addIssue({ code: "custom", message: "At least one QA view must be required", path: ["qaViews"] });
  }
});
export type SurgicalModuleDefinition = z.infer<typeof SurgicalModuleDefinitionSchema>;

export const SurgicalModuleSourceSchema = z.object({
  definition: SurgicalModuleDefinitionSchema,
  source: z.string().min(800).max(180_000),
});
export type SurgicalModuleSource = z.infer<typeof SurgicalModuleSourceSchema>;

export const CompiledSurgicalModuleSchema = z.object({
  schemaVersion: z.literal("1.0"),
  revision: z.number().int().positive(),
  definition: SurgicalModuleDefinitionSchema,
  viewerUrl: z.string().min(1),
  bundleUrl: z.string().min(1),
  sourceUrl: z.string().min(1),
  sourceSha256: z.string().length(64),
  bundleSha256: z.string().length(64),
  generatedAt: z.iso.datetime(),
});
export type CompiledSurgicalModule = z.infer<typeof CompiledSurgicalModuleSchema>;

export interface SurgicalModuleRecoveryContext {
  attempt: number;
  failedViewId: string;
  failedStepId?: string | undefined;
  passedTargetIds?: string[] | undefined;
  issue: string;
  evidence: string;
  failedCriteria: string[];
  previous: SurgicalModuleSource;
}
