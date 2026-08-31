import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Gemini returns this on successful generateContent responses. Keep the type
 * deliberately SDK-independent so tests and alternate WorkflowAI adapters do
 * not need the Google client installed to participate in a project budget.
 */
export interface GeminiTokenUsage {
  promptTokens: number;
  candidateTokens: number;
  thoughtsTokens: number;
  toolUsePromptTokens: number;
  totalTokens: number;
  reported: boolean;
}

export interface GeminiUsageScope {
  beforeRequest(): Promise<void>;
  recordResponse(usage: GeminiTokenUsage): Promise<void>;
}

export class GeminiTokenBudgetExceededError extends Error {
  constructor(
    readonly projectId: string,
    readonly usedTokens: number,
    readonly limitTokens: number,
  ) {
    super(
      `Gemini token budget reached for this project (${usedTokens.toLocaleString()} of ${limitTokens.toLocaleString()} metered tokens).`,
    );
    this.name = "GeminiTokenBudgetExceededError";
  }
}

const scopes = new AsyncLocalStorage<GeminiUsageScope>();

/** Runs one provider operation inside its project-scoped Gemini budget. */
export function withGeminiUsageScope<T>(scope: GeminiUsageScope, operation: () => Promise<T>): Promise<T> {
  return scopes.run(scope, operation);
}

/**
 * Wrap every SDK generateContent call. AsyncLocalStorage makes parallel research
 * branches safe: each branch inherits its own project's ledger without mutable
 * singleton state on the Gemini client.
 */
export async function recordGeminiResponse<T extends { usageMetadata?: unknown }>(
  operation: () => Promise<T>,
): Promise<T> {
  const scope = scopes.getStore();
  if (scope) await scope.beforeRequest();
  const response = await operation();
  if (scope) await scope.recordResponse(normalizeGeminiTokenUsage(response.usageMetadata));
  return response;
}

export function normalizeGeminiTokenUsage(value: unknown): GeminiTokenUsage {
  const metadata = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const promptTokens = tokenCount(metadata.promptTokenCount);
  // The public Gemini API calls this candidatesTokenCount while a few SDK
  // transports expose responseTokenCount. They mean the same billed output.
  const candidateTokens = tokenCount(metadata.candidatesTokenCount ?? metadata.responseTokenCount);
  const thoughtsTokens = tokenCount(metadata.thoughtsTokenCount);
  const toolUsePromptTokens = tokenCount(metadata.toolUsePromptTokenCount);
  const explicitTotal = metadata.totalTokenCount;
  const reported = [
    explicitTotal,
    metadata.promptTokenCount,
    metadata.candidatesTokenCount,
    metadata.responseTokenCount,
    metadata.thoughtsTokenCount,
    metadata.toolUsePromptTokenCount,
  ].some((entry) => typeof entry === "number" && Number.isFinite(entry));
  return {
    promptTokens,
    candidateTokens,
    thoughtsTokens,
    toolUsePromptTokens,
    totalTokens: tokenCount(explicitTotal) || promptTokens + candidateTokens + thoughtsTokens + toolUsePromptTokens,
    reported,
  };
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
