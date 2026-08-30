import { describe, expect, it } from "vitest";
import { describeError, safeLogFields } from "../src/lib/diagnostics.js";

describe("diagnostic logging", () => {
  it("keeps transport error metadata while bounding the message", () => {
    const cause = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    const error = Object.assign(new Error("Gemini module generation failed"), { statusCode: 502, cause });

    expect(describeError(error)).toEqual({
      error: "Gemini module generation failed",
      errorName: "Error",
      httpStatus: 502,
      cause: {
        name: "Error",
        message: "connection refused",
        errorCode: "ECONNREFUSED",
      },
    });
  });

  it("redacts request payloads and credentials without dropping useful error codes", () => {
    expect(safeLogFields({
      prompt: "private surgical request",
      apiKey: "secret",
      code: "large generated TSX payload",
      errorCode: "ETIMEDOUT",
      statusCode: 504,
      destination: "Google Gemini API",
    })).toEqual({
      errorCode: "ETIMEDOUT",
      statusCode: 504,
      destination: "Google Gemini API",
    });
  });
});
