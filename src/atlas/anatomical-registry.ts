import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { SurgicalModuleDefinition, SurgicalModulePlacement } from "./module-contracts.js";

const Vec3Schema = z.tuple([z.number(), z.number(), z.number()]);

const AnatomicalRegistrySchema = z.object({
  schemaVersion: z.literal("1.0"),
  humanBase: z.object({
    id: z.string(),
    heightCm: z.number().positive(),
    heightWorldUnits: z.number().positive(),
    worldUnitsPerCm: z.number().positive(),
    axes: z.record(z.string(), z.string()),
    source: z.string(),
  }),
  referenceScenes: z.array(z.object({
    id: z.string(),
    source: z.string(),
    purpose: z.string(),
    registrationNotes: z.array(z.string()),
  })),
  frames: z.array(z.object({
    id: z.string(),
    label: z.string(),
    parentId: z.string().nullable(),
    originPatient: Vec3Schema,
    rotation: Vec3Schema,
    scaleWorldPerCm: z.number().positive(),
    boundsCm: Vec3Schema,
    sourceSceneId: z.string(),
    usage: z.string(),
  })),
  structures: z.array(z.object({
    id: z.string(),
    label: z.string(),
    frameId: z.string(),
    centerCm: Vec3Schema,
    sizeCm: Vec3Schema,
    orientation: Vec3Schema,
    landmarks: z.array(z.string()),
    sourceSceneId: z.string(),
    sourceSymbol: z.string().min(1),
    registrationMethod: z.string().min(1),
  })),
  cameras: z.array(z.object({
    id: z.string(),
    frameId: z.string(),
    position: Vec3Schema,
    target: Vec3Schema,
    fov: z.number(),
    purpose: z.string(),
  })),
}).superRefine((registry, context) => {
  const frameIds = new Set(registry.frames.map((frame) => frame.id));
  const sceneIds = new Set(registry.referenceScenes.map((scene) => scene.id));
  const structureIds = new Set<string>();
  for (const [index, frame] of registry.frames.entries()) {
    if (frame.parentId && !frameIds.has(frame.parentId)) {
      context.addIssue({ code: "custom", path: ["frames", index, "parentId"], message: `Unknown parent frame ${frame.parentId}` });
    }
    if (!sceneIds.has(frame.sourceSceneId)) {
      context.addIssue({ code: "custom", path: ["frames", index, "sourceSceneId"], message: `Unknown source scene ${frame.sourceSceneId}` });
    }
  }
  for (const [index, structure] of registry.structures.entries()) {
    if (structureIds.has(structure.id)) {
      context.addIssue({ code: "custom", path: ["structures", index, "id"], message: `Duplicate structure registration ${structure.id}` });
    }
    structureIds.add(structure.id);
    if (!frameIds.has(structure.frameId)) {
      context.addIssue({ code: "custom", path: ["structures", index, "frameId"], message: `Unknown frame ${structure.frameId}` });
    }
    if (!sceneIds.has(structure.sourceSceneId)) {
      context.addIssue({ code: "custom", path: ["structures", index, "sourceSceneId"], message: `Unknown source scene ${structure.sourceSceneId}` });
    }
    const frame = registry.frames.find((candidate) => candidate.id === structure.frameId);
    if (!frame) continue;
    for (let axis = 0; axis < 3; axis += 1) {
      const occupied = Math.abs(structure.centerCm[axis]!) + structure.sizeCm[axis]! / 2;
      if (occupied > frame.boundsCm[axis]! / 2) {
        context.addIssue({
          code: "custom",
          path: ["structures", index, "centerCm", axis],
          message: `${structure.id} escapes ${structure.frameId} bounds on axis ${axis}`,
        });
      }
    }
  }
});

export type AnatomicalRegistry = z.infer<typeof AnatomicalRegistrySchema>;

let cachedRegistry: AnatomicalRegistry | undefined;

export function loadAnatomicalRegistry(): AnatomicalRegistry {
  if (cachedRegistry) return cachedRegistry;
  const file = path.resolve(process.cwd(), "renderer/atlas/anatomical-registry.json");
  cachedRegistry = AnatomicalRegistrySchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  return cachedRegistry;
}

/**
 * The complete reference is intentionally sent to the module author. It is a
 * placement catalogue, not a request to instantiate every entry. At its current
 * size it is cheaper and safer than asking the model to infer an unlisted body
 * transform and then repairing buried or floating anatomy in visual QA.
 */
export function anatomicalRegistryPromptReference(): string {
  return JSON.stringify(loadAnatomicalRegistry());
}

/**
 * RegisteredStructureFrame is deliberately strict: it is a convenience for
 * geometry authored around the origin of a static catalogue entry, not a
 * generic group for newly researched or aggregate-provided anatomy. Catching
 * invalid IDs here keeps a bad module out of the browser render/repair loop.
 */
export function validateRegisteredStructureFrames(
  source: string,
  forbiddenIds: ReadonlySet<string> = new Set(),
): void {
  const knownIds = new Set(loadAnatomicalRegistry().structures.map((structure) => structure.id));
  const unknownIds = new Set<string>();
  const disallowedIds = new Set<string>();
  let dynamicId = false;
  const openingTag = /<RegisteredStructureFrame\b([^>]*)>/gs;
  for (const match of source.matchAll(openingTag)) {
    const attributes = match[1] ?? "";
    const literalId = attributes.match(/\bid\s*=\s*["']([^"']+)["']/s)?.[1];
    if (!literalId) {
      dynamicId = true;
      continue;
    }
    if (!knownIds.has(literalId)) unknownIds.add(literalId);
    if (forbiddenIds.has(literalId)) disallowedIds.add(literalId);
  }
  if (dynamicId) {
    throw new Error(
      "RegisteredStructureFrame requires a literal ID from the static anatomical registry; use an explicit group for research-derived anatomy",
    );
  }
  if (unknownIds.size > 0) {
    throw new Error(
      `RegisteredStructureFrame can only use static anatomical-registry IDs; unknown: ${[...unknownIds].join(", ")}`,
    );
  }
  if (disallowedIds.size > 0) {
    throw new Error(
      `Do not wrap or duplicate anatomy already supplied by a curated atlas aggregate: ${[...disallowedIds].join(", ")}`,
    );
  }
}

export function validateModulePlacements(
  definition: SurgicalModuleDefinition,
  acceptedPlacements: SurgicalModulePlacement[] = [],
): void {
  const registry = loadAnatomicalRegistry();
  const frames = new Map(registry.frames.map((frame) => [frame.id, frame]));
  const structures = new Map(registry.structures.map((structure) => [structure.id, structure]));
  const promoted = new Map<string, SurgicalModulePlacement>();
  for (const placement of acceptedPlacements) {
    if (!structures.has(placement.structureId) && !promoted.has(placement.structureId)) {
      promoted.set(placement.structureId, placement);
    }
  }
  for (const placement of definition.placements) {
    const frame = frames.get(placement.frameId);
    if (!frame) throw new Error(`Placement ${placement.structureId} uses unknown anatomical frame ${placement.frameId}`);
    for (let axis = 0; axis < 3; axis += 1) {
      const centre = placement.centerCm[axis]!;
      const extent = placement.sizeCm[axis]! / 2;
      const halfBound = frame.boundsCm[axis]! / 2;
      if (Math.abs(centre) + extent > halfBound * 1.35) {
        throw new Error(
          `Placement ${placement.structureId} escapes ${placement.frameId} bounds on axis ${axis}: ` +
          `center=${centre} cm, size=${placement.sizeCm[axis]} cm, frame=${frame.boundsCm[axis]} cm`,
        );
      }
    }
    const staticRegistration = structures.get(placement.structureId);
    const promotedRegistration = promoted.get(placement.structureId);
    const registered = staticRegistration
      ? {
          frameId: staticRegistration.frameId,
          centerCm: staticRegistration.centerCm,
          sizeCm: staticRegistration.sizeCm,
          rotation: staticRegistration.orientation,
        }
      : promotedRegistration;
    if (!registered) continue;
    if (placement.basis !== "registered") {
      throw new Error(`Known or accepted atlas structure ${placement.structureId} must use basis="registered"`);
    }
    if (placement.frameId !== registered.frameId) {
      throw new Error(`Known atlas structure ${placement.structureId} belongs to ${registered.frameId}, not ${placement.frameId}`);
    }
    const centreDelta = maxDelta(placement.centerCm, registered.centerCm);
    const sizeDelta = maxRelativeDelta(placement.sizeCm, registered.sizeCm);
    const rotationDelta = maxDelta(placement.rotation, registered.rotation);
    if (centreDelta > 0.25 || sizeDelta > 0.08 || rotationDelta > 0.08) {
      throw new Error(
        `Known atlas structure ${placement.structureId} must preserve its registered centre/size/rotation. ` +
        `Expected center ${JSON.stringify(registered.centerCm)}, size ${JSON.stringify(registered.sizeCm)}, ` +
        `and rotation ${JSON.stringify(registered.rotation)}.`,
      );
    }
  }
}

function maxDelta(left: [number, number, number], right: [number, number, number]): number {
  return Math.max(...left.map((value, index) => Math.abs(value - right[index]!)));
}

function maxRelativeDelta(left: [number, number, number], right: [number, number, number]): number {
  return Math.max(...left.map((value, index) => Math.abs(value - right[index]!) / right[index]!));
}
