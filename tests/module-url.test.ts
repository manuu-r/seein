import { describe, expect, it } from "vitest";
import { buildAtlasModuleUrl, privateArtifactUrl } from "../renderer/module-url.js";

describe("atlas module URL resolution", () => {
  it("keeps QA module traffic on loopback and forwards the complete render target", () => {
    const query = new URLSearchParams({
      manifest: "http://127.0.0.1:8787/artifacts/projects/test/scene/revision-001.json",
      artifactBase: "http://127.0.0.1:8787",
      state: "pelvic-entry",
      view: "qa-pelvic-overview",
      qa: "1",
    });

    const result = buildAtlasModuleUrl(
      "https://seein.maybecoded.com/artifacts/projects/test/module/revision-001/index.html?revision=1",
      "http://127.0.0.1:8787/viewer/",
      query.get("artifactBase"),
      query,
    );

    expect(result.origin).toBe("http://127.0.0.1:8787");
    expect(result.pathname).toBe("/artifacts/projects/test/module/revision-001/index.html");
    expect(result.searchParams.get("revision")).toBe("1");
    expect(result.searchParams.get("state")).toBe("pelvic-entry");
    expect(result.searchParams.get("view")).toBe("qa-pelvic-overview");
    expect(result.searchParams.get("qa")).toBe("1");
  });

  it("does not rewrite a URL outside the immutable artifact namespace", () => {
    const result = privateArtifactUrl(
      "https://seein.maybecoded.com/viewer/module.html",
      "http://127.0.0.1:8787/viewer/",
      "http://127.0.0.1:8787",
    );

    expect(result.toString()).toBe("https://seein.maybecoded.com/viewer/module.html");
  });

  it("ignores an invalid private artifact protocol", () => {
    const result = privateArtifactUrl(
      "https://seein.maybecoded.com/artifacts/projects/test/module.js",
      "http://127.0.0.1:8787/viewer/",
      "file:///tmp/private-artifacts",
    );

    expect(result.toString()).toBe("https://seein.maybecoded.com/artifacts/projects/test/module.js");
  });
});
