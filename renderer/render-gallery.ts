export type RenderGalleryStatus = "rendering" | "ready" | "passed" | "review" | "failed";

export interface RenderQualityScores {
  recognizability?: number;
  domainFidelity?: number;
  visualQuality?: number;
  constructionCompleteness?: number;
}

export interface RenderGalleryItem {
  key: string;
  label: string;
  status: RenderGalleryStatus;
  targetId?: string;
  stateId?: string;
  viewId?: string;
  revision?: number;
  imageUrl?: string;
  diagnosticUrl?: string;
  scores?: RenderQualityScores;
  createdAt?: string;
}

export interface RenderGalleryEvent {
  kind?: "stage" | "operation";
  operationId?: string;
  stage?: string;
  status?: string;
  detail?: Record<string, unknown>;
  createdAt?: string;
  sequence?: number;
}

interface OrderedEvent {
  event: RenderGalleryEvent;
  order: number;
}

interface OrderedItem extends RenderGalleryItem {
  order: number;
}

interface InspectionResult {
  verdict: "pass" | "fix";
  scores?: RenderQualityScores;
}

/**
 * Build a compact, latest-first view of render activity from the same durable
 * event stream that drives the Guide. Successful captures replace an earlier
 * diagnostic for the same revision/target, and later QA results decorate the
 * captured image without requiring another endpoint.
 */
export function deriveRenderGallery(events: RenderGalleryEvent[]): RenderGalleryItem[] {
  const ordered = events
    .map((event, index) => ({ event, order: eventOrder(event, index) }))
    .sort((a, b) => a.order - b.order);
  const items = new Map<string, OrderedItem>();
  const inspections = new Map<string, InspectionResult>();
  const operations = new Map<string, OrderedEvent>();

  for (const entry of ordered) {
    const { event, order } = entry;
    const detail = event.detail ?? {};
    const key = renderKey(detail, event.operationId ?? `event-${order}`);

    if (event.stage === "inspecting" && event.status === "completed") {
      const verdict = detail.verdict === "pass" || detail.verdict === "fix" ? detail.verdict : undefined;
      if (verdict) {
        const scores = qualityScores(detail.scores);
        inspections.set(key, { verdict, ...(scores ? { scores } : {}) });
      }
    }

    if (event.kind === "operation" && isRenderOperation(detail)) {
      operations.set(event.operationId ?? `operation-${order}`, entry);
    }

    const renderUrl = text(detail.renderUrl);
    const failureScreenshotUrl = text(detail.failureScreenshotUrl);
    const diagnosticUrl = text(detail.diagnosticUrl);
    if (!renderUrl && !failureScreenshotUrl && !diagnosticUrl) continue;
    const imageUrl = renderUrl ?? failureScreenshotUrl;

    const targetId = text(detail.targetId);
    const stateId = text(detail.stateId);
    const viewId = text(detail.viewId);
    const revision = positiveInteger(detail.revision);
    items.set(key, {
      key,
      label: renderLabel(detail, targetId ?? viewId ?? stateId ?? "Rendered view"),
      status: renderUrl ? "ready" : "failed",
      ...(targetId ? { targetId } : {}),
      ...(stateId ? { stateId } : {}),
      ...(viewId ? { viewId } : {}),
      ...(revision ? { revision } : {}),
      ...(imageUrl ? { imageUrl } : {}),
      ...(diagnosticUrl ? { diagnosticUrl } : {}),
      ...(event.createdAt ? { createdAt: event.createdAt } : {}),
      order,
    });
  }

  for (const { event, order } of operations.values()) {
    const detail = event.detail ?? {};
    const phase = text(detail.phase);
    if (phase !== "started" && phase !== "retrying" && phase !== "failed") continue;
    const key = renderKey(detail, event.operationId ?? `operation-${order}`);
    if (items.has(key)) continue;
    const targetId = text(detail.targetId);
    const stateId = text(detail.stateId);
    const viewId = text(detail.viewId);
    const revision = positiveInteger(detail.revision);
    items.set(key, {
      key,
      label: renderLabel(detail, targetId ?? viewId ?? stateId ?? "Rendered view"),
      status: phase === "failed" ? "failed" : "rendering",
      ...(targetId ? { targetId } : {}),
      ...(stateId ? { stateId } : {}),
      ...(viewId ? { viewId } : {}),
      ...(revision ? { revision } : {}),
      ...(event.createdAt ? { createdAt: event.createdAt } : {}),
      order,
    });
  }

  for (const item of items.values()) {
    const inspection = inspections.get(item.key);
    if (!inspection || item.status === "failed" || item.status === "rendering") continue;
    item.status = inspection.verdict === "pass" ? "passed" : "review";
    if (inspection.scores) item.scores = inspection.scores;
  }

  return [...items.values()]
    .sort((a, b) => b.order - a.order)
    .map(({ order: _order, ...item }) => item);
}

export function renderScoreSummary(scores: RenderQualityScores | undefined): string[] {
  if (!scores) return [];
  return [
    scoreLabel("Recognizability", scores.recognizability),
    scoreLabel("Fidelity", scores.domainFidelity),
    scoreLabel("Visual", scores.visualQuality),
    scoreLabel("Complete", scores.constructionCompleteness),
  ].filter((value): value is string => Boolean(value));
}

function qualityScores(value: unknown): RenderQualityScores | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const recognizability = unitScore(candidate.recognizabilityScore);
  const domainFidelity = unitScore(candidate.domainFidelityScore);
  const visualQuality = unitScore(candidate.visualQualityScore);
  const constructionCompleteness = unitScore(candidate.constructionCompletenessScore);
  if (
    recognizability === undefined
    && domainFidelity === undefined
    && visualQuality === undefined
    && constructionCompleteness === undefined
  ) return undefined;
  return {
    ...(recognizability !== undefined ? { recognizability } : {}),
    ...(domainFidelity !== undefined ? { domainFidelity } : {}),
    ...(visualQuality !== undefined ? { visualQuality } : {}),
    ...(constructionCompleteness !== undefined ? { constructionCompleteness } : {}),
  };
}

function renderKey(detail: Record<string, unknown>, fallback: string): string {
  const revision = positiveInteger(detail.revision);
  const target = text(detail.targetId) ?? text(detail.viewId) ?? text(detail.stateId);
  return `${revision ?? "current"}:${target ?? fallback}`;
}

function renderLabel(detail: Record<string, unknown>, fallback: string): string {
  const explicit = text(detail.targetLabel);
  if (explicit) return explicit;
  const operation = text(detail.label)?.replace(/^Render\s+/i, "").trim();
  return operation || humanize(fallback);
}

function isRenderOperation(detail: Record<string, unknown>): boolean {
  const action = text(detail.action) ?? "";
  const provider = text(detail.provider) ?? "";
  return /playwright.*screenshot|screenshot.*playwright/i.test(`${action} ${provider}`);
}

function eventOrder(event: RenderGalleryEvent, fallback: number): number {
  if (typeof event.sequence === "number" && Number.isFinite(event.sequence)) return event.sequence;
  const timestamp = event.createdAt ? Date.parse(event.createdAt) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : fallback;
}

function scoreLabel(label: string, value: number | undefined): string | undefined {
  return value === undefined ? undefined : `${label} ${Math.round(value * 100)}`;
}

function unitScore(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function humanize(value: string): string {
  const normalized = value.replaceAll(/[-_]+/g, " ").trim();
  return normalized ? normalized.replace(/^./, (character) => character.toUpperCase()) : "Rendered view";
}
