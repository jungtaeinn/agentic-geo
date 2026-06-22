import { describe, expect, it } from "vitest";
import { pdpGeoGeneratorRagManifest } from "../src";
import { defaultPdpGeoGeneratorRagProfile } from "../src/rag/default-profile";
import { readPdpGeoGeneratorRagProfile } from "../src/rag/profile";
import { createPdpGeoRagQuery, LocalVersionedRagRetriever, resolvePdpGeoRagSettings } from "../src/rag/retrieval";

describe("readPdpGeoGeneratorRagProfile", () => {
  it("reads managed GEO generator RAG files including locale terminology", async () => {
    const profile = await readPdpGeoGeneratorRagProfile();

    expect(profile.profile).toBe(pdpGeoGeneratorRagManifest.profile);
    expect(profile.analysisPrompt).toContain("GEO-optimized PDP artifacts");
    expect(profile.analysisPrompt).toContain("WebPage.description");
    expect(profile.analysisPrompt).toContain("Do not expose internal labels");
    expect(profile.documents.map((document) => document.name)).toEqual(expect.arrayContaining([
      pdpGeoGeneratorRagManifest.documents.schemaOrgProduct,
      pdpGeoGeneratorRagManifest.documents.eeat,
      pdpGeoGeneratorRagManifest.documents.cep,
      pdpGeoGeneratorRagManifest.documents.bestPractice,
      pdpGeoGeneratorRagManifest.documents.geoPaper,
      pdpGeoGeneratorRagManifest.documents.officialAiSearchPlatformDocs,
      pdpGeoGeneratorRagManifest.documents.localeExpressionGuidelines,
      pdpGeoGeneratorRagManifest.documents.localeTerminologyMap
    ]));
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.documents.bestPractice)?.content)
      .toContain("Public Wording Guardrails");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.documents.bestPractice)?.content)
      .toContain("Schema.org + GEO Description Direction");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.documents.bestPractice)?.content)
      .toContain("Reference Output From Amoremall/Sulwhasoo Example (Verbatim)");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.documents.bestPractice)?.content)
      .toContain("Cross-Product Benchmarking Guidance");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.documents.schemaOrgProduct)?.content)
      .toContain("Do not expose internal diagnostic labels");
  });

  it("builds retrieval queries for review-led FAQ intent and public wording constraints", () => {
    const query = createPdpGeoRagQuery({
      name: "Concentrated Ginseng Rejuvenating Serum",
      brand: "Sulwhasoo",
      category: "Skincare Serum",
      benefits: ["fine lines", "elasticity", "firmness"],
      effects: [],
      ingredients: ["Korean Ginseng Actives", "Retinol"],
      usage: ["Apply after toner"],
      metrics: [],
      faq: [],
      reviews: {
        keywords: ["absorbs quickly", "smooth texture"],
        items: []
      },
      images: [],
      options: [],
      breadcrumbs: [],
      sourceTexts: []
    }, "en-US", "US");

    expect(query).toContain("answer-ready FAQ intent");
    expect(query).toContain("customer review language");
    expect(query).toContain("WebPage/Product description separation");
    expect(query).toContain("public wording without internal diagnostic labels");
  });

  it("keeps default fallback RAG aligned with citation and public wording guardrails", () => {
    const bestPractice = defaultPdpGeoGeneratorRagProfile.documents.find(
      (document) => document.name === pdpGeoGeneratorRagManifest.documents.bestPractice
    );

    expect(defaultPdpGeoGeneratorRagProfile.analysisPrompt).toContain("answer-ready, citation-friendly");
    expect(bestPractice?.content).toContain("Public Wording Guardrails");
    expect(bestPractice?.content).toContain("Schema.org + GEO Description Direction");
    expect(bestPractice?.content).toContain("Reconstruct FAQPage questions");
    expect(bestPractice?.content).toContain("Do not reuse the same text for WebPage.description and Product.description");
    expect(bestPractice?.content).toContain("Korean Reference Artifact Usage");
    expect(bestPractice?.content).toContain("Cross-Product Benchmarking Guidance");
  });

  it("splits long reference artifacts into bounded local RAG chunks", async () => {
    const product = {
      name: "Reference Serum",
      benefits: ["firmness"],
      effects: [],
      ingredients: [],
      usage: [],
      metrics: [],
      faq: [],
      reviews: {
        keywords: [],
        items: []
      },
      images: [],
      options: [],
      breadcrumbs: [],
      sourceTexts: []
    };
    const chunks = await new LocalVersionedRagRetriever().retrieve({
      query: createPdpGeoRagQuery(product, "en-US", "US"),
      product,
      locale: "en-US",
      market: "US",
      documents: [{
        name: pdpGeoGeneratorRagManifest.documents.bestPractice,
        version: "v1",
        content: `# Best Practice\n\n${"source-backed reference artifact ".repeat(200)}`
      }],
      settings: resolvePdpGeoRagSettings({
        maxChunks: 10,
        scoreThreshold: 0
      })
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.text.length <= 1100)).toBe(true);
  });
});
