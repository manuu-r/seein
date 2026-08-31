import { describe, expect, it } from "vitest";
import {
  formatGeminiUsage,
  operationPresentation,
  summarizeGeminiUsage,
  workflowFailurePresentation,
} from "../renderer/workflow-presentation.js";

describe("workflow guide presentation", () => {
  it("shows the latest per-project Gemini token snapshot from workflow events", () => {
    const usage = summarizeGeminiUsage([
      { geminiTokensUsed: 12_400, geminiTokensLimit: 2_000_000, geminiTokenResponses: 3 },
      { geminiTokensUsed: 87_650, geminiTokensLimit: 2_000_000, geminiTokenResponses: 7 },
      { geminiTokensUsed: 20_000, geminiTokensLimit: 2_000_000, geminiTokenResponses: 4 },
    ]);

    expect(usage).toEqual({ usedTokens: 87_650, limitTokens: 2_000_000, responses: 7, percent: 4 });
    expect(formatGeminiUsage(usage!)).toBe("Gemini 87.7k / 2M · 4%");
  });

  it("turns the old Playwright timeout into a concise, actionable message", () => {
    const failure = workflowFailurePresentation(
      "Error: Render pelvic view failed after 4 attempts: page.waitForFunction: Timeout 60000ms exceeded.\n    at Orchestrator.renderScene (file:///app/dist/server/workflow/orchestrator.js:1472:15)",
    );

    expect(failure.headline).toBe("The view did not reach render readiness");
    expect(failure.description).toContain("source is kept");
    expect(failure.description).not.toContain("file://");
  });

  it("explains Chromium startup failures without blaming the generated scene", () => {
    const failure = workflowFailurePresentation(
      "browserType.launch: Failed to launch Chromium · phase=startup; frame=none; state=unavailable",
    );

    expect(failure.headline).toBe("The renderer could not start");
    expect(failure.description).toContain("infrastructure issue");
    expect(failure.description).toContain("will not rewrite");
  });

  it("does not expose private viewer URLs or raw provider actions in normal operation status", () => {
    const presentation = operationPresentation("failed", "Render pelvic inlet", {
      action: "Playwright page load + screenshot",
      destination: "http://127.0.0.1:8787/viewer/?manifest=private-artifact",
      attempt: 4,
      maxAttempts: 4,
      totalDurationMs: 365_000,
      error: "page.waitForFunction: Timeout 60000ms exceeded.",
    });

    expect(presentation).toMatchObject({
      badge: "ERROR",
      tone: "error",
      headline: "Render pelvic inlet needs attention",
    });
    expect(presentation.description).toContain("source is kept");
    expect(presentation.metadata).toEqual(["Attempt 4 of 4", "6m 5s"]);
    expect(JSON.stringify(presentation)).not.toContain("127.0.0.1");
  });
});
