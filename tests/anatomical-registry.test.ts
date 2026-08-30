import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadAnatomicalRegistry,
  validateModulePlacements,
  validateRegisteredStructureFrames,
} from "../src/atlas/anatomical-registry.js";
import { SurgicalAtlasLibrary } from "../src/atlas/module-library.js";
import type { Inspection } from "../src/contracts.js";
import { LocalArtifactStore } from "../src/storage/artifact-store.js";
import type { SurgicalModuleSource } from "../src/atlas/module-contracts.js";

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const moduleSource: SurgicalModuleSource = {
  definition: {
    schemaVersion: "1.0",
    title: "Registered hepatobiliary anatomy",
    subtitle: "Stable placement test",
    clinicalFocus: "Verify registered and research-derived coordinates.",
    laterality: "right",
    approach: "laparoscopic",
    disclaimer: "Educational only.",
    background: "#082a2e",
    showOperatingRoom: true,
    structures: [
      { id: "liver", label: "Liver", category: "organ", studyId: "liver-study" },
      { id: "gallbladder", label: "Gallbladder", category: "organ", studyId: "gallbladder-study" },
      { id: "variant-duct", label: "Variant duct", category: "duct", studyId: "variant-study" },
    ],
    placements: [
      {
        structureId: "liver",
        frameId: "right-upper-quadrant",
        centerCm: [-1.05, 4.4, -7.1],
        sizeCm: [19.2, 17.5, 19.4],
        rotation: [0, 0, 0],
        basis: "registered",
        anchorIds: ["porta-hepatis", "gallbladder-fossa"],
        rationale: "Copied from the stable surgical-atlas registration.",
      },
      {
        structureId: "gallbladder",
        frameId: "right-upper-quadrant",
        centerCm: [-2.8, 3.35, 3.25],
        sizeCm: [3.2, 7.4, 2.5],
        rotation: [0.1, -0.12, -0.34],
        basis: "registered",
        anchorIds: ["gallbladder-fossa", "gallbladder-neck"],
        rationale: "Copied from the stable surgical-atlas registration.",
      },
      {
        structureId: "variant-duct",
        frameId: "right-upper-quadrant",
        centerCm: [-1.4, 2.1, 1.2],
        sizeCm: [0.5, 3.2, 0.5],
        rotation: [0, 0, 0],
        basis: "research-derived",
        anchorIds: ["porta-hepatis", "cystic-duct-junction"],
        rationale: "New variation constrained by two registered ductal landmarks.",
      },
    ],
    steps: [{
      id: "overview",
      shortLabel: "Overview",
      title: "Overview",
      description: "Registered anatomy overview.",
      teachingFocus: "Spatial registration.",
      camera: { position: [-0.15, -2.2, 6.4], target: [-0.45, 1.65, -0.95], fov: 38 },
      transparentPatient: true,
      showLabels: false,
    }],
    qaViews: [{ id: "overview", label: "Overview", stepId: "overview", required: true }],
  },
  source: "export default function Scene(){ return null; }".padEnd(900, " "),
};

const passingInspection: Inspection = {
  verdict: "pass",
  category: "none",
  issue: "",
  evidence: "All required views passed.",
  patch: { kind: "none" },
  assessment: {
    recognizabilityScore: 0.94,
    domainFidelityScore: 0.93,
    visualQualityScore: 0.9,
    constructionCompletenessScore: 0.96,
    confidence: 0.95,
    failedCriteria: [],
    strengths: ["Registered anatomy is visible."],
    recommendedAction: "pass",
    targetStudyIds: [],
    researchQuestions: [],
    rationale: "The accepted render satisfies the evidence-backed brief.",
  },
};

describe("anatomical registration library", () => {
  it("loads calibrated body, abdominal, and groin frames from surgical-atlas", () => {
    const registry = loadAnatomicalRegistry();
    expect(registry.humanBase.heightCm).toBe(175);
    expect(registry.frames.map((frame) => frame.id)).toEqual(expect.arrayContaining([
      "whole-body",
      "right-upper-quadrant",
      "right-groin",
    ]));
    expect(registry.structures.map((structure) => structure.id)).toEqual(expect.arrayContaining([
      "liver",
      "gallbladder",
      "stomach",
      "pancreas",
      "right-kidney",
      "colon",
      "appendix",
      "urinary-bladder",
      "right-lung",
      "heart",
      "inferior-epigastric-artery-right",
      "deep-inguinal-ring-right",
    ]));
    expect(registry.structures.length).toBeGreaterThanOrEqual(45);
    expect(registry.structures.every((structure) =>
      structure.sourceSymbol.length > 0 && structure.registrationMethod.length > 0,
    )).toBe(true);
  });

  it("rejects movement of a known registered structure", () => {
    const moved = structuredClone(moduleSource.definition);
    moved.placements[0]!.centerCm[0] += 3;
    expect(() => validateModulePlacements(moved)).toThrow(/preserve its registered centre\/size\/rotation/);
  });

  it("rejects unknown, dynamic, and aggregate-owned registered structure frames", () => {
    expect(() => validateRegisteredStructureFrames(
      '<RegisteredStructureFrame id="liver"><group /></RegisteredStructureFrame>',
    )).not.toThrow();
    expect(() => validateRegisteredStructureFrames(
      '<RegisteredStructureFrame id="laparoscopic-ports"><group /></RegisteredStructureFrame>',
    )).toThrow(/unknown: laparoscopic-ports/);
    expect(() => validateRegisteredStructureFrames(
      '<RegisteredStructureFrame id={placementId}><group /></RegisteredStructureFrame>',
    )).toThrow(/requires a literal ID/);
    expect(() => validateRegisteredStructureFrames(
      '<RegisteredStructureFrame id="gallbladder"><group /></RegisteredStructureFrame>',
      new Set(["gallbladder"]),
    )).toThrow(/already supplied by a curated atlas aggregate: gallbladder/);
  });

  it("stores only placement metadata for retrieval, while retaining source for audit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "seein-library-"));
    temporaryRoots.push(root);
    const library = new SurgicalAtlasLibrary(new LocalArtifactStore(root, "http://localhost:8787"));
    const stored = await library.storeAccepted({
      projectId: "project",
      revision: 2,
      prompt: "variant duct at the right hepatic hilum",
      module: moduleSource,
      inspection: passingInspection,
    });
    const relevant = await library.findRelevant("show the right hepatic variant duct");
    expect(relevant[0]?.key).toBe(stored.key);
    expect(relevant[0]?.placements.find((placement) => placement.structureId === "variant-duct")?.anchorIds)
      .toEqual(["porta-hepatis", "cystic-duct-junction"]);
    expect(await fs.readFile(path.join(root, "library/anatomy/modules", stored.key, "scene.tsx"), "utf8"))
      .toContain("export default");
  });
});
