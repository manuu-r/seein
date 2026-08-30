import fs from "node:fs/promises";
import { z } from "zod";
import type { Inspection } from "../contracts.js";
import { hashObject, sha256 } from "../lib/hash.js";
import type { ArtifactStore } from "../storage/artifact-store.js";
import type { ResearchDossier } from "../workflow/graph-contracts.js";
import { SurgicalModulePlacementSchema, type SurgicalModuleSource } from "./module-contracts.js";

const LibraryEntrySchema = z.object({
  schemaVersion: z.literal("1.0"),
  key: z.string().length(64),
  sourceProjectId: z.string().min(1),
  sourceRevision: z.number().int().positive(),
  prompt: z.string().min(1),
  title: z.string().min(1),
  studyIds: z.array(z.string()),
  structures: z.array(z.object({
    id: z.string(),
    label: z.string(),
    category: z.string(),
    studyId: z.string(),
  })),
  placements: z.array(SurgicalModulePlacementSchema),
  sourceSha256: z.string().length(64),
  sourceUrl: z.string(),
  definitionUrl: z.string(),
  acceptedScores: z.object({
    recognizability: z.number(),
    domainFidelity: z.number(),
    visualQuality: z.number(),
    constructionCompleteness: z.number(),
  }),
  createdAt: z.iso.datetime(),
});

const LibraryIndexSchema = z.object({
  schemaVersion: z.literal("1.0"),
  entries: z.array(LibraryEntrySchema),
});

export type SurgicalAtlasLibraryEntry = z.infer<typeof LibraryEntrySchema>;

/**
 * Accepted generated modules become durable anatomical placement references.
 * Future prompts receive their registered/researched coordinates and nominal
 * sizes, while their old rendering source stays on disk for audit rather than
 * being blindly copied into every new scene.
 */
export class SurgicalAtlasLibrary {
  private readonly indexKey = "library/anatomy/index.json";
  private writeChain = Promise.resolve();

  constructor(private readonly artifacts: ArtifactStore) {}

  async findRelevant(
    prompt: string,
    dossier?: ResearchDossier,
    limit = 4,
  ): Promise<SurgicalAtlasLibraryEntry[]> {
    const index = await this.readIndex();
    const wanted = new Set(tokenize([
      prompt,
      ...(dossier?.objectStudies.flatMap((study) => [study.id, study.name, ...study.components, ...study.identityMarkers]) ?? []),
    ].join(" ")));
    return index.entries
      .map((entry) => ({ entry, score: overlapScore(wanted, entry) }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score || right.entry.createdAt.localeCompare(left.entry.createdAt))
      .slice(0, limit)
      .map(({ entry }) => entry);
  }

  async storeAccepted(input: {
    projectId: string;
    revision: number;
    prompt: string;
    module: SurgicalModuleSource;
    inspection: Inspection;
  }): Promise<SurgicalAtlasLibraryEntry> {
    const sourceSha256 = sha256(input.module.source);
    const key = hashObject({
      structures: input.module.definition.structures,
      placements: input.module.definition.placements,
      sourceSha256,
      schema: "accepted-r3f-atlas-module-v1",
    });
    const root = `library/anatomy/modules/${key}`;
    const [sourceArtifact, definitionArtifact] = await Promise.all([
      this.artifacts.writeText(`${root}/scene.tsx`, input.module.source),
      this.artifacts.writeJson(`${root}/definition.json`, input.module.definition),
    ]);
    const entry = LibraryEntrySchema.parse({
      schemaVersion: "1.0",
      key,
      sourceProjectId: input.projectId,
      sourceRevision: input.revision,
      prompt: input.prompt,
      title: input.module.definition.title,
      studyIds: [...new Set(input.module.definition.structures.map((structure) => structure.studyId))],
      structures: input.module.definition.structures,
      placements: input.module.definition.placements,
      sourceSha256,
      sourceUrl: sourceArtifact.url,
      definitionUrl: definitionArtifact.url,
      acceptedScores: {
        recognizability: input.inspection.assessment.recognizabilityScore,
        domainFidelity: input.inspection.assessment.domainFidelityScore,
        visualQuality: input.inspection.assessment.visualQualityScore,
        constructionCompleteness: input.inspection.assessment.constructionCompletenessScore,
      },
      createdAt: new Date().toISOString(),
    });

    this.writeChain = this.writeChain.then(async () => {
      const index = await this.readIndex();
      const entries = [entry, ...index.entries.filter((candidate) => candidate.key !== entry.key)]
        .slice(0, 500);
      await this.artifacts.writeJson(this.indexKey, { schemaVersion: "1.0", entries });
    });
    await this.writeChain;
    return entry;
  }

  private async readIndex(): Promise<z.infer<typeof LibraryIndexSchema>> {
    try {
      const value = JSON.parse(await fs.readFile(this.artifacts.absolutePath(this.indexKey), "utf8"));
      return LibraryIndexSchema.parse(value);
    } catch {
      return { schemaVersion: "1.0", entries: [] };
    }
  }
}

function tokenize(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3);
}

function overlapScore(wanted: Set<string>, entry: SurgicalAtlasLibraryEntry): number {
  const available = new Set(tokenize([
    entry.prompt,
    entry.title,
    ...entry.studyIds,
    ...entry.structures.flatMap((structure) => [structure.id, structure.label, structure.category, structure.studyId]),
    ...entry.placements.flatMap((placement) => [placement.structureId, placement.frameId, ...placement.anchorIds]),
  ].join(" ")));
  return [...wanted].reduce((score, token) => score + (available.has(token) ? 1 : 0), 0);
}
