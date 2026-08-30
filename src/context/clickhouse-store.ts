import { createClient, type ClickHouseClient } from "@clickhouse/client";
import {
  InspectionSchema,
  ProjectRecordSchema,
  QualitySupervisorStateSchema,
  ResearchBriefSchema,
  RunEventSchema,
  SceneManifestSchema,
  SpatialReportSchema,
  type Inspection,
  type ProjectRecord,
  type QualitySupervisorState,
  type ResearchBrief,
  type RunEvent,
  type SceneManifest,
  type SpatialReport,
} from "../contracts.js";
import {
  UserPreferenceProfileSchema,
  WorkflowGraphStateSchema,
  type UserPreferenceProfile,
  type WorkflowGraphState,
} from "../workflow/graph-contracts.js";
import type { Config } from "../config.js";
import type { ContextStore } from "./context-store.js";

interface ClickHouseRow {
  [key: string]: unknown;
}

export class ClickHouseContextStore implements ContextStore {
  private readonly client: ClickHouseClient;
  private pendingEvents: RunEvent[] = [];
  private eventTimer: NodeJS.Timeout | null = null;
  private eventFlush: Promise<void> = Promise.resolve();
  private pendingProjects = new Map<string, ProjectRecord>();
  private projectTimer: NodeJS.Timeout | null = null;
  private projectFlush: Promise<void> = Promise.resolve();

  constructor(private readonly config: Config) {
    this.client = createClient({
      url: config.CLICKHOUSE_URL,
      username: config.CLICKHOUSE_USERNAME,
      password: config.CLICKHOUSE_PASSWORD,
      database: config.CLICKHOUSE_DATABASE,
    });
  }

  async migrate(): Promise<void> {
    const statements = [
      `CREATE TABLE IF NOT EXISTS run_events (
        project_id String,
        run_id String,
        sequence UInt32,
        stage LowCardinality(String),
        status LowCardinality(String),
        detail String,
        payload String,
        created_at DateTime64(3, 'UTC')
      ) ENGINE = MergeTree ORDER BY (project_id, run_id, sequence)`,
      `CREATE TABLE IF NOT EXISTS projects (
        project_id String,
        run_id String,
        status LowCardinality(String),
        slug String,
        payload String,
        created_at DateTime64(3, 'UTC'),
        updated_at DateTime64(3, 'UTC')
      ) ENGINE = ReplacingMergeTree(updated_at) ORDER BY project_id`,
      `CREATE TABLE IF NOT EXISTS research_cache (
        cache_key String,
        prompt String,
        payload String,
        created_at DateTime64(3, 'UTC')
      ) ENGINE = ReplacingMergeTree(created_at) ORDER BY cache_key`,
      `CREATE TABLE IF NOT EXISTS workflow_cache (
        cache_key String,
        kind LowCardinality(String),
        payload String,
        created_at DateTime64(3, 'UTC')
      ) ENGINE = ReplacingMergeTree(created_at) ORDER BY (kind, cache_key)`,
      `CREATE TABLE IF NOT EXISTS workflow_graph_states (
        project_id String,
        run_id String,
        user_id String,
        graph_version LowCardinality(String),
        current_node LowCardinality(String),
        status LowCardinality(String),
        waiting_for LowCardinality(String),
        sequence UInt32,
        payload String,
        updated_at DateTime64(3, 'UTC')
      ) ENGINE = ReplacingMergeTree(updated_at) ORDER BY (project_id, sequence)`,
      `CREATE TABLE IF NOT EXISTS user_preference_profiles (
        user_id String,
        preference_count UInt16,
        payload String,
        updated_at DateTime64(3, 'UTC')
      ) ENGINE = ReplacingMergeTree(updated_at) ORDER BY user_id`,
      `CREATE TABLE IF NOT EXISTS scene_revisions (
        project_id String,
        revision UInt16,
        manifest String,
        sha256 FixedString(64),
        path String,
        created_at DateTime64(3, 'UTC')
      ) ENGINE = MergeTree ORDER BY (project_id, revision)`,
      `CREATE TABLE IF NOT EXISTS procedure_states (
        project_id String,
        revision UInt16,
        state_id String,
        label String,
        objective String,
        camera_view_id String,
        visible_objects Array(String),
        visible_nodes Array(String),
        highlighted_objects Array(String),
        highlighted_nodes Array(String),
        payload String,
        created_at DateTime64(3, 'UTC')
      ) ENGINE = ReplacingMergeTree(created_at) ORDER BY (project_id, revision, state_id)`,
      `CREATE TABLE IF NOT EXISTS renders (
        project_id String,
        revision UInt16,
        kind LowCardinality(String),
        path String,
        sha256 FixedString(64),
        created_at DateTime64(3, 'UTC')
      ) ENGINE = MergeTree ORDER BY (project_id, revision, kind)`,
      `CREATE TABLE IF NOT EXISTS qa_reports (
        project_id String,
        revision UInt16,
        payload String,
        created_at DateTime64(3, 'UTC')
      ) ENGINE = MergeTree ORDER BY (project_id, revision)`,
      `CREATE TABLE IF NOT EXISTS spatial_reports (
        project_id String,
        revision UInt16,
        analyzer LowCardinality(String),
        issue_count UInt16,
        payload String,
        created_at DateTime64(3, 'UTC')
      ) ENGINE = ReplacingMergeTree(created_at) ORDER BY (project_id, revision, analyzer)`,
      `CREATE TABLE IF NOT EXISTS spatial_issues (
        project_id String,
        revision UInt16,
        analyzer LowCardinality(String),
        issue_index UInt16,
        category LowCardinality(String),
        severity LowCardinality(String),
        object_ids Array(String),
        evidence String,
        created_at DateTime64(3, 'UTC')
      ) ENGINE = ReplacingMergeTree(created_at) ORDER BY (project_id, revision, analyzer, issue_index)`,
      `CREATE TABLE IF NOT EXISTS qa_target_results (
        project_id String,
        revision UInt16,
        target_id String,
        state_id String,
        view_id String,
        verdict LowCardinality(String),
        category LowCardinality(String),
        patch_kind LowCardinality(String),
        recognizability Float32,
        domain_fidelity Float32,
        visual_quality Float32,
        construction_completeness Float32,
        confidence Float32,
        recommended_action LowCardinality(String),
        issue String,
        payload String,
        created_at DateTime64(3, 'UTC')
      ) ENGINE = ReplacingMergeTree(created_at) ORDER BY (project_id, revision, target_id)`,
      `CREATE TABLE IF NOT EXISTS quality_supervisor_states (
        project_id String,
        attempt UInt16,
        status LowCardinality(String),
        revision UInt16,
        target_id String,
        recognizability Float32,
        domain_fidelity Float32,
        visual_quality Float32,
        construction_completeness Float32,
        logical_ai_calls UInt16,
        payload String,
        updated_at DateTime64(3, 'UTC')
      ) ENGINE = ReplacingMergeTree(updated_at) ORDER BY (project_id, attempt)`,
      `ALTER TABLE run_events ADD COLUMN IF NOT EXISTS payload String AFTER detail`,
    ];
    for (const query of statements) await this.client.command({ query });
  }


  async close(): Promise<void> {
    if (this.eventTimer) clearTimeout(this.eventTimer);
    if (this.projectTimer) clearTimeout(this.projectTimer);
    this.eventTimer = null;
    this.projectTimer = null;
    await Promise.all([this.flushEvents(), this.flushProjects()]);
    await Promise.all([this.eventFlush, this.projectFlush]);
    await this.client.close();
  }

  async appendEvent(event: RunEvent): Promise<void> {
    this.pendingEvents.push(event);
    if (this.pendingEvents.length >= 32) {
      await this.flushEvents();
      return;
    }
    if (!this.eventTimer) {
      this.eventTimer = setTimeout(() => {
        this.eventTimer = null;
        void this.flushEvents().catch(() => undefined);
      }, 75);
      this.eventTimer.unref();
    }
  }

  async listEvents(projectId: string): Promise<RunEvent[]> {
    await this.flushEvents();
    const rows = await this.query(
      `SELECT payload FROM run_events
       WHERE project_id = {projectId:String} AND payload != ''
       ORDER BY run_id, sequence`,
      { projectId },
    );
    return rows
      .map((row) => (typeof row.payload === "string" ? RunEventSchema.parse(JSON.parse(row.payload)) : null))
      .filter((event): event is RunEvent => event !== null);
  }

  async findProject(projectId: string): Promise<ProjectRecord | null> {
    await this.flushProjects();
    const rows = await this.query(
      `SELECT argMax(payload, updated_at) AS payload
       FROM projects WHERE project_id = {projectId:String} GROUP BY project_id`,
      { projectId },
    );
    const payload = rows[0]?.payload;
    return typeof payload === "string" ? ProjectRecordSchema.parse(JSON.parse(payload)) : null;
  }

  async listProjects(limit = 100): Promise<ProjectRecord[]> {
    await this.flushProjects();
    const rows = await this.query(
      `SELECT argMax(payload, updated_at) AS payload, max(updated_at) AS latest_at
       FROM projects GROUP BY project_id ORDER BY latest_at DESC LIMIT {limit:UInt32}`,
      { limit },
    );
    return rows
      .map((row) => (typeof row.payload === "string" ? ProjectRecordSchema.parse(JSON.parse(row.payload)) : null))
      .filter((project): project is ProjectRecord => project !== null);
  }

  async storeProjects(records: ProjectRecord[]): Promise<void> {
    if (records.length === 0) return;
    for (const record of records) this.pendingProjects.set(record.projectId, record);
    if (this.pendingProjects.size >= 32) {
      await this.flushProjects();
      return;
    }
    if (!this.projectTimer) {
      this.projectTimer = setTimeout(() => {
        this.projectTimer = null;
        void this.flushProjects().catch(() => undefined);
      }, 75);
      this.projectTimer.unref();
    }
  }

  async findResearch(key: string): Promise<ResearchBrief | null> {
    const rows = await this.query(
      `SELECT argMax(payload, created_at) AS payload
       FROM research_cache WHERE cache_key = {key:String} GROUP BY cache_key`,
      { key },
    );
    const payload = rows[0]?.payload;
    return typeof payload === "string" ? ResearchBriefSchema.parse(JSON.parse(payload)) : null;
  }

  async storeResearch(key: string, prompt: string, brief: ResearchBrief): Promise<void> {
    await this.insert("research_cache", [
      { cache_key: key, prompt, payload: JSON.stringify(brief), created_at: clickhouseNow() },
    ]);
  }

  async findCachedStep(key: string): Promise<unknown | null> {
    const rows = await this.query(
      `SELECT argMax(payload, created_at) AS payload
       FROM workflow_cache WHERE cache_key = {key:String} GROUP BY cache_key`,
      { key },
    );
    const payload = rows[0]?.payload;
    return typeof payload === "string" ? JSON.parse(payload) : null;
  }

  async storeCachedStep(key: string, kind: string, payload: unknown): Promise<void> {
    await this.insert("workflow_cache", [
      { cache_key: key, kind, payload: JSON.stringify(payload), created_at: clickhouseNow() },
    ]);
  }


  async findLatestScene(projectId: string): Promise<SceneManifest | null> {
    const rows = await this.query(
      `SELECT argMax(manifest, created_at) AS manifest
       FROM scene_revisions WHERE project_id = {projectId:String}
       GROUP BY revision ORDER BY revision DESC LIMIT 1`,
      { projectId },
    );
    const manifest = rows[0]?.manifest;
    return typeof manifest === "string" ? SceneManifestSchema.parse(JSON.parse(manifest)) : null;
  }

  async storeScene(projectId: string, manifest: SceneManifest, sha256: string, path: string): Promise<void> {
    await Promise.all([
      this.insert("scene_revisions", [{
        project_id: projectId,
        revision: manifest.revision,
        manifest: JSON.stringify(manifest),
        sha256,
        path,
        created_at: clickhouseNow(),
      }]),
      this.insert(
        "procedure_states",
        manifest.states.map((state) => ({
          project_id: projectId,
          revision: manifest.revision,
          state_id: state.id,
          label: state.label,
          objective: state.objective,
          camera_view_id: state.cameraViewId ?? "",
          visible_objects: state.visibleObjects,
          visible_nodes: state.visibleNodes,
          highlighted_objects: state.highlightedObjects,
          highlighted_nodes: state.highlightedNodes,
          payload: JSON.stringify(state),
          created_at: clickhouseNow(),
        })),
      ),
    ]);
  }


  async storeRender(
    projectId: string,
    revision: number,
    path: string,
    sha256: string,
    kind: "initial" | "final",
  ): Promise<void> {
    await this.insert("renders", [
      { project_id: projectId, revision, kind, path, sha256, created_at: clickhouseNow() },
    ]);
  }

  async storeQa(projectId: string, revision: number, inspection: Inspection): Promise<void> {
    const parsed = InspectionSchema.parse(inspection);
    await Promise.all([
      this.insert("qa_reports", [{
        project_id: projectId,
        revision,
        payload: JSON.stringify(parsed),
        created_at: clickhouseNow(),
      }]),
      parsed.targetId ? this.insert("qa_target_results", [{
        project_id: projectId,
        revision,
        target_id: parsed.targetId,
        state_id: parsed.stateId ?? "",
        view_id: parsed.viewId ?? "",
        verdict: parsed.verdict,
        category: parsed.category,
        patch_kind: parsed.patch.kind,
        recognizability: parsed.assessment.recognizabilityScore,
        domain_fidelity: parsed.assessment.domainFidelityScore,
        visual_quality: parsed.assessment.visualQualityScore,
        construction_completeness: parsed.assessment.constructionCompletenessScore,
        confidence: parsed.assessment.confidence,
        recommended_action: parsed.assessment.recommendedAction,
        issue: parsed.issue,
        payload: JSON.stringify(parsed),
        created_at: clickhouseNow(),
      }]) : Promise.resolve(),
    ]);
  }

  async storeSpatial(projectId: string, revision: number, report: SpatialReport): Promise<void> {
    const parsed = SpatialReportSchema.parse(report);
    await Promise.all([
      this.insert("spatial_reports", [{
        project_id: projectId,
        revision,
        analyzer: parsed.analyzer,
        issue_count: parsed.issues.length,
        payload: JSON.stringify(parsed),
        created_at: clickhouseNow(),
      }]),
      parsed.issues.length > 0 ? this.insert(
        "spatial_issues",
        parsed.issues.map((issue, index) => ({
          project_id: projectId,
          revision,
          analyzer: parsed.analyzer,
          issue_index: index,
          category: issue.category,
          severity: issue.severity,
          object_ids: issue.objectIds,
          evidence: issue.evidence,
          created_at: clickhouseNow(),
        })),
      ) : Promise.resolve(),
    ]);
  }


  async findQualitySupervisorState(projectId: string): Promise<QualitySupervisorState | null> {
    const rows = await this.query(
      `SELECT argMax(payload, updated_at) AS payload
       FROM quality_supervisor_states WHERE project_id = {projectId:String} GROUP BY project_id`,
      { projectId },
    );
    const payload = rows[0]?.payload;
    return typeof payload === "string" ? QualitySupervisorStateSchema.parse(JSON.parse(payload)) : null;
  }

  async storeQualitySupervisorState(state: QualitySupervisorState): Promise<void> {
    const parsed = QualitySupervisorStateSchema.parse(state);
    await this.insert("quality_supervisor_states", [{
      project_id: parsed.projectId,
      attempt: parsed.attempt,
      status: parsed.status,
      revision: parsed.currentRevision,
      target_id: parsed.currentTargetId ?? "",
      recognizability: parsed.bestScores.recognizability,
      domain_fidelity: parsed.bestScores.domainFidelity,
      visual_quality: parsed.bestScores.visualQuality,
      construction_completeness: parsed.bestScores.constructionCompleteness,
      logical_ai_calls: parsed.logicalAiCalls,
      payload: JSON.stringify(parsed),
      updated_at: parsed.updatedAt.replace("T", " ").replace("Z", ""),
    }]);
  }

  async findGraphState(projectId: string): Promise<WorkflowGraphState | null> {
    const rows = await this.query(
      `SELECT argMax(payload, updated_at) AS payload
       FROM workflow_graph_states WHERE project_id = {projectId:String} GROUP BY project_id`,
      { projectId },
    );
    const payload = rows[0]?.payload;
    return typeof payload === "string" ? WorkflowGraphStateSchema.parse(JSON.parse(payload)) : null;
  }

  async storeGraphState(state: WorkflowGraphState): Promise<void> {
    const parsed = WorkflowGraphStateSchema.parse(state);
    await this.insert("workflow_graph_states", [{
      project_id: parsed.projectId,
      run_id: parsed.runId,
      user_id: parsed.userId,
      graph_version: parsed.graphVersion,
      current_node: parsed.currentNode,
      status: parsed.status,
      waiting_for: parsed.waitingFor ?? "",
      sequence: parsed.sequence,
      payload: JSON.stringify(parsed),
      updated_at: parsed.updatedAt.replace("T", " ").replace("Z", ""),
    }]);
  }

  async findUserPreferenceProfile(userId: string): Promise<UserPreferenceProfile | null> {
    const rows = await this.query(
      `SELECT argMax(payload, updated_at) AS payload
       FROM user_preference_profiles WHERE user_id = {userId:String} GROUP BY user_id`,
      { userId },
    );
    const payload = rows[0]?.payload;
    return typeof payload === "string" ? UserPreferenceProfileSchema.parse(JSON.parse(payload)) : null;
  }

  async storeUserPreferenceProfile(profile: UserPreferenceProfile): Promise<void> {
    const parsed = UserPreferenceProfileSchema.parse(profile);
    await this.insert("user_preference_profiles", [{
      user_id: parsed.userId,
      preference_count: parsed.preferences.length,
      payload: JSON.stringify(parsed),
      updated_at: parsed.updatedAt.replace("T", " ").replace("Z", ""),
    }]);
  }

  private async flushEvents(): Promise<void> {
    if (this.eventTimer) clearTimeout(this.eventTimer);
    this.eventTimer = null;
    const events = this.pendingEvents.splice(0);
    if (events.length === 0) return this.eventFlush;
    this.eventFlush = this.eventFlush.then(() =>
      this.insert(
        "run_events",
        events.map((event) => ({
          project_id: event.projectId,
          run_id: event.runId,
          sequence: event.sequence,
          stage: event.stage,
          status: event.status,
          detail: JSON.stringify(event.detail),
          payload: JSON.stringify(event),
          created_at: event.createdAt.replace("T", " ").replace("Z", ""),
        })),
      ),
    );
    return this.eventFlush;
  }

  private async flushProjects(): Promise<void> {
    if (this.projectTimer) clearTimeout(this.projectTimer);
    this.projectTimer = null;
    const projects = [...this.pendingProjects.values()];
    this.pendingProjects.clear();
    if (projects.length === 0) return this.projectFlush;
    this.projectFlush = this.projectFlush.then(() =>
      this.insert(
        "projects",
        projects.map((record) => ({
          project_id: record.projectId,
          run_id: record.runId,
          status: record.status,
          slug: record.slug,
          payload: JSON.stringify(record),
          created_at: record.createdAt.replace("T", " ").replace("Z", ""),
          updated_at: record.updatedAt.replace("T", " ").replace("Z", ""),
        })),
      ),
    );
    return this.projectFlush;
  }

  async deleteProject(projectId: string): Promise<void> {
    // Only project-scoped tables. research_cache, workflow_cache and
    // user_preference_profiles are shared reuse history, not this run's data.
    const tables = [
      "run_events",
      "projects",
      "workflow_graph_states",
      "scene_revisions",
      "renders",
      "qa_reports",
      "spatial_reports",
      "spatial_issues",
      "procedure_states",
      "qa_target_results",
      "quality_supervisor_states",
    ];
    // Events and project records are written in batches; drain them first so a
    // queued row cannot land after the delete and resurrect the run.
    await Promise.all([this.flushEvents(), this.flushProjects()]);
    for (const table of tables) {
      await this.client.command({
        query: `DELETE FROM ${table} WHERE project_id = {projectId:String}`,
        query_params: { projectId },
      });
    }
  }

  private async insert(table: string, values: ClickHouseRow[]): Promise<void> {
    await this.client.insert({ table, values, format: "JSONEachRow" });
  }

  private async query(query: string, query_params: Record<string, unknown>): Promise<ClickHouseRow[]> {
    const result = await this.client.query({ query, query_params, format: "JSONEachRow" });
    return (await result.json()) as ClickHouseRow[];
  }
}


function clickhouseNow(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}
