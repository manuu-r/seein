import {
  SceneManifestSchema,
  type QaPatch,
  type ResolvedAsset,
  type SceneManifest,
  type ScenePlan,
} from "../contracts.js";
import { slugify } from "../lib/strings.js";

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
    case "none":
      break;
  }
  return SceneManifestSchema.parse(next);
}

