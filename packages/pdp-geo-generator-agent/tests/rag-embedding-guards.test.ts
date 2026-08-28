import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assemblePdpGeoRagChunks, generatePdpGeo, inferPdpGeoBrandOverlayDocuments, selectFinalRagChunks } from "../src/agent";
import { loadPdpGeoEmbeddingSnapshot } from "../src/rag/embedding-snapshot";
import { createPdpGeoRagQueryPlan, resolvePdpGeoRagSettings, retrievePdpGeoRagChunks } from "../src/rag/retrieval";
import { readPdpGeoGeneratorRagProfile } from "../src/rag/profile";
import { evalProducts } from "../evals/fixtures/products";
import { runRagEval } from "../evals/runner";
import { ragEvalGoldens } from "../evals/goldens";
import type { PdpProductSignal } from "../src/types";

/**
 * Guards that must hold before the corpus can move from deterministic hash
 * embeddings to a real provider embedding space. Each one protects the meaning
 * of a cosine similarity: a score is only comparable when every vector in the
 * batch came from the same model.
 */

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

describe("embedding cache isolation between embedders (G1)", () => {
  it("re-embeds corpus texts when a different embedder runs in the same process", async () => {
    const settings = resolvePdpGeoRagSettings({ maxChunks: 2, scoreThreshold: 0 });
    const documents = [
      { name: "guard-a.md", content: "# GuardA\n\nguardalpha marker paragraph", version: "v1" },
      { name: "guard-b.md", content: "# GuardB\n\nguardbeta marker paragraph", version: "v1" }
    ];
    const query = "guard cache namespace probe";
    const createEmbedder = (winner: "guardalpha" | "guardbeta") => ({
      async embed(texts: string[]): Promise<number[][]> {
        return texts.map((text) => (text.includes(winner) || text.includes(query) ? [1, 0] : [0, 1]));
      }
    });

    const firstRun = await retrievePdpGeoRagChunks(
      { query, product, locale: "en-US", market: "US", documents, settings },
      { customEmbedder: createEmbedder("guardalpha") }
    );
    const secondRun = await retrievePdpGeoRagChunks(
      { query, product, locale: "en-US", market: "US", documents, settings },
      { customEmbedder: createEmbedder("guardbeta") }
    );

    const semanticOf = (chunks: typeof firstRun, source: string) =>
      Number(chunks.find((chunk) => chunk.source === source)?.metadata.semanticScore ?? 0);

    expect(semanticOf(firstRun, "guard-a.md")).toBeGreaterThan(semanticOf(firstRun, "guard-b.md"));
    expect(semanticOf(secondRun, "guard-b.md")).toBeGreaterThan(semanticOf(secondRun, "guard-a.md"));
  });
});

describe("partial provider failure (G2)", () => {
  it("falls back to hash embeddings for the whole batch when one vector is missing", async () => {
    const settings = resolvePdpGeoRagSettings({ maxChunks: 2, scoreThreshold: 0 });
    const documents = [
      { name: "partial-a.md", content: "# PartialA\n\npartialalpha marker paragraph", version: "v1" },
      { name: "partial-b.md", content: "# PartialB\n\npartialbeta marker paragraph", version: "v1" }
    ];
    const query = "partial batch probe";
    const partialEmbedder = {
      async embed(texts: string[]): Promise<number[][]> {
        // Provider drops one item: the retriever must not treat the gap as a
        // zero similarity, which sits below anything the hash space can score.
        return texts.map((text) => (text.includes("partialbeta") ? [] : [1, 0]));
      }
    };

    const hashRun = await retrievePdpGeoRagChunks({
      query,
      product,
      locale: "en-US",
      market: "US",
      documents,
      settings
    });
    const partialRun = await retrievePdpGeoRagChunks(
      { query, product, locale: "en-US", market: "US", documents, settings },
      { customEmbedder: partialEmbedder }
    );

    const semanticBySource = (chunks: typeof hashRun) =>
      Object.fromEntries(chunks.map((chunk) => [chunk.source, Number(chunk.metadata.semanticScore ?? 0)]));

    expect(semanticBySource(partialRun)).toEqual(semanticBySource(hashRun));
  });
});

describe("brand-identity coverage retrieval (G3)", () => {
  it("routes its own retrieval through the configured embedder", async () => {
    const embeddedTexts: string[] = [];
    const recordingEmbedder = {
      async embed(texts: string[]): Promise<number[][]> {
        embeddedTexts.push(...texts);
        return texts.map(() => [1, 0]);
      }
    };

    await generatePdpGeo({
      product: {
        geoProduct: {
          name: "EXAMPLEDERMA BarrierCare 365 Cream",
          brand: "EXAMPLEDERMA",
          description: "Barrier cream for dry, sensitive skin.",
          category: "Cream",
          benefits: ["hydration"],
          ingredients: ["Ceramide"]
        }
      },
      hints: { locale: "ko-KR", market: "KR" }
    }, { customEmbedder: recordingEmbedder });

    expect(embeddedTexts.some((text) => text.toLowerCase().includes("target brand identity for pdp geo generation"))).toBe(true);
  });
});

describe("rag eval embedder injection", () => {
  it("routes eval retrieval through an injected embedder", async () => {
    const embeddedTexts: string[] = [];
    const recordingEmbedder = {
      async embed(texts: string[]): Promise<number[][]> {
        embeddedTexts.push(...texts);
        return texts.map(() => [1, 0]);
      }
    };

    await runRagEval(ragEvalGoldens.slice(0, 1), { customEmbedder: recordingEmbedder });

    expect(embeddedTexts.length).toBeGreaterThan(0);
  });
});

describe("embedding snapshot vector-space validation (G4)", () => {
  const writeSnapshot = async (snapshot: unknown): Promise<string> => {
    const directory = await mkdtemp(join(tmpdir(), "pdp-geo-snapshot-"));
    const path = join(directory, "snapshot.json");
    await writeFile(path, JSON.stringify(snapshot), "utf8");
    return path;
  };

  it("refuses a snapshot built by a different model than the query embedder", async () => {
    const path = await writeSnapshot({
      model: "text-embedding-3-small",
      dimensions: 2,
      createdAt: "2026-08-28",
      entries: { "1:1": [1, 0] }
    });

    await expect(loadPdpGeoEmbeddingSnapshot(path, { model: "text-embedding-3-large" })).rejects.toThrow(/text-embedding-3-small/);
  });

  it("refuses a snapshot whose vectors contradict its declared dimensions", async () => {
    const path = await writeSnapshot({
      model: "text-embedding-3-large",
      dimensions: 3072,
      createdAt: "2026-08-28",
      entries: { "1:1": [1, 0] }
    });

    await expect(loadPdpGeoEmbeddingSnapshot(path)).rejects.toThrow(/3072/);
  });

  it("loads a snapshot that matches the expected vector space", async () => {
    const path = await writeSnapshot({
      model: "text-embedding-3-large",
      dimensions: 2,
      createdAt: "2026-08-28",
      entries: { "1:1": [1, 0] }
    });

    const snapshot = await loadPdpGeoEmbeddingSnapshot(path, { model: "text-embedding-3-large", dimensions: 2 });

    expect(snapshot.dimensions).toBe(2);
  });
});

describe("query text handed to a provider embedder (G5)", () => {
  it("embeds the natural-language query, not the lexical token expansion", async () => {
    const settings = resolvePdpGeoRagSettings({ maxChunks: 2, scoreThreshold: 0 });
    const documents = [
      { name: "asym-a.md", content: "# AsymA\n\nasymalpha marker paragraph", version: "v1" }
    ];
    const query = "Update only FAQPage.mainEntity: source-backed answers for Ceramide.";
    const embeddedTexts: string[] = [];
    const recordingEmbedder = {
      async embed(texts: string[]): Promise<number[][]> {
        embeddedTexts.push(...texts);
        return texts.map(() => [1, 0]);
      }
    };

    await retrievePdpGeoRagChunks(
      { query, product, locale: "en-US", market: "US", documents, settings },
      { customEmbedder: recordingEmbedder }
    );

    // The candidate side is natural prose, so a query flattened to lowercase
    // tokens puts the two sides in different registers for a real model.
    expect(embeddedTexts[0]).toBe(query);
  });
});

describe("eval ↔ production retrieval parity (A5)", () => {
  it("assembles the coverage passes alongside primary retrieval in one shared step", async () => {
    const profile = await readPdpGeoGeneratorRagProfile();
    const evalProduct = Object.values(evalProducts)[0]!;
    const settings = resolvePdpGeoRagSettings({});
    const queryPlan = createPdpGeoRagQueryPlan(evalProduct, "ko-KR", "KR", {
      queryPlanning: { enabled: true, updateTargets: ["productDescription"] }
    });

    const chunks = await assemblePdpGeoRagChunks({
      queryPlan,
      product: evalProduct,
      locale: "ko-KR",
      market: "KR",
      documents: profile.documents.map((document) => ({ name: document.name, content: document.content, version: document.version })),
      settings
    });

    // Coverage passes are what keep a policy document reachable when strategy
    // chunks outrank it. A harness that skips them measures a retrieval the
    // product never runs.
    expect(chunks.some((chunk) => chunk.metadata.queryPlanTarget === "strategicCoverage")).toBe(true);
  });

  it("reports which documents the eval actually selected", async () => {
    const result = await runRagEval(ragEvalGoldens.slice(0, 1));

    expect(result.scores[0]!.selectedSources.length).toBeGreaterThan(0);
  });
});

describe("coverage guarantee for every policy family (A1)", () => {
  const assembleFor = async (maxChunks: number) => {
    const profile = await readPdpGeoGeneratorRagProfile();
    const evalProduct = Object.values(evalProducts)[0]!;
    const queryPlan = createPdpGeoRagQueryPlan(evalProduct, "ko-KR", "KR", {
      queryPlanning: { enabled: true, updateTargets: ["productDescription"] }
    });
    return assemblePdpGeoRagChunks({
      queryPlan,
      product: evalProduct,
      locale: "ko-KR",
      market: "KR",
      documents: profile.documents.map((document) => ({ name: document.name, content: document.content, version: document.version })),
      settings: resolvePdpGeoRagSettings({ maxChunks })
    });
  };

  it("retrieves the evidence-card corpus, which shares no coverage slot with any other document", async () => {
    const chunks = await assembleFor(12);

    // The research document defers every number and provenance URL to these
    // cards, so a corpus that never retrieves them has no evidence layer.
    expect(chunks.some((chunk) => chunk.source.includes("geo-research-cards"))).toBe(true);
  });

  it("keeps a common document reachable when a brand overlay shares its kind", async () => {
    const chunks = await assembleFor(12);

    expect(chunks.some((chunk) => chunk.source.endsWith("locale-terminology-map_v1.json"))).toBe(true);
  });
});

describe("coverage slots are a guarantee, not a best effort (A1)", () => {
  it("seats every policy family at the default budget", async () => {
    const profile = await readPdpGeoGeneratorRagProfile();
    const evalProduct = Object.values(evalProducts)[0]!;
    const queryPlan = createPdpGeoRagQueryPlan(evalProduct, "ko-KR", "KR", {
      queryPlanning: { enabled: true, updateTargets: ["productDescription"] }
    });
    const documents = profile.documents.map((document) => ({ name: document.name, content: document.content, version: document.version }));
    const settings = resolvePdpGeoRagSettings({});

    const assembled = await assemblePdpGeoRagChunks({ queryPlan, product: evalProduct, locale: "ko-KR", market: "KR", documents, settings });
    const selected = selectFinalRagChunks(assembled, settings.maxChunks, {});

    // A coverage order that runs out of budget silently drops whichever family
    // sits last in the list — the guarantee has to survive the budget, or the
    // last family is protected in name only.
    const seatedKinds = new Set(selected.map((chunk) => chunk.kind));
    for (const kind of ["field-contracts", "geo-research", "evidence-cards", "eeat", "cep", "schema", "best-practice", "locale", "terminology", "official-docs"]) {
      expect(seatedKinds.has(kind as never), `missing coverage kind: ${kind}`).toBe(true);
    }
  });
});

describe("section routing by what a section decides (A2)", () => {
  it("gives the E-E-A-T seat to the claim-safety rule, not the retrieval-planning section", async () => {
    const profile = await readPdpGeoGeneratorRagProfile();
    const evalProduct = Object.values(evalProducts)[0]!;
    const settings = resolvePdpGeoRagSettings({});
    const queryPlan = createPdpGeoRagQueryPlan(evalProduct, "ko-KR", "KR", {
      queryPlanning: { enabled: true, updateTargets: ["productDescription"] }
    });
    const assembled = await assemblePdpGeoRagChunks({
      queryPlan,
      product: evalProduct,
      locale: "ko-KR",
      market: "KR",
      documents: profile.documents.map((document) => ({ name: document.name, content: document.content, version: document.version })),
      settings
    });

    const eeatHeadings = selectFinalRagChunks(assembled, settings.maxChunks, {})
      .filter((chunk) => chunk.source.startsWith("eeat"))
      .map((chunk) => String(chunk.metadata.headingPath ?? ""));

    // A section that says which chunks to fetch decides nothing about wording,
    // so it must not take the seat that carries the claim-safety rule.
    expect(eeatHeadings.some((heading) => /Trust-First Claim Safety/.test(heading))).toBe(true);
    expect(eeatHeadings.every((heading) => !/Partial Update Query Planning/.test(heading))).toBe(true);
  });
});


describe("brand overlays layer on the common policy, they do not replace it (A3)", () => {
  it("seats the common locale and terminology documents alongside the brand overlays", async () => {
    const profile = await readPdpGeoGeneratorRagProfile();
    const brandProduct = Object.values(evalProducts).find((candidate) => /exampleluxe|예시럭셔리/i.test(`${candidate.brand ?? ""} ${candidate.name}`))!;
    const documents = profile.documents
      .map((document) => ({ name: document.name, content: document.content, version: document.version }))
      .filter((document) => !document.name.startsWith("brands/") || document.name.startsWith("brands/exampleluxe/"));
    const settings = resolvePdpGeoRagSettings({});
    const queryPlan = createPdpGeoRagQueryPlan(brandProduct, "ko-KR", "KR", {
      queryPlanning: { enabled: true, updateTargets: ["productDescription"] }
    });

    const assembled = await assemblePdpGeoRagChunks({ queryPlan, product: brandProduct, locale: "ko-KR", market: "KR", documents, settings });
    const sources = selectFinalRagChunks(assembled, settings.maxChunks, {
      brandOverlayDocuments: inferPdpGeoBrandOverlayDocuments(brandProduct)
    }).map((chunk) => chunk.source);

    // A brand overlay carries only the brand's deltas; the rules it deltas from
    // live in the common document. Seating one without the other leaves either
    // the overlay referring to guidance that never arrived, or the brand's
    // adjustments missing entirely — both have to reach the prompt.
    expect(sources).toContain("locale-expression-guidelines_v1.md");
    expect(sources).toContain("locale-terminology-map_v1.json");
    expect(sources).toContain("brands/exampleluxe/locale-expression-guidelines_v2.md");
    expect(sources).toContain("brands/exampleluxe/locale-terminology-map_v2.json");
  });
});

describe("a scope statement does not represent its policy family (R3)", () => {
  it("gives the schema and official-docs families a rule section on a schema subquery", async () => {
    const profile = await readPdpGeoGeneratorRagProfile();
    const evalProduct = Object.values(evalProducts)[0]!;
    const settings = resolvePdpGeoRagSettings({});
    const queryPlan = createPdpGeoRagQueryPlan(evalProduct, "ko-KR", "KR", {
      queryPlanning: { enabled: true, updateTargets: ["schema"] }
    });
    const assembled = await assemblePdpGeoRagChunks({
      queryPlan,
      product: evalProduct,
      locale: "ko-KR",
      market: "KR",
      documents: profile.documents.map((document) => ({ name: document.name, content: document.content, version: document.version })),
      settings
    });
    const selected = selectFinalRagChunks(assembled, settings.maxChunks, {
      brandOverlayDocuments: inferPdpGeoBrandOverlayDocuments(evalProduct)
    });

    // A "Purpose" or "Source Scope" section says what a document is for and
    // where it came from. It decides nothing about a field, so spending a
    // family's one reserved seat on it sends the model orientation text in
    // place of the rules that family exists to supply.
    for (const kind of ["schema", "official-docs"] as const) {
      const headings = selected.filter((chunk) => chunk.kind === kind).map((chunk) => String(chunk.metadata.headingPath ?? chunk.source));
      expect(headings.length, `${kind} should reach the context at all`).toBeGreaterThan(0);
      expect(
        headings.some((heading) => !/Purpose|Source Scope/.test(heading)),
        `${kind} is represented only by scope statements: ${headings.join(" | ")}`
      ).toBe(true);
    }
  });
});
