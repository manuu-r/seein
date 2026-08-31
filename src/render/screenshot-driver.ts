import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Frame, type Page } from "playwright";
import type { Config } from "../config.js";

export interface RenderReadinessState {
  assetsLoaded?: boolean;
  moduleCompiled?: boolean;
  cameraSettled?: boolean;
  stableFrames?: number;
  stateId?: string;
  viewId?: string;
  sceneMounted?: boolean;
  assetProgress?: number;
  failure?: string;
}

export interface RenderFrameDiagnostics {
  url: string;
  isMainFrame: boolean;
  ready: boolean;
  errors: string[];
  renderState?: RenderReadinessState;
  documentReadyState?: string;
  rootChildCount?: number;
  canvasCount?: number;
  canvas?: { width: number; height: number };
}

export interface RenderNetworkDiagnostic {
  kind: "response" | "request-failed";
  url: string;
  resourceType: string;
  status?: number;
  failure?: string;
}

export type RendererDiagnosticPhase = "startup" | "navigation" | "outer-readiness" | "frame-stability" | "screenshot";

export interface RendererDiagnostics {
  capturedAt: string;
  viewerUrl: string;
  phase: RendererDiagnosticPhase;
  browserErrors: string[];
  frames: RenderFrameDiagnostics[];
  network: RenderNetworkDiagnostic[];
  failureScreenshotPath?: string;
}

/** A capture failure with the browser evidence and retry classification preserved. */
export class ScreenshotCaptureError extends Error {
  readonly retryable: boolean;

  constructor(
    message: string,
    readonly diagnostics: RendererDiagnostics,
    retryable: boolean,
    cause?: unknown,
  ) {
    super(`${message} · ${summarizeRendererDiagnostics(diagnostics)}`, cause === undefined ? undefined : { cause });
    this.name = "ScreenshotCaptureError";
    this.retryable = retryable;
  }
}

export interface ScreenshotResult {
  path: string;
  browserErrors: string[];
  diagnostics?: RendererDiagnostics;
}

export interface ScreenshotDriver {
  readonly identity: string;
  capture(viewerUrl: string, outputPath: string): Promise<ScreenshotResult>;
  close(): Promise<void>;
}

export class PlaywrightScreenshotDriver implements ScreenshotDriver {
  readonly identity = "playwright-chromium:diagnostic-readiness-v4";
  private browserPromise: Promise<Browser> | null = null;

  constructor(private readonly config: Config) {}

  async capture(viewerUrl: string, outputPath: string): Promise<ScreenshotResult> {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const consoleErrors: string[] = [];
    const network: RenderNetworkDiagnostic[] = [];
    let phase: RendererDiagnosticPhase = "startup";
    let page: Page | undefined;
    try {
      const browser = await this.getBrowser();
      const nextPage = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
      page = nextPage;
      phase = "navigation";
      nextPage.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(`console.error: ${message.text()}`);
      });
      nextPage.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
      nextPage.on("requestfailed", (request) => {
        recordNetworkDiagnostic(network, {
          kind: "request-failed",
          url: request.url(),
          resourceType: request.resourceType(),
          failure: request.failure()?.errorText ?? "unknown request failure",
        });
      });
      nextPage.on("response", (response) => {
        if (response.status() < 400 && !isRendererAsset(response.url())) return;
        recordNetworkDiagnostic(network, {
          kind: "response",
          url: response.url(),
          resourceType: response.request().resourceType(),
          status: response.status(),
        });
      });

      await nextPage.goto(viewerUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      phase = "outer-readiness";
      await nextPage.waitForFunction(
        () => {
          const viewer = window as unknown as { __SEEIN_READY__?: boolean; __SEEIN_RENDER_FAILURE__?: string };
          return viewer.__SEEIN_READY__ === true || Boolean(viewer.__SEEIN_RENDER_FAILURE__);
        },
        undefined,
        { timeout: 60_000, polling: 100 },
      );
      const initial = await readFrameSnapshot(nextPage.mainFrame());
      if (initial.renderState?.failure) throw new Error(initial.renderState.failure);
      if (initial.errors.length > 0) {
        const readinessError = initial.errors.find((message) => /failed|error|readiness/i.test(message));
        if (readinessError) throw new Error(readinessError);
      }
      phase = "frame-stability";
      await nextPage.waitForFunction(
        () => {
          const viewer = window as unknown as {
            __SEEIN_RENDER_FAILURE__?: string;
            __SEEIN_RENDER_STATE__?: RenderReadinessState;
          };
          const state = viewer.__SEEIN_RENDER_STATE__;
          return Boolean(viewer.__SEEIN_RENDER_FAILURE__) || (
            state?.assetsLoaded === true &&
            state.moduleCompiled === true &&
            state.cameraSettled === true &&
            (state.stableFrames ?? 0) >= 2
          );
        },
        undefined,
        { timeout: 60_000, polling: 100 },
      );
      const settled = await readFrameSnapshot(nextPage.mainFrame());
      if (settled.renderState?.failure) throw new Error(settled.renderState.failure);
      phase = "screenshot";
      await nextPage.screenshot({ path: outputPath, type: "png" });
      return {
        path: outputPath,
        browserErrors: boundedMessages([...consoleErrors, ...settled.errors]),
        diagnostics: await collectRendererDiagnostics(nextPage, viewerUrl, phase, consoleErrors, network),
      };
    } catch (error) {
      const diagnostics = page
        ? await collectRendererDiagnostics(page, viewerUrl, phase, consoleErrors, network)
        : startupDiagnostics(viewerUrl, error, consoleErrors, network);
      if (page) {
        const failureScreenshotPath = await saveFailureScreenshot(page, outputPath);
        if (failureScreenshotPath) diagnostics.failureScreenshotPath = failureScreenshotPath;
      } else {
        // A broken/overloaded Chromium process should not be reused by the one
        // permitted infrastructure retry.
        await this.discardBrowser();
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new ScreenshotCaptureError(
        message,
        diagnostics,
        // Chromium startup/new-page failures and pre-viewer transport failures
        // are infrastructure conditions. They receive one retry but never ask
        // Gemini to rewrite an otherwise unknown scene.
        isRendererInfrastructureFailure(diagnostics)
          || (phase === "navigation" && diagnostics.frames.length <= 1 && diagnostics.network.length > 0),
        error,
      );
    } finally {
      await page?.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    await this.discardBrowser();
  }

  private getBrowser(): Promise<Browser> {
    if (!this.browserPromise) {
      const executablePath = resolveChromiumPath(this.config.PLAYWRIGHT_EXECUTABLE_PATH);
      const launch = this.launchBrowser({
        headless: this.config.PLAYWRIGHT_HEADLESS,
        ...(executablePath ? { executablePath } : {}),
      });
      this.browserPromise = launch;
      void launch.catch(() => {
        if (this.browserPromise === launch) this.browserPromise = null;
      });
    }
    return this.browserPromise;
  }

  /** Kept separate so startup failures can be exercised without a real browser. */
  protected launchBrowser(options: Parameters<typeof chromium.launch>[0]): Promise<Browser> {
    return chromium.launch(options);
  }

  private async discardBrowser(): Promise<void> {
    const pending = this.browserPromise;
    this.browserPromise = null;
    if (!pending) return;
    const browser = await pending.catch(() => null);
    await browser?.close().catch(() => undefined);
  }
}

async function collectRendererDiagnostics(
  page: Page,
  viewerUrl: string,
  phase: RendererDiagnosticPhase,
  consoleErrors: string[],
  network: RenderNetworkDiagnostic[],
): Promise<RendererDiagnostics> {
  const frames = await Promise.all(page.frames().slice(0, 8).map((frame) => readFrameSnapshot(frame)));
  return {
    capturedAt: new Date().toISOString(),
    viewerUrl: boundedText(viewerUrl, 2_000),
    phase,
    browserErrors: boundedMessages(consoleErrors),
    frames,
    network: network.slice(-32).map((entry) => ({
      ...entry,
      url: boundedText(entry.url, 2_000),
      ...(entry.failure ? { failure: boundedText(entry.failure, 1_000) } : {}),
    })),
  };
}

function startupDiagnostics(
  viewerUrl: string,
  error: unknown,
  consoleErrors: string[],
  network: RenderNetworkDiagnostic[],
): RendererDiagnostics {
  const message = error instanceof Error ? error.message : String(error);
  return {
    capturedAt: new Date().toISOString(),
    viewerUrl: boundedText(viewerUrl, 2_000),
    phase: "startup",
    browserErrors: boundedMessages([...consoleErrors, `renderer startup: ${message}`]),
    frames: [],
    network: network.slice(-32).map((entry) => ({
      ...entry,
      url: boundedText(entry.url, 2_000),
      ...(entry.failure ? { failure: boundedText(entry.failure, 1_000) } : {}),
    })),
  };
}

async function readFrameSnapshot(frame: Frame): Promise<RenderFrameDiagnostics> {
  try {
    const snapshot = await frame.evaluate(() => {
      type RenderState = {
        assetsLoaded?: boolean;
        moduleCompiled?: boolean;
        cameraSettled?: boolean;
        stableFrames?: number;
        stateId?: string;
        viewId?: string;
        sceneMounted?: boolean;
        assetProgress?: number;
        failure?: string;
      };
      const viewer = window as unknown as {
        __SEEIN_READY__?: boolean;
        __SEEIN_ERRORS__?: unknown;
        __SEEIN_RENDER_STATE__?: RenderState;
        __SEEIN_RENDER_FAILURE__?: string;
      };
      const state = viewer.__SEEIN_RENDER_STATE__;
      const errors = Array.isArray(viewer.__SEEIN_ERRORS__)
        ? viewer.__SEEIN_ERRORS__.filter((entry): entry is string => typeof entry === "string")
        : [];
      if (viewer.__SEEIN_RENDER_FAILURE__) errors.push(viewer.__SEEIN_RENDER_FAILURE__);
      const canvas = document.querySelector("canvas");
      return {
        ready: viewer.__SEEIN_READY__ === true,
        errors,
        renderState: state
          ? {
              assetsLoaded: state.assetsLoaded === true,
              moduleCompiled: state.moduleCompiled === true,
              cameraSettled: state.cameraSettled === true,
              stableFrames: state.stableFrames ?? 0,
              stateId: state.stateId ?? "",
              viewId: state.viewId ?? "",
              sceneMounted: state.sceneMounted === true,
              assetProgress: state.assetProgress ?? 0,
              ...(state.failure ? { failure: state.failure } : {}),
            }
          : undefined,
        documentReadyState: document.readyState,
        rootChildCount: document.getElementById("root")?.childElementCount ?? 0,
        canvasCount: document.querySelectorAll("canvas").length,
        ...(canvas ? { canvas: { width: canvas.width, height: canvas.height } } : {}),
      };
    });
    return {
      url: boundedText(frame.url(), 2_000),
      isMainFrame: frame.parentFrame() === null,
      ready: snapshot.ready,
      errors: boundedMessages(snapshot.errors),
      ...(snapshot.renderState ? { renderState: snapshot.renderState } : {}),
      ...(snapshot.documentReadyState ? { documentReadyState: snapshot.documentReadyState } : {}),
      ...(typeof snapshot.rootChildCount === "number" ? { rootChildCount: snapshot.rootChildCount } : {}),
      ...(typeof snapshot.canvasCount === "number" ? { canvasCount: snapshot.canvasCount } : {}),
      ...(snapshot.canvas ? { canvas: snapshot.canvas } : {}),
    };
  } catch (error) {
    return {
      url: boundedText(frame.url(), 2_000),
      isMainFrame: frame.parentFrame() === null,
      ready: false,
      errors: [boundedText(`Could not inspect frame: ${error instanceof Error ? error.message : String(error)}`, 1_000)],
    };
  }
}

async function saveFailureScreenshot(page: Page, outputPath: string): Promise<string | undefined> {
  const failurePath = outputPath.endsWith(".png")
    ? `${outputPath.slice(0, -4)}.diagnostic.png`
    : `${outputPath}.diagnostic.png`;
  try {
    await page.screenshot({ path: failurePath, type: "png" });
    return failurePath;
  } catch {
    return undefined;
  }
}

function recordNetworkDiagnostic(target: RenderNetworkDiagnostic[], value: RenderNetworkDiagnostic): void {
  if (target.length >= 64) return;
  target.push(value);
}

function isRendererAsset(value: string): boolean {
  try {
    const url = new URL(value);
    return url.pathname.includes("/artifacts/") || /\.(?:js|css|json|html)$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function boundedMessages(values: string[]): string[] {
  return [...new Set(values.map((value) => boundedText(value, 1_000)))].slice(-32);
}

function boundedText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

export function summarizeRendererDiagnostics(diagnostics: RendererDiagnostics): string {
  const child = diagnostics.frames.find((frame) => !frame.isMainFrame) ?? diagnostics.frames[0];
  const state = child?.renderState;
  const errors = [...diagnostics.browserErrors, ...(child?.errors ?? [])].slice(-2).join(" | ");
  return [
    `phase=${diagnostics.phase}`,
    child ? `frame=${child.url}` : "frame=none",
    state
      ? `state=assets:${state.assetsLoaded === true},mounted:${state.sceneMounted === true},compiled:${state.moduleCompiled === true},camera:${state.cameraSettled === true},frames:${state.stableFrames ?? 0}`
      : "state=unavailable",
    errors ? `errors=${boundedText(errors, 800)}` : "errors=none",
  ].join("; ");
}

/**
 * Chromium could not launch or allocate a page, so no generated source was
 * observed. This is deliberately distinct from an in-page render failure:
 * callers may retry the renderer, but must not ask Gemini to revise a scene.
 */
export function isRendererInfrastructureFailure(diagnostics: RendererDiagnostics): boolean {
  return diagnostics.phase === "startup";
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
