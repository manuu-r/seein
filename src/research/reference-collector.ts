import dns from "node:dns/promises";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { Config } from "../config.js";
import type { ReferenceArtifact, ResearchBrief } from "../contracts.js";
import type { ReferenceCandidateSchema } from "../contracts.js";
import type { z } from "zod";

type ReferenceCandidate = z.infer<typeof ReferenceCandidateSchema>;
import { sha256 } from "../lib/hash.js";
import { safeFilename } from "../lib/strings.js";

const MEDIA_EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

export class ReferenceCollector {
  private readonly inFlight = new Map<string, Promise<{ path: string; mediaType: string; sha256: string; reused: boolean }>>();

  constructor(private readonly config: Config) {}

  async collect(brief: ResearchBrief, targetDirectory: string): Promise<ReferenceArtifact[]> {
    return this.collectCandidates(brief.references.slice(0, this.config.REFERENCE_MAX_COUNT), targetDirectory);
  }

  /** Downloads specific candidates, so callers can verify an image exists before relying on it. */
  async collectCandidates(
    candidates: ReferenceCandidate[],
    targetDirectory: string,
  ): Promise<ReferenceArtifact[]> {
    await fs.mkdir(targetDirectory, { recursive: true });
    return Promise.all(
      candidates.map(async (candidate, index): Promise<ReferenceArtifact> => {
        try {
          const downloaded = await this.cachedDownload(candidate.imageUrl);
          const extension = MEDIA_EXTENSIONS[downloaded.mediaType];
          if (!extension) throw new Error(`Unsupported reference media type: ${downloaded.mediaType}`);
          const name = `${String(index + 1).padStart(2, "0")}-${safeFilename(candidate.title)}${extension}`;
          const localPath = path.join(targetDirectory, name);
          await fs.copyFile(downloaded.path, localPath);
          return {
            candidate,
            localPath,
            sha256: downloaded.sha256,
            mediaType: downloaded.mediaType,
            reused: downloaded.reused,
          };
        } catch (error) {
          return { candidate, error: error instanceof Error ? error.message : String(error) };
        }
      }),
    );
  }

  private async cachedDownload(url: string): Promise<{ path: string; mediaType: string; sha256: string; reused: boolean }> {
    const cacheKey = sha256(Buffer.from(url));
    const cacheDirectory = path.join(this.config.DATA_ROOT, "library", "references");
    await fs.mkdir(cacheDirectory, { recursive: true });
    for (const [mediaType, extension] of Object.entries(MEDIA_EXTENSIONS)) {
      const cachedPath = path.join(cacheDirectory, `${cacheKey}${extension}`);
      const buffer = await fs.readFile(cachedPath).catch(() => null);
      if (buffer) return { path: cachedPath, mediaType, sha256: sha256(buffer), reused: true };
    }
    const existing = this.inFlight.get(cacheKey);
    if (existing) return existing;
    const download = this.download(url).then(async ({ buffer, mediaType }) => {
      const extension = MEDIA_EXTENSIONS[mediaType];
      if (!extension) throw new Error(`Unsupported reference media type: ${mediaType}`);
      const cachedPath = path.join(cacheDirectory, `${cacheKey}${extension}`);
      await fs.writeFile(cachedPath, buffer);
      return { path: cachedPath, mediaType, sha256: sha256(buffer), reused: false };
    });
    this.inFlight.set(cacheKey, download);
    try {
      return await download;
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }

  private async download(initialUrl: string): Promise<{ buffer: Buffer; mediaType: string }> {
    let url = new URL(initialUrl);
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      await assertPublicUrl(url);
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
        headers: { "user-agent": "SeeIn-ReferenceCollector/0.1" },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error(`Reference redirect missing location (${response.status})`);
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) throw new Error(`Reference request failed with ${response.status}`);
      const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
      if (!(mediaType in MEDIA_EXTENSIONS)) throw new Error(`Unsupported reference media type: ${mediaType}`);
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (declared > this.config.REFERENCE_MAX_BYTES) throw new Error("Reference exceeds byte limit");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Reference response has no body");
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > this.config.REFERENCE_MAX_BYTES) {
          await reader.cancel();
          throw new Error("Reference exceeds byte limit");
        }
        chunks.push(Buffer.from(value));
      }
      return { buffer: Buffer.concat(chunks), mediaType };
    }
    throw new Error("Reference exceeded redirect limit");
  }
}

async function assertPublicUrl(url: URL): Promise<void> {
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only HTTP(S) references are allowed");
  if (url.username || url.password) throw new Error("Credentialed reference URLs are not allowed");
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) throw new Error("Local reference URLs are not allowed");
  const addresses = await dns.lookup(hostname, { all: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("Private-network reference URLs are not allowed");
  }
}

function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  const normalized = address.toLowerCase();
  return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:");
}
