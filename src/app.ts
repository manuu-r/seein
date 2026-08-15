import type { Config } from "./config.js";
import { GeminiWorkflowAI, DeterministicWorkflowAI, type WorkflowAI } from "./ai/workflow-ai.js";
import { DeterministicBlenderDriver, QwenMcpBlenderDriver, type BlenderDriver } from "./blender/blender-driver.js";
import { ClickHouseContextStore } from "./context/clickhouse-store.js";
import { MemoryContextStore, type ContextStore } from "./context/context-store.js";
import { PlaceholderScreenshotDriver, PlaywrightScreenshotDriver, type ScreenshotDriver } from "./render/screenshot-driver.js";
import { ReferenceCollector } from "./research/reference-collector.js";
import { LocalArtifactStore } from "./storage/artifact-store.js";
import { ProjectManager } from "./storage/project-manager.js";
import { Orchestrator } from "./workflow/orchestrator.js";

export interface AppServices {
  config: Config;
  context: ContextStore;
  projects: ProjectManager;
  orchestrator: Orchestrator;
}

export interface AppOverrides {
  context?: ContextStore;
  ai?: WorkflowAI;
  blender?: BlenderDriver;
  screenshots?: ScreenshotDriver;
  references?: ReferenceCollector;
}

export async function createAppServices(config: Config, overrides: AppOverrides = {}): Promise<AppServices> {
  const artifacts = new LocalArtifactStore(config.DATA_ROOT, config.PUBLIC_BASE_URL);
  const context =
    overrides.context ??
    (config.CONTEXT_DRIVER === "clickhouse" ? new ClickHouseContextStore(config) : new MemoryContextStore());
  const projects = new ProjectManager(config.DATA_ROOT, artifacts, context);
  const ai =
    overrides.ai ?? (config.AI_DRIVER === "gemini" ? new GeminiWorkflowAI(config) : new DeterministicWorkflowAI());
  const blender =
    overrides.blender ??
    (config.BLENDER_DRIVER === "qwen-mcp" ? new QwenMcpBlenderDriver(config) : new DeterministicBlenderDriver());
  const screenshots =
    overrides.screenshots ??
    (config.SCREENSHOT_DRIVER === "playwright"
      ? new PlaywrightScreenshotDriver(config)
      : new PlaceholderScreenshotDriver());
  await context.migrate();
  const orchestrator = new Orchestrator(
    config,
    projects,
    artifacts,
    context,
    ai,
    overrides.references ?? new ReferenceCollector(config),
    blender,
    screenshots,
  );
  return { config, context, projects, orchestrator };
}
