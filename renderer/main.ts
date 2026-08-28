import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/examples/jsm/renderers/CSS2DRenderer.js";

interface SceneObjectRecord {
  id: string;
  url: string;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  label: string;
  labelVisible: boolean;
  highlight: boolean;
}

interface Manifest {
  title: string;
  environment: { background: string; groundColor: string; groundSize: number };
  camera: { position: [number, number, number]; target: [number, number, number]; fov: number };
  lights: Array<{ id: string; type: string; color: string; intensity: number; position: [number, number, number] }>;
  objects: SceneObjectRecord[];
  states: Array<{ id: string; label: string; visibleObjects: string[]; highlightedObjects: string[] }>;
  transitions: Array<{ from: string; to: string; durationMs: number }>;
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
  finalInspection?: { verdict: string; issue: string; evidence: string };
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

// Assigned by runGuidedViewer, which can run during module evaluation.
let restartPolling: (() => void) | null = null;

const LAUNCHER_EXAMPLES = [
  "A compact medieval blacksmith workshop with labeled tools",
  "A cutaway of a four-stroke engine cycle",
  "A coral reef ecosystem with labeled species",
];


window.__SEEIN_READY__ = false;
window.__SEEIN_ERRORS__ = [];

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
  title.textContent = "Start a new scene";

  for (const example of LAUNCHER_EXAMPLES) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "launcher__chip";
    chip.textContent = example;
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
      submit.textContent = "Generate scene";
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

  buildStateControls(manifest, objectRoots);
  status.textContent = window.__SEEIN_ERRORS__?.length
    ? `Rendered with ${window.__SEEIN_ERRORS__.length} asset error(s)`
    : `${manifest.objects.length} assets ready`;
  window.__SEEIN_READY__ = true;

  const renderFrame = (): void => {
    controls.update();
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
    requestAnimationFrame(renderFrame);
  };
  renderFrame();

  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    labelRenderer.setSize(innerWidth, innerHeight);
  });
}

async function runGuidedViewer(projectId: string): Promise<void> {
  workflowPanel.hidden = false;
  stageEmpty.hidden = false;
  title.textContent = "Shaping your visualization";
  status.textContent = "Waiting for the backend graph…";
  let lastSequence = -1;
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
    }
    if (!sceneMounted && interaction.state.finalSceneRevision) {
      sceneMounted = true;
      stageEmpty.hidden = true;
      await renderManifest(interaction.sceneUrl);
    } else if (!sceneMounted) {
      status.textContent = graphStatus(interaction.state);
      window.__SEEIN_READY__ = true;
    }
    stopped = interaction.state.status === "completed" || interaction.state.status === "failed";
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

function renderWorkflowAction(
  projectId: string,
  state: WorkflowGraphState,
  refresh: () => Promise<void>,
): void {
  workflowNode.textContent = humanize(state.currentNode);
  workflowGuidance.textContent = state.guidance;
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
    const form = document.createElement("form");
    form.className = "card";
    const heading = document.createElement("h2");
    heading.textContent = state.clarification.summary;
    form.append(heading);
    for (const question of state.clarification.questions) {
      const label = document.createElement("label");
      label.htmlFor = `answer-${question.id}`;
      label.append(document.createTextNode(question.question));
      const reason = document.createElement("span");
      reason.className = "field__why";
      reason.textContent = `Why I’m asking: ${question.reason}`;
      label.append(reason);
      if (question.options.length > 0) {
        const options = document.createElement("span");
        options.className = "field__hint";
        options.textContent = `Useful starting points: ${question.options.join(" · ")}`;
        label.append(options);
      }
      const answer = document.createElement("textarea");
      answer.id = `answer-${question.id}`;
      answer.name = question.id;
      answer.rows = 2;
      answer.required = question.required;
      label.append(answer);
      form.append(label);
    }
    const extra = document.createElement("textarea");
    extra.name = "additionalContext";
    extra.rows = 2;
    extra.placeholder = "Anything else the visualization should respect (optional)";
    const continueButton = actionButton("Continue to research");
    continueButton.type = "submit";
    form.append(extra, continueButton);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(form);
      const answers = state.clarification!.questions.map((question) => ({
        questionId: question.id,
        answer: String(data.get(question.id) ?? "").trim(),
      })).filter((answer) => answer.answer);
      void submitWorkflowAction(
        form,
        `/api/projects/${encodeURIComponent(projectId)}/clarifications`,
        { answers, additionalContext: String(data.get("additionalContext") ?? "").trim() },
        refresh,
      );
    });
    workflowAction.append(form);
    return;
  }

  if (state.currentNode === "await-research-approval" && state.researchDossier) {
    const dossier = state.researchDossier;
    const card = document.createElement("section");
    card.className = "card";
    const checks = dossier.readiness.checks;
    const failing = checks.filter((check) => !check.passed);
    const heading = document.createElement("h2");
    heading.textContent = failing.length === 0
      ? "Evidence is ready"
      : `${failing.length} of ${checks.length} checks still blocking`;
    const score = document.createElement("span");
    score.className = "readiness__score";
    score.textContent = `${Math.round(dossier.readiness.score * 100)}%`;
    heading.append(score);
    card.append(heading);

    // Blocking checks lead; the passing ones stay auditable but out of the way.
    for (const check of failing) {
      const row = document.createElement("div");
      row.className = "check";
      row.dataset.passed = "false";
      const label = document.createElement("strong");
      label.textContent = check.label;
      const evidence = document.createElement("div");
      evidence.className = "field__why";
      evidence.textContent = check.evidence;
      const text = document.createElement("div");
      text.append(label, evidence);
      row.append(text);
      card.append(row);
    }
    if (failing.length < checks.length) {
      const passed = document.createElement("details");
      passed.className = "passed";
      const summary = document.createElement("summary");
      summary.textContent = `${checks.length - failing.length} checks passed`;
      passed.append(summary);
      for (const check of checks.filter((check) => check.passed)) {
        const row = document.createElement("div");
        row.className = "check";
        row.dataset.passed = "true";
        const text = document.createElement("div");
        const label = document.createElement("strong");
        label.textContent = check.label;
        const evidence = document.createElement("div");
        evidence.className = "field__why";
        evidence.textContent = check.evidence;
        text.append(label, evidence);
        row.append(text);
        passed.append(row);
      }
      card.append(passed);
    }

    // Each study with the references the planner will actually be shown, so the
    // evidence can be judged before generation rather than after.
    const studies = document.createElement("div");
    studies.className = "specimens";
    for (const study of dossier.objectStudies) {
      const entry = document.createElement("div");
      entry.className = "specimen";
      const name = document.createElement("div");
      name.className = "specimen__name";
      name.textContent = study.name;
      entry.append(name);
      const images = study.referenceImageUrls ?? [];
      if (images.length > 0) {
        const strip = document.createElement("div");
        strip.className = "sheet";
        for (const url of images.slice(0, 4)) {
          const frame = document.createElement("a");
          frame.href = url;
          frame.target = "_blank";
          frame.rel = "noreferrer";
          const thumb = document.createElement("img");
          thumb.src = url;
          thumb.alt = "";
          thumb.loading = "lazy";
          thumb.decoding = "async";
          // Several publishers block hotlinking, so a thumbnail can fail in the
          // browser even though the backend downloaded it for the planner. Keep the
          // tile, drop the broken-image glyph, and say the planner still has it.
          thumb.addEventListener("error", () => {
            frame.dataset.unavailable = "true";
            frame.title = "Preview blocked by the source site. The planner still received this image.";
            thumb.remove();
          });
          frame.append(thumb);
          strip.append(frame);
        }
        entry.append(strip);
      } else {
        const none = document.createElement("span");
        none.className = "specimen__none";
        none.textContent = "No reference image; this object is modelled from text alone.";
        entry.append(none);
      }
      studies.append(entry);
    }
    card.append(studies);
    if (dossier.searchAttribution) {
      const attribution = document.createElement("details");
      attribution.className = "attribution";
      const summary = document.createElement("summary");
      summary.textContent = "Google Image Search suggestions and attribution";
      const frame = document.createElement("iframe");
      frame.title = "Google Image Search attribution";
      frame.setAttribute("sandbox", "allow-popups allow-popups-to-escape-sandbox");
      frame.srcdoc = dossier.searchAttribution.renderedContent;
      attribution.append(summary, frame);
      card.append(attribution);
    }
    const feedback = document.createElement("textarea");
    feedback.rows = 2;
    feedback.placeholder = "What evidence is still missing? (required only for more research)";
    const actions = document.createElement("div");
    actions.className = "actions";
    const approve = actionButton("Approve generation");
    approve.disabled = dossier.readiness.decision !== "ready";
    if (approve.disabled) {
      approve.title = `Blocked by: ${failing.map((check) => check.label).join("; ")}`;
    }
    const more = actionButton("Research this gap", "secondary");
    actions.append(approve, more);
    card.append(feedback, actions);
    approve.addEventListener("click", () => void submitWorkflowAction(
      card,
      `/api/projects/${encodeURIComponent(projectId)}/research-decision`,
      { decision: "approve", feedback: feedback.value.trim() },
      refresh,
    ));
    more.addEventListener("click", () => void submitWorkflowAction(
      card,
      `/api/projects/${encodeURIComponent(projectId)}/research-decision`,
      { decision: "research-more", feedback: feedback.value.trim() },
      refresh,
    ));
    workflowAction.append(card);
    return;
  }

  if (state.currentNode === "await-feedback") {
    const card = document.createElement("section");
    card.className = "card";
    const heading = document.createElement("h2");
    heading.textContent = state.finalInspection?.verdict === "pass" ? "The bounded visual QA passed" : "Review the final bounded result";
    const evidence = document.createElement("p");
    evidence.textContent = state.finalInspection?.evidence || "Explore the scene states and inspect the result.";
    const categories = document.createElement("div");
    categories.className = "categories";
    for (const category of ["identity", "missing-part", "scale", "layout", "lighting", "label", "teaching-order", "style", "other"]) {
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
    comment.placeholder = "What should change, and why?";
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
    const accept = actionButton("Accept visualization");
    const reviseScene = actionButton("Revise scene", "secondary");
    const reviseIntent = actionButton("Rethink intent", "secondary");
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

  if (state.currentNode === "completed") {
    const card = document.createElement("section");
    card.className = "card";
    const message = document.createElement("p");
    message.textContent = state.nextProjectId
      ? "Your requested revision has started as a linked project with the same explicit preference profile."
      : "This visualization is accepted and its reusable evidence, assets, and preferences are indexed.";
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
  return value.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function showWorkflowError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  status.textContent = message;
  status.style.color = "#fca5a5";
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

function buildStateControls(manifest: Manifest, objects: Map<string, THREE.Object3D>): void {
  let activeStateId = manifest.states[0]?.id ?? "";
  let animationToken = 0;
  const applyState = (stateId: string, immediate = false): void => {
    const state = manifest.states.find((candidate) => candidate.id === stateId);
    if (!state) return;
    const visible = new Set(state.visibleObjects);
    const highlighted = new Set(state.highlightedObjects);
    for (const button of stateControls.querySelectorAll("button")) {
      button.setAttribute("aria-pressed", String(button.dataset.state === stateId));
    }
    const duration = immediate
      ? 0
      : manifest.transitions.find((transition) => transition.from === activeStateId && transition.to === stateId)?.durationMs ?? 350;
    activeStateId = stateId;
    animationToken += 1;
    const token = animationToken;
    const starting = new Map([...objects].map(([id, object]) => [id, object.visible ? 1 : 0]));
    for (const object of objects.values()) object.visible = true;
    const startedAt = performance.now();
    const tick = (now: number): void => {
      if (token !== animationToken) return;
      const progress = duration === 0 ? 1 : Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      for (const [id, object] of objects) {
        const start = starting.get(id) ?? 0;
        const target = visible.has(id) ? 1 : 0;
        setOpacity(object, start + (target - start) * eased);
        if (progress === 1) {
          object.visible = target === 1;
          setOpacity(object, 1);
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
  if (manifest.states[0]) applyState(manifest.states[0].id, true);
}

function setHighlight(root: THREE.Object3D, enabled: boolean): void {
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      if (!(material instanceof THREE.MeshStandardMaterial)) continue;
      material.emissive.set(enabled ? "#0ea5e9" : "#000000");
      material.emissiveIntensity = enabled ? 0.25 : 0;
    }
  });
}

function setOpacity(root: THREE.Object3D, opacity: number): void {
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      material.transparent = opacity < 0.999;
      material.opacity = opacity;
      material.depthWrite = opacity >= 0.999;
    }
  });
}

function requiredElement(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Renderer shell is missing ${selector}`);
  return element;
}
