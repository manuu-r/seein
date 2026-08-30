import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import type { Config } from "../config.js";

export interface ScreenshotResult {
  path: string;
  browserErrors: string[];
}

export interface ScreenshotDriver {
  readonly identity: string;
  capture(viewerUrl: string, outputPath: string): Promise<ScreenshotResult>;
  close(): Promise<void>;
}

export class PlaywrightScreenshotDriver implements ScreenshotDriver {
  readonly identity = "playwright-chromium:explicit-readiness-v3";
  private browserPromise: Promise<Browser> | null = null;

  constructor(private readonly config: Config) {}

  async capture(viewerUrl: string, outputPath: string): Promise<ScreenshotResult> {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const browser = await this.getBrowser();
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    try {
      const consoleErrors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      page.on("pageerror", (error) => consoleErrors.push(error.message));
      await page.goto(viewerUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForFunction(() => (window as unknown as { __SEEIN_READY__?: boolean }).__SEEIN_READY__ === true, undefined, {
        timeout: 60_000,
      });
      await page.waitForFunction(
        () => {
          const state = (window as unknown as {
            __SEEIN_RENDER_STATE__?: {
              assetsLoaded?: boolean;
              moduleCompiled?: boolean;
              cameraSettled?: boolean;
              stableFrames?: number;
            };
          }).__SEEIN_RENDER_STATE__;
          return state?.assetsLoaded === true &&
            state.moduleCompiled === true &&
            state.cameraSettled === true &&
            (state.stableFrames ?? 0) >= 2;
        },
        undefined,
        { timeout: 60_000 },
      );
      const viewerErrors = await page.evaluate(
        () => (window as unknown as { __SEEIN_ERRORS__?: string[] }).__SEEIN_ERRORS__ ?? [],
      );
      await page.screenshot({ path: outputPath, type: "png" });
      const readinessError = viewerErrors.find((message) => /did not reach render readiness within/i.test(message));
      if (readinessError) {
        // Treat a cold-start readiness timeout as a renderer/provider failure,
        // not as anatomical evidence. The orchestrator retries the Chromium
        // capture with warm HTTP and loader caches before considering a source
        // revision, so Gemini never judges a timeout screenshot as anatomy.
        throw new Error(readinessError);
      }
      return { path: outputPath, browserErrors: [...consoleErrors, ...viewerErrors] };
    } finally {
      await page.close();
    }
  }

  async close(): Promise<void> {
    if (!this.browserPromise) return;
    const browser = await this.browserPromise.catch(() => null);
    this.browserPromise = null;
    await browser?.close();
  }

  private getBrowser(): Promise<Browser> {
    if (!this.browserPromise) {
      const executablePath = resolveChromiumPath(this.config.PLAYWRIGHT_EXECUTABLE_PATH);
      this.browserPromise = chromium.launch({
        headless: this.config.PLAYWRIGHT_HEADLESS,
        ...(executablePath ? { executablePath } : {}),
      });
    }
    return this.browserPromise;
  }
}

function resolveChromiumPath(configured: string): string | undefined {
  const candidates = [
    configured,
    chromium.executablePath(),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate));
}
