import path from "node:path";
import { build } from "esbuild";
import ts from "typescript";
import type { ArtifactStore } from "../storage/artifact-store.js";
import { CompiledSurgicalModuleSchema, SurgicalModuleSourceSchema, type CompiledSurgicalModule, type SurgicalModuleSource } from "./module-contracts.js";

const ALLOWED_IMPORTS = new Set([
  "@seein/atlas",
  "react",
  "three",
]);

const BANNED_SOURCE_PATTERNS: Array<[RegExp, string]> = [
  [/\bfetch\s*\(/, "network fetch"],
  [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
  [/\bWebSocket\b/, "WebSocket"],
  [/\bEventSource\b/, "EventSource"],
  [/\bnavigator\s*\.\s*sendBeacon\b/, "sendBeacon"],
  [/\b(?:localStorage|sessionStorage|indexedDB)\b/, "browser persistence"],
  [/\bdocument\s*\.\s*cookie\b/, "cookies"],
  [/\beval\s*\(/, "eval"],
  [/\bnew\s+Function\b/, "dynamic Function"],
  [/\bimport\s*\(/, "dynamic import"],
  [/\b(?:node:|child_process|worker_threads|node_modules)\b/, "Node runtime access"],
  [/<script\b/i, "script element"],
  [/https?:\/\//i, "remote URL"],
];

export class SurgicalModuleCompiler {
  readonly identity = "seein-atlas-esbuild:v1";

  constructor(
    private readonly artifacts: ArtifactStore,
    private readonly atlasEntry = path.resolve(process.cwd(), "renderer/atlas/index.ts"),
  ) {}

  async compile(relativeProjectRoot: string, revision: number, input: SurgicalModuleSource): Promise<CompiledSurgicalModule> {
    const module = SurgicalModuleSourceSchema.parse(input);
    validateGeneratedModuleSource(module.source);
    const revisionName = `revision-${String(revision).padStart(3, "0")}`;
    const root = `${relativeProjectRoot}/module/${revisionName}`;
    const sourceArtifact = await this.artifacts.writeText(`${root}/scene.tsx`, module.source);
    typecheckGeneratedModule(sourceArtifact.path, this.atlasEntry);
    const entrySource = renderEntrySource(module.definition);
    const buildResult = await build({
      stdin: {
        contents: entrySource,
        loader: "tsx",
        resolveDir: path.dirname(sourceArtifact.path),
        sourcefile: "entry.tsx",
      },
      alias: { "@seein/atlas": this.atlasEntry },
      nodePaths: [path.resolve(process.cwd(), "node_modules")],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: ["es2022"],
      jsx: "automatic",
      minify: true,
      sourcemap: false,
      legalComments: "none",
      define: {
        "process.env.NODE_ENV": JSON.stringify("production"),
      },
      logLevel: "silent",
    });
    const javascript = buildResult.outputFiles.find((file) => file.path.endsWith("<stdout>"))
      ?? buildResult.outputFiles.find((file) => file.path.endsWith(".js"))
      ?? buildResult.outputFiles[0];
    if (!javascript || javascript.contents.byteLength < 1_000) {
      throw new Error("Surgical module compiler did not produce a browser bundle");
    }
    const bundleArtifact = await this.artifacts.writeBuffer(`${root}/module.js`, Buffer.from(javascript.contents));
    const htmlArtifact = await this.artifacts.writeText(`${root}/index.html`, moduleHtml());
    return CompiledSurgicalModuleSchema.parse({
      schemaVersion: "1.0",
      revision,
      definition: module.definition,
      viewerUrl: htmlArtifact.url,
      bundleUrl: bundleArtifact.url,
      sourceUrl: sourceArtifact.url,
      sourceSha256: sourceArtifact.sha256,
      bundleSha256: bundleArtifact.sha256,
      generatedAt: new Date().toISOString(),
    });
  }
}

function typecheckGeneratedModule(sourcePath: string, atlasEntry: string): void {
  const options: ts.CompilerOptions = {
    allowSyntheticDefaultImports: true,
    esModuleInterop: true,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    baseUrl: process.cwd(),
    typeRoots: [path.resolve(process.cwd(), "node_modules/@types")],
    paths: {
      "@seein/atlas": [atlasEntry],
      "react/jsx-runtime": [path.resolve(process.cwd(), "node_modules/@types/react/jsx-runtime.d.ts")],
    },
  };
  const program = ts.createProgram([sourcePath], options);
  const diagnostics = ts.getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file?.fileName === sourcePath);
  if (diagnostics.length === 0) return;
  const formatted = ts.formatDiagnostics(diagnostics.slice(0, 12), {
    getCanonicalFileName: (fileName: string) => fileName,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => "\n",
  });
  throw new Error(`Generated surgical module failed TypeScript validation:\n${formatted}`);
}

export function validateGeneratedModuleSource(source: string): void {
  const importPattern = /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g;
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1]!;
    if (!ALLOWED_IMPORTS.has(specifier)) {
      throw new Error(`Generated surgical module imports forbidden package "${specifier}". Allowed imports: ${[...ALLOWED_IMPORTS].join(", ")}`);
    }
  }
  if (!source.includes("@seein/atlas")) {
    throw new Error("Generated surgical module must use the curated @seein/atlas component library");
  }
  if (!/export\s+default\s+(?:function|class|[A-Za-z_$])/.test(source)) {
    throw new Error("Generated surgical module must have a default React scene export");
  }
  for (const [pattern, label] of BANNED_SOURCE_PATTERNS) {
    if (pattern.test(source)) throw new Error(`Generated surgical module contains forbidden ${label}`);
  }
}

function renderEntrySource(definition: SurgicalModuleSource["definition"]): string {
  return `
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import GeneratedScene from "./scene.tsx";
import { AtlasModuleHost } from "@seein/atlas";

window.__SEEIN_READY__ = false;
window.__SEEIN_ERRORS__ = [];
window.__SEEIN_RENDER_STATE__ = {
  assetsLoaded: false,
  moduleCompiled: false,
  cameraSettled: false,
  stableFrames: 0,
  stateId: "",
  viewId: "",
  sceneMounted: false,
  assetProgress: 0,
};
const reportGlobalModuleFailure = (value: unknown) => {
  const message = value instanceof Error ? value.message : String(value);
  if (!window.__SEEIN_ERRORS__?.includes(message)) window.__SEEIN_ERRORS__?.push(message);
  window.__SEEIN_RENDER_FAILURE__ = message;
  if (window.__SEEIN_RENDER_STATE__) window.__SEEIN_RENDER_STATE__.failure = message;
  window.parent.postMessage({ type: "seein-module-failed", error: message, errors: window.__SEEIN_ERRORS__, renderState: window.__SEEIN_RENDER_STATE__ }, "*");
};
window.addEventListener("error", (event) => reportGlobalModuleFailure(event.error ?? event.message));
window.addEventListener("unhandledrejection", (event) => reportGlobalModuleFailure(event.reason));

const definition = ${JSON.stringify(definition)};
createRoot(document.getElementById("root")).render(
  <StrictMode><AtlasModuleHost definition={definition} Scene={GeneratedScene} /></StrictMode>,
);
`;
}

function moduleHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; worker-src 'self' blob:" />
    <title>SeeIn surgical module</title>
    <style>html,body,#root{width:100%;height:100%;margin:0;overflow:hidden;background:#082a2e}button{font:inherit}</style>
  </head>
  <body><div id="root"></div><script type="module" src="./module.js"></script></body>
</html>\n`;
}
