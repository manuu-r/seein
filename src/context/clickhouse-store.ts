import { createClient, type ClickHouseClient } from "@clickhouse/client";
import {
  InspectionSchema,
  ProjectRecordSchema,
  QualitySupervisorStateSchema,
  ResearchBriefSchema,
  ReusableProceduralComponentSchema,
  ResolvedAssetSchema,
  RunEventSchema,
  SceneManifestSchema,
  AssetSpecSchema,
  SpatialReportSchema,
  type AssetSpec,
  type Inspection,
  type ProjectRecord,
  type QualitySupervisorState,
  type ResearchBrief,
  type ReusableProceduralComponent,
  type RunEvent,
  type SceneManifest,
  type SpatialReport,
} from "../contracts.js";
import { hashObject } from "../lib/hash.js";
import {
  UserPreferenceProfileSchema,
  WorkflowGraphStateSchema,
  type UserPreferenceProfile,
  type WorkflowGraphState,
} from "../workflow/graph-contracts.js";
import type { Config } from "../config.js";
import type {
  AssetCandidates,
  AssetLookupRequest,
  AssetRecord,
  ContextStore,
} from "./context-store.js";

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
      `CREATE TABLE IF NOT EXISTS assets (
        asset_key String,
        asset_id String,
        spec_id String,
        category LowCardinality(String),
        description String,
        tags Array(String),
        style LowCardinality(String),
        dimensions Array(Float32),
        generator LowCardinality(String),
        sha256 String,
        path String,
        bounds_min Array(Float32),
        bounds_max Array(Float32),
        geometry_size Array(Float32),
        geometry_source LowCardinality(String),
        spec String,
        resolved String,
        created_at DateTime64(3, 'UTC')
      ) ENGINE = ReplacingMergeTree(created_at) ORDER BY asset_key`,
      `CREATE TABLE IF NOT EXISTS scene_revisions (
        project_id String,
        revision UInt16,
        manifest String,
        sha256 FixedString(64),
        path String,
        created_at DateTime64(3, 'UTC')
      ) ENGINE = MergeTree ORDER BY (project_id, revision)`,
      `CREATE TABLE IF NOT EXISTS scene_objects (
        project_id String,
        revision UInt16,
        object_id String,
        asset_id String,
        label String,
        position Array(Float32),
        rotation Array(Float32),
        scale Array(Float32),
        created_at DateTime64(3, 'UTC')
      ) ENGINE = MergeTree ORDER BY (project_id, revision, object_id)`,
      `CREATE TABLE IF NOT EXISTS object_relationships (
        project_id String,
        revision UInt16,
        source_object_id String,
        target_object_id String,
        relationship LowCardinality(String),
        description String,
        created_at DateTime64(3, 'UTC')
      ) ENGINE = MergeTree ORDER BY (project_id, revision, source_object_id, target_object_id)`,
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
      `CREATE TABLE IF NOT EXISTS spatial_object_facts (
        project_id String,
        revision UInt16,
        analyzer LowCardinality(String),
        object_id String,
        asset_id String,
        asset_sha256 FixedString(64),
        geometry_source LowCardinality(String),
        local_bounds_min Array(Float32),
        local_bounds_max Array(Float32),
        bounds_min Array(Float32),
        bounds_max Array(Float32),
        floor_clearance Float32,
        camera_depth Float32,
        projected_coverage Float32,
        in_frame Bool,
        created_at DateTime64(3, 'UTC')
      ) ENGINE = ReplacingMergeTree(created_at) ORDER BY (project_id, revision, analyzer, object_id)`,
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
      `CREATE TABLE IF NOT EXISTS procedural_components (
        component_key FixedString(64),
        project_id String,
        revision UInt16,
        node_id String,
        study_id String,
        name String,
        kind LowCardinality(String),
        layer LowCardinality(String),
        material_id String,
        tags Array(String),
        depends_on Array(String),
        payload String,
        created_at DateTime64(3, 'UTC')
      ) ENGINE = ReplacingMergeTree(created_at) ORDER BY (component_key, project_id, revision)`,
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
      `ALTER TABLE assets ADD COLUMN IF NOT EXISTS style LowCardinality(String) AFTER tags`,
      `ALTER TABLE assets ADD COLUMN IF NOT EXISTS dimensions Array(Float32) AFTER style`,
      `ALTER TABLE assets ADD COLUMN IF NOT EXISTS generator LowCardinality(String) AFTER dimensions`,
      `ALTER TABLE assets ADD COLUMN IF NOT EXISTS sha256 String AFTER generator`,
      `ALTER TABLE assets ADD COLUMN IF NOT EXISTS path String AFTER sha256`,
      `ALTER TABLE assets ADD COLUMN IF NOT EXISTS bounds_min Array(Float32) AFTER path`,
      `ALTER TABLE assets ADD COLUMN IF NOT EXISTS bounds_max Array(Float32) AFTER bounds_min`,
      `ALTER TABLE assets ADD COLUMN IF NOT EXISTS geometry_size Array(Float32) AFTER bounds_max`,
      `ALTER TABLE assets ADD COLUMN IF NOT EXISTS geometry_source LowCardinality(String) AFTER geometry_size`,
      `ALTER TABLE spatial_object_facts ADD COLUMN IF NOT EXISTS asset_id String AFTER object_id`,
      `ALTER TABLE spatial_object_facts ADD COLUMN IF NOT EXISTS asset_sha256 FixedString(64) AFTER asset_id`,
      `ALTER TABLE spatial_object_facts ADD COLUMN IF NOT EXISTS geometry_source LowCardinality(String) AFTER asset_sha256`,
      `ALTER TABLE spatial_object_facts ADD COLUMN IF NOT EXISTS local_bounds_min Array(Float32) AFTER geometry_source`,
      `ALTER TABLE spatial_object_facts ADD COLUMN IF NOT EXISTS local_bounds_max Array(Float32) AFTER local_bounds_min`,
      `ALTER TABLE qa_target_results ADD COLUMN IF NOT EXISTS recognizability Float32 AFTER patch_kind`,
      `ALTER TABLE qa_target_results ADD COLUMN IF NOT EXISTS domain_fidelity Float32 AFTER recognizability`,
      `ALTER TABLE qa_target_results ADD COLUMN IF NOT EXISTS visual_quality Float32 AFTER domain_fidelity`,
      `ALTER TABLE qa_target_results ADD COLUMN IF NOT EXISTS construction_completeness Float32 AFTER visual_quality`,
      `ALTER TABLE qa_target_results ADD COLUMN IF NOT EXISTS confidence Float32 AFTER construction_completeness`,
      `ALTER TABLE qa_target_results ADD COLUMN IF NOT EXISTS recommended_action LowCardinality(String) AFTER confidence`,
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

  async findProceduralComponents(queryTerms: string[], limit = 12): Promise<ReusableProceduralComponent[]> {
    const terms = [...new Set(queryTerms.flatMap(tokenize))];
    if (terms.length === 0) return [];
    const rows = await this.query(
      // tags has to be aggregated like payload: the row set is deduplicated by
      // component_key, so the score must come from the same latest version.
      `SELECT argMax(payload, created_at) AS payload,
              length(arrayIntersect(argMax(tags, created_at), {terms:Array(String)})) AS score,
              max(created_at) AS newest
       FROM procedural_components
       WHERE hasAny(tags, {terms:Array(String)})
       GROUP BY component_key
       ORDER BY score DESC, newest DESC
       LIMIT {limit:UInt16}`,
      { terms, limit },
    );
    return rows.flatMap((row) => {
      if (typeof row.payload !== "string") return [];
      const parsed = ReusableProceduralComponentSchema.safeParse(JSON.parse(row.payload));
      return parsed.success ? [parsed.data] : [];
    });
  }

  async findAssets(requests: AssetLookupRequest[], relatedLimit = 5): Promise<Map<string, AssetCandidates>> {
    const result = new Map<string, AssetCandidates>();
    if (requests.length === 0) return result;
    const keys = requests.map((request) => request.assetKey);
    const categories = [...new Set(requests.map((request) => request.spec.category.toLowerCase()))];
    const tags = [...new Set(requests.flatMap((request) => request.spec.tags.map((tag) => tag.toLowerCase())))];
    const select = `SELECT asset_key, argMax(spec, created_at) AS spec,
                            argMax(resolved, created_at) AS resolved,
                            max(created_at) AS latest_at
                     FROM assets`;
    const [exactRows, relatedRows] = await Promise.all([
      this.query(`${select} WHERE asset_key IN {keys:Array(String)} GROUP BY asset_key`, { keys }),
      this.query(
        `${select}
         WHERE category IN {categories:Array(String)} OR hasAny(tags, {tags:Array(String)})
         GROUP BY asset_key
         ORDER BY latest_at DESC
         LIMIT {limit:UInt32}`,
        { categories, tags, limit: Math.max(relatedLimit * requests.length * 4, 32) },
      ),
    ]);
    const exact = new Map(
      exactRows
        .map((row) => [String(row.asset_key), parseAssetRow(row)] as const)
        .filter((entry): entry is readonly [string, AssetRecord] => entry[1] !== null),
    );
    const pool = relatedRows.map(parseAssetRow).filter((row): row is AssetRecord => row !== null);
    for (const request of requests) {
      const related = pool
        .map((record) => ({ record, score: assetScore(request.spec, record.spec) }))
        .filter(({ score }) => score > 0)
        .sort((left, right) => right.score - left.score)
        .slice(0, relatedLimit)
        .map(({ record }) => record);
      result.set(request.assetKey, { exact: exact.get(request.assetKey) ?? null, related });
    }
    return result;
  }

  async storeAssets(records: AssetRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.insert(
      "assets",
      records.map((record) => ({
        asset_key: record.resolved.assetKey,
        asset_id: record.resolved.assetId,
        spec_id: record.resolved.specId,
        category: record.spec.category.toLowerCase(),
        description: record.spec.description,
        tags: record.spec.tags.map((tag) => tag.toLowerCase()),
        style: record.spec.style.toLowerCase(),
        dimensions: record.spec.dimensions,
        generator: record.resolved.generator,
        sha256: record.resolved.sha256,
        path: record.resolved.path,
        bounds_min: record.resolved.geometry?.bounds.min ?? [],
        bounds_max: record.resolved.geometry?.bounds.max ?? [],
        geometry_size: record.resolved.geometry?.size ?? [],
        geometry_source: record.resolved.geometry?.source ?? "",
        spec: JSON.stringify(record.spec),
        resolved: JSON.stringify(record.resolved),
        created_at: clickhouseNow(),
      })),
    );
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
    const proceduralComponents: ReusableProceduralComponent[] = [];
    if (manifest.procedural) {
      const materials = new Map(manifest.procedural.materials.map((material) => [material.id, material]));
      const landmarks = new Map(manifest.procedural.landmarks.map((landmark) => [landmark.id, landmark]));
      for (const node of manifest.procedural.nodes) {
        const material = materials.get(node.materialId);
        if (!material) continue;
        const usedLandmarks = node.kind === "tube"
          ? node.points.flatMap((point) => point.landmarkId && landmarks.has(point.landmarkId) ? [landmarks.get(point.landmarkId)!] : [])
          : [];
        proceduralComponents.push({
          componentKey: hashObject({ node, material, landmarks: usedLandmarks }),
          node,
          material,
          landmarks: usedLandmarks,
          sourceProjectId: projectId,
          sourceRevision: manifest.revision,
          createdAt: manifest.generatedAt,
        });
      }
    }
    await Promise.all([
      this.insert("scene_revisions", [
        {
          project_id: projectId,
          revision: manifest.revision,
          manifest: JSON.stringify(manifest),
          sha256,
          path,
          created_at: clickhouseNow(),
        },
      ]),
      manifest.objects.length > 0 ? this.insert(
        "scene_objects",
        manifest.objects.map((object) => ({
          project_id: projectId,
          revision: manifest.revision,
          object_id: object.id,
          asset_id: object.assetId,
          label: object.label,
          position: object.position,
          rotation: object.rotation,
          scale: object.scale,
          created_at: clickhouseNow(),
        })),
      ) : Promise.resolve(),
      manifest.relationships.length > 0 ? this.insert(
        "object_relationships",
        manifest.relationships.map((relationship) => ({
          project_id: projectId,
          revision: manifest.revision,
          source_object_id: relationship.from,
          target_object_id: relationship.to,
          relationship: relationship.type,
          description: relationship.description,
          created_at: clickhouseNow(),
        })),
      ) : Promise.resolve(),
      proceduralComponents.length > 0 ? this.insert(
        "procedural_components",
        proceduralComponents.map((component) => ({
          component_key: component.componentKey,
          project_id: projectId,
          revision: manifest.revision,
          node_id: component.node.id,
          study_id: component.node.studyId,
          name: component.node.name,
          kind: component.node.kind,
          layer: component.node.layer,
          material_id: component.node.materialId,
          tags: tokenize(`${component.node.studyId} ${component.node.name} ${component.node.tags.join(" ")}`),
          depends_on: component.node.dependsOn,
          payload: JSON.stringify(component),
          created_at: clickhouseNow(),
        })),
      ) : Promise.resolve(),
      manifest.states.length > 0 ? this.insert(
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
      ) : Promise.resolve(),
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
      this.insert("spatial_reports", [
        {
          project_id: projectId,
          revision,
          analyzer: parsed.analyzer,
          issue_count: parsed.issues.length,
          payload: JSON.stringify(parsed),
          created_at: clickhouseNow(),
        },
      ]),
      parsed.objects.length > 0 ? this.insert(
        "spatial_object_facts",
        parsed.objects.map((object) => ({
          project_id: projectId,
          revision,
          analyzer: parsed.analyzer,
          object_id: object.objectId,
          asset_id: object.assetId,
          asset_sha256: object.assetSha256,
          geometry_source: object.geometrySource,
          local_bounds_min: object.localBounds.min,
          local_bounds_max: object.localBounds.max,
          bounds_min: object.bounds.min,
          bounds_max: object.bounds.max,
          floor_clearance: object.floorClearance,
          camera_depth: object.cameraDepth,
          projected_coverage: object.projectedCoverage,
          in_frame: object.inFrame,
          created_at: clickhouseNow(),
        })),
      ) : Promise.resolve(),
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

  private async insert(table: string, values: ClickHouseRow[]): Promise<void> {
    await this.client.insert({ table, values, format: "JSONEachRow" });
  }

  private async query(query: string, query_params: Record<string, unknown>): Promise<ClickHouseRow[]> {
    const result = await this.client.query({ query, query_params, format: "JSONEachRow" });
    return (await result.json()) as ClickHouseRow[];
  }
}

function parseAssetRow(row: ClickHouseRow | undefined): AssetRecord | null {
  if (!row || typeof row.spec !== "string" || typeof row.resolved !== "string") return null;
  return {
    spec: AssetSpecSchema.parse(JSON.parse(row.spec)),
    resolved: ResolvedAssetSchema.parse(JSON.parse(row.resolved)),
    createdAt: String(row.latest_at ?? new Date().toISOString()),
  };
}

function clickhouseNow(): string {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}

function tokenize(value: string): string[] {
  return [...new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3))];
}

function assetScore(requested: AssetSpec, candidate: AssetSpec): number {
  const requestedTags = new Set(requested.tags.map((tag) => tag.toLowerCase()));
  const overlap = candidate.tags.filter((tag) => requestedTags.has(tag.toLowerCase())).length;
  return (
    (requested.category.toLowerCase() === candidate.category.toLowerCase() ? 10 : 0) +
    (requested.style.toLowerCase() === candidate.style.toLowerCase() ? 3 : 0) +
    overlap
  );
}
