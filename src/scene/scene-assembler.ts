import {
  SceneManifestSchema,
  ScenePlanSchema,
  type QaPatch,
  type ResolvedAsset,
  type SceneManifest,
  type ScenePlan,
} from "../contracts.js";
import { slugify } from "../lib/strings.js";
import { boundsSize, recipeBounds } from "./geometry-bounds.js";

export function assembleScene(
  projectId: string,
  plan: ScenePlan,
  assets: Map<string, ResolvedAsset>,
  revision = 1,
): SceneManifest {
  const objects = plan.objects.map((object) => {
    const asset = assets.get(object.assetSpecId);
    if (!asset) throw new Error(`No resolved asset for ${object.assetSpecId}`);
    return {
      id: object.id,
      assetId: asset.assetId,
      url: asset.url,
      position: object.position,
      rotation: object.rotation,
      scale: object.scale,
      label: object.label,
      labelVisible: true,
      highlight: object.highlight,
    };
  });
  return SceneManifestSchema.parse({
    schemaVersion: "1.0",
    projectId,
    sceneId: slugify(plan.title),
    title: plan.title,
    revision,
    environment: plan.environment,
    camera: plan.camera,
    lights: plan.lights,
    objects,
    relationships: plan.relationships,
    states: plan.states,
    transitions: plan.transitions,
    generatedAt: new Date().toISOString(),
  });
}

export function applyQaPatch(manifest: SceneManifest, patch: QaPatch): SceneManifest {
  const next = structuredClone(manifest);
  next.revision += 1;
  next.generatedAt = new Date().toISOString();
  switch (patch.kind) {
    case "camera":
      next.camera.position = patch.position;
      next.camera.target = patch.target;
      break;
    case "light": {
      const light = next.lights.find((candidate) => candidate.id === patch.objectId);
      if (!light) throw new Error(`QA patch references missing light ${patch.objectId}`);
      if (patch.position) light.position = patch.position;
      if (patch.intensity !== undefined) light.intensity = patch.intensity;
      if (patch.color) light.color = patch.color;
      break;
    }
    case "object-transform": {
      const object = next.objects.find((candidate) => candidate.id === patch.objectId);
      if (!object) throw new Error(`QA patch references missing object ${patch.objectId}`);
      if (patch.position) object.position = patch.position;
      if (patch.rotation) object.rotation = patch.rotation;
      if (patch.scale) object.scale = patch.scale;
      break;
    }
    case "label": {
      const object = next.objects.find((candidate) => candidate.id === patch.objectId);
      if (!object) throw new Error(`QA patch references missing object ${patch.objectId}`);
      object.labelVisible = patch.visible;
      break;
    }
    case "asset-regenerate":
      throw new Error("Asset regeneration must be applied to the scene plan and resolved GLB set");
    case "none":
      break;
  }
  return SceneManifestSchema.parse(next);
}

export function applyAssetRegeneration(plan: ScenePlan, patch: Extract<QaPatch, { kind: "asset-regenerate" }>): ScenePlan {
  const next = structuredClone(plan);
  const asset = next.assets.find((candidate) => candidate.id === patch.assetSpecId);
  if (!asset) throw new Error(`QA patch references missing asset spec ${patch.assetSpecId}`);
  asset.description = patch.description;
  asset.parts = patch.parts;
  const size = boundsSize(recipeBounds(asset));
  asset.dimensions = [Math.max(size[0], 0.001), Math.max(size[1], 0.001), Math.max(size[2], 0.001)];
  return ScenePlanSchema.parse(next);
}

export function applyResolvedAssets(
  manifest: SceneManifest,
  plan: ScenePlan,
  assets: Map<string, ResolvedAsset>,
): SceneManifest {
  const next = structuredClone(manifest);
  next.revision += 1;
  next.generatedAt = new Date().toISOString();
  const planned = new Map(plan.objects.map((object) => [object.id, object]));
  for (const object of next.objects) {
    const assetSpecId = planned.get(object.id)?.assetSpecId;
    const resolved = assetSpecId ? assets.get(assetSpecId) : undefined;
    if (!resolved) throw new Error(`No regenerated asset resolved for object ${object.id}`);
    object.assetId = resolved.assetId;
    object.url = resolved.url;
  }
  return SceneManifestSchema.parse(next);
}
