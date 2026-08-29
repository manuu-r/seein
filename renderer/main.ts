import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";
import {
  createProceduralExtrusionGeometry,
  createProceduralLatheGeometry,
  createSizedPrimitiveGeometry,
  createTaperedTubeGeometry,
} from "../src/scene/procedural-geometry.js";

interface SceneObjectRecord {
  id: string;
  url: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  label: string;
  labelPosition?: [number, number, number];
  labelVisible: boolean;
  highlight: boolean;
}

interface ProceduralMaterialRecord {
  id: string;
  color: string;
  roughness: number;
  metalness: number;
  opacity: number;
  emissive: string;
  emissiveIntensity: number;
  side: "front" | "back" | "double";
}

interface ProceduralPathPointRecord {
  landmarkId?: string;
  position?: [number, number, number];
  offset: [number, number, number];
  radius?: number;
}

interface ProceduralNodeBaseRecord {
  id: string;
  name: string;
  materialId: string;
  parentId?: string;
  label: string;
  labelPosition?: [number, number, number];
  labelVisible: boolean;
  highlight: boolean;
  castShadow: boolean;
  receiveShadow: boolean;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
}

type ProceduralNodeRecord = ProceduralNodeBaseRecord & (
  | { kind: "primitive"; shape: "box" | "sphere" | "cylinder" | "cone" | "torus" | "capsule"; size: [number, number, number]; segments: number }
  | { kind: "tube"; points: ProceduralPathPointRecord[]; radius: number; radialSegments: number; tubularSegments: number; closed: boolean }
  | { kind: "extrusion"; outline: Array<[number, number]>; depth: number; bevel: number }
  | { kind: "lathe"; profile: Array<[number, number]>; segments: number }
  | { kind: "instances"; shape: "box" | "sphere" | "cylinder" | "cone"; size: [number, number, number]; segments: number; instances: Array<{ position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number] }> }
);

interface ProceduralProgramRecord {
  coordinateFrame: { metersPerUnit: number };
  landmarks: Array<{ id: string; position: [number, number, number] }>;
  materials: ProceduralMaterialRecord[];
  nodes: ProceduralNodeRecord[];
  views: Array<{
    id: string;
    label: string;
    position: [number, number, number];
    target: [number, number, number];
    fov: number;
    required: boolean;
    stateIds: string[];
  }>;
}

interface Manifest {
  title: string;
  environment: { background: string; groundColor: string; groundSize: number };
  camera: { position: [number, number, number]; target: [number, number, number]; fov: number };
  lights: Array<{ id: string; type: string; color: string; intensity: number; position: [number, number, number] }>;
  objects: SceneObjectRecord[];
  procedural?: ProceduralProgramRecord;
  states: Array<{
    id: string;
    label: string;
    visibleObjects: string[];
    highlightedObjects: string[];
    visibleNodes?: string[];
    highlightedNodes?: string[];
    cameraViewId?: string;
    mutations?: Array<{
      entityId: string;
      position?: [number, number, number];
      rotation?: [number, number, number];
      scale?: [number, number, number];
      opacity?: number;
    }>;
  }>;
  transitions: Array<{
    from: string;
    to: string;
    durationMs: number;
    kind?: "normal" | "alternative" | "complication";
    condition?: string;
    description?: string;
  }>;
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
      sources: Array<{ url: string; title: string }>;
      references: Array<{ imageUrl: string; sourceUrl: string; title: string }>;
    };
    objectStudies: Array<{ id: string; name: string; identityMarkers: string[]; referenceImageUrls?: string[] }>;
    searchAttribution?: { model: string; queries: string[]; renderedContent: string };
    readiness: {
      decision: "ready" | "needs-research" | "needs-user";
      score: number;
      checks: Array<{ id: string; label: string; passed: boolean; evidence: string }>;
      gaps: string[];
    };
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
  state: WorkflowGraphState;
  sceneUrl: string;
}

declare global {
  interface Window {
    __SEEIN_READY__?: boolean;
    __SEEIN_ERRORS__?: string[];
    __SEEIN_RENDER_STATE__?: {
      assetsLoaded: boolean;
      proceduralCompiled: boolean;
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
const workflowElapsed = requiredElement("#workflow-elapsed");
const activity = requiredElement("#activity");
const activityList = requiredElement("#activity-list");

// Assigned by runGuidedViewer, which can run during module evaluation.
let restartPolling: (() => void) | null = null;

const LAUNCHER_EXAMPLES = [
  "Right hepatic hilum anatomy for laparoscopic cholecystectomy, including Calot’s triangle and structures at risk",
  "Endoscopic endonasal transsphenoidal approach to the pituitary with carotid and optic relationships",
  "Microsurgical clipping view of a middle cerebral artery bifurcation aneurysm with perforators preserved",
];


window.__SEEIN_READY__ = false;
window.__SEEIN_ERRORS__ = [];
window.__SEEIN_RENDER_STATE__ = {
  assetsLoaded: false,
  proceduralCompiled: false,
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
    container.append(entry);
  }
  container.hidden = false;
}

async function renderManifest(manifestUrl: string): Promise<void> {
  stageEmpty.hidden = true;
  const response = await fetch(manifestUrl);
  if (!response.ok) throw new Error(`Manifest request failed: ${response.status}`);
  const manifest = (await response.json()) as Manifest;
  title.textContent = manifest.title;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(manifest.environment.background);
  const sceneRoot = new THREE.Group();
  sceneRoot.name = "SceneRoot";
  scene.add(sceneRoot);

  const camera = new THREE.PerspectiveCamera(manifest.camera.fov, innerWidth / innerHeight, 0.01, 1000);
  camera.position.fromArray(manifest.camera.position);

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  viewport.append(renderer.domElement);

  const labelRenderer = new CSS2DRenderer();
  labelRenderer.setSize(innerWidth, innerHeight);
  labelRenderer.domElement.style.position = "fixed";
  labelRenderer.domElement.style.inset = "0";
  labelRenderer.domElement.style.pointerEvents = "none";
  viewport.append(labelRenderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.fromArray(manifest.camera.target);
  controls.enableDamping = true;
  controls.update();

  addEnvironment(sceneRoot, manifest);
  const objectRoots = new Map<string, THREE.Object3D>();
  const loader = new GLTFLoader();
  await Promise.all(
    manifest.objects.map(async (record) => {
      try {
        const gltf = await loader.loadAsync(record.url);
        const root = gltf.scene;
        root.name = record.id;
        root.position.fromArray(record.position);
        root.rotation.fromArray([...record.rotation, "XYZ"]);
        root.scale.fromArray(record.scale);
        if (record.highlight) setHighlight(root, true);
        const label = document.createElement("div");
        label.className = "scene-label";
        label.textContent = record.label;
        label.hidden = !record.labelVisible;
        const labelObject = new CSS2DObject(label);
        const bounds = new THREE.Box3().setFromObject(root);
        labelObject.position.set(0, Math.max(0.6, bounds.max.y - bounds.min.y + 0.25), 0);
        root.add(labelObject);
        sceneRoot.add(root);
        objectRoots.set(record.id, root);
      } catch (error) {
        const message = `${record.id}: ${error instanceof Error ? error.message : String(error)}`;
        window.__SEEIN_ERRORS__?.push(message);
        const fallback = new THREE.Mesh(
          new THREE.BoxGeometry(0.5, 0.5, 0.5),
          new THREE.MeshStandardMaterial({ color: "#ef4444", wireframe: true }),
        );
        fallback.position.fromArray(record.position);
        fallback.name = record.id;
        sceneRoot.add(fallback);
        objectRoots.set(record.id, fallback);
      }
    }),
  );
  if (window.__SEEIN_RENDER_STATE__) window.__SEEIN_RENDER_STATE__.assetsLoaded = true;

  if (manifest.procedural) buildProceduralProgram(manifest.procedural, sceneRoot, objectRoots);
  if (window.__SEEIN_RENDER_STATE__) window.__SEEIN_RENDER_STATE__.proceduralCompiled = true;

  const query = new URLSearchParams(location.search);
  const requestedView = query.get("view") ?? "";
  const requestedState = query.get("state") ?? "";
  const applyView = (viewId: string): void => {
    const view = manifest.procedural?.views.find((candidate) => candidate.id === viewId);
    if (!view) return;
    camera.position.fromArray(view.position);
    camera.fov = view.fov;
    camera.updateProjectionMatrix();
    controls.target.fromArray(view.target);
    controls.update();
    if (window.__SEEIN_RENDER_STATE__) {
      window.__SEEIN_RENDER_STATE__.viewId = viewId;
      window.__SEEIN_RENDER_STATE__.cameraSettled = true;
      window.__SEEIN_RENDER_STATE__.stableFrames = 0;
    }
  };
  const selectedView = manifest.procedural?.views.find((view) => view.id === requestedView)
    ?? manifest.procedural?.views.find((view) => view.required)
    ?? manifest.procedural?.views[0];
  if (selectedView) applyView(selectedView.id);
  else if (window.__SEEIN_RENDER_STATE__) window.__SEEIN_RENDER_STATE__.cameraSettled = true;

  buildStateControls(manifest, objectRoots, applyView, requestedState, requestedView);
  status.textContent = window.__SEEIN_ERRORS__?.length
    ? `Rendered with ${window.__SEEIN_ERRORS__.length} asset error(s)`
    : `${manifest.objects.length} anatomical assets · ${manifest.procedural?.nodes.length ?? 0} procedural structures ready`;

  const renderFrame = (): void => {
    controls.update();
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
    if (window.__SEEIN_RENDER_STATE__?.cameraSettled) window.__SEEIN_RENDER_STATE__.stableFrames += 1;
    requestAnimationFrame(renderFrame);
  };
  renderFrame();
  await waitForStableFrames(2);
  window.__SEEIN_READY__ = true;

  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    labelRenderer.setSize(innerWidth, innerHeight);
  });
}

interface ProjectEvent {
  stage?: string;
  status?: string;
  detail?: Record<string, unknown>;
  createdAt?: string;
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
  generating_assets: { doing: "Modelling anatomical structures", done: "Anatomical structures modelled" },
  resolving_assets: { doing: "Resolving reusable anatomy", done: "3D anatomy ready" },
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

  // A stage emits "started" then "completed". Collapse each pair into one line so
  // the reader sees a list of things that happened, not a transaction log.
  const merged = new Map<string, { stage: string; status: string; detail: Record<string, unknown> | undefined; at: string | undefined; startedAt: string | undefined }>();
  for (const event of events) {
    const stage = event.stage ?? "step";
    const existing = merged.get(stage);
    if (event.status === "started") {
      merged.set(stage, { stage, status: "started", detail: undefined, at: event.createdAt, startedAt: event.createdAt });
    } else {
      merged.set(stage, {
        stage,
        status: event.status ?? "info",
        detail: event.detail,
        at: event.createdAt,
        startedAt: existing?.startedAt,
      });
    }
  }

  const now = Date.now();
  const rows = [...merged.values()].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "")).slice(0, 8);
  if (rows.length === 0) return;
  activityList.replaceChildren(
    ...rows.map((row) => {
      const item = document.createElement("li");
      item.className = "step";
      item.dataset.status = row.status;
      const headline = document.createElement("div");
      headline.className = "step__what";
      headline.textContent = storyFor(row.stage, row.status);
      const meta = document.createElement("div");
      meta.className = "step__meta";
      const detail = storyDetail(row.stage, row.detail);
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

function wireConsoleToggle(): void {
  const setCollapsed = (collapsed: boolean): void => {
    workflowPanel.dataset.collapsed = String(collapsed);
    consoleToggle.textContent = collapsed ? "Show" : "Hide";
    consoleToggle.setAttribute("aria-expanded", String(!collapsed));
  };
  setCollapsed(false);
  consoleToggle.addEventListener("click", () => {
    setCollapsed(workflowPanel.dataset.collapsed !== "true");
  });
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

  const details = document.createElement("a");
  details.className = "modal__detail-link";
  details.href = `/api/projects/${encodeURIComponent(projectId)}/interaction`;
  details.target = "_blank";
  details.rel = "noreferrer";
  details.textContent = "See the full dossier";

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

function buildProceduralProgram(
  program: ProceduralProgramRecord,
  sceneRoot: THREE.Group,
  objectRoots: Map<string, THREE.Object3D>,
): void {
  const programRoot = new THREE.Group();
  programRoot.name = "ProceduralRoot";
  programRoot.scale.setScalar(program.coordinateFrame.metersPerUnit);
  sceneRoot.add(programRoot);

  const landmarks = new Map(program.landmarks.map((landmark) => [landmark.id, landmark.position]));
  const materials = new Map(program.materials.map((record) => [record.id, record]));
  const built = new Map<string, THREE.Object3D>();

  for (const node of program.nodes) {
    const materialRecord = materials.get(node.materialId);
    if (!materialRecord) throw new Error(`Procedural node ${node.id} uses missing material ${node.materialId}`);
    const material = createProceduralMaterial(materialRecord);
    const root = createProceduralNode(node, material, landmarks);
    root.name = node.id;
    root.position.fromArray(node.position);
    root.rotation.fromArray([...node.rotation, "XYZ"]);
    root.scale.fromArray(node.scale);
    root.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.castShadow = node.castShadow;
      child.receiveShadow = node.receiveShadow;
    });
    if (node.highlight) setHighlight(root, true);
    addSceneLabel(root, node.label, node.labelVisible, node.labelPosition);
    built.set(node.id, root);
    objectRoots.set(node.id, root);
  }

  for (const node of program.nodes) {
    const root = built.get(node.id)!;
    const parent = node.parentId ? built.get(node.parentId) : undefined;
    (parent ?? programRoot).add(root);
  }
}

function createProceduralMaterial(record: ProceduralMaterialRecord): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: record.color,
    roughness: record.roughness,
    metalness: record.metalness,
    opacity: record.opacity,
    transparent: record.opacity < 0.999,
    depthWrite: record.opacity >= 0.999,
    emissive: record.emissive,
    emissiveIntensity: record.emissiveIntensity,
    side: record.side === "double" ? THREE.DoubleSide : record.side === "back" ? THREE.BackSide : THREE.FrontSide,
    clearcoat: record.metalness > 0.35 ? 0.18 : 0.04,
    clearcoatRoughness: Math.min(1, record.roughness + 0.1),
  });
}

function createProceduralNode(
  node: ProceduralNodeRecord,
  material: THREE.Material,
  landmarks: Map<string, [number, number, number]>,
): THREE.Object3D {
  if (node.kind === "instances") {
    const geometry = createSizedPrimitiveGeometry(node.shape, node.size, node.segments);
    const mesh = new THREE.InstancedMesh(geometry, material, node.instances.length);
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    for (const [index, instance] of node.instances.entries()) {
      quaternion.setFromEuler(new THREE.Euler(...instance.rotation, "XYZ"));
      matrix.compose(new THREE.Vector3(...instance.position), quaternion, new THREE.Vector3(...instance.scale));
      mesh.setMatrixAt(index, matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  }

  let geometry: THREE.BufferGeometry;
  if (node.kind === "primitive") {
    geometry = createSizedPrimitiveGeometry(node.shape, node.size, node.segments);
  } else if (node.kind === "tube") {
    const points = node.points.map((point, index) => {
      const source = point.position ?? (point.landmarkId ? landmarks.get(point.landmarkId) : undefined);
      if (!source) throw new Error(`Tube ${node.id} point ${index} has no resolvable coordinate`);
      return {
        position: new THREE.Vector3(source[0] + point.offset[0], source[1] + point.offset[1], source[2] + point.offset[2]),
        radius: point.radius ?? node.radius,
      };
    });
    geometry = createTaperedTubeGeometry(points, node.tubularSegments, node.radialSegments, node.closed);
  } else if (node.kind === "extrusion") {
    geometry = createProceduralExtrusionGeometry(node.outline, node.depth, node.bevel);
  } else {
    geometry = createProceduralLatheGeometry(node.profile, node.segments);
  }
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material);
}

function addSceneLabel(
  root: THREE.Object3D,
  text: string,
  visible: boolean,
  position?: [number, number, number],
): void {
  const label = document.createElement("div");
  label.className = "scene-label";
  label.textContent = text;
  label.hidden = !visible;
  const labelObject = new CSS2DObject(label);
  const bounds = new THREE.Box3().setFromObject(root);
  const height = bounds.isEmpty() ? 0.5 : bounds.max.y - bounds.min.y;
  if (position) labelObject.position.fromArray(position);
  else labelObject.position.set(0, Math.max(0.25, height / 2 + 0.15), 0);
  root.add(labelObject);
}

async function waitForStableFrames(required: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const check = (): void => {
      if ((window.__SEEIN_RENDER_STATE__?.stableFrames ?? 0) >= required) resolve();
      else requestAnimationFrame(check);
    };
    check();
  });
}

function addEnvironment(root: THREE.Group, manifest: Manifest): void {
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(manifest.environment.groundSize, manifest.environment.groundSize),
    new THREE.MeshStandardMaterial({ color: manifest.environment.groundColor, roughness: 0.92 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.name = "Ground";
  root.add(ground);
  for (const record of manifest.lights) {
    let light: THREE.Light;
    if (record.type === "ambient") light = new THREE.AmbientLight(record.color, record.intensity);
    else if (record.type === "hemisphere") light = new THREE.HemisphereLight(record.color, "#1e293b", record.intensity);
    else if (record.type === "point") light = new THREE.PointLight(record.color, record.intensity);
    else light = new THREE.DirectionalLight(record.color, record.intensity);
    light.name = record.id;
    light.position.fromArray(record.position);
    light.castShadow = record.type === "directional" || record.type === "point";
    root.add(light);
  }
}

function buildStateControls(
  manifest: Manifest,
  objects: Map<string, THREE.Object3D>,
  applyView: (viewId: string) => void,
  requestedState = "",
  lockedViewId = "",
): void {
  const initialState = manifest.states.find((state) => state.id === requestedState) ?? manifest.states[0];
  let activeStateId = initialState?.id ?? "";
  let animationToken = 0;
  const baseTransforms = new Map([...objects].map(([id, object]) => [id, {
    position: object.position.clone(),
    quaternion: object.quaternion.clone(),
    scale: object.scale.clone(),
  }]));
  const applyState = (stateId: string, immediate = false): void => {
    const state = manifest.states.find((candidate) => candidate.id === stateId);
    if (!state) return;
    const visible = new Set([...state.visibleObjects, ...(state.visibleNodes ?? [])]);
    const highlighted = new Set([...state.highlightedObjects, ...(state.highlightedNodes ?? [])]);
    for (const button of stateControls.querySelectorAll("button")) {
      button.setAttribute("aria-pressed", String(button.dataset.state === stateId));
    }
    const duration = immediate
      ? 0
      : manifest.transitions.find((transition) => transition.from === activeStateId && transition.to === stateId)?.durationMs ?? 350;
    activeStateId = stateId;
    if (window.__SEEIN_RENDER_STATE__) window.__SEEIN_RENDER_STATE__.stateId = stateId;
    if (state.cameraViewId && !lockedViewId) applyView(state.cameraViewId);
    animationToken += 1;
    const token = animationToken;
    const mutations = new Map((state.mutations ?? []).map((mutation) => [mutation.entityId, mutation]));
    const starting = new Map([...objects].map(([id, object]) => [id, {
      opacity: Number(object.userData.seeinOpacityMultiplier ?? (object.visible ? 1 : 0)),
      position: object.position.clone(),
      quaternion: object.quaternion.clone(),
      scale: object.scale.clone(),
    }]));
    for (const object of objects.values()) object.visible = true;
    const startedAt = performance.now();
    const tick = (now: number): void => {
      if (token !== animationToken) return;
      const progress = duration === 0 ? 1 : Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      for (const [id, object] of objects) {
        const start = starting.get(id);
        const base = baseTransforms.get(id);
        if (!start || !base) continue;
        const mutation = mutations.get(id);
        const targetOpacity = visible.has(id) ? (mutation?.opacity ?? 1) : 0;
        const targetPosition = mutation?.position ? new THREE.Vector3(...mutation.position) : base.position;
        const targetQuaternion = mutation?.rotation
          ? new THREE.Quaternion().setFromEuler(new THREE.Euler(...mutation.rotation, "XYZ"))
          : base.quaternion;
        const targetScale = mutation?.scale ? new THREE.Vector3(...mutation.scale) : base.scale;
        setOpacity(object, start.opacity + (targetOpacity - start.opacity) * eased);
        object.position.copy(start.position).lerp(targetPosition, eased);
        object.quaternion.copy(start.quaternion).slerp(targetQuaternion, eased);
        object.scale.copy(start.scale).lerp(targetScale, eased);
        if (progress === 1) {
          object.visible = targetOpacity > 0;
          setOpacity(object, targetOpacity);
          setHighlight(object, highlighted.has(id));
        }
      }
      if (progress < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  for (const [index, state] of manifest.states.entries()) {
    const button = document.createElement("button");
    button.textContent = state.label;
    button.dataset.state = state.id;
    button.setAttribute("aria-pressed", String(index === 0));
    button.addEventListener("click", () => applyState(state.id));
    stateControls.append(button);
  }
  if (initialState) applyState(initialState.id, true);
}

function setHighlight(root: THREE.Object3D, enabled: boolean): void {
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      if (!(material instanceof THREE.MeshStandardMaterial)) continue;
      if (!material.userData.seeinOriginalEmissive) {
        material.userData.seeinOriginalEmissive = material.emissive.getHexString();
        material.userData.seeinOriginalEmissiveIntensity = material.emissiveIntensity;
      }
      material.emissive.set(enabled ? "#0ea5e9" : `#${String(material.userData.seeinOriginalEmissive)}`);
      material.emissiveIntensity = enabled
        ? Math.max(0.25, Number(material.userData.seeinOriginalEmissiveIntensity ?? 0))
        : Number(material.userData.seeinOriginalEmissiveIntensity ?? 0);
    }
  });
}

function setOpacity(root: THREE.Object3D, opacity: number): void {
  root.userData.seeinOpacityMultiplier = opacity;
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      if (material.userData.seeinBaseOpacity === undefined) {
        material.userData.seeinBaseOpacity = material.opacity;
        material.userData.seeinBaseDepthWrite = material.depthWrite;
      }
      const baseOpacity = Number(material.userData.seeinBaseOpacity ?? 1);
      material.opacity = baseOpacity * opacity;
      material.transparent = material.opacity < 0.999;
      material.depthWrite = opacity >= 0.999
        ? Boolean(material.userData.seeinBaseDepthWrite)
        : false;
    }
  });
}

function requiredElement(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Renderer shell is missing ${selector}`);
  return element;
}
