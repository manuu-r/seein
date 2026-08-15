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

window.__SEEIN_READY__ = false;
window.__SEEIN_ERRORS__ = [];

void start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  window.__SEEIN_ERRORS__?.push(message);
  status.textContent = `Scene failed: ${message}`;
  status.style.color = "#fca5a5";
  window.__SEEIN_READY__ = true;
});

async function start(): Promise<void> {
  const manifestUrl = new URLSearchParams(location.search).get("manifest");
  if (!manifestUrl) throw new Error("Missing ?manifest= URL");
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
