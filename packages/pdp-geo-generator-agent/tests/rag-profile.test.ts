import { describe, expect, it } from "vitest";
import { pdpGeoGeneratorRagManifest } from "../src";
import { defaultPdpGeoGeneratorRagProfile } from "../src/rag/default-profile";
import { pdpGeoRagIndex } from "../src/rag/rag-index";
import { readPdpGeoGeneratorRagProfile } from "../src/rag/profile";
import { createPdpGeoReasoning } from "../src/rag/reasoning";
import { createPdpGeoRagQuery, createPdpGeoRagQueryPlan, LocalVersionedRagRetriever, resolvePdpGeoRagSettings, retrievePdpGeoRagChunks } from "../src/rag/retrieval";

describe("readPdpGeoGeneratorRagProfile", () => {
  it("reads managed GEO generator RAG files including locale terminology", async () => {
    const profile = await readPdpGeoGeneratorRagProfile();

    expect(profile.profile).toBe(pdpGeoGeneratorRagManifest.profile);
    expect(profile.analysisPrompt).toContain("GEO-optimized PDP artifacts");
    expect(profile.analysisPrompt).toContain("WebPage.description");
    expect(profile.analysisPrompt).toContain("OCR text is present");
    expect(profile.analysisPrompt).toContain("classified OCR sentences");
    expect(profile.analysisPrompt).toContain("Do not expose internal labels");
    expect(profile.analysisPrompt).toContain("Do not solve routing errors with product-specific sentence blocklists");
    expect(profile.documents.map((document) => document.name)).toEqual(expect.arrayContaining([
      pdpGeoGeneratorRagManifest.documents.schemaOrgProduct,
      pdpGeoGeneratorRagManifest.documents.eeat,
      pdpGeoGeneratorRagManifest.documents.cep,
      pdpGeoGeneratorRagManifest.documents.bestPractice,
      pdpGeoGeneratorRagManifest.documents.geoResearch,
      pdpGeoGeneratorRagManifest.documents.officialAiSearchPlatformDocs,
      pdpGeoGeneratorRagManifest.documents.localeExpressionGuidelines,
      pdpGeoGeneratorRagManifest.documents.localeTerminologyMap,
      pdpGeoGeneratorRagManifest.brandIdentities.sulwhasoo,
      pdpGeoGeneratorRagManifest.brandIdentities.aestura,
      pdpGeoGeneratorRagManifest.brandBestPractices.sulwhasoo,
      pdpGeoGeneratorRagManifest.brandBestPractices.aestura,
      pdpGeoGeneratorRagManifest.brandLocaleExpressionGuidelines.sulwhasoo,
      pdpGeoGeneratorRagManifest.brandLocaleExpressionGuidelines.aestura,
      pdpGeoGeneratorRagManifest.brandLocaleTerminologyMaps.sulwhasoo,
      pdpGeoGeneratorRagManifest.brandLocaleTerminologyMaps.aestura
    ]));
    expect(pdpGeoRagIndex.some((entry) => entry.document === pdpGeoGeneratorRagManifest.documents.schemaOrgProduct)).toBe(true);
    expect(pdpGeoRagIndex.some((entry) => entry.document === pdpGeoGeneratorRagManifest.brandBestPractices.sulwhasoo && entry.kind === "best-practice")).toBe(true);
    expect(pdpGeoRagIndex.some((entry) => entry.document === pdpGeoGeneratorRagManifest.brandBestPractices.aestura && entry.kind === "best-practice")).toBe(true);
    expect(pdpGeoRagIndex.some((entry) => entry.document === pdpGeoGeneratorRagManifest.brandLocaleExpressionGuidelines.sulwhasoo && entry.kind === "locale")).toBe(true);
    expect(pdpGeoRagIndex.some((entry) => entry.document === pdpGeoGeneratorRagManifest.brandLocaleExpressionGuidelines.aestura && entry.kind === "locale")).toBe(true);
    expect(pdpGeoRagIndex.some((entry) => entry.document === pdpGeoGeneratorRagManifest.brandLocaleTerminologyMaps.sulwhasoo && entry.kind === "terminology")).toBe(true);
    expect(pdpGeoRagIndex.some((entry) => entry.document === pdpGeoGeneratorRagManifest.brandLocaleTerminologyMaps.aestura && entry.kind === "terminology")).toBe(true);
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.documents.bestPractice)?.content)
      .toContain("RAG Corpus Orchestration");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.documents.bestPractice)?.content)
      .toContain("Public Wording Guardrails");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.documents.bestPractice)?.content)
      .toContain("Schema.org + GEO Description Direction");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.documents.bestPractice)?.content)
      .toContain("Reference Pattern Template");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.documents.bestPractice)?.content)
      .toContain("Field Evidence Routing Pattern");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.documents.bestPractice)?.content)
      .not.toContain("Reference Output From Amoremall/Sulwhasoo Example (Verbatim)");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.documents.bestPractice)?.content)
      .toContain("Cross-Product Benchmarking Guidance");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.documents.bestPractice)?.content)
      .toContain("OCR Sentence Diagnostics and English RAG Use");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.documents.schemaOrgProduct)?.content)
      .toContain("Do not expose internal diagnostic labels");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.documents.schemaOrgProduct)?.content)
      .toContain("When OCR sentences provide ingredient, benefit, usage, review, or full-ingredient evidence");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.documents.eeat)?.content)
      .toContain("Trust-First Claim Safety");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.documents.cep)?.content)
      .toContain("CEP Identification and Prioritization");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.documents.geoResearch)?.content)
      .toContain("Research-Backed GEO Principles");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.documents.geoResearch)?.content)
      .toContain("evidence-role classification and source-grounded regeneration");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.brandIdentities.sulwhasoo)?.content)
      .toContain("Ginseng Science and Skin Longevity");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.brandIdentities.aestura)?.content)
      .toContain("Dermocosmetic and Sensitive Skin Expertise");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.brandIdentities.sulwhasoo)?.content)
      .toContain("Research Papers and Official Articles");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.brandIdentities.aestura)?.content)
      .toContain("PubMed ID: 40099382");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.brandBestPractices.sulwhasoo)?.content)
      .toContain("Sulwhasoo Best Practice v1");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.brandBestPractices.aestura)?.content)
      .toContain("AESTURA Best Practice v1");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.brandLocaleExpressionGuidelines.sulwhasoo)?.content)
      .toContain("Sulwhasoo Locale Expression Guidelines v1");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.brandLocaleExpressionGuidelines.aestura)?.content)
      .toContain("AESTURA Locale Expression Guidelines v1");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.brandLocaleTerminologyMaps.sulwhasoo)?.content)
      .toContain("korean-ginseng-science");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.brandLocaleTerminologyMaps.aestura)?.content)
      .toContain("dermocosmetic-barrier");
  });

  it("loads nested brand RAG documents as retrievable managed chunks", async () => {
    const profile = await readPdpGeoGeneratorRagProfile();
    const product = {
      name: "Concentrated Ginseng Rejuvenating Serum",
      brand: "Sulwhasoo",
      category: "Skincare Serum",
      benefits: ["firmness", "radiance"],
      effects: [],
      ingredients: ["Korean Ginseng"],
      usage: ["Apply after toner."],
      metrics: [],
      faq: [],
      reviews: {
        keywords: ["nourishing texture"],
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
      documents: profile.documents
        .filter((document) => document.name === pdpGeoGeneratorRagManifest.brandIdentities.sulwhasoo)
        .map((document) => ({
          name: document.name,
          version: document.version,
          content: document.content
        })),
      settings: resolvePdpGeoRagSettings({
        maxChunks: 50,
        scoreThreshold: 0
      })
    });

    expect(chunks.some((chunk) => chunk.source === pdpGeoGeneratorRagManifest.brandIdentities.sulwhasoo)).toBe(true);
    expect(chunks.find((chunk) => chunk.title === "GEO Projection Rules")?.fieldTargets)
      .toEqual(expect.arrayContaining(["Product.description", "FAQPage.mainEntity", "HowTo.step"]));
    expect(chunks.find((chunk) => chunk.title === "Identity Pillars")?.intents)
      .toEqual(expect.arrayContaining(["customer", "claims", "evidence"]));
    expect(chunks.find((chunk) => chunk.title === "Research Papers and Official Articles")?.fieldTargets)
      .toEqual(expect.arrayContaining(["diagnostics", "WebPage.description", "FAQPage.mainEntity"]));

    const bestPracticeChunks = await new LocalVersionedRagRetriever().retrieve({
      query: createPdpGeoRagQuery(product, "en-US", "US"),
      product,
      locale: "en-US",
      market: "US",
      documents: profile.documents
        .filter((document) => document.name === pdpGeoGeneratorRagManifest.brandBestPractices.sulwhasoo)
        .map((document) => ({
          name: document.name,
          version: document.version,
          content: document.content
        })),
      settings: resolvePdpGeoRagSettings({
        maxChunks: 50,
        scoreThreshold: 0
      })
    });

    expect(bestPracticeChunks.some((chunk) => chunk.source === pdpGeoGeneratorRagManifest.brandBestPractices.sulwhasoo)).toBe(true);
    expect(bestPracticeChunks.find((chunk) => chunk.title === "Brand-Specific Best Practice Overlay")?.kind)
      .toBe("best-practice");
    expect(bestPracticeChunks.find((chunk) => chunk.title === "Brand-Specific Best Practice Overlay")?.fieldTargets)
      .toEqual(expect.arrayContaining(["Product.description", "FAQPage.mainEntity", "HowTo.step"]));

    const localeChunks = await new LocalVersionedRagRetriever().retrieve({
      query: createPdpGeoRagQuery(product, "en-US", "US"),
      product,
      locale: "en-US",
      market: "US",
      documents: profile.documents
        .filter((document) => document.name === pdpGeoGeneratorRagManifest.brandLocaleExpressionGuidelines.sulwhasoo)
        .map((document) => ({
          name: document.name,
          version: document.version,
          content: document.content
        })),
      settings: resolvePdpGeoRagSettings({
        maxChunks: 50,
        scoreThreshold: 0
      })
    });

    expect(localeChunks.some((chunk) => chunk.source === pdpGeoGeneratorRagManifest.brandLocaleExpressionGuidelines.sulwhasoo)).toBe(true);
    expect(localeChunks.find((chunk) => chunk.title === "Brand-Specific Locale Overlay")?.kind)
      .toBe("locale");

    const terminologyDocument = profile.documents.find(
      (document) => document.name === pdpGeoGeneratorRagManifest.brandLocaleTerminologyMaps.sulwhasoo
    );
    expect(() => JSON.parse(terminologyDocument?.content ?? "")).not.toThrow();
    expect(JSON.parse(terminologyDocument?.content ?? "{}").concepts.some((concept: { concept: string }) =>
      concept.concept === "korean-ginseng-science"
    )).toBe(true);
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
    expect(query).toContain("OCR sentence diagnostics");
    expect(query).toContain("customer review language");
    expect(query).toContain("WebPage/Product description separation");
    expect(query).toContain("public wording without internal diagnostic labels");
  });

  it("keeps default fallback RAG aligned with answer-ready content and public wording guardrails", () => {
    const bestPractice = defaultPdpGeoGeneratorRagProfile.documents.find(
      (document) => document.name === pdpGeoGeneratorRagManifest.documents.bestPractice
    );

    expect(defaultPdpGeoGeneratorRagProfile.analysisPrompt).toContain("diverse product keywords");
    expect(defaultPdpGeoGeneratorRagProfile.analysisPrompt).toContain("typed RAG index");
    expect(defaultPdpGeoGeneratorRagProfile.analysisPrompt).toContain("classified OCR sentences");
    expect(bestPractice?.content).toContain("Public Wording Guardrails");
    expect(bestPractice?.content).toContain("Schema.org + GEO Description Direction");
    expect(bestPractice?.content).toContain("Reconstruct FAQPage questions");
    expect(bestPractice?.content).toContain("OCR Sentence Diagnostics and English RAG Use");
    expect(bestPractice?.content).toContain("natural English commerce language");
    expect(bestPractice?.content).toContain("Do not reuse the same text for WebPage.description and Product.description");
    expect(bestPractice?.content).toContain("Korean Reference Artifact Usage");
    expect(bestPractice?.content).toContain("Cross-Product Benchmarking Guidance");

    expect(defaultPdpGeoGeneratorRagProfile.documents.find(
      (document) => document.name === pdpGeoGeneratorRagManifest.documents.eeat
    )?.content).toContain("Trust-First Claim Safety");
    expect(defaultPdpGeoGeneratorRagProfile.documents.find(
      (document) => document.name === pdpGeoGeneratorRagManifest.documents.cep
    )?.content).toContain("CEP Identification and Prioritization");
    expect(defaultPdpGeoGeneratorRagProfile.documents.find(
      (document) => document.name === pdpGeoGeneratorRagManifest.documents.geoResearch
    )?.content).toContain("Research-Backed GEO Principles");
    expect(pdpGeoRagIndex.find((entry) => entry.document === pdpGeoGeneratorRagManifest.documents.geoResearch)?.sections)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ heading: "Retrieval and Query Planning" })
      ]));
  });

  it("creates targeted subqueries for partial FAQ and HowTo updates", () => {
    const product = {
      name: "Reference Serum",
      benefits: ["hydration"],
      effects: [],
      ingredients: ["Niacinamide"],
      usage: ["Apply after toner."],
      metrics: [],
      faq: [],
      reviews: {
        keywords: ["lightweight texture"],
        items: []
      },
      images: [],
      options: [],
      breadcrumbs: [],
      sourceTexts: []
    };
    const plan = createPdpGeoRagQueryPlan(product, "en-US", "US", {
      queryPlanning: {
        enabled: true,
        updateTargets: ["faq", "howToUse"]
      }
    });

    expect(plan.mode).toBe("agentic-subquery-planning");
    expect(plan.queries.some((query) => query.target === "faq" && query.fieldTargets.includes("FAQPage.mainEntity"))).toBe(true);
    expect(plan.queries.some((query) => query.target === "howToUse" && query.fieldTargets.includes("HowTo.step"))).toBe(true);
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

  it("classifies added RAG document sections into GEO generation intents", async () => {
    const product = {
      name: "Reference Serum",
      benefits: ["hydration"],
      effects: [],
      ingredients: ["Niacinamide"],
      usage: ["Apply after toner."],
      metrics: [],
      faq: [],
      reviews: {
        keywords: ["lightweight texture"],
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
        name: "custom-geo-playbook.md",
        version: "v1",
        content: [
          "# Custom GEO Playbook",
          "",
          "## FAQ Generation Rules",
          "FAQ answers should combine customer questions, ingredient facts, and review language.",
          "",
          "## Usage Routine Rules",
          "HowTo steps should be complete usage actions with order and amount.",
          "",
          "## Claim Evidence Rules",
          "Claims must use source-supported evidence, clinical metrics, and Product additionalProperty only when visible."
        ].join("\n")
      }],
      settings: resolvePdpGeoRagSettings({
        maxChunks: 10,
        scoreThreshold: 0
      })
    });

    expect(chunks.find((chunk) => chunk.title === "FAQ Generation Rules")?.intents).toContain("faq");
    expect(chunks.find((chunk) => chunk.title === "FAQ Generation Rules")?.fieldTargets).toContain("FAQPage.mainEntity");
    expect(chunks.find((chunk) => chunk.title === "FAQ Generation Rules")?.metadata.headingPath)
      .toBe("Custom GEO Playbook > FAQ Generation Rules");
    expect(chunks.find((chunk) => chunk.title === "FAQ Generation Rules")?.metadata.contextualRetrieval).toBe(true);
    expect(chunks.find((chunk) => chunk.title === "FAQ Generation Rules")?.metadata.reranker).toBe("local-contextual-hybrid");
    expect(chunks.find((chunk) => chunk.title === "Usage Routine Rules")?.intents).toContain("howTo");
    expect(chunks.find((chunk) => chunk.title === "Usage Routine Rules")?.fieldTargets).toContain("HowTo.step");
    expect(chunks.find((chunk) => chunk.title === "Claim Evidence Rules")?.intents).toContain("claims");
    expect(chunks.find((chunk) => chunk.title === "Claim Evidence Rules")?.fieldTargets).toContain("Product.additionalProperty");
  });

  it("resolves URLs embedded in RAG documents and classifies resolved content", async () => {
    const product = {
      name: "Reference Serum",
      benefits: ["hydration"],
      effects: [],
      ingredients: ["Niacinamide"],
      usage: ["Apply after toner."],
      metrics: [],
      faq: [],
      reviews: {
        keywords: ["lightweight texture"],
        items: []
      },
      images: [],
      options: [],
      breadcrumbs: [],
      sourceTexts: []
    };
    const chunks = await retrievePdpGeoRagChunks({
      query: createPdpGeoRagQuery(product, "en-US", "US"),
      product,
      locale: "en-US",
      market: "US",
      documents: [{
        name: "custom-geo-links.md",
        version: "v1",
        content: "Read the latest GEO trend note: https://example.com/geo-trends"
      }],
      settings: resolvePdpGeoRagSettings({
        resolveUrls: true,
        maxResolvedUrlDocuments: 1,
        maxChunks: 10,
        scoreThreshold: 0
      })
    }, {
      urlResolver: {
        async resolve(request) {
          expect(request.url).toBe("https://example.com/geo-trends");
          return {
            url: request.url,
            title: "GEO Trend Note",
            content: [
              "## Authentication Setup",
              "Install the SDK, create an API key, configure billing, and run curl commands.",
              "",
              "## Review-led FAQ Eligibility",
              "Generative search answers prefer customer review questions when FAQ answers include source-backed review language.",
              "",
              "## Evidence-backed Claims",
              "Claims need citation-ready metrics, source support, and Product additionalProperty mapping."
            ].join("\n"),
            contentType: "text/markdown"
          };
        }
      }
    });

    const faqChunk = chunks.find((chunk) => chunk.source === "https://example.com/geo-trends" && chunk.title === "Review-led FAQ Eligibility");
    const claimChunk = chunks.find((chunk) => chunk.source === "https://example.com/geo-trends" && chunk.title === "Evidence-backed Claims");
    const authChunk = chunks.find((chunk) => chunk.source === "https://example.com/geo-trends" && chunk.title === "Authentication Setup");

    expect(authChunk).toBeUndefined();
    expect(faqChunk?.intents).toEqual(expect.arrayContaining(["faq", "review"]));
    expect(faqChunk?.fieldTargets).toContain("FAQPage.mainEntity");
    expect(claimChunk?.intents).toEqual(expect.arrayContaining(["claims", "evidence"]));
    expect(claimChunk?.fieldTargets).toContain("Product.additionalProperty");
  });

  it("builds explicit GEO reasoning from selected RAG chunks and product evidence", () => {
    const reasoning = createPdpGeoReasoning({
      locale: "en-US",
      market: "US",
      product: {
        name: "Ginseng Barrier Serum",
        benefits: ["hydration", "skin barrier support"],
        effects: ["firmer-looking skin"],
        ingredients: ["Niacinamide", "Panax Ginseng Root Extract"],
        usage: ["Apply morning and night after toner."],
        metrics: [],
        faq: [],
        reviews: {
          keywords: ["absorbs quickly"],
          items: [{ body: "It absorbs quickly and keeps skin hydrated.", rating: 5 }]
        },
        images: [],
        options: [],
        breadcrumbs: [],
        sourceTexts: ["Daily serum for hydration and skin barrier care."]
      },
      ragChunks: [
        {
          id: "best-faq-1",
          source: pdpGeoGeneratorRagManifest.documents.bestPractice,
          title: "FAQ Best Practice",
          kind: "best-practice",
          intents: ["faq"],
          fieldTargets: ["FAQPage.mainEntity"],
          text: "Compose answer-ready FAQ and stepwise HowTo from source-backed evidence.",
          metadata: {},
          score: 0.92
        },
        {
          id: "best-howto-1",
          source: pdpGeoGeneratorRagManifest.documents.bestPractice,
          title: "HowTo Best Practice",
          kind: "best-practice",
          intents: ["howTo"],
          fieldTargets: ["HowTo.step"],
          text: "Rewrite source usage text into complete HowTo steps.",
          metadata: {},
          score: 0.91
        },
        {
          id: "schema-1",
          source: pdpGeoGeneratorRagManifest.documents.schemaOrgProduct,
          title: "FAQPage and HowTo schema",
          kind: "schema",
          intents: ["faq", "howTo", "schema"],
          fieldTargets: ["FAQPage.mainEntity", "HowTo.step"],
          text: "Use FAQPage and HowTo only when product facts support them.",
          metadata: {},
          score: 0.9
        },
        {
          id: "eeat-1",
          source: pdpGeoGeneratorRagManifest.documents.eeat,
          kind: "eeat",
          intents: ["claims", "review", "howTo", "evidence"],
          fieldTargets: ["Product.description", "Product.positiveNotes"],
          text: "Trust signals and evidence hierarchy should guide all public claims.",
          metadata: {},
          score: 0.88
        },
        {
          id: "cep-1",
          source: pdpGeoGeneratorRagManifest.documents.cep,
          kind: "cep",
          intents: ["customer", "faq"],
          fieldTargets: ["WebPage.description", "FAQPage.mainEntity"],
          text: "Category entry points connect customer intent to product answers.",
          metadata: {},
          score: 0.87
        },
        {
          id: "geo-research-1",
          source: pdpGeoGeneratorRagManifest.documents.geoResearch,
          kind: "geo-research",
          intents: ["faq", "howTo", "claims", "customer", "review"],
          fieldTargets: ["PDP.content"],
          text: "Generative search answers need citation-ready, entity-rich source support.",
          metadata: {},
          score: 0.86
        }
      ]
    });

    expect(reasoning.mode).toBe("explicit-rag-product-reasoning");
    expect(reasoning.principles).toEqual(expect.arrayContaining(["answer-ready FAQ", "stepwise HowTo", "review-intent FAQ"]));
    expect(reasoning.decisions.find((decision) => decision.principle === "answer-ready FAQ")?.productEvidence.join(" ")).toContain("hydration");
    expect(reasoning.decisions.find((decision) => decision.principle === "answer-ready FAQ")?.ragSources)
      .toContain(`${pdpGeoGeneratorRagManifest.documents.bestPractice}#FAQ Best Practice`);
    expect(reasoning.decisions.find((decision) => decision.principle === "answer-ready FAQ")?.ragSources)
      .not.toContain(`${pdpGeoGeneratorRagManifest.documents.bestPractice}#HowTo Best Practice`);
    expect(reasoning.decisions.find((decision) => decision.principle === "stepwise HowTo")?.ragSources)
      .toContain(`${pdpGeoGeneratorRagManifest.documents.bestPractice}#HowTo Best Practice`);
    expect(reasoning.decisions.find((decision) => decision.principle === "stepwise HowTo")?.ragSources)
      .not.toContain(`${pdpGeoGeneratorRagManifest.documents.bestPractice}#FAQ Best Practice`);
  });
});
