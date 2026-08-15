import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Config } from "../config.js";
import type {
  Inspection,
  ProjectRecord,
  ResearchBrief,
  ResolvedAsset,
  RunEvent,
  SceneManifest,
  ScenePlan,
  SpatialReport,
  WorkflowStage,
} from "../contracts.js";
import { InspectionSchema, ScenePlanSchema } from "../contracts.js";
import type { WorkflowAI } from "../ai/workflow-ai.js";
import type { BlenderDriver } from "../blender/blender-driver.js";
import type { AssetRecord, ContextStore } from "../context/context-store.js";
import { hashObject, sha256 } from "../lib/hash.js";
import { normalizePrompt } from "../lib/strings.js";
import type { ScreenshotDriver } from "../render/screenshot-driver.js";
import type { ReferenceCollector } from "../research/reference-collector.js";
import { applyQaPatch, assembleScene } from "../scene/scene-assembler.js";
import { analyzeSpatial } from "../scene/spatial-analyzer.js";
import type { ArtifactStore, StoredArtifact } from "../storage/artifact-store.js";
import type { ProjectManager } from "../storage/project-manager.js";

export interface WorkflowResult {
  project: ProjectRecord;
  research: ResearchBrief;
  plan: ScenePlan;
  initialScene: SceneManifest;
  finalScene: SceneManifest;
  viewerUrl: string;
}

const CachedRenderSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().length(64),
  browserErrors: z.array(z.string()),
});

const RENDERER_CACHE_IDENTITY = "three-viewer:v1";

export class Orchestrator {
  private readonly activeRuns = new Map<string, Promise<WorkflowResult>>();
  private readonly sequences = new Map<string, number>();

  constructor(
    private readonly config: Config,
    private readonly projects: ProjectManager,
    private readonly artifacts: ArtifactStore,
    private readonly context: ContextStore,
    private readonly ai: WorkflowAI,
    private readonly references: ReferenceCollector,
    private readonly blender: BlenderDriver,
    private readonly screenshots: ScreenshotDriver,
  ) {}

  async start(prompt: string): Promise<ProjectRecord> {
    const project = await this.projects.create(prompt);
    const run = this.execute(project);
    this.activeRuns.set(project.projectId, run);
    void run.finally(() => this.activeRuns.delete(project.projectId)).catch(() => undefined);
    return project;
  }

  async run(prompt: string): Promise<WorkflowResult> {
    const project = await this.projects.create(prompt);
    return this.execute(project);
  }

  getActiveRun(projectId: string): Promise<WorkflowResult> | undefined {
    return this.activeRuns.get(projectId);
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.activeRuns.values()]);
    await Promise.all([this.blender.close(), this.screenshots.close()]);
    await this.context.close();
  }

  private async execute(initialProject: ProjectRecord): Promise<WorkflowResult> {
    let project = initialProject;
    const relativeRoot = this.projects.relativeRoot(project);
    try {
      await this.emit(project, "created", "completed", { prompt: project.prompt });

      project = await this.stage(project, "researching");
      const researchKey = hashObject({
        prompt: normalizePrompt(project.prompt),
        schema: "research-v2",
        provider: this.ai.researchIdentity,
      });
      let research = await this.context.findResearch(researchKey);
      const researchCacheHit = research !== null;
      let prefetchedPlan: ScenePlan | null = null;
      if (!research) {
        const combined = await this.ai.researchAndPlan(project.prompt, this.config.WORKFLOW_MAX_OBJECTS);
        research = combined.research;
        prefetchedPlan = combined.plan;
        await this.context.storeResearch(researchKey, project.prompt, research);
      }
      const planKey = hashObject({
        prompt: normalizePrompt(project.prompt),
        research: hashObject(research),
        maxObjects: this.config.WORKFLOW_MAX_OBJECTS,
        schema: "plan-v2",
        provider: this.ai.planningIdentity,
      });
      const cachedPlan = ScenePlanSchema.safeParse(await this.context.findCachedStep(planKey));
      const planCacheHit = cachedPlan.success;
      const planPromise = cachedPlan.success
        ? Promise.resolve(cachedPlan.data)
        : Promise.resolve(prefetchedPlan ?? this.ai.plan(project.prompt, research, this.config.WORKFLOW_MAX_OBJECTS)).then(
            async (value) => {
              const parsed = ScenePlanSchema.parse(value);
              await this.context.storeCachedStep(planKey, "scene-plan", parsed);
              return parsed;
            },
          );
      const [plan, referenceArtifacts] = await Promise.all([
        planPromise,
        this.references.collect(research, path.join(project.root, "research", "references")),
        this.artifacts.writeJson(`${relativeRoot}/research/brief.json`, research),
        this.artifacts.writeJson(`${relativeRoot}/research/sources.json`, research.sources),
        this.artifacts.writeText(`${relativeRoot}/research/notes.md`, renderResearchNotes(research)),
      ]);
      await this.artifacts.writeJson(`${relativeRoot}/research/references/index.json`, referenceArtifacts);
      await this.emit(project, "researching", "completed", {
        cacheHit: researchCacheHit,
        combinedResearchPlan: !researchCacheHit,
        referencesRequested: research.references.length,
        referencesDownloaded: referenceArtifacts.filter((artifact) => artifact.localPath).length,
        referencesReused: referenceArtifacts.filter((artifact) => artifact.reused).length,
      });

      project = await this.stage(project, "planning");
      await this.artifacts.writeJson(`${relativeRoot}/plan/scene-plan.json`, plan);
      await this.emit(project, "planning", "completed", {
        cacheHit: planCacheHit,
        assets: plan.assets.length,
        objects: plan.objects.length,
      });

      project = await this.stage(project, "resolving_assets");
      const resolved = await this.resolveAssets(project, plan);
      await this.artifacts.writeJson(`${relativeRoot}/assets/index.json`, [...resolved.values()]);
      await this.emit(project, "resolving_assets", "completed", {
        generated: [...resolved.values()].filter((asset) => !asset.reused).length,
        reused: [...resolved.values()].filter((asset) => asset.reused).length,
      });

      project = await this.stage(project, "assembling");
      const initialScene = assembleScene(project.projectId, plan, resolved, 1);
      const initialSpatial = analyzeSpatial(plan, initialScene);
      const [initialManifest] = await Promise.all([
        this.storeScene(project, initialScene),
        this.artifacts.writeJson(`${relativeRoot}/qa/spatial-revision-001.json`, initialSpatial),
        this.context.storeSpatial(project.projectId, 1, initialSpatial),
      ]);
      await this.emit(project, "assembling", "completed", {
        revision: 1,
        spatialIssues: initialSpatial.issues.length,
      });

      project = await this.stage(project, "rendering_initial");
      const initialRenderPath = path.join(project.root, "renders", "revision-001.png");
      const initialRendered = await this.renderScene(
        project,
        initialScene,
        initialManifest,
        initialRenderPath,
        `${relativeRoot}/renders/revision-001.png`,
        "initial",
      );
      const initialRender = initialRendered.artifact;
      const initialCapture = initialRendered.capture;
      await this.emit(project, "rendering_initial", "completed", {
        cacheHit: initialRendered.cacheHit,
        browserErrors: initialCapture.browserErrors,
      });

      project = await this.stage(project, "inspecting");
      const inspectionKey = hashObject({
        scene: canonicalSceneForQa(initialScene),
        spatial: canonicalSpatialForQa(initialSpatial),
        screenshot: initialRender.sha256,
        browserErrors: initialCapture.browserErrors,
        provider: this.ai.inspectionIdentity,
        renderer: this.screenshots.identity,
        schema: "inspection-v2",
      });
      const cachedInspection = InspectionSchema.safeParse(await this.context.findCachedStep(inspectionKey));
      const inspection: Inspection = cachedInspection.success
        ? cachedInspection.data
        : await this.ai.inspect(initialScene, initialRenderPath, initialSpatial);
      await Promise.all([
        this.artifacts.writeJson(`${relativeRoot}/qa/revision-001.json`, inspection),
        this.context.storeQa(project.projectId, 1, inspection),
        cachedInspection.success
          ? Promise.resolve()
          : this.context.storeCachedStep(inspectionKey, "inspection", inspection),
      ]);
      await this.emit(project, "inspecting", "completed", {
        cacheHit: cachedInspection.success,
        verdict: inspection.verdict,
        category: inspection.category,
      });

      project = await this.stage(project, "refining");
      const shouldPatch = inspection.verdict === "fix" && inspection.patch.kind !== "none";
      const finalScene = shouldPatch ? applyQaPatch(initialScene, inspection.patch) : initialScene;
      const finalSpatial = shouldPatch ? analyzeSpatial(plan, finalScene) : initialSpatial;
      const finalManifest = shouldPatch
        ? (
            await Promise.all([
              this.storeScene(project, finalScene),
              this.artifacts.writeJson(
                `${relativeRoot}/qa/spatial-revision-${padRevision(finalScene.revision)}.json`,
                finalSpatial,
              ),
              this.context.storeSpatial(project.projectId, finalScene.revision, finalSpatial),
            ])
          )[0]
        : initialManifest;
      await this.emit(project, "refining", "completed", {
        revision: finalScene.revision,
        patch: shouldPatch ? inspection.patch.kind : "none",
      });

      project = await this.stage(project, "rendering_final");
      if (shouldPatch) {
        const finalRenderPath = path.join(project.root, "renders", `revision-${padRevision(finalScene.revision)}.png`);
        const finalRendered = await this.renderScene(
          project,
          finalScene,
          finalManifest,
          finalRenderPath,
          `${relativeRoot}/renders/revision-${padRevision(finalScene.revision)}.png`,
          "final",
        );
        await this.emit(project, "rendering_final", "completed", {
          cacheHit: finalRendered.cacheHit,
          browserErrors: finalRendered.capture.browserErrors,
        });
      } else {
        await this.context.storeRender(project.projectId, 1, initialRender.path, initialRender.sha256, "final");
        await this.emit(project, "rendering_final", "completed", { reusedInitial: true, browserErrors: initialCapture.browserErrors });
      }

      project = await this.projects.update(project, { status: "completed", finalRevision: finalScene.revision });
      await this.emit(project, "completed", "completed", { revision: finalScene.revision });
      return {
        project,
        research,
        plan,
        initialScene,
        finalScene,
        viewerUrl: this.viewerUrl(finalManifest.url),
      };
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      project = await this.projects.update(project, { status: "failed", error: message });
      await this.emit(project, "failed", "failed", { error: message });
      throw error;
    } finally {
      this.sequences.delete(project.runId);
    }
  }

  private async resolveAssets(project: ProjectRecord, plan: ScenePlan): Promise<Map<string, ResolvedAsset>> {
    const results = new Map<string, ResolvedAsset>();
    const relativeRoot = this.projects.relativeRoot(project);
    const lookups = plan.assets.map((spec) => ({
      spec,
      assetKey: hashObject({ spec, generator: this.blender.identity, schema: "asset-v1" }),
    }));
    const candidates = await this.context.findAssets(lookups, 8);
    const validation = new Map<string, Promise<boolean>>();
    const validate = (record: AssetRecord): Promise<boolean> => {
      const key = `${record.resolved.path}:${record.resolved.sha256}`;
      const existing = validation.get(key);
      if (existing) return existing;
      const pending = validCachedAsset(record.resolved);
      validation.set(key, pending);
      return pending;
    };
    const recordsToStore: AssetRecord[] = [];
    const missing: typeof lookups = [];

    await Promise.all(
      lookups.map(async (lookup) => {
        const available = candidates.get(lookup.assetKey);
        const possible = [available?.exact ?? null, ...(available?.related ?? [])].filter(
          (candidate): candidate is AssetRecord =>
            candidate !== null &&
            candidate.resolved.generator === this.blender.identity &&
            (candidate.resolved.assetKey === lookup.assetKey ||
              isCompatibleAssetForGenerator(lookup.spec, candidate, this.blender.identity)),
        );
        const validity = await Promise.all(possible.map(validate));
        const cached = possible.find((_candidate, index) => validity[index]);
        if (!cached) {
          missing.push(lookup);
          return;
        }

        const projectKey = `${relativeRoot}/assets/reused/${lookup.spec.id}.glb`;
        const projectArtifact = await this.artifacts.copyFile(projectKey, cached.resolved.path);
        const libraryResolved: ResolvedAsset = {
          ...cached.resolved,
          assetKey: lookup.assetKey,
          specId: lookup.spec.id,
          reused: true,
        };
        results.set(lookup.spec.id, {
          ...libraryResolved,
          path: projectArtifact.path,
          url: projectArtifact.url,
        });
        if (cached.resolved.assetKey !== lookup.assetKey) {
          recordsToStore.push({ spec: lookup.spec, resolved: libraryResolved, createdAt: new Date().toISOString() });
        }
      }),
    );
    const lookupOrder = new Map(lookups.map((lookup, index) => [lookup.spec.id, index]));
    missing.sort((left, right) =>
      (lookupOrder.get(left.spec.id) ?? Number.MAX_SAFE_INTEGER) -
      (lookupOrder.get(right.spec.id) ?? Number.MAX_SAFE_INTEGER),
    );

    if (missing.length > 0) {
      await this.emit(project, "generating_assets", "started", {
        count: missing.length,
        specIds: missing.map(({ spec }) => spec.id),
      });
      const outputs = await this.blender.generateMany(
        missing.map(({ spec }) => ({
          spec,
          outputPath: this.artifacts.absolutePath(`${relativeRoot}/assets/generated/${spec.id}.glb`),
        })),
      );
      if (outputs.length !== missing.length) {
        throw new Error(`Blender returned ${outputs.length} assets for ${missing.length} requests`);
      }
      await Promise.all(
        missing.map(async ({ spec, assetKey }, index) => {
          const output = outputs[index];
          if (!output) throw new Error(`Blender returned no output for ${spec.id}`);
          const generatedKey = `${relativeRoot}/assets/generated/${spec.id}.glb`;
          const projectArtifact = await artifactFromExisting(output.path, generatedKey, this.artifacts);
          const libraryKey = `library/assets/${assetKey}/model.glb`;
          const libraryArtifact = await this.artifacts.copyFile(libraryKey, projectArtifact.path);
          const libraryResolved: ResolvedAsset = {
            assetId: assetKey.slice(0, 24),
            assetKey,
            specId: spec.id,
            path: libraryArtifact.path,
            url: libraryArtifact.url,
            sha256: libraryArtifact.sha256,
            reused: false,
            generator: output.generator,
            metadata: output.metadata,
          };
          recordsToStore.push({ spec, resolved: libraryResolved, createdAt: new Date().toISOString() });
          results.set(spec.id, { ...libraryResolved, path: projectArtifact.path, url: projectArtifact.url });
          await this.artifacts.writeJson(`library/assets/${assetKey}/metadata.json`, {
            spec,
            resolved: libraryResolved,
          });
        }),
      );
      await this.emit(project, "generating_assets", "completed", {
        count: missing.length,
        specIds: missing.map(({ spec }) => spec.id),
      });
    }
    recordsToStore.sort((left, right) => left.spec.id.localeCompare(right.spec.id));
    await this.context.storeAssets(recordsToStore);
    return new Map(
      plan.assets.map((spec) => {
        const resolved = results.get(spec.id);
        if (!resolved) throw new Error(`Asset resolution produced no result for ${spec.id}`);
        return [spec.id, resolved];
      }),
    );
  }

  private async storeScene(project: ProjectRecord, manifest: SceneManifest): Promise<StoredArtifact> {
    const relativeRoot = this.projects.relativeRoot(project);
    const key = `${relativeRoot}/scene/revision-${padRevision(manifest.revision)}.json`;
    const artifact = await this.artifacts.writeJson(key, manifest);
    await this.context.storeScene(project.projectId, manifest, artifact.sha256, artifact.path);
    return artifact;
  }

  private async renderScene(
    project: ProjectRecord,
    scene: SceneManifest,
    manifest: StoredArtifact,
    outputPath: string,
    artifactKey: string,
    kind: "initial" | "final",
  ): Promise<{
    artifact: StoredArtifact;
    capture: { path: string; browserErrors: string[] };
    cacheHit: boolean;
  }> {
    const cacheKey = hashObject({
      scene: canonicalSceneForQa(scene),
      renderer: RENDERER_CACHE_IDENTITY,
      capture: this.screenshots.identity,
      schema: "render-v1",
    });
    const cached = CachedRenderSchema.safeParse(await this.context.findCachedStep(cacheKey));
    const cacheHit =
      cached.success &&
      cached.data.browserErrors.length === 0 &&
      (await validFile(cached.data.path, cached.data.sha256));
    const capture = cacheHit
      ? { path: outputPath, browserErrors: cached.data.browserErrors }
      : await this.screenshots.capture(this.viewerUrl(manifest.url), outputPath);
    const artifact = await artifactFromExisting(
      cacheHit ? cached.data.path : capture.path,
      artifactKey,
      this.artifacts,
    );
    await Promise.all([
      this.context.storeRender(project.projectId, scene.revision, artifact.path, artifact.sha256, kind),
      cacheHit || capture.browserErrors.length > 0
        ? Promise.resolve()
        : this.context.storeCachedStep(cacheKey, "render", {
            path: artifact.path,
            sha256: artifact.sha256,
            browserErrors: capture.browserErrors,
          }),
    ]);
    return { artifact, capture: { ...capture, path: artifact.path }, cacheHit };
  }

  private viewerUrl(manifestUrl: string): string {
    return `${this.config.PUBLIC_BASE_URL.replace(/\/$/, "")}/viewer/?manifest=${encodeURIComponent(manifestUrl)}`;
  }

  private async stage(project: ProjectRecord, stage: WorkflowStage): Promise<ProjectRecord> {
    const next = await this.projects.markStage(project, stage);
    await this.emit(next, stage, "started", {});
    return next;
  }

  private async emit(
    project: ProjectRecord,
    stage: WorkflowStage,
    status: RunEvent["status"],
    detail: Record<string, unknown>,
  ): Promise<void> {
    const sequence = this.sequences.get(project.runId) ?? 0;
    this.sequences.set(project.runId, sequence + 1);
    const event: RunEvent = {
      projectId: project.projectId,
      runId: project.runId,
      sequence,
      stage,
      status,
      detail,
      createdAt: new Date().toISOString(),
    };
    await this.projects.writeEvent(project, event);
    await this.context.appendEvent(event);
  }
}

async function validCachedAsset(asset: ResolvedAsset): Promise<boolean> {
  return validFile(asset.path, asset.sha256);
}

async function validFile(filePath: string, expectedSha256: string): Promise<boolean> {
  try {
    const buffer = await fs.readFile(filePath);
    return buffer.length > 20 && sha256(buffer) === expectedSha256;
  } catch {
    return false;
  }
}

async function artifactFromExisting(
  sourcePath: string,
  key: string,
  artifacts: ArtifactStore,
): Promise<StoredArtifact> {
  if (path.resolve(sourcePath) === path.resolve(artifacts.absolutePath(key))) {
    const buffer = await fs.readFile(sourcePath);
    return { key, path: sourcePath, url: artifacts.publicUrl(key), sha256: sha256(buffer), size: buffer.length };
  }
  return artifacts.copyFile(key, sourcePath);
}

function renderResearchNotes(research: ResearchBrief): string {
  return `# ${research.concept}\n\n${research.summary}\n\n## Visual notes\n\n${research.visualNotes.map((note) => `- ${note}`).join("\n")}\n\n## Object notes\n\n${research.objectNotes.map((note) => `- ${note}`).join("\n")}\n\n## Sources\n\n${research.sources.map((source) => `- [${source.title}](${source.url}) — ${source.note}`).join("\n")}\n`;
}

function padRevision(revision: number): string {
  return String(revision).padStart(3, "0");
}

function canonicalSceneForQa(manifest: SceneManifest): unknown {
  const { projectId: _projectId, sceneId: _sceneId, revision: _revision, generatedAt: _generatedAt, ...stable } =
    manifest;
  return {
    ...stable,
    objects: stable.objects.map(({ url: _url, ...object }) => object),
  };
}

function canonicalSpatialForQa(report: SpatialReport): unknown {
  const { sceneRevision: _sceneRevision, generatedAt: _generatedAt, ...stable } = report;
  return stable;
}

function isCompatibleAsset(requested: ScenePlan["assets"][number], candidate: ScenePlan["assets"][number]): boolean {
  if (requested.category.toLowerCase() !== candidate.category.toLowerCase()) return false;
  if (requested.style.toLowerCase() !== candidate.style.toLowerCase()) return false;
  const candidateTags = new Set(candidate.tags.map((tag) => tag.toLowerCase()));
  const overlap = requested.tags.filter((tag) => candidateTags.has(tag.toLowerCase())).length;
  if (overlap < Math.min(2, requested.tags.length)) return false;
  return requested.dimensions.every((dimension, index) => {
    const other = candidate.dimensions[index] ?? 0;
    if (dimension <= 0 || other <= 0) return false;
    const ratio = dimension / other;
    return ratio >= 0.5 && ratio <= 2;
  });
}

export function isCompatibleAssetForGenerator(
  requested: ScenePlan["assets"][number],
  candidate: AssetRecord,
  generatorIdentity: string,
): boolean {
  return candidate.resolved.generator === generatorIdentity && isCompatibleAsset(requested, candidate.spec);
}
