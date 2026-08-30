export {};

interface Manifest {
  title: string;
  module?: {
    viewerUrl: string;
    definition: {
      steps: Array<{ id: string }>;
      qaViews: Array<{ id: string; stepId: string }>;
    };
  };
}

interface CheckpointSummary {
  sequence: number;
  node: string;
  status: "running" | "waiting" | "completed" | "failed";
  guidance: string;
  resumable: boolean;
  stage: "clarification" | "research" | "generation" | null;
  updatedAt: string;
}

interface WorkflowGraphState {
  sequence: number;
  currentNode: string;
  status: "running" | "waiting" | "completed" | "failed";
  guidance: string;
  failedNode?: string;
  failureMessage?: string;
  resumeCount?: number;
  steps: Array<{ id: string; label: string; status: string; summary: string }>;
  clarification?: {
    summary: string;
    questions: Array<{ id: string; question: string; reason: string; options: string[]; required: boolean }>;
  };
  researchDossier?: {
    brief: {
      concept: string;
      summary: string;
      visualNotes: string[];
      objectNotes: string[];
      styleKeywords: string[];
      sources: Array<{ url: string; title: string; note?: string }>;
      references: Array<{ imageUrl: string; sourceUrl: string; title: string; relevance?: string }>;
    };
    objectStudies: Array<{
      id: string;
      name: string;
      role: string;
      identityMarkers: string[];
      components: string[];
      materials: string[];
      proportionAndScale: string[];
      spatialRelationships: string[];
      sourceUrls: string[];
      referenceImageUrls?: string[];
      uncertainty?: string;
    }>;
    intentCoverage: Array<{ requirement: string; evidence: string; objectStudyIds: string[] }>;
    contradictions: string[];
    unresolvedQuestions: string[];
    perspectives: Array<{
      perspectiveId: string;
      summary: string;
      findings: Array<{
        claim: string;
        whyItMatters: string;
        sourceUrls: string[];
        confidence: "high" | "medium" | "low";
      }>;
      sources: Array<{ url: string; title: string; note?: string }>;
      references: Array<{ imageUrl: string; sourceUrl: string; title: string; relevance?: string }>;
      unansweredQuestions: string[];
    }>;
    searchAttribution?: { model: string; queries: string[]; renderedContent: string };
    readiness: {
      decision: "ready" | "needs-research" | "needs-user";
      score: number;
      checks: Array<{ id: string; label: string; passed: boolean; evidence: string }>;
      gaps: string[];
    };
    generatedAt?: string;
  };
  finalSceneRevision?: number;
  finalInspection?: {
    verdict: string;
    issue: string;
    evidence: string;
    assessment?: {
      recognizabilityScore: number;
      domainFidelityScore: number;
      visualQualityScore: number;
      constructionCompletenessScore: number;
    };
  };
  qaCoverage?: {
    requiredTargets: Array<{ id: string; label: string }>;
    passedTargetIds: string[];
    unresolvedTargetIds: string[];
    refinements: number;
    complete: boolean;
    supervisorStatus?: string;
  };
  qualitySupervisor?: {
    status: string;
    attempt: number;
    inspections: number;
    targetedResearchRounds: number;
    replans: number;
    logicalAiCalls: number;
    startedAt: string;
    deadlineAt: string;
    bestScores: {
      recognizability: number;
      domainFidelity: number;
      visualQuality: number;
      constructionCompleteness: number;
    };
  };
  qaExhausted?: boolean;
  nextProjectId?: string;
}

interface InteractionResponse {
  project?: { projectId: string; prompt: string };
  state: WorkflowGraphState;
  sceneUrl: string;
}

declare global {
  interface Window {
    __SEEIN_READY__?: boolean;
    __SEEIN_ERRORS__?: string[];
    __SEEIN_RENDER_STATE__?: {
      assetsLoaded: boolean;
      moduleCompiled: boolean;
      cameraSettled: boolean;
      stableFrames: number;
      stateId: string;
      viewId: string;
    };
  }
}

const viewport = requiredElement("#viewport");
const status = requiredElement("#status");
const title = requiredElement("#scene-title");
const stateControls = requiredElement("#state-controls");
const workflowPanel = requiredElement("#workflow-panel");
const workflowNode = requiredElement("#workflow-node");
const workflowSteps = requiredElement("#workflow-steps");
const workflowGuidance = requiredElement("#workflow-guidance");
const workflowAction = requiredElement("#workflow-action");
const launcher = requiredElement("#launcher");
const stageEmpty = requiredElement("#stage-empty");
const consoleToggle = requiredElement("#console-toggle");
const workflowProgress = requiredElement("#workflow-progress");
const nowSection = requiredElement(".now");
const flow = requiredElement("#flow");
const modal = requiredElement("#modal") as HTMLDialogElement;
const consoleStop = requiredElement("#console-stop");
const workflowElapsed = requiredElement("#workflow-elapsed");
const workflowOperation = requiredElement("#workflow-operation");
const workflowOperationLabel = requiredElement("#workflow-operation-label");
const workflowOperationRoute = requiredElement("#workflow-operation-route");
const workflowOperationDetail = requiredElement("#workflow-operation-detail");
const activity = requiredElement("#activity") as HTMLDetailsElement;
const activityList = requiredElement("#activity-list");
const consolePeek = requiredElement("#console-peek") as HTMLButtonElement;
const consolePeekProgress = requiredElement("#console-peek-progress");
const consolePeekNode = requiredElement("#console-peek-node");
const dossierOpen = requiredElement("#dossier-open") as HTMLButtonElement;
const dossierLayer = requiredElement("#dossier-layer");
const dossierClose = requiredElement("#dossier-close") as HTMLButtonElement;
const dossierScrim = requiredElement("#dossier-scrim") as HTMLButtonElement;
const dossierContent = requiredElement("#dossier-content");

// Assigned by runGuidedViewer, which can run during module evaluation.
let restartPolling: (() => void) | null = null;
let dossierReturnFocus: HTMLElement | null = null;

const LAUNCHER_EXAMPLES = [
  "Right hepatic hilum anatomy for laparoscopic cholecystectomy, including Calot’s triangle and structures at risk",
  "Endoscopic endonasal transsphenoidal approach to the pituitary with carotid and optic relationships",
  "Microsurgical clipping view of a middle cerebral artery bifurcation aneurysm with perforators preserved",
];


window.__SEEIN_READY__ = false;
window.__SEEIN_ERRORS__ = [];
window.__SEEIN_RENDER_STATE__ = {
  assetsLoaded: false,
  moduleCompiled: false,
  cameraSettled: false,
  stableFrames: 0,
  stateId: "",
  viewId: "",
};

void start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  window.__SEEIN_ERRORS__?.push(message);
  status.hidden = false;
  status.textContent = `Scene failed: ${message}`;
  status.style.color = "#fca5a5";
  if (window.__SEEIN_RENDER_STATE__) {
    window.__SEEIN_RENDER_STATE__.assetsLoaded = true;
    window.__SEEIN_RENDER_STATE__.moduleCompiled = true;
    window.__SEEIN_RENDER_STATE__.cameraSettled = true;
    window.__SEEIN_RENDER_STATE__.stableFrames = 3;
  }
  window.__SEEIN_READY__ = true;
});

async function start(): Promise<void> {
  const query = new URLSearchParams(location.search);
  const manifestUrl = query.get("manifest");
  const projectId = query.get("project");
  if (manifestUrl) return renderManifest(manifestUrl);
  if (projectId) return runGuidedViewer(projectId);
  return showLauncher();
}

async function showLauncher(): Promise<void> {
  const form = requiredElement("#launcher-form") as HTMLFormElement;
  const prompt = requiredElement("#launcher-prompt") as HTMLTextAreaElement;
  const submit = requiredElement("#launcher-submit") as HTMLButtonElement;
  const errorLine = requiredElement("#launcher-error");
  const examples = requiredElement("#launcher-examples");
  const voice = requiredElement("#voice-input") as HTMLButtonElement;

    launcher.hidden = false;
  status.hidden = true;
  title.textContent = "Start a surgical anatomy visualization";

  for (const example of LAUNCHER_EXAMPLES) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "launcher__chip";
    chip.textContent = example;
    chip.title = example;
    chip.addEventListener("click", () => {
      prompt.value = example;
      prompt.focus();
    });
    examples.append(chip);
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = prompt.value.trim();
    if (text.length < 3) return;
    submit.disabled = true;
    submit.textContent = "Starting…";
    errorLine.hidden = true;
    void createProject(text).catch((error: unknown) => {
      errorLine.textContent = error instanceof Error ? error.message : String(error);
      errorLine.hidden = false;
      submit.disabled = false;
      submit.textContent = "Build visualization";
    });
  });

  // Cmd/Ctrl+Enter submits without reaching for the mouse.
  prompt.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) form.requestSubmit();
  });

  voice.addEventListener("click", () => {
    voice.dataset.notice = "true";
    const label = voice.querySelector("span");
    if (label) label.textContent = "Voice input is coming";
    window.setTimeout(() => {
      voice.dataset.notice = "false";
      if (label) label.textContent = "Voice soon";
    }, 1800);
  });

  await listRecentRuns();
  prompt.focus();
  window.__SEEIN_READY__ = true;
}

async function createProject(prompt: string): Promise<void> {
  const response = await fetch("/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(detail?.error ?? `Could not start the run: ${response.status}`);
  }
  const project = (await response.json()) as { projectId: string };
  openProject(project.projectId);
}

function openProject(projectId: string): void {
  const url = new URL(location.href);
  url.searchParams.set("project", projectId);
  history.replaceState(null, "", url);
    launcher.hidden = true;
  status.hidden = false;
  void runGuidedViewer(projectId).catch((error: unknown) => showWorkflowError(error));
}

/** Deleting a run is irreversible and removes its files, so it asks first. */
async function confirmDeleteRun(projectId: string, prompt: string): Promise<void> {
  const inner = document.createElement("div");
  inner.className = "modal__inner";
  const title = document.createElement("h2");
  title.id = "modal-title";
  title.className = "modal__title";
  title.textContent = "Delete this run?";
  const lede = document.createElement("p");
  lede.className = "modal__lede";
    lede.textContent = `"${prompt.slice(0, 120)}" and everything it produced: evidence, reference images, generated source, renders, and history. Reusable anatomy and research shared with other runs are kept. This cannot be undone.`;
  const error = document.createElement("p");
  error.className = "error-text";
  error.hidden = true;

  const actions = document.createElement("div");
  actions.className = "modal__actions";
  const confirm = actionButton("Delete permanently");
  const cancel = actionButton("Keep it", "secondary");
  cancel.addEventListener("click", () => modal.close());
  confirm.addEventListener("click", () => {
    confirm.disabled = true;
    confirm.textContent = "Deleting";
    error.hidden = true;
    void fetch(`/api/projects/${encodeURIComponent(projectId)}`, { method: "DELETE" })
      .then(async (response) => {
        if (!response.ok && response.status !== 204) {
          const detail = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(detail?.error ?? `Delete failed: ${response.status}`);
        }
        modal.close();
        location.reload();
      })
      .catch((cause: unknown) => {
        error.textContent = cause instanceof Error ? cause.message : String(cause);
        error.hidden = false;
        confirm.disabled = false;
        confirm.textContent = "Delete permanently";
      });
  });
  actions.append(confirm, cancel);
  inner.append(title, lede, error, actions);
  modal.replaceChildren(inner);
  modal.dataset.sequence = "delete";
  if (!modal.open) modal.showModal();
}

async function listRecentRuns(): Promise<void> {
  const container = requiredElement("#launcher-recent");
  const response = await fetch("/api/projects", { cache: "no-store" }).catch(() => null);
  if (!response?.ok) return;
  const { projects } = (await response.json()) as {
    projects: Array<{ projectId: string; prompt: string; status: string; createdAt: string }>;
  };
  const recent = [...projects].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5);
  if (recent.length === 0) return;

  const heading = document.createElement("h2");
  heading.textContent = "Prior runs";
  container.append(heading);
  for (const project of recent) {
    const entry = document.createElement("button");
    entry.type = "button";
    entry.className = "launcher__run";
    entry.dataset.status = project.status;
    const label = document.createElement("span");
    label.textContent = project.prompt;
    const badge = document.createElement("span");
    badge.className = "run__state";
    badge.textContent = project.status.replaceAll("_", " ");
    entry.append(label, badge);
    entry.addEventListener("click", () => openProject(project.projectId));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "run__delete";
    remove.title = "Delete this run and its data";
    remove.setAttribute("aria-label", `Delete run: ${project.prompt}`);
    remove.textContent = "Delete";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      void confirmDeleteRun(project.projectId, project.prompt);
    });

    const row = document.createElement("div");
    row.className = "run";
    row.append(entry, remove);
    container.append(row);
  }
  container.hidden = false;
}

async function renderManifest(manifestUrl: string): Promise<void> {
  stageEmpty.hidden = true;
  const response = await fetch(manifestUrl);
  if (!response.ok) throw new Error(`Manifest request failed: ${response.status}`);
  const manifest = (await response.json()) as Manifest;
  title.textContent = manifest.title;
  if (manifest.module) return renderAtlasModule(manifest);

  throw new Error("Scene manifest has no compiled surgical module.");
}

async function renderAtlasModule(manifest: Manifest): Promise<void> {
  if (!manifest.module) throw new Error("Atlas module metadata is missing");
  const sceneHead = title.closest(".scene-head") as HTMLElement | null;
  if (sceneHead) sceneHead.style.display = "none";
  const query = new URLSearchParams(location.search);
  const moduleUrl = new URL(manifest.module.viewerUrl, location.href);
  const stateId = query.get("state");
  const viewId = query.get("view");
  if (stateId) moduleUrl.searchParams.set("state", stateId);
  if (viewId) moduleUrl.searchParams.set("view", viewId);

  const frame = document.createElement("iframe");
  frame.title = manifest.title;
  frame.src = moduleUrl.toString();
  frame.style.position = "fixed";
  frame.style.inset = "0";
  frame.style.width = "100%";
  frame.style.height = "100%";
  frame.style.border = "0";
  frame.style.background = "#082a2e";
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
  viewport.replaceChildren(frame);
  status.textContent = "Loading generated surgical atlas module…";

  await new Promise<void>((resolve, reject) => {
    // The calibrated patient shell, complete internal context, and operative
    // atlas intentionally compile substantially more geometry than the old
    // placeholder viewer. Software-rendered Chromium can need more than 28 s
    // on a cold page even though the scene is healthy, so reserve enough time
    // for the child to report real frame stability.
    const deadline = Date.now() + 50_000;
    const poll = () => {
      try {
        const child = frame.contentWindow;
        if (child?.__SEEIN_READY__) {
          const childState = child.__SEEIN_RENDER_STATE__;
          const childErrors = child.__SEEIN_ERRORS__ ?? [];
          window.__SEEIN_ERRORS__?.push(...childErrors);
          if (window.__SEEIN_RENDER_STATE__) {
            window.__SEEIN_RENDER_STATE__ = childState
              ? { ...childState }
              : {
                  assetsLoaded: true,
                  moduleCompiled: true,
                  cameraSettled: true,
                  stableFrames: 3,
                  stateId: stateId ?? "",
                  viewId: viewId ?? "",
                };
          }
          resolve();
          return;
        }
      } catch (error) {
        reject(error);
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error("Generated surgical module did not reach render readiness within 50 seconds"));
        return;
      }
      requestAnimationFrame(poll);
    };
    frame.addEventListener("error", () => reject(new Error("Generated surgical module iframe failed to load")), { once: true });
    requestAnimationFrame(poll);
  });

  status.textContent = window.__SEEIN_ERRORS__?.length
    ? `Generated module rendered with ${window.__SEEIN_ERRORS__.length} browser error(s)`
    : `${manifest.module.definition.steps.length} surgical states · live generated module`;
  window.__SEEIN_READY__ = true;
}

interface ProjectEvent {
  kind?: "stage" | "operation";
  operationId?: string;
  message?: string;
  stage?: string;
  status?: string;
  detail?: Record<string, unknown>;
  createdAt?: string;
}

interface ActivityRow {
  key: string;
  kind: "stage" | "operation";
  stage: string;
  status: string;
  message: string | undefined;
  detail: Record<string, unknown> | undefined;
  at: string | undefined;
  startedAt: string | undefined;
}

/**
 * The event log is written for operators. This turns each stage into something a
 * person reading the panel can follow, in the present tense while it runs and the
 * past tense once it lands.
 */
const STAGE_STORY: Record<string, { doing: string; done: string }> = {
  created: { doing: "Starting up", done: "Started" },
  clarifying: { doing: "Defining the surgical teaching target", done: "Clinical-visual questions ready" },
  awaiting_clarification: { doing: "Waiting on your answers", done: "Got your answers" },
  researching: { doing: "Researching anatomy and operative relationships", done: "Anatomical evidence gathered" },
  auditing_research: { doing: "Auditing anatomical evidence", done: "Anatomical evidence checked" },
  planning: { doing: "Designing the anatomy construction", done: "Anatomy construction designed" },
  assembling: { doing: "Assembling anatomical relationships", done: "Anatomy assembled" },
  rendering_initial: { doing: "Rendering the first operative view", done: "First operative view rendered" },
  rendering_final: { doing: "Rendering the corrected anatomy", done: "Corrected anatomy rendered" },
  inspecting: { doing: "Inspecting anatomy against evidence", done: "Anatomy render inspected" },
  refining: { doing: "Correcting the highest-risk mismatch", done: "Anatomical correction applied" },
  planning_research: { doing: "Planning the medical evidence search", done: "Medical research planned" },
  awaiting_research_approval: { doing: "Waiting for anatomical evidence approval", done: "Anatomical evidence approved" },
  awaiting_feedback: { doing: "Waiting for the surgeon’s review", done: "Surgeon review received" },
  awaiting_quality: { doing: "Checkpointing unresolved quality work", done: "Quality checkpoint saved" },
  resumed: { doing: "Picking up from a checkpoint", done: "Resumed from a checkpoint" },
  completed: { doing: "Finishing", done: "Finished" },
  failed: { doing: "Stopped", done: "Stopped" },
};

function storyFor(stage: string, status: string): string {
  const story = STAGE_STORY[stage];
  if (!story) return humanize(stage);
  if (status === "failed") return story.doing === "Stopped" ? "The run stopped" : `${story.doing} did not finish`;
  return status === "completed" ? story.done : story.doing;
}

/** Plain-language footnote for the numbers worth surfacing. */
function storyDetail(stage: string, detail: Record<string, unknown> | undefined): string {
  if (!detail) return "";
  const num = (key: string): number | undefined =>
    typeof detail[key] === "number" ? (detail[key] as number) : undefined;
  const bits: string[] = [];

  const built = num("generated");
  const reused = num("reused");
  if (built !== undefined) {
    bits.push(reused ? `${built} built, ${reused} reused from earlier runs` : `${built} built from scratch`);
  }
  const images = num("imagesDownloaded");
  if (images !== undefined) {
    const failed = num("downloadFailures");
    bits.push(failed ? `${images} reference images, ${failed} unavailable` : `${images} reference images`);
  }
  const shown = num("referencesShownToPlanner");
  if (shown !== undefined) bits.push(`${shown} shown to the anatomy planner`);
  const objects = num("objects");
  if (objects !== undefined) bits.push(`${objects} anatomical structures`);
  const issues = num("spatialIssues");
  if (issues !== undefined) bits.push(issues === 0 ? "no spatial problems" : `${issues} spatial things to verify`);
  if (typeof detail.verdict === "string") {
    bits.push(detail.verdict === "pass" ? "anatomy view passes" : `requires a change to ${String(detail.category ?? "the anatomy")}`);
  }
  if (typeof detail.error === "string") bits.push(firstUsefulLine(detail.error));
  if (bits.length === 0 && detail.cacheHit === true) bits.push("reused from an earlier run");
  return bits.slice(0, 2).join(" · ");
}

function operationPhase(event: ProjectEvent): string {
  return typeof event.detail?.phase === "string" ? event.detail.phase : "started";
}

function operationHeadline(row: ActivityRow): string {
  const label = typeof row.detail?.label === "string" ? row.detail.label : row.message ?? "External call";
  if (row.status === "completed") return `${label} completed`;
  if (row.status === "retrying") return `${label} failed — retry scheduled`;
  if (row.status === "failed") return `${label} failed`;
  return `Calling ${label}`;
}

function durationLabel(value: unknown): string {
  if (typeof value !== "number") return "";
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1000)}s`;
}

function operationMeta(detail: Record<string, unknown> | undefined, includeRoute = true): string {
  if (!detail) return "";
  const bits: string[] = [];
  if (includeRoute && typeof detail.action === "string" && typeof detail.destination === "string") {
    bits.push(`${detail.action} → ${detail.destination}`);
  } else if (includeRoute && typeof detail.destination === "string") {
    bits.push(detail.destination);
  }
  if (typeof detail.provider === "string") bits.push(detail.provider);
  if (typeof detail.attempt === "number") {
    bits.push(`attempt ${detail.attempt}/${typeof detail.maxAttempts === "number" ? detail.maxAttempts : "?"}`);
  }
  const duration = durationLabel(detail.totalDurationMs ?? detail.durationMs);
  if (duration) bits.push(duration);
  if (typeof detail.retryInMs === "number") bits.push(`retry in ${durationLabel(detail.retryInMs)}`);
  if (typeof detail.error === "string") bits.push(firstUsefulLine(detail.error));
  return bits.join(" · ");
}

function renderLiveOperation(rows: ActivityRow[]): void {
  const operations = rows.filter((row) => row.kind === "operation");
  const current = operations.find((row) => row.status === "started" || row.status === "retrying") ?? operations[0];
  if (!current) {
    workflowOperation.hidden = true;
    return;
  }
  workflowOperation.hidden = false;
  workflowOperation.dataset.phase = current.status;
  workflowOperationLabel.textContent = operationHeadline(current);
  const action = typeof current.detail?.action === "string" ? current.detail.action : "External operation";
  const destination = typeof current.detail?.destination === "string" ? current.detail.destination : "provider";
  workflowOperationRoute.textContent = `${action} → ${destination}`;
  workflowOperationDetail.textContent = operationMeta(current.detail, false);
}

function relativeTime(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} hr ago`;
}

// Stringified errors often start with a bare "ZodError: [", which tells the reader
// nothing. Prefer the first line that carries an actual message.
function firstUsefulLine(text: string): string {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const message = lines.find((line) => /"message"\s*:/.test(line)) ?? lines.find((line) => line.length > 24);
  const cleaned = (message ?? lines[0] ?? text).replace(/^"message"\s*:\s*"?/, "").replace(/",?$/, "");
  return cleaned.slice(0, 110);
}

async function renderActivity(projectId: string): Promise<void> {
  const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/events`, { cache: "no-store" })
    .catch(() => null);
  if (!response?.ok) return;
  const { events } = (await response.json()) as { events: ProjectEvent[] };

  // Stages collapse into one line, while each provider operation keeps its own row.
  // This makes parallel research calls, source compilation, and render failures visible.
  const stages = new Map<string, ActivityRow>();
  const operations = new Map<string, ActivityRow>();
  for (const event of events) {
    const stage = event.stage ?? "step";
    if (event.kind === "operation") {
      const key = event.operationId ?? `operation-${event.createdAt ?? operations.size}`;
      const existing = operations.get(key);
      operations.set(key, {
        key,
        kind: "operation",
        stage,
        status: operationPhase(event),
        message: event.message,
        detail: event.detail,
        at: event.createdAt,
        startedAt: existing?.startedAt ?? event.createdAt,
      });
      continue;
    }
    const existing = stages.get(stage);
    if (event.status === "started") {
      stages.set(stage, { key: stage, kind: "stage", stage, status: "started", message: undefined, detail: undefined, at: event.createdAt, startedAt: event.createdAt });
    } else {
      stages.set(stage, {
        key: stage,
        kind: "stage",
        stage,
        status: event.status ?? "info",
        message: undefined,
        detail: event.detail,
        at: event.createdAt,
        startedAt: existing?.startedAt,
      });
    }
  }

  const now = Date.now();
  const rows = [...stages.values(), ...operations.values()]
    .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  renderLiveOperation(rows);
  if (rows.length === 0) return;
  activityList.replaceChildren(
    ...rows.slice(0, 14).map((row) => {
      const item = document.createElement("li");
      item.className = "step";
      item.dataset.status = row.status;
      const headline = document.createElement("div");
      headline.className = "step__what";
      headline.textContent = row.kind === "operation" ? operationHeadline(row) : storyFor(row.stage, row.status);
      const meta = document.createElement("div");
      meta.className = "step__meta";
      const detail = row.kind === "operation" ? operationMeta(row.detail) : storyDetail(row.stage, row.detail);
      const took = row.startedAt && row.at && row.status !== "started"
        ? `${Math.max(1, Math.round((Date.parse(row.at) - Date.parse(row.startedAt)) / 1000))}s`
        : "";
      meta.textContent = [detail, took, relativeTime(row.at, now)].filter(Boolean).join(" · ");
      item.append(headline);
      if (meta.textContent) item.append(meta);
      return item;
    }),
  );
}

function startElapsed(): () => void {
  const startedAt = Date.now();
  const tick = (): void => {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    workflowElapsed.textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    workflowElapsed.hidden = false;
  };
  tick();
  const timer = window.setInterval(tick, 1000);
  return () => window.clearInterval(timer);
}

/** Stopping is destructive to in-flight work, so it confirms before firing. */
function wireStop(projectId: string, refresh: () => Promise<void>): void {
  consoleStop.addEventListener("click", () => {
    const inner = document.createElement("div");
    inner.className = "modal__inner";
    const title = document.createElement("h2");
    title.id = "modal-title";
    title.className = "modal__title";
    title.textContent = "Stop this run?";
    const lede = document.createElement("p");
    lede.className = "modal__lede";
    lede.textContent = "It stops at the end of the current step. Work already finished is kept and the run can be rewound to a checkpoint; anything in progress is discarded.";
    const error = document.createElement("p");
    error.className = "error-text";
    error.hidden = true;
    const actions = document.createElement("div");
    actions.className = "modal__actions";
    const confirm = actionButton("Stop it");
    const cancel = actionButton("Keep going", "secondary");
    cancel.addEventListener("click", () => modal.close());
    confirm.addEventListener("click", () => {
      confirm.disabled = true;
      confirm.textContent = "Stopping";
      void fetch(`/api/projects/${encodeURIComponent(projectId)}/cancel`, { method: "POST" })
        .then(async (response) => {
          if (!response.ok) {
            const detail = (await response.json().catch(() => null)) as { error?: string } | null;
            throw new Error(detail?.error ?? `Stop failed: ${response.status}`);
          }
          modal.close();
          await refresh();
        })
        .catch((cause: unknown) => {
          error.textContent = cause instanceof Error ? cause.message : String(cause);
          error.hidden = false;
          confirm.disabled = false;
          confirm.textContent = "Stop it";
        });
    });
    actions.append(confirm, cancel);
    inner.append(title, lede, error, actions);
    modal.replaceChildren(inner);
    modal.dataset.sequence = "stop";
    if (!modal.open) modal.showModal();
  });
}

function wireConsoleToggle(): void {
  if (workflowPanel.dataset.wired === "true") return;
  workflowPanel.dataset.wired = "true";
  const setCollapsed = (collapsed: boolean): void => {
    workflowPanel.dataset.collapsed = String(collapsed);
    consoleToggle.textContent = collapsed ? "Show" : "Hide";
    consoleToggle.setAttribute("aria-expanded", String(!collapsed));
    consolePeek.setAttribute("aria-expanded", String(!collapsed));
  };
  setCollapsed(matchMedia("(max-width: 860px)").matches);
  consoleToggle.addEventListener("click", () => {
    setCollapsed(workflowPanel.dataset.collapsed !== "true");
  });
  consolePeek.addEventListener("click", () => setCollapsed(false));
}

function openResearchDossier(): void {
  dossierReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  dossierLayer.hidden = false;
  document.documentElement.classList.add("has-dossier");
  dossierContent.scrollTop = 0;
  dossierClose.focus();
}

function closeResearchDossier(): void {
  dossierLayer.hidden = true;
  document.documentElement.classList.remove("has-dossier");
  if (dossierReturnFocus?.isConnected && dossierReturnFocus.getClientRects().length > 0) {
    dossierReturnFocus.focus();
  } else if (!dossierOpen.hidden) {
    dossierOpen.focus();
  }
  dossierReturnFocus = null;
}

dossierOpen.addEventListener("click", openResearchDossier);
dossierClose.addEventListener("click", closeResearchDossier);
dossierScrim.addEventListener("click", closeResearchDossier);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !dossierLayer.hidden) closeResearchDossier();
  if (event.key !== "Tab" || dossierLayer.hidden) return;
  const focusable = [...dossierLayer.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), summary, input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  )].filter((element) => element.getClientRects().length > 0);
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});

type ResearchDossier = NonNullable<WorkflowGraphState["researchDossier"]>;

function renderResearchDossier(projectId: string, dossier: ResearchDossier | undefined): void {
  dossierOpen.hidden = !dossier;
  if (!dossier) {
    if (!dossierLayer.hidden) closeResearchDossier();
    dossierContent.replaceChildren();
    return;
  }

  const allReferences = uniqueBy(
    [
      ...dossier.brief.references,
      ...dossier.perspectives.flatMap((perspective) => perspective.references),
      ...dossier.objectStudies.flatMap((study) => (study.referenceImageUrls ?? []).map((imageUrl) => ({
        imageUrl,
        sourceUrl: study.sourceUrls[0] ?? imageUrl,
        title: study.name,
        relevance: study.role,
      }))),
    ],
    (reference) => reference.imageUrl,
  );
  const allSources = uniqueBy(
    [...dossier.brief.sources, ...dossier.perspectives.flatMap((perspective) => perspective.sources)],
    (source) => source.url,
  );
  const passed = dossier.readiness.checks.filter((check) => check.passed).length;

  const hero = document.createElement("section");
  hero.className = "dossier-hero";
  const heroMeta = document.createElement("p");
  heroMeta.className = "dossier-hero__meta";
  heroMeta.textContent = dossier.generatedAt
    ? `Compiled ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(dossier.generatedAt))}`
    : "Live research record";
  const heroTitle = document.createElement("h3");
  heroTitle.textContent = dossier.brief.concept;
  const heroSummary = document.createElement("p");
  heroSummary.textContent = dossier.brief.summary;
  hero.append(heroMeta, heroTitle, heroSummary);

  const index = document.createElement("nav");
  index.className = "dossier-index";
  index.setAttribute("aria-label", "Dossier sections");
  const stats: Array<[string, string, string]> = [
    ["Sources", String(allSources.length), "sources"],
    ["Reference images", String(allReferences.length), "images"],
    ["Anatomy studies", String(dossier.objectStudies.length), "anatomy"],
    ["Readiness", `${Math.round(dossier.readiness.score * 100)}%`, "readiness"],
  ];
  for (const [label, value, target] of stats) {
    const link = document.createElement("a");
    link.href = `#dossier-${target}`;
    const number = document.createElement("strong");
    number.textContent = value;
    const caption = document.createElement("span");
    caption.textContent = label;
    link.append(number, caption);
    index.append(link);
  }

  const overview = dossierSection("overview", "Research overview", "The visual decisions the model will follow.");
  const lenses = document.createElement("div");
  lenses.className = "dossier-lenses";
  for (const perspective of dossier.perspectives) {
    const card = document.createElement("details");
    card.className = "dossier-lens";
    const summary = document.createElement("summary");
    const name = document.createElement("strong");
    name.textContent = perspectiveLabel(perspective.perspectiveId);
    const count = document.createElement("span");
    count.textContent = `${perspective.findings.length} findings`;
    summary.append(name, count);
    const intro = document.createElement("p");
    intro.textContent = perspective.summary;
    const findings = document.createElement("ol");
    findings.className = "dossier-findings";
    for (const finding of perspective.findings) {
      const item = document.createElement("li");
      const claim = document.createElement("p");
      claim.textContent = finding.claim;
      const why = document.createElement("p");
      why.className = "dossier-muted";
      why.textContent = finding.whyItMatters;
      const confidence = document.createElement("span");
      confidence.className = "confidence";
      confidence.dataset.level = finding.confidence;
      confidence.textContent = `${finding.confidence} confidence`;
      item.append(confidence, claim, why);
      findings.append(item);
    }
    card.append(summary, intro, findings);
    lenses.append(card);
  }
  const decisionNotes = document.createElement("div");
  decisionNotes.className = "dossier-notes";
  for (const note of dossier.brief.visualNotes) {
    const item = document.createElement("p");
    item.textContent = note;
    decisionNotes.append(item);
  }
  overview.body.append(lenses, subsectionTitle("Visual instructions"), decisionNotes);

  const anatomy = dossierSection("anatomy", "Anatomy studies", "Construction notes, scale, relationships, uncertainty, and supporting references for every structure.");
  const anatomyList = document.createElement("div");
  anatomyList.className = "anatomy-studies";
  for (const study of dossier.objectStudies) {
    const detail = document.createElement("details");
    detail.className = "anatomy-study";
    const summary = document.createElement("summary");
    const title = document.createElement("span");
    title.innerHTML = `<strong>${escapeMarkup(study.name)}</strong><small>${escapeMarkup(study.role)}</small>`;
    const marker = document.createElement("span");
    marker.className = "anatomy-study__count";
    marker.textContent = `${study.identityMarkers.length} markers`;
    summary.append(title, marker);
    const body = document.createElement("div");
    body.className = "anatomy-study__body";
    const studyImages = allReferences.filter((reference) => study.referenceImageUrls?.includes(reference.imageUrl));
    if (studyImages.length > 0) body.append(referenceGallery(studyImages.slice(0, 6), true));
    body.append(
      studyList("Identity markers", study.identityMarkers),
      studyList("Spatial relationships", study.spatialRelationships),
      studyList("Components", study.components),
      studyList("Tissue & material cues", study.materials),
      studyList("Proportion & scale", study.proportionAndScale),
    );
    if (study.uncertainty) {
      const uncertainty = document.createElement("p");
      uncertainty.className = "dossier-callout";
      uncertainty.textContent = `Uncertainty: ${study.uncertainty}`;
      body.append(uncertainty);
    }
    detail.append(summary, body);
    anatomyList.append(detail);
  }
  anatomy.body.append(anatomyList);

  const images = dossierSection("images", "Reference images", "The visual library collected during research. Open any item at its original source.");
  images.body.append(referenceGallery(allReferences));

  const sources = dossierSection("sources", "Sources & resources", "Every retrieved document remains available for inspection.");
  const sourceList = document.createElement("ol");
  sourceList.className = "source-library";
  for (const source of allSources) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = source.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    const domain = document.createElement("span");
    domain.textContent = hostname(source.url);
    const label = document.createElement("strong");
    label.textContent = source.title;
    link.append(domain, label);
    if (source.note) {
      const note = document.createElement("p");
      note.textContent = source.note;
      item.append(link, note);
    } else {
      item.append(link);
    }
    sourceList.append(item);
  }
  sources.body.append(sourceList);

  const readiness = dossierSection("readiness", "Coverage & readiness", `${passed} of ${dossier.readiness.checks.length} evidence checks passed.`);
  const readinessGrid = document.createElement("div");
  readinessGrid.className = "readiness-grid";
  for (const check of dossier.readiness.checks) {
    const row = document.createElement("article");
    row.className = "readiness-row";
    row.dataset.passed = String(check.passed);
    const label = document.createElement("strong");
    label.textContent = check.label;
    const evidence = document.createElement("p");
    evidence.textContent = check.evidence;
    row.append(label, evidence);
    readinessGrid.append(row);
  }
  const coverage = document.createElement("div");
  coverage.className = "coverage-list";
  for (const item of dossier.intentCoverage) {
    const detail = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = item.requirement;
    const evidence = document.createElement("p");
    evidence.textContent = item.evidence;
    detail.append(summary, evidence);
    coverage.append(detail);
  }
  readiness.body.append(readinessGrid, subsectionTitle("Clinical intent coverage"), coverage);

  const trace = dossierSection("trace", "Research trace", "Queries, tensions, and remaining unknowns stay available without crowding the main experience.");
  const transparency = document.createElement("div");
  transparency.className = "trace-grid";
  transparency.append(
    traceCard("Contradictions resolved", dossier.contradictions, "No contradictions were recorded."),
    traceCard("Open questions", dossier.unresolvedQuestions, "No blocking questions remain."),
  );
  trace.body.append(transparency);
  if (dossier.searchAttribution) {
    const search = document.createElement("details");
    search.className = "search-trace";
    const summary = document.createElement("summary");
    summary.textContent = `Search trace · ${dossier.searchAttribution.queries.length} queries · ${dossier.searchAttribution.model}`;
    const queryList = document.createElement("ul");
    for (const query of dossier.searchAttribution.queries) {
      const item = document.createElement("li");
      item.textContent = query;
      queryList.append(item);
    }
    const raw = document.createElement("details");
    raw.className = "search-trace__raw";
    const rawSummary = document.createElement("summary");
    rawSummary.textContent = "Rendered search attribution";
    const pre = document.createElement("pre");
    pre.textContent = dossier.searchAttribution.renderedContent;
    raw.append(rawSummary, pre);
    search.append(summary, queryList, raw);
    trace.body.append(search);
  }

  const footer = document.createElement("footer");
  footer.className = "dossier-footer";
  const note = document.createElement("p");
  note.textContent = "This dossier is an audit trail for an educational visualization, not clinical guidance.";
  const rawLink = document.createElement("a");
  rawLink.href = `/api/projects/${encodeURIComponent(projectId)}/interaction`;
  rawLink.target = "_blank";
  rawLink.rel = "noreferrer";
  rawLink.textContent = "Open machine-readable record";
  footer.append(note, rawLink);

  dossierContent.replaceChildren(hero, index, overview.section, anatomy.section, images.section, sources.section, readiness.section, trace.section, footer);
}

function dossierSection(id: string, title: string, description: string): { section: HTMLElement; body: HTMLElement } {
  const section = document.createElement("section");
  section.id = `dossier-${id}`;
  section.className = "dossier-section";
  const head = document.createElement("header");
  const eyebrow = document.createElement("p");
  eyebrow.className = "dossier-section__index";
  const sectionNumbers: Record<string, string> = {
    overview: "01",
    anatomy: "02",
    images: "03",
    sources: "04",
    readiness: "05",
    trace: "06",
  };
  eyebrow.textContent = sectionNumbers[id] ?? "—";
  const heading = document.createElement("h3");
  heading.textContent = title;
  const lede = document.createElement("p");
  lede.textContent = description;
  head.append(eyebrow, heading, lede);
  const body = document.createElement("div");
  body.className = "dossier-section__body";
  section.append(head, body);
  return { section, body };
}

function subsectionTitle(label: string): HTMLElement {
  const title = document.createElement("h4");
  title.className = "dossier-subtitle";
  title.textContent = label;
  return title;
}

function studyList(label: string, values: string[]): HTMLElement {
  const group = document.createElement("section");
  group.className = "study-list";
  const title = document.createElement("h4");
  title.textContent = label;
  const list = document.createElement("ul");
  for (const value of values) {
    const item = document.createElement("li");
    item.textContent = value;
    list.append(item);
  }
  group.append(title, list);
  return group;
}

function referenceGallery(references: ResearchDossier["brief"]["references"], compact = false): HTMLElement {
  const gallery = document.createElement("div");
  gallery.className = compact ? "reference-gallery reference-gallery--compact" : "reference-gallery";
  for (const reference of references) {
    const link = document.createElement("a");
    link.href = reference.sourceUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    const figure = document.createElement("figure");
    const image = document.createElement("img");
    image.src = reference.imageUrl;
    image.alt = reference.title;
    image.loading = "lazy";
    image.addEventListener("error", () => {
      figure.dataset.unavailable = "true";
      image.remove();
    });
    const caption = document.createElement("figcaption");
    const title = document.createElement("strong");
    title.textContent = reference.title;
    const domain = document.createElement("span");
    domain.textContent = hostname(reference.sourceUrl);
    caption.append(title, domain);
    figure.append(image, caption);
    link.append(figure);
    gallery.append(link);
  }
  if (references.length === 0) {
    const empty = document.createElement("p");
    empty.className = "dossier-muted";
    empty.textContent = "No reference images were retained for this run.";
    gallery.append(empty);
  }
  return gallery;
}

function traceCard(titleText: string, values: string[], emptyText: string): HTMLElement {
  const card = document.createElement("article");
  const title = document.createElement("h4");
  title.textContent = titleText;
  const list = document.createElement("ul");
  const items = values.length > 0 ? values : [emptyText];
  for (const value of items) {
    const item = document.createElement("li");
    item.textContent = value;
    list.append(item);
  }
  card.append(title, list);
  return card;
}

function perspectiveLabel(value: string): string {
  const labels: Record<string, string> = {
    "visual-identity": "Visual identity",
    "objects-materials": "Anatomy & tissue",
    "scale-space": "Scale & spatial relationships",
  };
  return labels[value] ?? humanize(value);
}

function hostname(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "source";
  }
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function escapeMarkup(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#039;",
  })[character] ?? character);
}

async function runGuidedViewer(projectId: string): Promise<void> {
  workflowPanel.hidden = false;
  wireConsoleToggle();
  stageEmpty.hidden = false;
  title.textContent = "Building surgical anatomy";
  status.textContent = "Waiting for the backend graph…";
  let lastSequence = -1;
  let lastNode = "";
  let stopElapsed: (() => void) | null = null;
  let sceneMounted = false;
  let stopped = false;
  let timer = 0;

  const refresh = async (): Promise<void> => {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/interaction`, { cache: "no-store" });
    if (!response.ok) throw new Error(`Interaction request failed: ${response.status}`);
    const interaction = (await response.json()) as InteractionResponse;
    if (interaction.state.sequence !== lastSequence) {
      lastSequence = interaction.state.sequence;
      renderResearchDossier(projectId, interaction.state.researchDossier);
      renderWorkflowAction(projectId, interaction.state, refresh);
      // The clock measures the current node, so it restarts whenever the node does.
      if (interaction.state.currentNode !== lastNode) {
        lastNode = interaction.state.currentNode;
        stopElapsed?.();
        stopElapsed = interaction.state.status === "running" ? startElapsed() : null;
        if (interaction.state.status !== "running") workflowElapsed.hidden = true;
      }
    }
    // A running node marks its ledger row as working so a long model call is
    // visibly alive rather than indistinguishable from a hang.
    nowSection.dataset.working = String(interaction.state.status === "running");
    consoleStop.hidden = interaction.state.status !== "running";
    await renderActivity(projectId);
    if (!sceneMounted && interaction.state.finalSceneRevision) {
      sceneMounted = true;
      stageEmpty.hidden = true;
      await renderManifest(interaction.sceneUrl);
    } else if (!sceneMounted) {
      status.textContent = graphStatus(interaction.state);
      window.__SEEIN_READY__ = true;
    }
    stopped = interaction.state.status === "completed" || interaction.state.status === "failed";
    if (stopped) {
      stopElapsed?.();
      stopElapsed = null;
      workflowElapsed.hidden = true;
    }
  };

  const startPolling = (): void => {
    window.clearInterval(timer);
    timer = window.setInterval(() => {
      if (stopped) {
        window.clearInterval(timer);
        return;
      }
      void refresh().catch((error: unknown) => showWorkflowError(error));
    }, 1500);
  };

  restartPolling = () => {
    stopped = false;
    lastSequence = -1;
    startPolling();
  };

  wireStop(projectId, refresh);
  await refresh();
  startPolling();
}

// Set while the guided viewer is mounted so a rewind can wake the poll loop back up.

/**
 * Clarification owns the whole screen: it is the only thing being asked, and the
 * console behind it has nothing to add. Supplied options become selectable chips,
 * because a suggestion you have to retype is not a suggestion.
 */
function renderClarificationFlow(
  projectId: string,
  state: WorkflowGraphState,
  refresh: () => Promise<void>,
): void {
  const clarification = state.clarification;
  if (!clarification) return;
  if (flow.dataset.sequence === String(state.sequence)) return;
  flow.dataset.sequence = String(state.sequence);

  const inner = document.createElement("div");
  inner.className = "flow__inner";
  const count = document.createElement("p");
  count.className = "flow__count";
  count.textContent = `${clarification.questions.length} question${clarification.questions.length === 1 ? "" : "s"} before research`;
  const lede = document.createElement("p");
  lede.className = "flow__lede";
  lede.textContent = clarification.summary;

  const form = document.createElement("form");
  const answers = new Map<string, string>();

  for (const question of clarification.questions) {
    const block = document.createElement("section");
    block.className = "q";
    const ask = document.createElement("h2");
    ask.className = "q__ask";
    ask.textContent = question.question;
    block.append(ask);
    if (question.reason) {
      const why = document.createElement("p");
      why.className = "q__why";
      why.textContent = question.reason;
      block.append(why);
    }

    const free = document.createElement("textarea");
    free.rows = 2;
    free.placeholder = question.options.length > 0 ? "Or write your own" : "Your answer";
    free.addEventListener("input", () => {
      answers.set(question.id, free.value.trim());
      for (const chip of block.querySelectorAll<HTMLButtonElement>(".chip")) {
        chip.setAttribute("aria-pressed", String(chip.textContent === free.value.trim()));
      }
    });

    if (question.options.length > 0) {
      const chips = document.createElement("div");
      chips.className = "q__chips";
      for (const option of question.options) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "chip";
        chip.textContent = option;
        chip.setAttribute("aria-pressed", "false");
        chip.addEventListener("click", () => {
          const chosen = chip.getAttribute("aria-pressed") === "true";
          for (const other of chips.querySelectorAll<HTMLButtonElement>(".chip")) {
            other.setAttribute("aria-pressed", "false");
          }
          chip.setAttribute("aria-pressed", String(!chosen));
          free.value = chosen ? "" : option;
          answers.set(question.id, free.value);
        });
        chips.append(chip);
      }
      block.append(chips);
    }
    block.append(free);
    form.append(block);
  }

  const extra = document.createElement("textarea");
  extra.rows = 2;
  extra.placeholder = "Anything else that should shape the anatomy (optional)";
  const extraBlock = document.createElement("section");
  extraBlock.className = "q";
  extraBlock.append(extra);
  form.append(extraBlock);

  const actions = document.createElement("div");
  actions.className = "flow__actions";
  const submit = actionButton("Research the anatomy");
  submit.type = "submit";
  const note = document.createElement("span");
  note.className = "flow__note";
  note.textContent = "Unanswered questions become stated assumptions.";
  actions.append(submit, note);
  form.append(actions);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const payload = clarification.questions
      .map((question) => ({ questionId: question.id, answer: (answers.get(question.id) ?? "").trim() }))
      .filter((entry) => entry.answer);
    void submitWorkflowAction(
      form,
      `/api/projects/${encodeURIComponent(projectId)}/clarifications`,
      { answers: payload, additionalContext: extra.value.trim() },
      async () => { flow.hidden = true; await refresh(); },
    );
  });

  inner.append(count, lede, form);
  flow.replaceChildren(inner);
  flow.hidden = false;
}

/**
 * Approval blocks the run, so it is presented as a modal rather than as one more
 * card in a scrolling rail. When only one action is actually available the modal
 * offers exactly that action: an audit that still reports gaps cannot be approved,
 * so it asks to research them instead of showing a disabled button beside a live one.
 */
function renderApprovalModal(
  projectId: string,
  state: WorkflowGraphState,
  refresh: () => Promise<void>,
): void {
  const dossier = state.researchDossier;
  if (!dossier) return;
  if (modal.dataset.sequence === String(state.sequence)) return;
  modal.dataset.sequence = String(state.sequence);

  const ready = dossier.readiness.decision === "ready";
  const failing = dossier.readiness.checks.filter((check) => !check.passed);

  const inner = document.createElement("div");
  inner.className = "modal__inner";
  const title = document.createElement("h2");
  title.id = "modal-title";
  title.className = "modal__title";
  title.textContent = ready ? "The evidence is ready" : "Some evidence is still missing";
  const lede = document.createElement("p");
  lede.className = "modal__lede";
  lede.textContent = ready
    ? `${dossier.objectStudies.length} anatomical structures are supported by ${dossier.brief.sources.length} retrieved sources. Building will use only this evidence.`
    : `${failing.length} of ${dossier.readiness.checks.length} checks did not pass. One more targeted round can look specifically for what is missing.`;
  inner.append(title, lede);

  for (const check of failing) {
    const row = document.createElement("div");
    row.className = "check";
    row.dataset.passed = "false";
    const text = document.createElement("div");
    const label = document.createElement("strong");
    label.textContent = check.label;
    const evidence = document.createElement("p");
    evidence.textContent = check.evidence;
    text.append(label, evidence);
    row.append(text);
    inner.append(row);
  }

  const form = document.createElement("form");
  form.method = "dialog";
  const actions = document.createElement("div");
  actions.className = "modal__actions";

  const close = async (): Promise<void> => { modal.close(); await refresh(); };

  if (ready) {
    const approve = actionButton("Approve and build");
    approve.addEventListener("click", () => {
      void submitWorkflowAction(form, `/api/projects/${encodeURIComponent(projectId)}/research-decision`,
        { decision: "approve" }, close);
    });
    const more = actionButton("Look for more first", "secondary");
    more.addEventListener("click", () => {
      void submitWorkflowAction(form, `/api/projects/${encodeURIComponent(projectId)}/research-decision`,
        { decision: "research-more" }, close);
    });
    actions.append(approve, more);
  } else {
    // The only action the backend will accept, so it is the only one offered.
    const research = actionButton("Research the gaps");
    research.addEventListener("click", () => {
      void submitWorkflowAction(form, `/api/projects/${encodeURIComponent(projectId)}/research-decision`,
        { decision: "research-more" }, close);
    });
    actions.append(research);
  }

  const details = document.createElement("button");
  details.type = "button";
  details.className = "modal__detail-link";
  details.textContent = "Review the research dossier";
  details.addEventListener("click", () => {
    modal.close();
    openResearchDossier();
  });

  form.append(actions);
  inner.append(form, details);
  modal.replaceChildren(inner);
  if (!modal.open) modal.showModal();
}

function renderWorkflowAction(
  projectId: string,
  state: WorkflowGraphState,
  refresh: () => Promise<void>,
): void {
  workflowNode.textContent = humanize(state.currentNode);
  workflowGuidance.textContent = state.guidance;
  // One line answers "how far along am I" so the full ledger can stay folded.
  const doneCount = state.steps.filter((step) => step.status === "completed").length;
  const activeIndex = state.steps.findIndex((step) => step.status === "active" || step.status === "waiting");
  workflowProgress.textContent = `Step ${Math.min(state.steps.length, (activeIndex >= 0 ? activeIndex : doneCount) + 1)} of ${state.steps.length}`;
  consolePeekProgress.textContent = workflowProgress.textContent;
  consolePeekNode.textContent = humanize(state.currentNode);
  activity.hidden = false;
  workflowSteps.replaceChildren(
    ...state.steps.map((step, index) => {
      const item = document.createElement("li");
      item.className = "ledger__item";
      item.dataset.status = step.status;
      const marker = document.createElement("span");
      marker.className = "ledger__index";
      marker.textContent = String(index + 1).padStart(2, "0");
      const label = document.createElement("span");
      label.textContent = step.label;
      item.append(marker, label);
      return item;
    }),
  );
  workflowAction.replaceChildren();

  if (state.status === "failed") {
    const card = document.createElement("div");
    card.className = "card";
    const heading = document.createElement("h2");
    heading.textContent = state.failedNode
      ? `Stopped at ${humanize(state.failedNode)}`
      : "The run stopped";
    card.append(heading);
    if (state.failureMessage) {
      const detail = document.createElement("pre");
      detail.className = "failure";
      detail.textContent = state.failureMessage.split("\n").slice(0, 6).join("\n");
      card.append(detail);
    }
    const hint = document.createElement("p");
    hint.textContent = "Pick a checkpoint below to rewind to. Cached work is replayed, not regenerated.";
    card.append(hint);
    workflowAction.append(card);
  }

  if (state.status !== "running") {
    void renderCheckpointHistory(projectId, refresh);
  }

  if (state.currentNode === "await-clarification" && state.clarification) {
    renderClarificationFlow(projectId, state, refresh);
  } else {
    flow.hidden = true;
  }

  if (state.currentNode === "await-research-approval" && state.researchDossier) {
    renderApprovalModal(projectId, state, refresh);
  }

  if (state.currentNode === "await-feedback") {
    const card = document.createElement("section");
    card.className = "card";
    const heading = document.createElement("h2");
    heading.textContent = state.finalInspection?.verdict === "pass"
      ? "Surgeon-facing visual QA passed"
      : "Review the final anatomy visualization";
    const evidence = document.createElement("p");
    evidence.textContent = state.finalInspection?.evidence || "Explore every anatomy, approach, and procedure state before accepting the result.";
    const categories = document.createElement("div");
    categories.className = "categories";
    for (const category of ["anatomy", "laterality", "missing-part", "critical-structure", "surgical-approach", "procedure-step", "scale", "occlusion", "lighting", "label", "teaching-order", "style", "other"]) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = "category";
      input.value = category;
      label.append(input, document.createTextNode(humanize(category)));
      categories.append(label);
    }
    const comment = document.createElement("textarea");
    comment.rows = 3;
    comment.placeholder = "Name the incorrect or missing anatomy, relationship, view, or procedure step and what it should show.";
    const preferenceLabel = document.createElement("label");
    preferenceLabel.textContent = "Optional preference to carry into future projects";
    const preferenceKey = document.createElement("select");
    const preferenceOptions: Array<[string, string]> = [
      ["visual-style", "Visual style"],
      ["guidance-density", "Guidance density"],
      ["overview-order", "Teaching order"],
      ["label-density", "Label density"],
      ["accuracy-priority", "Accuracy priority"],
      ["other", "Other"],
    ];
    for (const [value, label] of preferenceOptions) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      preferenceKey.append(option);
    }
    const preferenceValue = document.createElement("input");
    preferenceValue.placeholder = "For example: always begin with a sparse overview";
    preferenceLabel.append(preferenceKey, preferenceValue);
    const actions = document.createElement("div");
    actions.className = "actions";
    const accept = actionButton("Accept anatomy visualization");
    const reviseScene = actionButton("Correct anatomy", "secondary");
    const reviseIntent = actionButton("Revise clinical intent", "secondary");
    actions.append(accept, reviseScene, reviseIntent);
    card.append(heading, evidence, categories, comment, preferenceLabel, actions);
    const submit = (decision: string): void => {
      const selected = [...categories.querySelectorAll<HTMLInputElement>('input:checked')].map((input) => input.value);
      void submitWorkflowAction(
        card,
        `/api/projects/${encodeURIComponent(projectId)}/feedback`,
        {
          decision,
          categories: selected,
          objectIds: [],
          comment: comment.value.trim(),
          preferences: preferenceValue.value.trim()
            ? [{ key: preferenceKey.value, value: preferenceValue.value.trim() }]
            : [],
        },
        refresh,
      );
    };
    accept.addEventListener("click", () => submit("accept"));
    reviseScene.addEventListener("click", () => submit("revise-scene"));
    reviseIntent.addEventListener("click", () => submit("revise-intent"));
    workflowAction.append(card);
    return;
  }

  if (state.currentNode === "quality-blocked") {
    const card = document.createElement("section");
    card.className = "card";
    const heading = document.createElement("h2");
    heading.textContent = "Anatomical construction is not complete yet";
    const coverage = state.qaCoverage;
    const detail = document.createElement("p");
    detail.textContent = coverage
      ? `${coverage.passedTargetIds.length}/${coverage.requiredTargets.length} required state/view checks pass at revision ${state.finalSceneRevision ?? "?"}. ${coverage.unresolvedTargetIds.length} remain unresolved after ${coverage.refinements} correction(s).`
      : "A required anatomical quality gate remains unresolved. This visualization cannot be accepted until every required operative view passes.";
    const evidence = document.createElement("p");
    evidence.className = "field__why";
    evidence.textContent = state.finalInspection?.evidence ?? "Use the generation checkpoint below to continue the correction loop.";
    const supervisor = state.qualitySupervisor;
    const supervisorDetail = document.createElement("p");
    supervisorDetail.className = "field__why";
    supervisorDetail.textContent = supervisor
      ? `Supervisor: ${humanize(supervisor.status)} · ${supervisor.attempt} repair action(s) · ${supervisor.inspections} inspection(s) · ${supervisor.targetedResearchRounds} targeted research round(s) · ${supervisor.replans} replan(s) · ${supervisor.logicalAiCalls} logical AI call(s). Best scores — recognizability ${Math.round(supervisor.bestScores.recognizability * 100)}%, domain fidelity ${Math.round(supervisor.bestScores.domainFidelity * 100)}%, visual quality ${Math.round(supervisor.bestScores.visualQuality * 100)}%, construction ${Math.round(supervisor.bestScores.constructionCompleteness * 100)}%.`
      : "The backend quality supervisor stopped at a durable checkpoint.";
    card.append(heading, detail, evidence, supervisorDetail);
    workflowAction.append(card);
    return;
  }

  if (state.currentNode === "completed") {
    const card = document.createElement("section");
    card.className = "card";
    const message = document.createElement("p");
    message.textContent = state.nextProjectId
      ? "Your requested revision has started as a linked project with the same explicit preference profile."
      : "This anatomy visualization is accepted and its reusable evidence, structures, views, and preferences are indexed.";
    card.append(message);
    if (state.nextProjectId) {
      const link = document.createElement("a");
      link.className = "workflow-link";
      link.href = `/api/projects/${encodeURIComponent(state.nextProjectId)}/view`;
      link.textContent = "Open linked revision";
      card.append(link);
    }
    workflowAction.append(card);
  }
}

async function renderCheckpointHistory(projectId: string, refresh: () => Promise<void>): Promise<void> {
  let checkpoints: CheckpointSummary[];
  try {
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/checkpoints`, { cache: "no-store" });
    if (!response.ok) return;
    ({ checkpoints } = (await response.json()) as { checkpoints: CheckpointSummary[] });
  } catch {
    return;
  }
  const resumable = checkpoints.filter((checkpoint) => checkpoint.resumable);
  if (resumable.length === 0) return;

  const card = document.createElement("div");
  card.className = "card";
  const heading = document.createElement("h2");
  heading.textContent = "Rewind to a checkpoint";
  card.append(heading);

  const fresh = document.createElement("label");
  fresh.className = "field__why";
  const freshInput = document.createElement("input");
  freshInput.type = "checkbox";
  fresh.append(freshInput, document.createTextNode("Ignore cached steps (regenerate from here)"));
  card.append(fresh);

  const list = document.createElement("ul");
  list.className = "checkpoints";
  for (const checkpoint of resumable) {
    const item = document.createElement("li");
    const button = actionButton("", "checkpoint-entry");
    button.dataset.stage = checkpoint.stage ?? "";
    const label = document.createElement("strong");
    label.textContent = `${checkpoint.sequence}. ${humanize(checkpoint.node)}`;
    const summary = document.createElement("span");
    summary.textContent = checkpoint.guidance;
    button.append(label, summary);
    button.addEventListener("click", () => {
      void submitWorkflowAction(
        card,
        `/api/projects/${encodeURIComponent(projectId)}/resume`,
        { sequence: checkpoint.sequence, fresh: freshInput.checked },
        async () => {
          restartPolling?.();
          await refresh();
        },
      );
    });
    item.append(button);
    list.append(item);
  }
  card.append(list);
  workflowAction.append(card);
}

async function submitWorkflowAction(
  container: HTMLElement,
  url: string,
  body: unknown,
  refresh: () => Promise<void>,
): Promise<void> {
  for (const button of container.querySelectorAll<HTMLButtonElement>("button")) button.disabled = true;
  container.querySelector(".workflow-error")?.remove();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = await response.json() as { error?: string };
    if (!response.ok) throw new Error(result.error || `Request failed: ${response.status}`);
    await refresh();
  } catch (error) {
    const message = document.createElement("p");
    message.className = "error-text";
    message.textContent = error instanceof Error ? error.message : String(error);
    container.append(message);
    for (const button of container.querySelectorAll<HTMLButtonElement>("button")) button.disabled = false;
  }
}

function actionButton(label: string, className = ""): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `act ${className}`.trim();
  button.textContent = label;
  return button;
}

function graphStatus(state: WorkflowGraphState): string {
  if (state.status === "waiting") return `Waiting: ${humanize(state.currentNode)}`;
  if (state.status === "failed") return "The backend graph stopped; see the guidance panel.";
  return `${humanize(state.currentNode)}…`;
}

function humanize(value: string): string {
  return value.replaceAll("-", " ").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function showWorkflowError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  status.textContent = message;
  status.style.color = "#fca5a5";
}


function requiredElement(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Renderer shell is missing ${selector}`);
  return element;
}
