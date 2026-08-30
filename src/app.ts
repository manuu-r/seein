import type { Config } from "./config.js";
import { GeminiWorkflowAI, type WorkflowAI } from "./ai/workflow-ai.js";
import { ClickHouseContextStore } from "./context/clickhouse-store.js";
import { MemoryContextStore, type ContextStore } from "./context/context-store.js";
import { PlaywrightScreenshotDriver, type ScreenshotDriver } from "./render/screenshot-driver.js";
import { ReferenceCollector } from "./research/reference-collector.js";
import { DisabledReferenceSearch, FirecrawlReferenceSearch, type ReferenceSearchDriver } from "./research/reference-search.js";
import { LocalArtifactStore } from "./storage/artifact-store.js";
import { ProjectManager } from "./storage/project-manager.js";
import { Orchestrator } from "./workflow/orchestrator.js";
import { silentDiagnosticLogger, type DiagnosticLogger } from "./lib/diagnostics.js";

export interface AppServices {
  config: Config;
  context: ContextStore;
  projects: ProjectManager;
  orchestrator: Orchestrator;
}

export interface AppOverrides {
  context?: ContextStore;
  ai?: WorkflowAI;
  screenshots?: ScreenshotDriver;
  references?: ReferenceCollector;
  referenceSearch?: ReferenceSearchDriver;
  logger?: DiagnosticLogger;
}

export async function createAppServices(config: Config, overrides: AppOverrides = {}): Promise<AppServices> {
  assertRuntimeDrivers(config, overrides);
  const artifacts = new LocalArtifactStore(config.DATA_ROOT, config.PUBLIC_BASE_URL);
  const context =
    overrides.context ??
    (config.CONTEXT_DRIVER === "clickhouse" ? new ClickHouseContextStore(config) : new MemoryContextStore());
  const projects = new ProjectManager(config.DATA_ROOT, artifacts, context);
  const ai = overrides.ai ?? new GeminiWorkflowAI(config);
  const screenshots = overrides.screenshots ?? new PlaywrightScreenshotDriver(config);
  const referenceSearch =
    overrides.referenceSearch ??
    (config.REFERENCE_SEARCH_DRIVER === "firecrawl"
      ? new FirecrawlReferenceSearch(config)
      : new DisabledReferenceSearch());
  await context.migrate();
  const orchestrator = new Orchestrator(
    config,
    projects,
    artifacts,
    context,
    ai,
    overrides.references ?? new ReferenceCollector(config),
    referenceSearch,
    screenshots,
    overrides.logger ?? silentDiagnosticLogger,
  );
  if (config.WORKFLOW_AUTO_RESUME_INTERRUPTED) await orchestrator.recoverInterruptedRuns();
  return { config, context, projects, orchestrator };
}

function assertRuntimeDrivers(config: Config, overrides: AppOverrides): void {
  if (config.NODE_ENV === "test") return;
  if (!overrides.ai && !config.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is required: SeeIn has no deterministic scene-planning fallback.");
  }
}
