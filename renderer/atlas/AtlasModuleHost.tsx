import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, useProgress } from "@react-three/drei";
import { Component, Suspense, type ErrorInfo, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OperatingRoom } from "./OperatingRoom";
import { DEFAULT_OPERATING_ROOM_STATE } from "./OperatingRoomState";
import type { SurgicalModuleDefinition, SurgicalSceneComponent } from "./types";

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
      sceneMounted: boolean;
      assetProgress: number;
      failure?: string;
    };
    __SEEIN_RENDER_FAILURE__?: string;
  }
}

function CameraRig({ definition, stepId, viewId }: { definition: SurgicalModuleDefinition; stepId: string; viewId: string }) {
  const { camera } = useThree();
  const orbitRef = useRef<any>(null);
  const step = definition.steps.find((candidate) => candidate.id === stepId) ?? definition.steps[0]!;
  const view = definition.qaViews.find((candidate) => candidate.id === viewId);
  const viewedStep = definition.steps.find((candidate) => candidate.id === view?.stepId) ?? step;

  useEffect(() => {
    camera.up.set(0, 0, -1);
    camera.position.fromArray([...viewedStep.camera.position]);
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.fov = viewedStep.camera.fov;
      camera.updateProjectionMatrix();
    }
    const orbit = orbitRef.current as { target: THREE.Vector3; update(): void } | null;
    orbit?.target.fromArray([...viewedStep.camera.target]);
    orbit?.update();
    if (window.__SEEIN_RENDER_STATE__) {
      window.__SEEIN_RENDER_STATE__.cameraSettled = true;
      window.__SEEIN_RENDER_STATE__.stableFrames = 0;
      window.__SEEIN_RENDER_STATE__.stateId = step.id;
      window.__SEEIN_RENDER_STATE__.viewId = view?.id ?? "";
    }
  }, [camera, step.id, view?.id, viewedStep]);

  // OrbitControls rewrites camera orientation on each damped frame. Reapply
  // the atlas screen convention so cephalad remains at the top of the view.
  useFrame(() => {
    const orbit = orbitRef.current as { target: THREE.Vector3 } | null;
    if (!orbit) return;
    camera.lookAt(orbit.target);
    camera.rotateZ(Math.PI);
  });

  return (
    <OrbitControls
      ref={orbitRef}
      makeDefault
      enableDamping
      dampingFactor={0.075}
      enablePan={false}
      minDistance={3}
      maxDistance={40}
    />
  );
}

function ReadinessProbe({ sceneMounted }: { sceneMounted: boolean }) {
  const progress = useProgress();
  useFrame(() => {
    if (!window.__SEEIN_RENDER_STATE__) return;
    window.__SEEIN_RENDER_STATE__.assetsLoaded = sceneMounted && !progress.active;
    window.__SEEIN_RENDER_STATE__.moduleCompiled = true;
    window.__SEEIN_RENDER_STATE__.sceneMounted = sceneMounted;
    window.__SEEIN_RENDER_STATE__.assetProgress = progress.progress;
    if (sceneMounted && window.__SEEIN_RENDER_STATE__.cameraSettled && !progress.active) {
      window.__SEEIN_RENDER_STATE__.stableFrames += 1;
      if (window.__SEEIN_RENDER_STATE__.stableFrames >= 3 && !window.__SEEIN_READY__) {
        window.__SEEIN_READY__ = true;
        window.parent.postMessage({ type: "seein-module-ready" }, "*");
      }
    } else {
      window.__SEEIN_RENDER_STATE__.stableFrames = 0;
    }
  });
  return null;
}

class SceneErrorBoundary extends Component<{
  children: ReactNode;
  onError(message: string): void;
}, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const componentStack = info.componentStack?.trim();
    this.props.onError(componentStack ? `${error.message}\n${componentStack}` : error.message);
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

function SceneMountedProbe({ onMounted }: { onMounted(): void }) {
  useEffect(() => onMounted(), [onMounted]);
  return null;
}

export function AtlasModuleHost({
  definition,
  Scene,
}: {
  definition: SurgicalModuleDefinition;
  Scene: SurgicalSceneComponent;
}) {
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const qaMode = query.get("qa") === "1";
  const requestedView = query.get("view") ?? "";
  const requestedStep = query.get("state")
    ?? definition.qaViews.find((view) => view.id === requestedView)?.stepId
    ?? definition.steps[0]!.id;
  const [stepId, setStepId] = useState(
    definition.steps.some((step) => step.id === requestedStep) ? requestedStep : definition.steps[0]!.id,
  );
  const [showLabels, setShowLabels] = useState(
    qaMode ? false : definition.steps.find((step) => step.id === requestedStep)?.showLabels ?? true,
  );
  const [transparentPatient, setTransparentPatient] = useState(
    definition.steps.find((step) => step.id === requestedStep)?.transparentPatient ?? true,
  );
  const [showStepDetails, setShowStepDetails] = useState(false);
  const [sceneMounted, setSceneMounted] = useState(false);
  const markSceneMounted = useMemo(() => () => setSceneMounted(true), []);
  const reportSceneFailure = useMemo(() => (message: string) => {
    const normalized = message.slice(0, 4_000);
    if (!window.__SEEIN_ERRORS__?.includes(normalized)) window.__SEEIN_ERRORS__?.push(normalized);
    window.__SEEIN_RENDER_FAILURE__ = normalized;
    if (window.__SEEIN_RENDER_STATE__) window.__SEEIN_RENDER_STATE__.failure = normalized;
    window.parent.postMessage({
      type: "seein-module-failed",
      error: normalized,
      errors: window.__SEEIN_ERRORS__ ?? [],
      renderState: window.__SEEIN_RENDER_STATE__,
    }, "*");
  }, []);
  const step = definition.steps.find((candidate) => candidate.id === stepId) ?? definition.steps[0]!;

  const chooseStep = (nextId: string) => {
    const next = definition.steps.find((candidate) => candidate.id === nextId);
    if (!next) return;
    setStepId(next.id);
    setShowLabels(qaMode ? false : next.showLabels);
    setTransparentPatient(next.transparentPatient);
    setShowStepDetails(false);
  };

  return (
    <main className="atlas-shell" style={{ background: definition.background }}>
      <style>{ATLAS_UI_STYLES}</style>
      <Canvas
        shadows
        dpr={[1, 1.5]}
        camera={{ position: [...step.camera.position], fov: step.camera.fov, near: 0.05, far: 100 }}
        gl={{ antialias: true, alpha: false, powerPreference: "high-performance", preserveDrawingBuffer: true }}
        onCreated={({ gl }) => {
          gl.outputColorSpace = THREE.SRGBColorSpace;
          gl.toneMapping = THREE.ACESFilmicToneMapping;
          gl.toneMappingExposure = 1.02;
        }}
      >
        <color attach="background" args={[definition.background]} />
        <fog attach="fog" args={[definition.background, 24, 52]} />
        <ambientLight intensity={0.42} />
        <hemisphereLight args={["#fff1df", "#163237", 0.65]} />
        <spotLight position={[2, 8, 12]} intensity={3.1} angle={0.52} penumbra={0.78} color="#fff0dc" castShadow shadow-mapSize={[1024, 1024]} />
        <directionalLight position={[-8, -2, 7]} intensity={1.25} color="#bcdad8" />
        <Suspense fallback={null}>
          {definition.showOperatingRoom && <OperatingRoom state={DEFAULT_OPERATING_ROOM_STATE} />}
          <SceneErrorBoundary onError={reportSceneFailure}>
            <Scene activeStepId={stepId} showLabels={showLabels} transparentPatient={transparentPatient} />
            <SceneMountedProbe onMounted={markSceneMounted} />
          </SceneErrorBoundary>
        </Suspense>
        <CameraRig definition={definition} stepId={stepId} viewId={requestedView} />
        <ReadinessProbe sceneMounted={sceneMounted} />
      </Canvas>

      <header className="atlas-head">
        <div className="atlas-head__card">
          <div className="atlas-kicker">Surgical atlas · {definition.laterality}</div>
          <h1>{definition.title}</h1>
          <p>{definition.subtitle}</p>
        </div>
      </header>

      <aside className="atlas-step-card" data-expanded={String(showStepDetails)}>
        <div className="atlas-step-card__head">
          <div>
            <div className="atlas-kicker">{step.shortLabel}</div>
            <h2>{step.title}</h2>
          </div>
          <button
            type="button"
            className="atlas-step-card__toggle"
            aria-expanded={showStepDetails}
            onClick={() => setShowStepDetails((value) => !value)}
          >
            {showStepDetails ? "Less" : "Details"}
          </button>
        </div>
        <div className="atlas-step-card__body">
          <p>{step.description}</p>
          <p>{step.teachingFocus}</p>
        </div>
      </aside>

      <nav className="atlas-sequence" aria-label="Surgical sequence">
        {definition.steps.map((candidate, index) => (
          <button
            key={candidate.id}
            type="button"
            className="atlas-sequence__item"
            aria-current={candidate.id === stepId ? "step" : undefined}
            onClick={() => chooseStep(candidate.id)}
          >
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong>{candidate.shortLabel}</strong>
          </button>
        ))}
      </nav>

      <div className="atlas-tools">
        <button type="button" aria-pressed={transparentPatient} onClick={() => setTransparentPatient((value) => !value)}>{transparentPatient ? "Cutaway on" : "Cutaway off"}</button>
        <button type="button" aria-pressed={showLabels} onClick={() => setShowLabels((value) => !value)}>{showLabels ? "Labels on" : "Labels off"}</button>
      </div>

      <div className="atlas-orientation atlas-orientation--cephalad">Cephalad ↑</div>
      <div className="atlas-orientation atlas-orientation--patient">Patient left</div>
    </main>
  );
}

const ATLAS_UI_STYLES = `
  .atlas-shell, .atlas-shell * { box-sizing: border-box; }
  .atlas-shell {
    position: fixed;
    inset: 0;
    overflow: hidden;
    color: #edf7f5;
    font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  }
  .atlas-head { position: absolute; inset: 18px 20px auto; display: flex; align-items: flex-start; pointer-events: none; }
  .atlas-head__card {
    width: min(720px, calc(100% - 270px));
    padding: 11px 14px;
    border: 1px solid rgba(180, 226, 218, .2);
    border-radius: 12px;
    background: rgba(5, 18, 21, .78);
    box-shadow: 0 10px 28px rgba(0, 0, 0, .12);
    backdrop-filter: blur(12px);
  }
  .atlas-kicker { color: #7fd7cb; font-size: 10px; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; }
  .atlas-head h1 { margin: 4px 0 2px; font-size: 18px; line-height: 1.2; }
  .atlas-head p { margin: 0; color: #aec6c2; font-size: 12px; line-height: 1.4; }
  .atlas-step-card {
    position: absolute;
    bottom: 20px;
    left: 20px;
    width: 330px;
    padding: 14px;
    border: 1px solid rgba(180, 226, 218, .2);
    border-radius: 14px;
    background: rgba(5, 18, 21, .84);
    box-shadow: 0 16px 38px rgba(0, 0, 0, .14);
    backdrop-filter: blur(14px);
  }
  .atlas-step-card__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .atlas-step-card h2 { margin: 5px 0 0; font-size: 16px; line-height: 1.2; }
  .atlas-step-card__body p { margin: 7px 0 0; color: #bdd0cd; font-size: 12px; line-height: 1.45; }
  .atlas-step-card__body p:last-child { color: #f3d8b9; font-size: 11px; line-height: 1.4; }
  .atlas-step-card__toggle { display: none; }
  .atlas-sequence { position: absolute; right: 20px; bottom: 20px; display: flex; flex-direction: column; gap: 6px; width: 220px; }
  .atlas-sequence__item {
    padding: 8px 10px;
    border: 1px solid rgba(180, 226, 218, .14);
    border-radius: 9px;
    color: #a9c0bc;
    background: rgba(5, 18, 21, .78);
    text-align: left;
    cursor: pointer;
    backdrop-filter: blur(10px);
  }
  .atlas-sequence__item:hover { border-color: rgba(180, 226, 218, .34); color: #edf7f5; }
  .atlas-sequence__item[aria-current="step"] { border-color: rgba(113, 216, 202, .55); color: #f3fbf9; background: rgba(25, 102, 96, .88); }
  .atlas-sequence__item span { display: inline-block; width: 24px; color: #7fd7cb; font-size: 10px; font-weight: 500; }
  .atlas-sequence__item strong { font-size: 11px; font-weight: 700; }
  .atlas-tools { position: absolute; top: 20px; right: 20px; display: flex; gap: 8px; }
  .atlas-tools button, .atlas-step-card__toggle {
    padding: 8px 11px;
    border: 1px solid rgba(180, 226, 218, .2);
    border-radius: 999px;
    color: #dceae7;
    background: rgba(5, 18, 21, .78);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
    backdrop-filter: blur(10px);
  }
  .atlas-tools button:hover, .atlas-step-card__toggle:hover { border-color: rgba(127, 215, 203, .6); }
  .atlas-orientation { position: absolute; color: #afd0ca; font-size: 10px; letter-spacing: .14em; text-transform: uppercase; pointer-events: none; }
  .atlas-orientation--cephalad { top: 18px; left: 50%; transform: translateX(-50%); }
  .atlas-orientation--patient { top: 50%; right: 20px; transform: rotate(90deg) translateX(50%); transform-origin: right top; }

  @media (max-width: 900px) {
    .atlas-head__card { width: calc(100% - 250px); }
    .atlas-head h1 { font-size: 16px; }
    .atlas-step-card { width: min(310px, calc(100% - 280px)); }
  }

  @media (max-width: 700px) {
    .atlas-head { inset: 56px 12px auto; }
    .atlas-head__card { width: 100%; padding: 9px 11px; }
    .atlas-head h1 { display: -webkit-box; overflow: hidden; margin-top: 3px; font-size: 15px; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
    .atlas-head p { display: none; }
    .atlas-kicker { font-size: 8px; letter-spacing: .14em; }
    .atlas-tools { top: 12px; right: 12px; }
    .atlas-tools button { padding: 7px 9px; font-size: 10px; }
    .atlas-orientation--cephalad { top: 20px; left: 12px; transform: none; font-size: 8px; }
    .atlas-orientation--patient { display: none; }
    .atlas-step-card {
      right: 12px;
      bottom: 68px;
      left: 12px;
      width: auto;
      max-height: min(34dvh, 250px);
      overflow: auto;
      padding: 10px 12px;
    }
    .atlas-step-card h2 { margin-top: 3px; font-size: 14px; }
    .atlas-step-card__toggle { display: block; flex: none; padding: 6px 9px; font-size: 9px; }
    .atlas-step-card__body { display: none; }
    .atlas-step-card[data-expanded="true"] .atlas-step-card__body { display: block; }
    .atlas-sequence {
      right: 12px;
      bottom: 12px;
      left: 12px;
      width: auto;
      flex-direction: row;
      overflow-x: auto;
      scrollbar-width: none;
    }
    .atlas-sequence::-webkit-scrollbar { display: none; }
    .atlas-sequence__item { flex: 0 0 auto; white-space: nowrap; }
  }

  @media (prefers-reduced-motion: reduce) {
    .atlas-shell *, .atlas-shell *::before, .atlas-shell *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; }
  }
`;
