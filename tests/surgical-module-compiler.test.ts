import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SurgicalModuleCompiler, validateGeneratedModuleSource } from "../src/atlas/module-compiler.js";
import { LocalArtifactStore } from "../src/storage/artifact-store.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function source() {
  return `
import { AnatomyLabel, OrganicOrgan, PatientOperatingContext, ProfiledOrgan, TaperedTube } from "@seein/atlas";
import type { SurgicalModuleProps } from "@seein/atlas";

const artery = [[0, 0, 0], [0.2, 0.4, 0.2], [0.4, 0.9, 0.35]] as const;
const radii = [0.09, 0.065, 0.035] as const;
const viscus = [[-0.8, -0.4, 0], [-0.65, 0.1, 0.08], [-0.5, 0.8, 0.12], [-0.35, 1.25, 0.08]] as const;
const viscusRadii = [[0.04, 0.04], [0.28, 0.22], [0.36, 0.27], [0.03, 0.03]] as const;

export default function GeneratedSurgicalScene({ activeStepId, showLabels, transparentPatient }: SurgicalModuleProps) {
  const focus = activeStepId === "operative-focus";
  return (
    <group>
      <PatientOperatingContext transparent={transparentPatient} drapeOpacity={focus ? 0.18 : 0.72} torsoAlpha={0.1} />
      <group position={[0, 1.4, 0.3]} scale={focus ? 1.7 : 1}>
        <OrganicOrgan position={[-0.5, 0, 0]} scale={[1.7, 0.85, 0.55]} color="#713d35" irregularity={0.12} seed={4} />
        <ProfiledOrgan points={viscus} radii={viscusRadii} color="#6f8d58" radialSegments={24} />
        <TaperedTube points={artery} radii={radii} color="#b52f3d" clearcoat={0.2} />
        <AnatomyLabel position={[0.3, 1.05, 0.45]} visible={showLabels}>Target artery</AnatomyLabel>
      </group>
    </group>
  );
}
// This deliberately substantial comment represents detailed generated construction notes:
// anatomy remains in the calibrated patient coordinate frame; the target is positioned relative to the organ rather
// than as an isolated decorative object; progressive taper preserves branch identity; cutaway state and camera state
// are controlled by the host; labels are optional and do not substitute for recognizable geometry or topology.
`;
}

const definition = {
  schemaVersion: "1.0" as const,
  title: "Compiler test anatomy",
  subtitle: "Atlas-backed generated module",
  clinicalFocus: "Verify that a generated R3F surgical scene compiles against the curated atlas library.",
  laterality: "right",
  approach: "laparoscopic operative view",
  disclaimer: "Educational visualization; not patient-specific clinical guidance.",
  background: "#082a2e",
  showOperatingRoom: true,
  structures: [
    { id: "body", label: "Patient", category: "tissue" as const, studyId: "body" },
    { id: "organ", label: "Target organ", category: "organ" as const, studyId: "organ" },
    { id: "artery", label: "Target artery", category: "artery" as const, studyId: "artery" },
  ],
  placements: [
    {
      structureId: "body",
      frameId: "whole-body" as const,
      centerCm: [0, 0, 0] as [number, number, number],
      sizeCm: [50, 175, 32] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      basis: "research-derived" as const,
      anchorIds: ["vertex", "heel-plane"],
      rationale: "The test patient occupies the registered whole-body frame.",
    },
    {
      structureId: "organ",
      frameId: "central-abdomen" as const,
      centerCm: [-5, 2, 0] as [number, number, number],
      sizeCm: [17, 9, 6] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      basis: "research-derived" as const,
      anchorIds: ["midline", "subcostal-plane"],
      rationale: "The synthetic target is registered to two abdominal landmarks.",
    },
    {
      structureId: "artery",
      frameId: "central-abdomen" as const,
      centerCm: [3, 4, 2] as [number, number, number],
      sizeCm: [4, 9, 4] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      basis: "research-derived" as const,
      anchorIds: ["target-organ", "vascular-root"],
      rationale: "The synthetic artery is constrained by its organ and vascular root.",
    },
  ],
  steps: [
    {
      id: "operative-focus",
      shortLabel: "Focus",
      title: "Operative focus",
      description: "Reveal the target anatomy in body and operating-room context.",
      teachingFocus: "Trace the artery relative to the organ.",
      camera: { position: [0, -7, 9] as [number, number, number], target: [0, 1, 0] as [number, number, number], fov: 40 },
      transparentPatient: true,
      showLabels: true,
    },
  ],
  qaViews: [{ id: "operative", label: "Operative view", stepId: "operative-focus", required: true }],
};

describe("SurgicalModuleCompiler", () => {
  it("bundles an atlas-backed generated scene into a live module", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "seein-atlas-"));
    temporaryRoots.push(root);
    const artifacts = new LocalArtifactStore(root, "http://localhost:8787");
    const compiler = new SurgicalModuleCompiler(artifacts);
    const compiled = await compiler.compile("projects/test", 1, { definition, source: source() });

    expect(compiled.viewerUrl).toContain("/artifacts/projects/test/module/revision-001/index.html");
    expect(compiled.sourceSha256).toHaveLength(64);
    expect(compiled.bundleSha256).toHaveLength(64);
    const bundle = await fs.readFile(path.join(root, "projects/test/module/revision-001/module.js"));
    expect(bundle.byteLength).toBeGreaterThan(100_000);
  });

  it("rejects generated source that reaches outside the atlas sandbox", () => {
    expect(() => validateGeneratedModuleSource(`${source()}\nfetch("https://example.com")`)).toThrow(/forbidden network fetch/);
    expect(() => validateGeneratedModuleSource(source().replace("@seein/atlas", "three/examples/jsm/loaders/GLTFLoader.js"))).toThrow(/forbidden package/);
  });

  it("rejects atlas component prop mistakes before the browser sees them", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "seein-atlas-types-"));
    temporaryRoots.push(root);
    const artifacts = new LocalArtifactStore(root, "http://localhost:8787");
    const compiler = new SurgicalModuleCompiler(artifacts);
    const invalidSource = source().replace(
      "points={artery} radii={radii}",
      "vertices={artery} radii={radii}",
    );

    await expect(compiler.compile("projects/test", 1, { definition, source: invalidSource }))
      .rejects.toThrow(/failed TypeScript validation/);
  });
});
