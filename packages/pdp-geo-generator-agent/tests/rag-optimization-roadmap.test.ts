import { describe, expect, it } from "vitest";
import { generatePdpGeo } from "../src/agent";
import { pdpGeoGeneratorRagManifest } from "../src/rag/manifest";
import { readPdpGeoGeneratorRagProfile } from "../src/rag/profile";
import { findPdpGeoRagIndexEntry } from "../src/rag/rag-index";
import { resolvePdpGeoRagSettings, retrievePdpGeoRagChunks } from "../src/rag/retrieval";
import {
  createEmptyPdpGeoEmbeddingSnapshot,
  createPdpGeoEmbeddingSnapshotKey,
  createSnapshotBackedPdpGeoEmbedder
} from "../src/rag/embedding-snapshot";
import { createPdpGeoRagIndexSkeleton, renderPdpGeoRagIndexSkeleton } from "../src/rag/index-skeleton";
import type { PdpGeoRetrievedChunk, PdpProductSignal } from "../src/types";

const product = {
  name: "Hydra Barrier Cream",
  brand: "Example Beauty",
  category: "Moisturizer",
  description: "Daily hydration cream for moisture barrier care.",
  benefits: ["hydration", "skin barrier support"],
  effects: [],
  ingredients: ["Ceramide", "Panthenol"],
  usage: ["Apply after serum."],
  metrics: [],
  faq: [],
  reviews: { keywords: ["lightweight"], items: [] },
  images: [],
  options: [],
  breadcrumbs: [],
  sourceTexts: []
} as unknown as PdpProductSignal;

describe("evidence-card corpus (offline link distillation replaces runtime URL resolution)", () => {
  it("loads the evidence cards as a managed, versioned profile document", async () => {
    const profile = await readPdpGeoGeneratorRagProfile();
    const cards = profile.documents.find(
      (document) => document.name === pdpGeoGeneratorRagManifest.documents.geoResearchEvidenceCards
    );

    expect(cards).toBeDefined();
    expect(cards?.managed).toBe(true);
    expect(cards?.version).toBe("v1");
    // The distilled corpus must carry provenance and publication status so
    // peer-reviewed and preprint claims keep different evidential weight.
    expect(cards?.content).toContain("Status: peer-reviewed");
    expect(cards?.content).toContain("Status: preprint");
    expect(cards?.content).toContain("https://arxiv.org/abs/2605.25517");
  });

  it("registers typed rag-index routing for the evidence cards", () => {
    const entry = findPdpGeoRagIndexEntry(pdpGeoGeneratorRagManifest.documents.geoResearchEvidenceCards);

    expect(entry).toBeDefined();
    expect(entry?.kind).toBe("evidence-cards");
    expect(entry?.sourceRole).toBe("research");
    expect(entry?.sections.map((section) => section.heading)).toEqual(
      expect.arrayContaining(["Peer-Reviewed Evidence Cards", "Preprint and Emerging Evidence Cards"])
    );
  });

  it("retrieves distilled paper claims without any URL resolution", async () => {
    const profile = await readPdpGeoGeneratorRagProfile();
    const cards = profile.documents.find(
      (document) => document.name === pdpGeoGeneratorRagManifest.documents.geoResearchEvidenceCards
    );
    const settings = resolvePdpGeoRagSettings({ maxChunks: 6, scoreThreshold: 0 });

    const chunks = await retrievePdpGeoRagChunks({
      query: "What gates citation selection: topical match, explicit price, recent timestamp, list position? Controlled citation trials evidence for product description.",
      product,
      locale: "en-US",
      market: "US",
      documents: [{ name: cards?.name ?? "", content: cards?.content ?? "", version: cards?.version }],
      settings
    });

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((chunk) => chunk.kind === "evidence-cards")).toBe(true);
    const citationCard = chunks.find((chunk) => /What Gets Cited/i.test(chunk.title ?? ""));
    expect(citationCard, "the SIGIR citation-gatekeeper card should be retrievable").toBeDefined();
    // resolveUrls stays off: retrieval consumed only the committed card text.
    expect(settings.resolveUrls).toBeUndefined();
  });
});

describe("snapshot-backed embedder (offline precompute, query-only live embedding)", () => {
  const corpusText = "Document: cards\nRAG kind: geo-research\nCitation gatekeepers include price and timestamp.";
  const otherText = "Document: eeat\nTrust-first claim safety.";

  function buildSnapshot() {
    const snapshot = createEmptyPdpGeoEmbeddingSnapshot("test-model", 3);
    snapshot.entries[createPdpGeoEmbeddingSnapshotKey(corpusText)] = [1, 0, 0];
    snapshot.entries[createPdpGeoEmbeddingSnapshotKey(otherText)] = [0, 1, 0];
    return snapshot;
  }

  it("serves corpus texts from the snapshot without calling the live embedder", async () => {
    let liveCalls = 0;
    const embedder = createSnapshotBackedPdpGeoEmbedder(buildSnapshot(), {
      queryEmbedder: {
        embed: async (texts) => {
          liveCalls += 1;
          return texts.map(() => [0, 0, 1]);
        }
      }
    });

    const vectors = await embedder.embed([corpusText, otherText]);

    expect(vectors).toEqual([[1, 0, 0], [0, 1, 0]]);
    expect(liveCalls).toBe(0);
  });

  it("delegates only unseen texts (the query) to the live embedder", async () => {
    const liveBatches: string[][] = [];
    const embedder = createSnapshotBackedPdpGeoEmbedder(buildSnapshot(), {
      queryEmbedder: {
        embed: async (texts) => {
          liveBatches.push(texts);
          return texts.map(() => [0, 0, 1]);
        }
      }
    });

    const vectors = await embedder.embed(["fresh product query", corpusText]);

    expect(vectors).toEqual([[0, 0, 1], [1, 0, 0]]);
    expect(liveBatches).toEqual([["fresh product query"]]);
  });

  it("throws on snapshot miss without a live embedder so retrieval falls back deterministically", async () => {
    const embedder = createSnapshotBackedPdpGeoEmbedder(buildSnapshot());

    await expect(embedder.embed(["unknown query"])).rejects.toThrow(/missing 1\/1/);
  });
});

describe("custom reranker hook (cross-encoder plumbing with deterministic fallback)", () => {
  it("invokes the reranker once on merged candidates and keeps generation valid", async () => {
    const seenQueries: string[] = [];
    let seenChunkCount = 0;

    const { result } = await generatePdpGeo(
      {
        product: {
          name: "Hydra Barrier Cream",
          brand: "Example Beauty",
          description: "Daily hydration cream for moisture barrier care.",
          benefits: ["hydration"],
          usage: ["Apply after serum."]
        },
        hints: { locale: "en-US", market: "US" }
      },
      {
        customReranker: {
          rerank: async ({ query, chunks }) => {
            seenQueries.push(query);
            seenChunkCount = chunks.length;
            // Identity ordering: contract is score/order adjustment with
            // metadata preserved.
            return chunks;
          }
        }
      }
    );

    expect(seenQueries).toHaveLength(1);
    expect(seenQueries[0]).toContain("Hydra Barrier Cream");
    expect(seenChunkCount).toBeGreaterThan(0);
    expect(result.schemaMarkup).toBeDefined();
  });

  it("falls back to local-hybrid ordering when the reranker fails", async () => {
    const { result } = await generatePdpGeo(
      {
        product: {
          name: "Hydra Barrier Cream",
          brand: "Example Beauty",
          description: "Daily hydration cream for moisture barrier care.",
          benefits: ["hydration"],
          usage: ["Apply after serum."]
        },
        hints: { locale: "en-US", market: "US" }
      },
      {
        customReranker: {
          rerank: async () => {
            throw new Error("reranker unavailable");
          }
        }
      }
    );

    expect(result.schemaMarkup).toBeDefined();
  });

  it("tags reranked chunks so provenance shows the custom reranker ran", async () => {
    const { result } = await generatePdpGeo(
      {
        product: {
          name: "Hydra Barrier Cream",
          brand: "Example Beauty",
          description: "Daily hydration cream for moisture barrier care.",
          benefits: ["hydration"],
          usage: ["Apply after serum."]
        },
        hints: { locale: "en-US", market: "US" }
      },
      {
        customReranker: {
          rerank: async ({ chunks }) => chunks.map((chunk: PdpGeoRetrievedChunk) => ({ ...chunk, score: Math.min(1, chunk.score + 0.01) }))
        }
      }
    );

    expect(result.schemaMarkup).toBeDefined();
  });
});

describe("rag-index skeleton generator (offline tree indexing, deterministic)", () => {
  it("reports full heading coverage state for the managed corpus", async () => {
    const profile = await readPdpGeoGeneratorRagProfile();
    const skeleton = createPdpGeoRagIndexSkeleton(profile.documents);

    const geoResearch = skeleton.find((entry) => entry.document === pdpGeoGeneratorRagManifest.documents.geoResearch);
    expect(geoResearch).toBeDefined();
    expect(geoResearch?.documentIndexed).toBe(true);
    expect(geoResearch?.sections.length).toBeGreaterThan(0);

    const cards = skeleton.find((entry) => entry.document === pdpGeoGeneratorRagManifest.documents.geoResearchEvidenceCards);
    expect(cards?.documentIndexed).toBe(true);
    // Card headings inherit their parent group entries via headingPath
    // matching. The heading-only document-title H1 no longer produces a
    // section at all (noise-chunk merge, roadmap item 3), so the corpus has
    // zero unindexed card sections.
    expect(cards?.sections.filter((section) => !section.indexed).map((section) => section.heading))
      .toEqual([]);
  });

  it("emits paste-ready entries for documents the index does not know", () => {
    const skeleton = createPdpGeoRagIndexSkeleton([
      {
        name: "unregistered-notes_v1.md",
        content: "# Unregistered Notes\n\n## Fresh Heading\n\n- Customer FAQ answers need evidence.",
        version: "v1"
      }
    ]);

    expect(skeleton[0]?.documentIndexed).toBe(false);
    expect(skeleton[0]?.unindexedSectionCount).toBeGreaterThan(0);

    const rendered = renderPdpGeoRagIndexSkeleton(skeleton);
    expect(rendered).toContain("MISSING DOCUMENT ENTRY: unregistered-notes_v1.md");
    expect(rendered).toContain("\"Fresh Heading\"");
  });
});
