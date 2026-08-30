import { z } from "zod";
import type { Config } from "../config.js";
import { ReferenceCandidateSchema } from "../contracts.js";

type ReferenceCandidate = z.infer<typeof ReferenceCandidateSchema>;

export interface ReferenceSearchDriver {
  readonly identity: string;
  /** Returns grounded reference images for one object, best match first. */
  searchImages(query: string, limit: number): Promise<ReferenceCandidate[]>;
}

const FirecrawlImageSchema = z.object({
  title: z.string().optional(),
  imageUrl: z.string(),
  url: z.string(),
  imageWidth: z.number().optional(),
  imageHeight: z.number().optional(),
  position: z.number().optional(),
});

const FirecrawlResponseSchema = z.object({
  success: z.boolean().optional(),
  creditsUsed: z.number().optional(),
  data: z.object({ images: z.array(FirecrawlImageSchema).default([]) }).partial(),
});

export class FirecrawlReferenceSearch implements ReferenceSearchDriver {
  readonly identity: string;

  constructor(private readonly config: Config) {
    if (!config.FIRECRAWL_API_KEY) {
      throw new Error("FIRECRAWL_API_KEY is required for REFERENCE_SEARCH_DRIVER=firecrawl");
    }
    this.identity = `firecrawl-image-search:v1:${config.REFERENCE_IMAGE_MIN_EDGE}`;
  }

  async searchImages(query: string, limit: number): Promise<ReferenceCandidate[]> {
    const response = await fetch(this.config.FIRECRAWL_SEARCH_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.FIRECRAWL_API_KEY}`,
        "content-type": "application/json",
      },
      // Firecrawl bills per 10 results, so over-fetch slightly to survive the
      // resolution filter below without paying for a second page.
      body: JSON.stringify({ query, sources: [{ type: "images" }], limit: Math.min(limit * 2, 10) }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Firecrawl image search failed: ${response.status} ${detail.slice(0, 200)}`);
    }
    const parsed = FirecrawlResponseSchema.parse(await response.json());
    const minEdge = this.config.REFERENCE_IMAGE_MIN_EDGE;
    return (parsed.data.images ?? [])
      // Thumbnails and sprite sheets carry no usable anatomical or structural detail.
      .filter((image) => {
        const width = image.imageWidth ?? minEdge;
        const height = image.imageHeight ?? minEdge;
        return width >= minEdge && height >= minEdge;
      })
      .flatMap((image) => {
        const candidate = ReferenceCandidateSchema.safeParse({
          imageUrl: image.imageUrl,
          sourceUrl: image.url,
          title: image.title?.trim() || "Reference image",
          relevance: `Firecrawl image search for "${query}"`,
        });
        return candidate.success ? [candidate.data] : [];
      })
      .slice(0, limit);
  }
}

/** Used when optional reference-image search is switched off. */
export class DisabledReferenceSearch implements ReferenceSearchDriver {
  readonly identity = "reference-search-disabled:v1";

  async searchImages(): Promise<ReferenceCandidate[]> {
    return [];
  }
}

/**
 * Builds the image query for one object study. The subject is included because a
 * bare study name ("Stomach and Adjacent Peritoneal Retraction Structures") loses
 * the procedural context that makes the returned anatomy correct.
 */
export function objectImageQuery(subject: string, name: string, identityMarkers: string[]): string {
  const marker = identityMarkers[0]?.split(/[,;.]/)[0]?.trim() ?? "";
  return [name, marker, subject].filter(Boolean).join(" ").slice(0, 300);
}
