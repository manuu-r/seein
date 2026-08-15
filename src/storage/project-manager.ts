import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ProjectRecordSchema, type ProjectRecord, type WorkflowStage } from "../contracts.js";
import type { ContextStore } from "../context/context-store.js";
import { slugify } from "../lib/strings.js";
import type { ArtifactStore } from "./artifact-store.js";

export class ProjectManager {
  constructor(
    private readonly dataRoot: string,
    private readonly artifacts: ArtifactStore,
    private readonly context: ContextStore,
  ) {}

  async create(prompt: string): Promise<ProjectRecord> {
    const now = new Date().toISOString();
    const projectId = randomUUID();
    const runId = randomUUID();
    const slug = slugify(prompt);
    const relativeRoot = `projects/${slug}-${projectId.slice(0, 8)}`;
    const root = this.artifacts.absolutePath(relativeRoot);
    await fs.mkdir(root, { recursive: true });
    const project: ProjectRecord = {
      projectId,
      runId,
      prompt,
      slug,
      root,
      status: "created",
      createdAt: now,
      updatedAt: now,
    };
    await Promise.all([
      this.artifacts.writeJson(`${relativeRoot}/request.json`, project),
      this.context.storeProjects([project]),
    ]);
    return project;
  }

  async update(project: ProjectRecord, update: Partial<ProjectRecord>): Promise<ProjectRecord> {
    const previous = Date.parse(project.updatedAt);
    const updatedAt = new Date(Math.max(Date.now(), Number.isFinite(previous) ? previous + 1 : 0)).toISOString();
    const next = { ...project, ...update, updatedAt };
    await Promise.all([
      this.artifacts.writeJson(`${this.relativeRoot(project)}/request.json`, next),
      this.context.storeProjects([next]),
    ]);
    return next;
  }

  async load(projectId: string): Promise<ProjectRecord | null> {
    const indexed = await this.context.findProject(projectId);
    if (indexed) return indexed;
    const projectsRoot = path.join(this.dataRoot, "projects");
    let entries: string[];
    try {
      entries = await fs.readdir(projectsRoot);
    } catch {
      return null;
    }
    const directory = entries.find((entry) => entry.endsWith(`-${projectId.slice(0, 8)}`));
    if (!directory) return null;
    const raw = await fs.readFile(path.join(projectsRoot, directory, "request.json"), "utf8");
    const project = ProjectRecordSchema.parse(JSON.parse(raw));
    await this.context.storeProjects([project]);
    return project;
  }

  relativeRoot(project: ProjectRecord): string {
    return path.relative(this.dataRoot, project.root).replaceAll(path.sep, "/");
  }

  async writeEvent(project: ProjectRecord, event: unknown): Promise<void> {
    const file = path.join(project.root, "logs", "events.ndjson");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${JSON.stringify(event)}\n`);
  }

  async list(): Promise<ProjectRecord[]> {
    const indexed = await this.context.listProjects();
    if (indexed.length > 0) return indexed;
    const projectsRoot = path.join(this.dataRoot, "projects");
    let entries: string[];
    try {
      entries = await fs.readdir(projectsRoot);
    } catch {
      return [];
    }
    const records = await Promise.all(
      entries.map(async (entry) => {
        try {
          const raw = await fs.readFile(path.join(projectsRoot, entry, "request.json"), "utf8");
          return ProjectRecordSchema.parse(JSON.parse(raw));
        } catch {
          return null;
        }
      }),
    );
    const sorted = records
      .filter((record): record is ProjectRecord => record !== null)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    await this.context.storeProjects(sorted);
    return sorted;
  }

  async markStage(project: ProjectRecord, status: WorkflowStage): Promise<ProjectRecord> {
    return this.update(project, { status });
  }
}
