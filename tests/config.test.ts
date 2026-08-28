import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("Gemini model defaults", () => {
  it("uses the latest GA workhorse and capability-specific image-search model", () => {
    const config = loadConfig({ NODE_ENV: "test" });

    expect(config.GEMINI_RESEARCH_MODEL).toBe("gemini-3.7-flash");
    expect(config.GEMINI_REFERENCE_MODEL).toBe("gemini-3.1-flash-image");
    expect(config.GEMINI_PLANNER_MODEL).toBe("gemini-3.7-flash");
    expect(config.GEMINI_INSPECTOR_MODEL).toBe("gemini-3.7-flash");
  });
});
