import path from "node:path";
import { z } from "zod";

const BooleanString = z
  .enum(["true", "false"])
  .default("true")
  .transform((value) => value === "true");

const AutoResumeString = z
  .enum(["true", "false"])
  .default("true")
  .transform((value) => value === "true");

const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(8787),
  PUBLIC_BASE_URL: z.url().default("http://localhost:8787"),
  DATA_ROOT: z.string().default("./data"),
  AI_DRIVER: z.enum(["gemini", "deterministic"]).default("gemini"),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_RESEARCH_MODEL: z.string().default("gemini-3.7-flash"),
  GEMINI_REFERENCE_MODEL: z.string().default("gemini-3.1-flash-image"),
  GEMINI_PLANNER_MODEL: z.string().default("gemini-3.7-flash"),
  GEMINI_INSPECTOR_MODEL: z.string().default("gemini-3.7-flash"),
  CONTEXT_DRIVER: z.enum(["clickhouse", "memory"]).default("clickhouse"),
  CLICKHOUSE_URL: z.url().default("http://localhost:8123"),
  CLICKHOUSE_DATABASE: z.string().default("seein"),
  CLICKHOUSE_USERNAME: z.string().default("default"),
  CLICKHOUSE_PASSWORD: z.string().default(""),
  BLENDER_DRIVER: z.enum(["qwen-mcp", "deterministic"]).default("qwen-mcp"),
  QWEN_MCP_COMMAND: z.string().default("qwen-mm-plugins-blender"),
  QWEN_MCP_ARGS: z.string().default(""),
  QWEN_MM_AUTOLAUNCH: z.string().default("1"),
  BLENDER_HOST: z.string().default("127.0.0.1"),
  BLENDER_PORT: z.coerce.number().int().positive().default(9876),
  SCREENSHOT_DRIVER: z.enum(["playwright", "placeholder"]).default("playwright"),
  PLAYWRIGHT_HEADLESS: BooleanString,
  PLAYWRIGHT_EXECUTABLE_PATH: z.string().default(""),
  // firecrawl | gemini | none. Gemini's image-search grounding returns no chunks
  // upstream, so per-object reference images come from a dedicated search driver.
  REFERENCE_SEARCH_DRIVER: z.enum(["firecrawl", "gemini", "none"]).default("firecrawl"),
  FIRECRAWL_API_KEY: z.string().optional(),
  FIRECRAWL_SEARCH_URL: z.url().default("https://api.firecrawl.dev/v2/search"),
  // Reference images retrieved per object study, and how many of those are sent to
  // the planner. The planner bound is lower because every image costs input tokens.
  REFERENCE_IMAGES_PER_OBJECT: z.coerce.number().int().min(1).max(6).default(3),
  PLANNER_REFERENCE_IMAGES_PER_OBJECT: z.coerce.number().int().min(0).max(4).default(2),
  REFERENCE_IMAGE_MIN_EDGE: z.coerce.number().int().min(0).max(4096).default(400),
  REFERENCE_MAX_COUNT: z.coerce.number().int().min(0).max(64).default(48),
  REFERENCE_MAX_BYTES: z.coerce.number().int().min(1024).default(8_000_000),
  WORKFLOW_MAX_OBJECTS: z.coerce.number().int().min(1).max(12).default(8),
  // Long-running autonomous quality supervision is constrained by both wall time
  // and action/API budgets. Passing state/view targets do not consume actions.
  WORKFLOW_MAX_ITERATIONS: z.coerce.number().int().min(1).max(128).default(64),
  // A normal local run should finish quickly. Longer unattended sessions are an
  // explicit run-policy choice (for example 240 minutes), not the default.
  WORKFLOW_MAX_RUNTIME_MINUTES: z.coerce.number().int().min(1).max(360).default(30),
  WORKFLOW_MAX_LOGICAL_AI_CALLS: z.coerce.number().int().min(4).max(1000).default(240),
  WORKFLOW_MAX_TARGETED_RESEARCH_ROUNDS: z.coerce.number().int().min(0).max(24).default(8),
  WORKFLOW_STALL_WINDOW: z.coerce.number().int().min(2).max(12).default(3),
  WORKFLOW_MIN_QUALITY_DELTA: z.coerce.number().min(0).max(0.25).default(0.015),
  WORKFLOW_MIN_RECOGNIZABILITY: z.coerce.number().min(0).max(1).default(0.82),
  WORKFLOW_MIN_DOMAIN_FIDELITY: z.coerce.number().min(0).max(1).default(0.78),
  WORKFLOW_MIN_VISUAL_QUALITY: z.coerce.number().min(0).max(1).default(0.72),
  WORKFLOW_MIN_CONSTRUCTION_COMPLETENESS: z.coerce.number().min(0).max(1).default(0.9),
  WORKFLOW_PROVIDER_RETRIES: z.coerce.number().int().min(1).max(8).default(4),
  WORKFLOW_RETRY_BASE_MS: z.coerce.number().int().min(0).max(30_000).default(1000),
  WORKFLOW_AUTO_RESUME_INTERRUPTED: AutoResumeString,
  WORKFLOW_MAX_QA_TARGETS: z.coerce.number().int().min(1).max(48).default(24),
  WORKFLOW_MAX_RESEARCH_ROUNDS: z.coerce.number().int().min(1).max(3).default(2),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(overrides: NodeJS.ProcessEnv = process.env) {
  const config = ConfigSchema.parse(overrides);
  return {
    ...config,
    DATA_ROOT: path.resolve(config.DATA_ROOT),
    GEMINI_API_KEY: config.GEMINI_API_KEY ?? "",
    FIRECRAWL_API_KEY: config.FIRECRAWL_API_KEY ?? "",
  };
}
