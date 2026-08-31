import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { makePatientContouredDrape } from "../renderer/atlas/PatientAtlas.js";

function patientSource(): THREE.Group {
  const geometry = new THREE.PlaneGeometry(6, 14, 1, 1);
  const body = new THREE.Mesh(geometry);
  body.name = "body";
  const source = new THREE.Group();
  source.add(body);
  return source;
}

describe("patient drape raycast acceleration", () => {
  it("preserves every drape vertex, index, and placement anchor", () => {
    const baseline = makePatientContouredDrape(patientSource(), { useBvh: false });
    const accelerated = makePatientContouredDrape(patientSource(), { useBvh: true });

    expect(baseline).not.toBeNull();
    expect(accelerated).not.toBeNull();
    const baselinePositions = baseline!.geometry.getAttribute("position").array;
    const acceleratedPositions = accelerated!.geometry.getAttribute("position").array;
    expect(Array.from(acceleratedPositions)).toEqual(Array.from(baselinePositions));
    expect(Array.from(accelerated!.geometry.index!.array)).toEqual(Array.from(baseline!.geometry.index!.array));

    for (const [u, y, clearance] of [
      [0, -7.2, 0],
      [0.12, -4.35, 0.026],
      [0.5, -2.1, 0.032],
      [0.88, 0.14, 0.01],
      [1, 0.18, 0],
    ] as const) {
      expect(accelerated!.surfacePoint(u, y, clearance)).toEqual(baseline!.surfacePoint(u, y, clearance));
    }

    baseline!.geometry.dispose();
    accelerated!.geometry.dispose();
  });
});
