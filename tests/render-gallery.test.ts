import { describe, expect, it } from "vitest";
import { deriveRenderGallery, renderScoreSummary } from "../renderer/render-gallery.js";

describe("progressive render gallery", () => {
  it("shows an in-flight Playwright target before its image is available", () => {
    const items = deriveRenderGallery([{
      sequence: 1,
      kind: "operation",
      operationId: "render-1",
      stage: "rendering_initial",
      status: "info",
      detail: {
        phase: "started",
        label: "Render Pelvic inlet overview",
        action: "Playwright page load + screenshot",
        revision: 1,
        targetId: "qa-pelvic-inlet",
        viewId: "qa-overview",
      },
      createdAt: "2026-08-31T08:00:00.000Z",
    }]);

    expect(items).toEqual([expect.objectContaining({
      key: "1:qa-pelvic-inlet",
      label: "Pelvic inlet overview",
      status: "rendering",
      revision: 1,
      viewId: "qa-overview",
    })]);
  });

  it("decorates a completed render with its later Gemini QA result", () => {
    const items = deriveRenderGallery([
      {
        sequence: 1,
        stage: "rendering_initial",
        status: "completed",
        detail: {
          revision: 2,
          targetId: "qa-corridor",
          targetLabel: "Operative corridor",
          stateId: "corridor-state",
          viewId: "qa-corridor-view",
          renderUrl: "https://seein.example/artifacts/projects/p/renders/revision-002-qa-corridor.png",
        },
        createdAt: "2026-08-31T08:01:00.000Z",
      },
      {
        sequence: 2,
        stage: "inspecting",
        status: "completed",
        detail: {
          revision: 2,
          targetId: "qa-corridor",
          verdict: "pass",
          scores: {
            recognizabilityScore: 0.91,
            domainFidelityScore: 0.87,
            visualQualityScore: 0.84,
            constructionCompletenessScore: 0.93,
          },
        },
        createdAt: "2026-08-31T08:02:00.000Z",
      },
    ]);

    expect(items).toEqual([expect.objectContaining({
      label: "Operative corridor",
      status: "passed",
      imageUrl: "https://seein.example/artifacts/projects/p/renders/revision-002-qa-corridor.png",
      scores: {
        recognizability: 0.91,
        domainFidelity: 0.87,
        visualQuality: 0.84,
        constructionCompleteness: 0.93,
      },
    })]);
    expect(renderScoreSummary(items[0]!.scores)).toEqual([
      "Recognizability 91",
      "Fidelity 87",
      "Visual 84",
      "Complete 93",
    ]);
  });

  it("shows a diagnostic capture and replaces it when that target later succeeds", () => {
    const failed = {
      sequence: 1,
      stage: "rendering_final",
      status: "info",
      detail: {
        phase: "captured-diagnostics",
        revision: 3,
        targetId: "qa-nerve",
        targetLabel: "Nerve preservation",
        failureScreenshotUrl: "https://seein.example/failure.png",
        diagnosticUrl: "https://seein.example/failure.json",
      },
      createdAt: "2026-08-31T08:03:00.000Z",
    } as const;

    expect(deriveRenderGallery([failed])[0]).toMatchObject({
      status: "failed",
      imageUrl: "https://seein.example/failure.png",
      diagnosticUrl: "https://seein.example/failure.json",
    });

    expect(deriveRenderGallery([
      failed,
      {
        sequence: 2,
        stage: "rendering_final",
        status: "completed",
        detail: {
          revision: 3,
          targetId: "qa-nerve",
          targetLabel: "Nerve preservation",
          renderUrl: "https://seein.example/recovered.png",
        },
        createdAt: "2026-08-31T08:04:00.000Z",
      },
    ])[0]).toMatchObject({
      status: "ready",
      imageUrl: "https://seein.example/recovered.png",
    });
  });
});
