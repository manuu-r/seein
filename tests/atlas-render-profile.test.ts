import { describe, expect, it } from "vitest";
import { resolveAtlasRenderProfile } from "../renderer/atlas/AtlasModuleHost.js";

describe("atlas render profile", () => {
  it("keeps the interactive scene at full quality", () => {
    expect(resolveAtlasRenderProfile(false, true)).toEqual({
      showOperatingRoom: true,
      shadows: true,
      dpr: [1, 1.5],
      antialias: true,
      preserveDrawingBuffer: true,
    });
    expect(resolveAtlasRenderProfile(false, false).showOperatingRoom).toBe(false);
  });

  it("keeps anatomy but removes non-placement raster cost from headless QA", () => {
    expect(resolveAtlasRenderProfile(true, true)).toEqual({
      showOperatingRoom: false,
      shadows: false,
      dpr: 1,
      antialias: false,
      preserveDrawingBuffer: false,
    });
  });
});
