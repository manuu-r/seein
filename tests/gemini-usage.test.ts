import { describe, expect, it, vi } from "vitest";
import {
  normalizeGeminiTokenUsage,
  recordGeminiResponse,
  withGeminiUsageScope,
} from "../src/ai/gemini-usage.js";

describe("Gemini project usage accounting", () => {
  it("counts Gemini prompt, output, thinking, and tool-use tokens from response metadata", () => {
    expect(normalizeGeminiTokenUsage({
      promptTokenCount: 120,
      candidatesTokenCount: 40,
      thoughtsTokenCount: 70,
      toolUsePromptTokenCount: 9,
      totalTokenCount: 239,
    })).toEqual({
      promptTokens: 120,
      candidateTokens: 40,
      thoughtsTokens: 70,
      toolUsePromptTokens: 9,
      totalTokens: 239,
      reported: true,
    });
  });

  it("records every successful SDK response inside the active project scope", async () => {
    const beforeRequest = vi.fn(async () => undefined);
    const recordResponse = vi.fn(async () => undefined);

    await withGeminiUsageScope(
      { beforeRequest, recordResponse },
      () => recordGeminiResponse(async () => ({
        usageMetadata: { promptTokenCount: 10, responseTokenCount: 4 },
      })),
    );

    expect(beforeRequest).toHaveBeenCalledOnce();
    expect(recordResponse).toHaveBeenCalledWith({
      promptTokens: 10,
      candidateTokens: 4,
      thoughtsTokens: 0,
      toolUsePromptTokens: 0,
      totalTokens: 14,
      reported: true,
    });
  });
});
