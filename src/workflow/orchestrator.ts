import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Config } from "../config.js";
import type {
  Inspection,
  AssetGeometry,
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
import {
  applyAssetRegeneration,
  applyQaPatch,
  applyResolvedAssets,
  assembleScene,
} from "../scene/scene-assembler.js";
import { boundsSize, measureGlbBuffer, measureGlbGeometry, recipeBounds } from "../scene/geometry-bounds.js";
import { analyzeSpatial } from "../scene/spatial-analyzer.js";
import type { ArtifactStore, StoredArtifact } from "../storage/artifact-store.js";
import type { ProjectManager } from "../storage/project-manager.js";

export interface WorkflowResult {
  project: ProjectRecord;
  research: ResearchBrief;
  plan: ScenePlan;
  initialScene: SceneManifest;
  finalScene: SceneManifest;
  finalInspection: Inspection;
  qaExhausted: boolean;
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
        schema: "plan-v3",
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
      const [initialPlan, referenceArtifacts] = await Promise.all([
        planPromise,
        this.references.collect(research, path.join(project.root, "research", "references")),
        this.artifacts.writeJson(`${relativeRoot}/research/brief.json`, research),
        this.artifacts.writeJson(`${relativeRoot}/research/sources.json`, research.sources),
        this.artifacts.writeText(`${relativeRoot}/research/notes.md`, renderResearchNotes(research)),
      ]);
      let plan = initialPlan;
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
      let resolved = await this.resolveAssets(project, plan, 1);
      await this.artifacts.writeJson(`${relativeRoot}/assets/index.json`, [...resolved.values()]);
      await this.emit(project, "resolving_assets", "completed", {
        generated: [...resolved.values()].filter((asset) => !asset.reused).length,
        reused: [...resolved.values()].filter((asset) => asset.reused).length,
      });

      project = await this.stage(project, "assembling");
      const initialScene = assembleScene(project.projectId, plan, resolved, 1);
      const initialSpatial = analyzeSpatial(plan, initialScene, resolved);
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

      let currentScene = initialScene;
      let currentSpatial = initialSpatial;
      let currentManifest = initialManifest;
      let currentRender = initialRendered;
      let refinements = 0;
      let exhausted = false;
      let finalVerdict: Inspection["verdict"] = "pass";
      let finalInspection: Inspection | null = null;

      for (let iteration = 1; iteration <= this.config.WORKFLOW_MAX_ITERATIONS; iteration += 1) {
        project = await this.stage(project, "inspecting");
        const inspectionKey = hashObject({
          scene: canonicalSceneForQa(currentScene),
          planAssets: hashObject(plan.assets),
          spatial: canonicalSpatialForQa(currentSpatial),
          screenshot: currentRender.artifact.sha256,
          browserErrors: currentRender.capture.browserErrors,
          provider: this.ai.inspectionIdentity,
          renderer: this.screenshots.identity,
          schema: "inspection-v3",
        });
        const cachedInspection = InspectionSchema.safeParse(await this.context.findCachedStep(inspectionKey));
        const inspection: Inspection = cachedInspection.success
          ? cachedInspection.data
          : await this.ai.inspect(currentScene, currentRender.artifact.path, currentSpatial, plan);
        await Promise.all([
          this.artifacts.writeJson(
            `${relativeRoot}/qa/revision-${padRevision(currentScene.revision)}.json`,
            inspection,
          ),
          this.context.storeQa(project.projectId, currentScene.revision, inspection),
          cachedInspection.success
            ? Promise.resolve()
            : this.context.storeCachedStep(inspectionKey, "inspection", inspection),
        ]);
        const canRefine =
          inspection.verdict === "fix" &&
          inspection.patch.kind !== "none" &&
          iteration < this.config.WORKFLOW_MAX_ITERATIONS;
        await this.emit(project, "inspecting", "completed", {
          iteration,
          revision: currentScene.revision,
          cacheHit: cachedInspection.success,
          verdict: inspection.verdict,
          category: inspection.category,
          canRefine,
        });
        finalVerdict = inspection.verdict;
        finalInspection = inspection;
        if (!canRefine) {
          exhausted =
            inspection.verdict === "fix" &&
            inspection.patch.kind !== "none" &&
            iteration >= this.config.WORKFLOW_MAX_ITERATIONS;
          break;
        }

        project = await this.stage(project, "refining");
        const nextRevision = currentScene.revision + 1;
        if (inspection.patch.kind === "asset-regenerate") {
          plan = applyAssetRegeneration(plan, inspection.patch);
          resolved = await this.resolveAssets(project, plan, nextRevision);
          currentScene = applyResolvedAssets(currentScene, plan, resolved);
          await Promise.all([
            this.artifacts.writeJson(`${relativeRoot}/plan/scene-plan.json`, plan),
            this.artifacts.writeJson(
              `${relativeRoot}/plan/scene-plan-revision-${padRevision(nextRevision)}.json`,
              plan,
            ),
            this.artifacts.writeJson(`${relativeRoot}/assets/index.json`, [...resolved.values()]),
            this.artifacts.writeJson(
              `${relativeRoot}/assets/index-revision-${padRevision(nextRevision)}.json`,
              [...resolved.values()],
            ),
          ]);
        } else {
          currentScene = applyQaPatch(currentScene, inspection.patch);
        }
        refinements += 1;
        currentSpatial = analyzeSpatial(plan, currentScene, resolved);
        [currentManifest] = await Promise.all([
          this.storeScene(project, currentScene),
          this.artifacts.writeJson(
            `${relativeRoot}/qa/spatial-revision-${padRevision(currentScene.revision)}.json`,
            currentSpatial,
          ),
          this.context.storeSpatial(project.projectId, currentScene.revision, currentSpatial),
        ]);
        await this.emit(project, "refining", "completed", {
          iteration,
          revision: currentScene.revision,
          patch: inspection.patch.kind,
          spatialIssues: currentSpatial.issues.length,
        });

        project = await this.stage(project, "rendering_final");
        const renderPath = path.join(project.root, "renders", `revision-${padRevision(currentScene.revision)}.png`);
        currentRender = await this.renderScene(
          project,
          currentScene,
          currentManifest,
          renderPath,
          `${relativeRoot}/renders/revision-${padRevision(currentScene.revision)}.png`,
          "final",
        );
        await this.emit(project, "rendering_final", "completed", {
          iteration,
          revision: currentScene.revision,
          cacheHit: currentRender.cacheHit,
          browserErrors: currentRender.capture.browserErrors,
        });
      }

      if (currentScene.revision === 1) {
        await this.context.storeRender(project.projectId, 1, initialRender.path, initialRender.sha256, "final");
      }
      if (!finalInspection) throw new Error("Workflow completed without inspecting its final render");
      project = await this.projects.update(project, {
        status: "completed",
        finalRevision: currentScene.revision,
        finalQaVerdict: finalVerdict,
        qaExhausted: exhausted,
      });
      await this.emit(project, "completed", "completed", {
        revision: currentScene.revision,
        refinements,
        finalVerdict,
        exhausted,
      });
      return {
        project,
        research,
        plan,
        initialScene,
        finalScene: currentScene,
        finalInspection,
        qaExhausted: exhausted,
        viewerUrl: this.viewerUrl(currentManifest.url),
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

  private async resolveAssets(
    project: ProjectRecord,
    plan: ScenePlan,
    revision: number,
  ): Promise<Map<string, ResolvedAsset>> {
    const results = new Map<string, ResolvedAsset>();
    const relativeRoot = this.projects.relativeRoot(project);
    const lookups = plan.assets.map((spec) => ({
      spec,
      assetKey: hashObject({ spec, generator: this.blender.identity, schema: "asset-v2" }),
    }));
    const candidates = await this.context.findAssets(lookups, 8);
    const validation = new Map<string, Promise<AssetGeometry | null>>();
    const inspect = (record: AssetRecord): Promise<AssetGeometry | null> => {
      const key = `${record.resolved.path}:${record.resolved.sha256}`;
      const existing = validation.get(key);
      if (existing) return existing;
      const pending = inspectCachedGlb(record.resolved);
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
              isMetadataCompatible(lookup.spec, candidate.spec)),
        );
        const measured = await Promise.all(possible.map(inspect));
        const cachedIndex = possible.findIndex((candidate, index) => {
          const geometry = measured[index];
          if (!geometry) return false;
          return candidate.resolved.assetKey === lookup.assetKey ||
            isCompatibleMeasuredAsset(lookup.spec, { ...candidate, resolved: { ...candidate.resolved, geometry } });
        });
        const cached = cachedIndex >= 0 ? possible[cachedIndex] : undefined;
        const geometry = cachedIndex >= 0 ? measured[cachedIndex] : undefined;
        if (!cached || !geometry) {
          missing.push(lookup);
          return;
        }

        const projectKey = `${relativeRoot}/assets/reused/revision-${padRevision(revision)}/${lookup.spec.id}.glb`;
        const projectArtifact = await this.artifacts.copyFile(projectKey, cached.resolved.path);
        const libraryResolved: ResolvedAsset = {
          ...cached.resolved,
          assetKey: lookup.assetKey,
          specId: lookup.spec.id,
          reused: true,
          geometry,
        };
        results.set(lookup.spec.id, {
          ...libraryResolved,
          path: projectArtifact.path,
          url: projectArtifact.url,
        });
        recordsToStore.push({ spec: lookup.spec, resolved: libraryResolved, createdAt: new Date().toISOString() });
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
          outputPath: this.artifacts.absolutePath(
            `${relativeRoot}/assets/generated/revision-${padRevision(revision)}/${spec.id}.glb`,
          ),
        })),
      );
      if (outputs.length !== missing.length) {
        throw new Error(`Blender returned ${outputs.length} assets for ${missing.length} requests`);
      }
      await Promise.all(
        missing.map(async ({ spec, assetKey }, index) => {
          const output = outputs[index];
          if (!output) throw new Error(`Blender returned no output for ${spec.id}`);
          const generatedKey = `${relativeRoot}/assets/generated/revision-${padRevision(revision)}/${spec.id}.glb`;
          const projectArtifact = await artifactFromExisting(output.path, generatedKey, this.artifacts);
          const geometry = await measureGlbGeometry(projectArtifact.path);
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
            geometry,
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

async function inspectCachedGlb(asset: ResolvedAsset): Promise<AssetGeometry | null> {
  try {
    const buffer = await fs.readFile(asset.path);
    if (buffer.length <= 20 || sha256(buffer) !== asset.sha256) return null;
    return measureGlbBuffer(buffer);
  } catch {
    return null;
  }
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

function isMetadataCompatible(
  requested: ScenePlan["assets"][number],
  candidate: ScenePlan["assets"][number],
): boolean {
  if (requested.category.toLowerCase() !== candidate.category.toLowerCase()) return false;
  if (requested.style.toLowerCase() !== candidate.style.toLowerCase()) return false;
  const candidateTags = new Set(candidate.tags.map((tag) => tag.toLowerCase()));
  const overlap = requested.tags.filter((tag) => candidateTags.has(tag.toLowerCase())).length;
  return overlap >= Math.min(2, requested.tags.length);
}

function isCompatibleMeasuredAsset(requested: ScenePlan["assets"][number], candidate: AssetRecord): boolean {
  if (!candidate.resolved.geometry || !isMetadataCompatible(requested, candidate.spec)) return false;
  const expected = recipeBounds(requested);
  const expectedSize = boundsSize(expected);
  const actual = candidate.resolved.geometry.bounds;
  const actualSize = candidate.resolved.geometry.size;
  return expectedSize.every((dimension, axis) => {
    const other = actualSize[axis] ?? 0;
    if (dimension <= 0.0001 || other <= 0.0001) return Math.abs(dimension - other) <= 0.01;
    const ratio = other / dimension;
    const anchorTolerance = Math.max(0.05, dimension * 0.2);
    return ratio >= 0.8 && ratio <= 1.25 &&
      Math.abs(actual.min[axis]! - expected.min[axis]!) <= anchorTolerance &&
      Math.abs(actual.max[axis]! - expected.max[axis]!) <= anchorTolerance;
  });
}

export function isCompatibleAssetForGenerator(
  requested: ScenePlan["assets"][number],
  candidate: AssetRecord,
  generatorIdentity: string,
): boolean {
  return candidate.resolved.generator === generatorIdentity && isCompatibleMeasuredAsset(requested, candidate);
}
