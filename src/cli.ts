import { createAppServices } from "./app.js";
import { loadConfig } from "./config.js";
import { ClickHouseContextStore } from "./context/clickhouse-store.js";

const [command = "run", ...args] = process.argv.slice(2);

if (command === "migrate") {
  const config = loadConfig();
  const context = new ClickHouseContextStore(config);
  await context.migrate();
  await context.close();
  process.stdout.write("ClickHouse schema is ready.\n");
} else if (command === "run") {
  const prompt = args.join(" ");
  if (!prompt) throw new Error("Usage: npm run generate -- <prompt> or tsx src/cli.ts run <prompt>");
  const services = await createAppServices(loadConfig());
  try {
    const result = await services.orchestrator.run(prompt);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    await services.orchestrator.close();
  }
} else if (command === "checkpoints") {
  const [projectId] = args;
  if (!projectId) throw new Error("Usage: node dist/server/cli.js checkpoints <projectId>");
  const services = await createAppServices(loadConfig());
  try {
    const checkpoints = await services.orchestrator.listCheckpoints(projectId);
    process.stdout.write(`${JSON.stringify(checkpoints, null, 2)}\n`);
  } finally {
    await services.orchestrator.close();
  }
} else if (command === "resume") {
  const [projectId, ...flags] = args;
  if (!projectId) {
    throw new Error("Usage: node dist/server/cli.js resume <projectId> [--fresh] [--at <sequence>]");
  }
  const atIndex = flags.indexOf("--at");
  const sequence = atIndex === -1 ? undefined : Number(flags[atIndex + 1]);
  if (sequence !== undefined && !Number.isInteger(sequence)) {
    throw new Error("--at requires a checkpoint sequence number");
  }
  const services = await createAppServices(loadConfig());
  try {
    const state = await services.orchestrator.resume(projectId, { sequence, fresh: flags.includes("--fresh") });
    await services.orchestrator.getActiveRun(projectId);
    const final = await services.orchestrator.getGraphState(projectId);
    process.stdout.write(`${JSON.stringify({
      projectId,
      rewoundTo: state.currentNode,
      resumeCount: state.resumeCount,
      node: final?.currentNode,
      status: final?.status,
      error: final?.failureMessage?.split("\n")[0],
    }, null, 2)}\n`);
  } finally {
    await services.orchestrator.close();
  }
} else {
  throw new Error(`Unknown command: ${command}`);
}
