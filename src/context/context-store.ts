import type {
  Inspection,
  ProjectRecord,
  QualitySupervisorState,
  ResearchBrief,
  RunEvent,
  SceneManifest,
  SpatialReport,
} from "../contracts.js";
import type { UserPreferenceProfile, WorkflowGraphState } from "../workflow/graph-contracts.js";

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
  findQualitySupervisorState(projectId: string): Promise<QualitySupervisorState | null>;
  storeQualitySupervisorState(state: QualitySupervisorState): Promise<void>;
  findGraphState(projectId: string): Promise<WorkflowGraphState | null>;
  storeGraphState(state: WorkflowGraphState): Promise<void>;
  findUserPreferenceProfile(userId: string): Promise<UserPreferenceProfile | null>;
  storeUserPreferenceProfile(profile: UserPreferenceProfile): Promise<void>;
  /**
   * Removes every row belonging to one project. Cross-project reuse (the accepted
   * anatomy library, research/step caches, and user preference profiles) is deliberately
   * left intact: those are not this run's data, they are shared history.
   */
  deleteProject(projectId: string): Promise<void>;
}

export class MemoryContextStore implements ContextStore {
  readonly research = new Map<string, ResearchBrief>();
  readonly cache = new Map<string, unknown>();
  readonly events: RunEvent[] = [];
  readonly projects = new Map<string, ProjectRecord>();
  readonly scenes: Array<{ projectId: string; manifest: SceneManifest }> = [];
  readonly renders: Array<{ projectId: string; revision: number; path: string }> = [];
  readonly reports: Array<{ projectId: string; revision: number; inspection: Inspection }> = [];
  readonly spatial: Array<{ projectId: string; revision: number; report: SpatialReport }> = [];
  readonly qualitySupervisorStates = new Map<string, QualitySupervisorState>();
  readonly graphStates = new Map<string, WorkflowGraphState>();
  readonly userPreferences = new Map<string, UserPreferenceProfile>();

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

  async findQualitySupervisorState(projectId: string): Promise<QualitySupervisorState | null> {
    return structuredClone(this.qualitySupervisorStates.get(projectId) ?? null);
  }

  async storeQualitySupervisorState(state: QualitySupervisorState): Promise<void> {
    this.qualitySupervisorStates.set(state.projectId, structuredClone(state));
  }

  async findGraphState(projectId: string): Promise<WorkflowGraphState | null> {
    return structuredClone(this.graphStates.get(projectId) ?? null);
  }

  async storeGraphState(state: WorkflowGraphState): Promise<void> {
    this.graphStates.set(state.projectId, structuredClone(state));
  }

  async findUserPreferenceProfile(userId: string): Promise<UserPreferenceProfile | null> {
    return structuredClone(this.userPreferences.get(userId) ?? null);
  }

  async storeUserPreferenceProfile(profile: UserPreferenceProfile): Promise<void> {
    this.userPreferences.set(profile.userId, structuredClone(profile));
  }

  async deleteProject(projectId: string): Promise<void> {
    this.projects.delete(projectId);
    this.graphStates.delete(projectId);
    this.qualitySupervisorStates.delete(projectId);
    for (let index = this.scenes.length - 1; index >= 0; index -= 1) {
      if (this.scenes[index]?.projectId === projectId) this.scenes.splice(index, 1);
    }
    for (let index = this.events.length - 1; index >= 0; index -= 1) {
      if (this.events[index]?.projectId === projectId) this.events.splice(index, 1);
    }
  }
}
