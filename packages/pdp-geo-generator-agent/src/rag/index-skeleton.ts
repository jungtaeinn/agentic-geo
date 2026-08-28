import { chunkPdpGeoRagDocument } from "./retrieval";
import { findPdpGeoRagIndexEntry, findPdpGeoRagSectionEntry } from "./rag-index";
import type { PdpGeoRagFieldTarget, PdpGeoRagIntent, PdpGeoRagKind } from "../types";

/**
 * Deterministic rag-index skeleton generator (PageIndex/RAPTOR-style tree
 * indexing, offline half only). It parses the real heading tree of every
 * corpus document, reports which headings already resolve to a typed
 * `rag-index.ts` section, and emits ready-to-paste section entries (with
 * heuristically inferred intents/fieldTargets) for the ones that do not.
 * No LLM and no runtime cost: the output is reviewed by a human and committed,
 * keeping retrieval deterministic while removing manual index drift.
 */
export interface PdpGeoRagIndexSkeletonSection {
  heading: string;
  headingPath: string;
  indexed: boolean;
  /** Routing the runtime would infer today (index entry when indexed, heuristic otherwise). */
  intents: PdpGeoRagIntent[];
  fieldTargets: PdpGeoRagFieldTarget[];
}

export interface PdpGeoRagIndexSkeletonEntry {
  document: string;
  version: string;
  kind: PdpGeoRagKind;
  documentIndexed: boolean;
  sections: PdpGeoRagIndexSkeletonSection[];
  unindexedSectionCount: number;
}

export function createPdpGeoRagIndexSkeleton(
  documents: Array<{ name: string; content: string; version?: string }>
): PdpGeoRagIndexSkeletonEntry[] {
  return documents.map((document) => {
    const chunks = chunkPdpGeoRagDocument(document.name, document.content, document.version ?? "v1");
    const indexEntry = findPdpGeoRagIndexEntry(document.name);
    const seen = new Set<string>();
    const sections: PdpGeoRagIndexSkeletonSection[] = [];

    for (const chunk of chunks) {
      const heading = chunk.title ?? "";
      const headingPath = typeof chunk.metadata.headingPath === "string" ? chunk.metadata.headingPath : heading;
      const key = `${heading}::${headingPath}`;
      if (!heading || seen.has(key)) {
        continue;
      }
      seen.add(key);
      sections.push({
        heading,
        headingPath,
        indexed: findPdpGeoRagSectionEntry(document.name, heading, headingPath) !== undefined,
        intents: chunk.intents ?? [],
        fieldTargets: chunk.fieldTargets ?? []
      });
    }

    return {
      document: document.name,
      version: document.version ?? "v1",
      kind: chunks[0]?.kind ?? "custom",
      documentIndexed: indexEntry !== undefined,
      sections,
      unindexedSectionCount: sections.filter((section) => !section.indexed).length
    };
  });
}

/** Renders unindexed headings as paste-ready `rag-index.ts` section entries. */
export function renderPdpGeoRagIndexSkeleton(entries: PdpGeoRagIndexSkeletonEntry[]): string {
  const lines: string[] = [];

  for (const entry of entries) {
    const unindexed = entry.sections.filter((section) => !section.indexed);
    if (!entry.documentIndexed) {
      lines.push(`// MISSING DOCUMENT ENTRY: ${entry.document} (kind: ${entry.kind}, version: ${entry.version})`);
    }
    if (unindexed.length === 0) {
      continue;
    }
    lines.push(`// ${entry.document}: ${unindexed.length} unindexed heading(s)`);
    for (const section of unindexed) {
      lines.push([
        "{",
        `  heading: ${JSON.stringify(section.heading)},`,
        `  intents: ${JSON.stringify(section.intents)},`,
        `  fieldTargets: ${JSON.stringify(section.fieldTargets)},`,
        "  priority: 0.8",
        "},"
      ].join("\n"));
    }
  }

  return lines.join("\n");
}
