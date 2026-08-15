import type {
  AssetSpec,
  Inspection,
  ProjectRecord,
  ResearchBrief,
  ResolvedAsset,
  RunEvent,
  SceneManifest,
  SpatialReport,
} from "../contracts.js";

export interface AssetRecord {
  spec: AssetSpec;
  resolved: ResolvedAsset;
  createdAt: string;
}

export interface AssetLookupRequest {
  assetKey: string;
  spec: AssetSpec;
}

export interface AssetCandidates {
  exact: AssetRecord | null;
  related: AssetRecord[];
}

export interface ContextStore {
  migrate(): Promise<void>;
  close(): Promise<void>;
  appendEvent(event: RunEvent): Promise<void>;
  listEvents(projectId: string): Promise<RunEvent[]>;
  findProject(projectId: string): Promise<ProjectRecord | null>;
  listProjects(limit?: number): Promise<ProjectRecord[]>;
  storeProjects(records: ProjectRecord[]): Promise<void>;
  findResearch(key: string): Promise<ResearchBrief | null>;
  storeResearch(key: string, prompt: string, brief: ResearchBrief): Promise<void>;
  findCachedStep(key: string): Promise<unknown | null>;
  storeCachedStep(key: string, kind: string, payload: unknown): Promise<void>;
  findAssets(requests: AssetLookupRequest[], relatedLimit?: number): Promise<Map<string, AssetCandidates>>;
  storeAssets(records: AssetRecord[]): Promise<void>;
  findLatestScene(projectId: string): Promise<SceneManifest | null>;
  storeScene(projectId: string, manifest: SceneManifest, sha256: string, path: string): Promise<void>;
  storeRender(
    projectId: string,
    revision: number,
    path: string,
    sha256: string,
    kind: "initial" | "final",
  ): Promise<void>;
  storeQa(projectId: string, revision: number, inspection: Inspection): Promise<void>;
  storeSpatial(projectId: string, revision: number, report: SpatialReport): Promise<void>;
}

export class MemoryContextStore implements ContextStore {
  readonly research = new Map<string, ResearchBrief>();
  readonly cache = new Map<string, unknown>();
  readonly assets = new Map<string, AssetRecord>();
  readonly events: RunEvent[] = [];
  readonly projects = new Map<string, ProjectRecord>();
  readonly scenes: Array<{ projectId: string; manifest: SceneManifest }> = [];
  readonly renders: Array<{ projectId: string; revision: number; path: string }> = [];
  readonly reports: Array<{ projectId: string; revision: number; inspection: Inspection }> = [];
  readonly spatial: Array<{ projectId: string; revision: number; report: SpatialReport }> = [];

  async migrate(): Promise<void> {}
  async close(): Promise<void> {}

  async appendEvent(event: RunEvent): Promise<void> {
    this.events.push(event);
  }

  async listEvents(projectId: string): Promise<RunEvent[]> {
    return this.events.filter((event) => event.projectId === projectId);
  }

  async findProject(projectId: string): Promise<ProjectRecord | null> {
    return this.projects.get(projectId) ?? null;
  }

  async listProjects(limit = 100): Promise<ProjectRecord[]> {
    return [...this.projects.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  async storeProjects(records: ProjectRecord[]): Promise<void> {
    for (const record of records) this.projects.set(record.projectId, structuredClone(record));
  }

  async findResearch(key: string): Promise<ResearchBrief | null> {
    return this.research.get(key) ?? null;
  }

  async storeResearch(key: string, _prompt: string, brief: ResearchBrief): Promise<void> {
    this.research.set(key, brief);
  }

  async findCachedStep(key: string): Promise<unknown | null> {
    return this.cache.get(key) ?? null;
  }

  async storeCachedStep(key: string, _kind: string, payload: unknown): Promise<void> {
    this.cache.set(key, structuredClone(payload));
  }

  async findAssets(requests: AssetLookupRequest[], relatedLimit = 5): Promise<Map<string, AssetCandidates>> {
    const result = new Map<string, AssetCandidates>();
    for (const request of requests) {
      result.set(request.assetKey, {
        exact: this.assets.get(request.assetKey) ?? null,
        related: this.relatedAssets(request.spec, relatedLimit),
      });
    }
    return result;
  }

  private relatedAssets(spec: AssetSpec, limit: number): AssetRecord[] {
    const requestedTags = new Set(spec.tags.map((tag) => tag.toLowerCase()));
    return [...this.assets.values()]
      .map((record) => ({
        record,
        score:
          (record.spec.category.toLowerCase() === spec.category.toLowerCase() ? 10 : 0) +
          record.spec.tags.filter((tag) => requestedTags.has(tag.toLowerCase())).length,
      }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map(({ record }) => record);
  }

  async storeAssets(records: AssetRecord[]): Promise<void> {
    for (const record of records) this.assets.set(record.resolved.assetKey, record);
  }

  async findLatestScene(projectId: string): Promise<SceneManifest | null> {
    return this.scenes
      .filter((scene) => scene.projectId === projectId)
      .sort((left, right) => right.manifest.revision - left.manifest.revision)[0]?.manifest ?? null;
  }

  async storeScene(projectId: string, manifest: SceneManifest): Promise<void> {
    this.scenes.push({ projectId, manifest });
  }

  async storeRender(projectId: string, revision: number, path: string): Promise<void> {
    this.renders.push({ projectId, revision, path });
  }

  async storeQa(projectId: string, revision: number, inspection: Inspection): Promise<void> {
    this.reports.push({ projectId, revision, inspection });
  }

  async storeSpatial(projectId: string, revision: number, report: SpatialReport): Promise<void> {
    this.spatial.push({ projectId, revision, report });
  }
}
