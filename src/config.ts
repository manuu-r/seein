import path from "node:path";
import { z } from "zod";

const BooleanString = z
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
  GEMINI_RESEARCH_MODEL: z.string().default("gemini-3.1-flash-image"),
  GEMINI_PLANNER_MODEL: z.string().default("gemini-3.6-flash"),
  GEMINI_INSPECTOR_MODEL: z.string().default("gemini-3.6-flash"),
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
  REFERENCE_MAX_COUNT: z.coerce.number().int().min(0).max(8).default(5),
  REFERENCE_MAX_BYTES: z.coerce.number().int().min(1024).default(8_000_000),
  WORKFLOW_MAX_OBJECTS: z.coerce.number().int().min(1).max(12).default(8),
  WORKFLOW_MAX_ITERATIONS: z.coerce.number().int().min(1).max(4).default(2),
  WORKFLOW_MAX_RESEARCH_ROUNDS: z.coerce.number().int().min(1).max(3).default(2),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(overrides: NodeJS.ProcessEnv = process.env) {
  const config = ConfigSchema.parse(overrides);
  return {
    ...config,
    DATA_ROOT: path.resolve(config.DATA_ROOT),
    GEMINI_API_KEY: config.GEMINI_API_KEY ?? "",
  };
}
