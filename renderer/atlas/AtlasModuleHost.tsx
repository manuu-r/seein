import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, useProgress } from "@react-three/drei";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
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
    };
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
  const [sceneMounted, setSceneMounted] = useState(false);
  const markSceneMounted = useMemo(() => () => setSceneMounted(true), []);
  const step = definition.steps.find((candidate) => candidate.id === stepId) ?? definition.steps[0]!;

  const chooseStep = (nextId: string) => {
    const next = definition.steps.find((candidate) => candidate.id === nextId);
    if (!next) return;
    setStepId(next.id);
    setShowLabels(qaMode ? false : next.showLabels);
    setTransparentPatient(next.transparentPatient);
  };

  return (
    <main style={{ position: "fixed", inset: 0, overflow: "hidden", background: definition.background, color: "#edf7f5", fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" }}>
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
          <Scene activeStepId={stepId} showLabels={showLabels} transparentPatient={transparentPatient} />
          <SceneMountedProbe onMounted={markSceneMounted} />
        </Suspense>
        <CameraRig definition={definition} stepId={stepId} viewId={requestedView} />
        <ReadinessProbe sceneMounted={sceneMounted} />
      </Canvas>

      <header style={{ position: "absolute", inset: "18px 20px auto 20px", display: "flex", gap: 16, alignItems: "flex-start", pointerEvents: "none" }}>
        <div style={{ maxWidth: 720, padding: "11px 14px", border: "1px solid rgba(180,226,218,.2)", borderRadius: 12, background: "rgba(5,18,21,.78)", backdropFilter: "blur(12px)" }}>
          <div style={{ color: "#7fd7cb", fontSize: 10, fontWeight: 800, letterSpacing: ".16em", textTransform: "uppercase" }}>Surgical atlas · {definition.laterality}</div>
          <h1 style={{ margin: "4px 0 2px", fontSize: 18, lineHeight: 1.2 }}>{definition.title}</h1>
          <div style={{ color: "#aec6c2", fontSize: 12 }}>{definition.subtitle}</div>
        </div>
      </header>

      <aside style={{ position: "absolute", left: 20, bottom: 20, width: 310, padding: 14, borderRadius: 14, background: "rgba(5,18,21,.84)", border: "1px solid rgba(180,226,218,.2)", backdropFilter: "blur(14px)" }}>
        <div style={{ color: "#7fd7cb", fontSize: 10, fontWeight: 800, letterSpacing: ".14em", textTransform: "uppercase" }}>{step.shortLabel}</div>
        <h2 style={{ margin: "5px 0", fontSize: 16 }}>{step.title}</h2>
        <p style={{ margin: 0, color: "#bdd0cd", fontSize: 12, lineHeight: 1.45 }}>{step.description}</p>
        <p style={{ margin: "8px 0 0", color: "#f3d8b9", fontSize: 11, lineHeight: 1.4 }}>{step.teachingFocus}</p>
      </aside>

      <nav style={{ position: "absolute", right: 20, bottom: 20, display: "flex", flexDirection: "column", gap: 6, width: 220 }} aria-label="Surgical sequence">
        {definition.steps.map((candidate, index) => (
          <button key={candidate.id} type="button" onClick={() => chooseStep(candidate.id)} style={{ cursor: "pointer", color: candidate.id === stepId ? "#f3fbf9" : "#a9c0bc", textAlign: "left", padding: "8px 10px", borderRadius: 9, border: candidate.id === stepId ? "1px solid rgba(113,216,202,.55)" : "1px solid rgba(180,226,218,.14)", background: candidate.id === stepId ? "rgba(25,102,96,.88)" : "rgba(5,18,21,.78)", backdropFilter: "blur(10px)" }}>
            <span style={{ display: "inline-block", width: 24, color: "#7fd7cb", fontSize: 10 }}>{String(index + 1).padStart(2, "0")}</span>
            <span style={{ fontSize: 11, fontWeight: 700 }}>{candidate.shortLabel}</span>
          </button>
        ))}
      </nav>

      <div style={{ position: "absolute", right: 20, top: 20, display: "flex", gap: 8 }}>
        <button type="button" onClick={() => setTransparentPatient((value) => !value)} style={toolButtonStyle}>{transparentPatient ? "Cutaway on" : "Cutaway off"}</button>
        <button type="button" onClick={() => setShowLabels((value) => !value)} style={toolButtonStyle}>{showLabels ? "Labels on" : "Labels off"}</button>
      </div>

      <div style={{ position: "absolute", left: "50%", top: 18, transform: "translateX(-50%)", color: "#afd0ca", fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase", pointerEvents: "none" }}>Cephalad ↑</div>
      <div style={{ position: "absolute", right: 20, top: "50%", transform: "rotate(90deg) translateX(50%)", transformOrigin: "right top", color: "#afd0ca", fontSize: 10, letterSpacing: ".12em", textTransform: "uppercase", pointerEvents: "none" }}>Patient left</div>
    </main>
  );
}

const toolButtonStyle: React.CSSProperties = {
  cursor: "pointer",
  color: "#dceae7",
  background: "rgba(5,18,21,.78)",
  border: "1px solid rgba(180,226,218,.2)",
  borderRadius: 999,
  padding: "8px 11px",
  fontSize: 11,
  backdropFilter: "blur(10px)",
};
