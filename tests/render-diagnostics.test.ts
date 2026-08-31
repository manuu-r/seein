import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { describe, expect, it } from "vitest";
import {
  hasLargeDevShm,
  isRendererInfrastructureFailure,
  PlaywrightScreenshotDriver,
  ScreenshotCaptureError,
  summarizeRendererDiagnostics,
  withWallClockDeadline,
  type RendererDiagnostics,
} from "../src/render/screenshot-driver.js";
import { canRepairRendererFailure } from "../src/workflow/orchestrator.js";
import type { Config } from "../src/config.js";

class NewPageFailureDriver extends PlaywrightScreenshotDriver {
  launcherCalls = 0;
  browserCloseCalls = 0;

  protected override launchBrowser(_options: Parameters<typeof chromium.launch>[0]): Promise<Browser> {
    this.launcherCalls += 1;
    return Promise.resolve({
      newPage: async () => {
        throw new Error("browser.newPage: Target page, context or browser has been closed");
      },
      close: async () => {
        this.browserCloseCalls += 1;
      },
    } as unknown as Browser);
  }
}

describe("renderer diagnostics", () => {
  it("enforces a wall-clock deadline even if a browser operation never settles", async () => {
    const never = new Promise<never>(() => undefined);
    await expect(withWallClockDeadline(never, 10, "Browser operation stalled"))
      .rejects.toThrow("Browser operation stalled within 1 seconds");
  });

  it("falls back to Chromium's safe shared-memory default when /dev/shm is unavailable", () => {
    expect(hasLargeDevShm(path.join(os.tmpdir(), "seein-missing-dev-shm"))).toBe(false);
  });

  it("summarizes the child module's real readiness state for a repair decision", () => {
    const summary = summarizeRendererDiagnostics({
      capturedAt: "2026-08-31T00:00:00.000Z",
      viewerUrl: "http://127.0.0.1:8787/viewer/?manifest=test",
      phase: "frame-stability",
      browserErrors: ["pageerror: geometry is undefined"],
      frames: [
        { url: "http://127.0.0.1:8787/viewer/", isMainFrame: true, ready: false, errors: [] },
        {
          url: "http://127.0.0.1:8787/artifacts/projects/p/module/revision-001/index.html",
          isMainFrame: false,
          ready: false,
          errors: ["geometry is undefined"],
          renderState: { assetsLoaded: false, sceneMounted: false, moduleCompiled: false, cameraSettled: false, stableFrames: 0 },
        },
      ],
      network: [],
    });

    expect(summary).toContain("phase=frame-stability");
    expect(summary).toContain("mounted:false");
    expect(summary).toContain("geometry is undefined");
  });

  it("classifies a Chromium startup failure as retryable infrastructure, not scene evidence", () => {
    const diagnostics: RendererDiagnostics = {
      capturedAt: "2026-08-31T00:00:00.000Z",
      viewerUrl: "http://127.0.0.1:8787/viewer/?manifest=test",
      phase: "startup",
      browserErrors: ["renderer startup: browserType.launch: Failed to launch Chromium"],
      frames: [],
      network: [],
    };
    const error = new ScreenshotCaptureError("browserType.launch: Failed to launch Chromium", diagnostics, true);

    expect(isRendererInfrastructureFailure(diagnostics)).toBe(true);
    expect(error.retryable).toBe(true);
    expect(canRepairRendererFailure(diagnostics)).toBe(false);
    expect(summarizeRendererDiagnostics(diagnostics)).toContain("phase=startup");
    expect(summarizeRendererDiagnostics(diagnostics)).toContain("frame=none");
  });

  it("keeps a generic readiness stall out of Gemini source recovery", () => {
    const diagnostics: RendererDiagnostics = {
      capturedAt: "2026-08-31T00:00:00.000Z",
      viewerUrl: "http://127.0.0.1:8787/viewer/?manifest=test",
      phase: "frame-stability",
      browserErrors: [],
      frames: [
        { url: "http://127.0.0.1:8787/viewer/", isMainFrame: true, ready: false, errors: [] },
        {
          url: "http://127.0.0.1:8787/artifacts/projects/p/module/revision-001/index.html",
          isMainFrame: false,
          ready: false,
          errors: [],
          renderState: {
            assetsLoaded: false,
            sceneMounted: true,
            moduleCompiled: true,
            cameraSettled: true,
            stableFrames: 0,
          },
        },
      ],
      network: [],
    };

    expect(canRepairRendererFailure(diagnostics)).toBe(false);
  });

  it("allows a bounded source repair only for an explicit module runtime failure", () => {
    const diagnostics: RendererDiagnostics = {
      capturedAt: "2026-08-31T00:00:00.000Z",
      viewerUrl: "http://127.0.0.1:8787/viewer/?manifest=test",
      phase: "outer-readiness",
      browserErrors: [],
      frames: [
        { url: "http://127.0.0.1:8787/viewer/", isMainFrame: true, ready: true, errors: [] },
        {
          url: "http://127.0.0.1:8787/artifacts/projects/p/module/revision-001/index.html",
          isMainFrame: false,
          ready: false,
          errors: ["Cannot read properties of undefined (reading 'position')"],
          renderState: {
            assetsLoaded: false,
            sceneMounted: false,
            moduleCompiled: false,
            cameraSettled: false,
            stableFrames: 0,
            failure: "Cannot read properties of undefined (reading 'position')",
          },
        },
      ],
      network: [],
    };

    expect(canRepairRendererFailure(diagnostics)).toBe(true);
    diagnostics.network.push({
      kind: "response",
      url: "http://127.0.0.1:8787/artifacts/projects/p/module/revision-001/module.js",
      resourceType: "script",
      status: 502,
    });
    expect(canRepairRendererFailure(diagnostics)).toBe(false);
  });

  it("captures a new-page failure as startup diagnostics and discards the broken browser", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "seein-renderer-startup-"));
    const driver = new NewPageFailureDriver({
      PLAYWRIGHT_HEADLESS: true,
      PLAYWRIGHT_EXECUTABLE_PATH: "",
    } as Config);
    const captureError = async (name: string): Promise<ScreenshotCaptureError> => {
      try {
        await driver.capture("http://127.0.0.1:8787/viewer/", path.join(directory, `${name}.png`));
        throw new Error("Expected capture to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(ScreenshotCaptureError);
        return error as ScreenshotCaptureError;
      }
    };

    try {
      const first = await captureError("first");
      const second = await captureError("second");

      for (const error of [first, second]) {
        expect(error.retryable).toBe(true);
        expect(error.diagnostics).toMatchObject({ phase: "startup", frames: [] });
        expect(canRepairRendererFailure(error.diagnostics)).toBe(false);
      }
      // A later provider retry starts a fresh Chromium process instead of
      // reusing the one that could not allocate a page.
      expect(driver.launcherCalls).toBe(2);
      expect(driver.browserCloseCalls).toBe(2);
    } finally {
      await driver.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
