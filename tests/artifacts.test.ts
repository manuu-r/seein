import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalArtifactStore } from "../src/storage/artifact-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("LocalArtifactStore", () => {
  it("writes addressable, hashed artifacts", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "seein-artifact-"));
    temporaryDirectories.push(root);
    const store = new LocalArtifactStore(root, "http://localhost:8787");
    const artifact = await store.writeText("projects/p1/notes.txt", "hello");
    expect(await fs.readFile(artifact.path, "utf8")).toBe("hello");
    expect(artifact.url).toBe("http://localhost:8787/artifacts/projects/p1/notes.txt");
    expect(artifact.sha256).toHaveLength(64);
  });

  it("rejects artifact keys that escape the data root", () => {
    const store = new LocalArtifactStore("/tmp/seein", "http://localhost:8787");
    expect(() => store.absolutePath("../../etc/passwd")).toThrow(/escapes root/);
  });
});

