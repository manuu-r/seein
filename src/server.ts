import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { createAppServices } from "./app.js";
import { loadConfig } from "./config.js";
import { CreateProjectRequestSchema } from "./contracts.js";

const config = loadConfig();
const services = await createAppServices(config);
const app = Fastify({ logger: true });
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = moduleDirectory.endsWith(path.join("dist", "server"))
  ? path.resolve(moduleDirectory, "../public/viewer")
  : path.resolve(process.cwd(), "dist/public/viewer");
await fs.mkdir(config.DATA_ROOT, { recursive: true });

await app.register(fastifyStatic, {
  root: publicRoot,
  prefix: "/viewer/",
  decorateReply: false,
});
await app.register(fastifyStatic, {
  root: config.DATA_ROOT,
  prefix: "/artifacts/",
  decorateReply: false,
});

app.get("/health", async () => ({ status: "ok" }));
app.get("/favicon.ico", async (_request, reply) => reply.code(204).send());

app.get("/", async (_request, reply) => reply.redirect("/viewer/"));

app.get("/api/projects", async () => ({ projects: await services.projects.list() }));

app.post("/api/projects", async (request, reply) => {
  const input = CreateProjectRequestSchema.parse(request.body);
  const project = await services.orchestrator.start(input.prompt, input.userId);
  return reply.code(202).send(projectResponse(project));
});

app.get<{ Params: { projectId: string } }>("/api/projects/:projectId", async (request, reply) => {
  const project = await services.projects.load(request.params.projectId);
  if (!project) return reply.code(404).send({ error: "Project not found" });
  return projectResponse(project);
});

app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/scene/latest", async (request, reply) => {
  const project = await services.projects.load(request.params.projectId);
  if (!project) return reply.code(404).send({ error: "Project not found" });
  const indexed = await services.context.findLatestScene(project.projectId);
  if (indexed) return indexed;
  const sceneDirectory = path.join(project.root, "scene");
  const entries = (await fs.readdir(sceneDirectory).catch(() => []))
    .filter((entry) => /^revision-\d+\.json$/.test(entry))
    .sort();
  const latest = entries.at(-1);
  if (!latest) return reply.code(404).send({ error: "Scene not ready" });
  return reply.type("application/json").send(await fs.readFile(path.join(sceneDirectory, latest), "utf8"));
});

app.post<{ Params: { projectId: string } }>("/api/projects/:projectId/cancel", async (request, reply) => {
  const state = await services.orchestrator.cancelProject(request.params.projectId);
  if (!state) return reply.code(404).send({ error: "Project not found" });
  return reply.code(202).send({ state });
});

app.delete<{ Params: { projectId: string } }>("/api/projects/:projectId", async (request, reply) => {
  const project = await services.projects.load(request.params.projectId);
  if (!project) return reply.code(404).send({ error: "Project not found" });
  await services.orchestrator.deleteProject(request.params.projectId);
  return reply.code(204).send();
});

app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/events", async (request, reply) => {
  const project = await services.projects.load(request.params.projectId);
  if (!project) return reply.code(404).send({ error: "Project not found" });
  const indexed = await services.context.listEvents(project.projectId);
  if (indexed.length > 0) return { events: indexed };
  const content = await fs.readFile(path.join(project.root, "logs", "events.ndjson"), "utf8").catch(() => "");
  return { events: content.split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown) };
});

app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/interaction", async (request, reply) => {
  const [project, state] = await Promise.all([
    services.projects.load(request.params.projectId),
    services.orchestrator.getGraphState(request.params.projectId),
  ]);
  if (!project) return reply.code(404).send({ error: "Project not found" });
  if (!state) return reply.code(404).send({ error: "Interaction graph not found" });
  return {
    project: projectResponse(project),
    state,
    sceneUrl: `/api/projects/${project.projectId}/scene/latest`,
  };
});

app.post<{ Params: { projectId: string } }>("/api/projects/:projectId/clarifications", async (request, reply) => {
  const state = await services.orchestrator.answerClarifications(request.params.projectId, request.body);
  return reply.code(202).send({ state });
});

app.post<{ Params: { projectId: string } }>("/api/projects/:projectId/research-decision", async (request, reply) => {
  const state = await services.orchestrator.decideResearch(request.params.projectId, request.body);
  return reply.code(202).send({ state });
});

app.post<{ Params: { projectId: string } }>("/api/projects/:projectId/feedback", async (request, reply) => {
  const result = await services.orchestrator.submitFeedback(request.params.projectId, request.body);
  return reply.code(result.nextProject ? 202 : 200).send({
    state: result.state,
    ...(result.nextProject ? { nextProject: projectResponse(result.nextProject) } : {}),
  });
});

app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/view", async (request, reply) => {
  const project = await services.projects.load(request.params.projectId);
  if (!project) return reply.code(404).send({ error: "Project not found" });
  return reply.redirect(`/viewer/?project=${encodeURIComponent(project.projectId)}`);
});

app.get<{ Params: { projectId: string } }>("/api/projects/:projectId/checkpoints", async (request, reply) => {
  const project = await services.projects.load(request.params.projectId);
  if (!project) return reply.code(404).send({ error: "Project not found" });
  return { checkpoints: await services.orchestrator.listCheckpoints(project.projectId) };
});

app.post<{ Params: { projectId: string }; Body: { sequence?: number; fresh?: boolean } }>(
  "/api/projects/:projectId/resume",
  async (request, reply) => {
    const state = await services.orchestrator.resume(request.params.projectId, {
      sequence: typeof request.body?.sequence === "number" ? request.body.sequence : undefined,
      fresh: request.body?.fresh === true,
    });
    return reply.code(202).send({ state });
  },
);

app.post<{ Params: { projectId: string } }>("/api/projects/:projectId/rerun", async (request, reply) => {
  const project = await services.projects.load(request.params.projectId);
  if (!project) return reply.code(404).send({ error: "Project not found" });
  const next = await services.orchestrator.start(project.prompt, project.userId, project.projectId);
  return reply.code(202).send(projectResponse(next));
});

app.setErrorHandler((error, _request, reply) => {
  const normalized = error instanceof Error ? error : new Error(String(error));
  const isStateConflict = /not waiting|still running|No checkpoint at sequence|Generation is blocked|reached the configured|requires feedback|requires a short explanation|interaction update is already|cannot be restarted automatically|No successful checkpoint|not currently working|still working/i.test(
    normalized.message,
  );
  const status = "issues" in normalized ? 400 : isStateConflict ? 409 : 500;
  app.log.error(error);
  void reply.code(status).send({ error: normalized.message });
});

const close = async (): Promise<void> => {
  await app.close();
  await services.orchestrator.close();
};
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());

await app.listen({ host: config.HOST, port: config.PORT });

function projectResponse(project: Awaited<ReturnType<typeof services.projects.create>>) {
  return {
    ...project,
    statusUrl: `${config.PUBLIC_BASE_URL}/api/projects/${project.projectId}`,
    eventsUrl: `${config.PUBLIC_BASE_URL}/api/projects/${project.projectId}/events`,
    interactionUrl: `${config.PUBLIC_BASE_URL}/api/projects/${project.projectId}/interaction`,
    viewerUrl: `${config.PUBLIC_BASE_URL}/api/projects/${project.projectId}/view`,
  };
}
