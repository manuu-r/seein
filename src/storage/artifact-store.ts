import fs from "node:fs/promises";
import path from "node:path";
import { sha256 } from "../lib/hash.js";

export interface StoredArtifact {
  key: string;
  path: string;
  url: string;
  sha256: string;
  size: number;
}

export interface ArtifactStore {
  writeJson(key: string, value: unknown): Promise<StoredArtifact>;
  writeText(key: string, value: string): Promise<StoredArtifact>;
  writeBuffer(key: string, value: Buffer): Promise<StoredArtifact>;
  copyFile(key: string, sourcePath: string): Promise<StoredArtifact>;
  exists(key: string): Promise<boolean>;
  absolutePath(key: string): string;
  publicUrl(key: string): string;
}

export class LocalArtifactStore implements ArtifactStore {
  constructor(
    private readonly root: string,
    private readonly publicBaseUrl: string,
  ) {}

  absolutePath(key: string): string {
    const normalized = path.posix.normalize(key.replaceAll("\\", "/")).replace(/^\/+/, "");
    if (normalized === ".." || normalized.startsWith("../")) {
      throw new Error(`Artifact key escapes root: ${key}`);
    }
    return path.join(this.root, normalized);
  }

  publicUrl(key: string): string {
    const normalized = key.replaceAll("\\", "/").replace(/^\/+/, "");
    return `${this.publicBaseUrl.replace(/\/$/, "")}/artifacts/${encodeURI(normalized)}`;
  }

  async writeJson(key: string, value: unknown): Promise<StoredArtifact> {
    return this.writeBuffer(key, Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
  }

  async writeText(key: string, value: string): Promise<StoredArtifact> {
    return this.writeBuffer(key, Buffer.from(value));
  }

  async writeBuffer(key: string, value: Buffer): Promise<StoredArtifact> {
    const target = this.absolutePath(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, value);
    return {
      key,
      path: target,
      url: this.publicUrl(key),
      sha256: sha256(value),
      size: value.byteLength,
    };
  }

  async copyFile(key: string, sourcePath: string): Promise<StoredArtifact> {
    return this.writeBuffer(key, await fs.readFile(sourcePath));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.absolutePath(key));
      return true;
    } catch {
      return false;
    }
  }
}

