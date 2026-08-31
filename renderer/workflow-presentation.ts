export type WorkflowTone = "info" | "success" | "warning" | "error";

export interface GeminiUsageSummary {
  usedTokens: number;
  limitTokens: number;
  responses: number;
  percent: number;
}

export interface OperationPresentation {
  badge: "INFO" | "DONE" | "RETRY" | "ERROR";
  tone: WorkflowTone;
  headline: string;
  description: string;
  metadata: string[];
}

export interface FailurePresentation {
  headline: string;
  description: string;
}

/**
 * The event stream already carries a project-scoped usage snapshot after each
 * Gemini response. Choosing the largest value makes the display robust when
 * event delivery is slightly out of order.
 */
export function summarizeGeminiUsage(
  details: Array<Record<string, unknown> | undefined>,
): GeminiUsageSummary | undefined {
  let latest: GeminiUsageSummary | undefined;
  for (const detail of details) {
    const usedTokens = nonNegativeNumber(detail?.geminiTokensUsed);
    const limitTokens = positiveNumber(detail?.geminiTokensLimit);
    if (usedTokens === undefined || limitTokens === undefined) continue;
    const responses = nonNegativeNumber(detail?.geminiTokenResponses) ?? 0;
    const next: GeminiUsageSummary = {
      usedTokens,
      limitTokens,
      responses,
      percent: Math.min(100, Math.round((usedTokens / limitTokens) * 100)),
    };
    if (!latest || next.usedTokens >= latest.usedTokens) latest = next;
  }
  return latest;
}

export function formatGeminiUsage(usage: GeminiUsageSummary): string {
  return `Gemini ${formatTokenCount(usage.usedTokens)} / ${formatTokenCount(usage.limitTokens)} · ${usage.percent}%`;
}

export function operationPresentation(
  status: string,
  label: string,
  detail: Record<string, unknown> | undefined,
): OperationPresentation {
  const metadata = operationMetadata(detail);
  const work = describeOperation(detail);
  const error = typeof detail?.error === "string" ? describeFailure(detail.error) : undefined;

  if (status === "completed") {
    return {
      badge: "DONE",
      tone: "success",
      headline: `${label} completed`,
      description: work.completed,
      metadata,
    };
  }
  if (status === "retrying") {
    return {
      badge: "RETRY",
      tone: "warning",
      headline: `${label} will retry`,
      description: error?.description ?? "That attempt did not complete. Retrying automatically.",
      metadata,
    };
  }
  if (status === "failed") {
    return {
      badge: "ERROR",
      tone: "error",
      headline: `${label} needs attention`,
      description: error?.description ?? "This step did not complete.",
      metadata,
    };
  }
  return {
    badge: "INFO",
    tone: "info",
    headline: label,
    description: work.running,
    metadata,
  };
}

export function workflowFailurePresentation(message: string): FailurePresentation {
  return describeFailure(message);
}

function operationMetadata(detail: Record<string, unknown> | undefined): string[] {
  if (!detail) return [];
  const bits: string[] = [];
  const attempt = nonNegativeNumber(detail.attempt);
  if (attempt !== undefined) {
    const maximum = positiveNumber(detail.maxAttempts);
    bits.push(maximum ? `Attempt ${attempt} of ${maximum}` : `Attempt ${attempt}`);
  }
  const duration = durationLabel(detail.totalDurationMs ?? detail.durationMs);
  if (duration) bits.push(duration);
  const retryIn = durationLabel(detail.retryInMs);
  if (retryIn) bits.push(`retrying in ${retryIn}`);
  return bits;
}

function describeOperation(detail: Record<string, unknown> | undefined): { running: string; completed: string } {
  const action = typeof detail?.action === "string" ? detail.action : "";
  const provider = typeof detail?.provider === "string" ? detail.provider : "";
  if (/playwright|screenshot/i.test(action) || /playwright/i.test(provider)) {
    return {
      running: "Opening the generated view and checking that it renders correctly.",
      completed: "The generated view rendered successfully.",
    };
  }
  if (/image search/i.test(action)) {
    return {
      running: "Finding useful visual reference material.",
      completed: "Reference material was collected.",
    };
  }
  if (/generatecontent|gemini/i.test(action) || /gemini/i.test(provider)) {
    return {
      running: "Gemini is working on the current anatomy task.",
      completed: "Gemini returned a result for this step.",
    };
  }
  if (/esbuild|compile|validate/i.test(action)) {
    return {
      running: "Compiling and checking the generated anatomy module.",
      completed: "The generated anatomy module compiled successfully.",
    };
  }
  return { running: "Working on this step.", completed: "This step completed." };
}

function describeFailure(message: string): FailurePresentation {
  if (/renderer startup|browserType\.launch|failed to launch (?:browser|chromium)|browser\.newPage|target page, context or browser has been closed/i.test(message)) {
    return {
      headline: "The renderer could not start",
      description: "Chromium could not start a browser page. This is a renderer infrastructure issue, so Gemini will not rewrite the generated scene.",
    };
  }
  if (/page\.waitForFunction|render readiness|did not reach render readiness|generated surgical module.*ready/i.test(message)) {
    return {
      headline: "The view did not reach render readiness",
      description: "The renderer did not receive a stable ready signal from this view. The source is kept unless diagnostics show a specific module runtime error.",
    };
  }
  if (/gemini token budget|token budget reached/i.test(message)) {
    return {
      headline: "This project reached its Gemini token budget",
      description: "No further Gemini requests will be made for this project until its budget is changed.",
    };
  }
  if (/\b403\b|\b401\b|iap|unauthori[sz]ed|access denied/i.test(message)) {
    return {
      headline: "A required scene file could not be accessed",
      description: "The renderer was blocked from reading a required file. Check access or routing before retrying.",
    };
  }
  if (/\b404\b|not found/i.test(message)) {
    return {
      headline: "A required scene file could not be found",
      description: "The renderer could not find one of the files needed for this view.",
    };
  }
  if (/network|econn|fetch failed|socket|timed out/i.test(message)) {
    return {
      headline: "A connection timed out",
      description: "A required service did not respond in time. The workflow kept the completed work and stopped at this step.",
    };
  }
  const concise = cleanError(message);
  return {
    headline: "The workflow stopped at this step",
    description: concise || "The workflow encountered an unexpected problem. Completed work has been kept.",
  };
}

function cleanError(value: string): string {
  const candidate = value
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0 && !/^at\s+/.test(line))
    ?.replace(/^Error:\s*/i, "")
    .replace(/https?:\/\/\S+/g, "the scene viewer")
    .replace(/\s+/g, " ")
    .trim() ?? "";
  return candidate.length <= 180 ? candidate : `${candidate.slice(0, 179)}…`;
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${trimTrailingZero((value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1))}M`;
  if (value >= 1_000) return `${trimTrailingZero((value / 1_000).toFixed(value >= 100_000 ? 0 : 1))}k`;
  return value.toLocaleString();
}

function trimTrailingZero(value: string): string {
  return value.replace(/\.0$/, "");
}

function durationLabel(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "";
  if (value < 1_000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1_000)}s`;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
