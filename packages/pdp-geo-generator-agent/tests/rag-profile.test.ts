import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pdpGeoGeneratorRagManifest } from "../src";
import { defaultPdpGeoGeneratorRagProfile } from "../src/rag/default-profile";
import { pdpGeoRagIndex } from "../src/rag/rag-index";
import {
  readPdpGeoGeneratorRagProfile,
  resetPdpGeoGeneratorRagProfile,
  writePdpGeoGeneratorRagProfile
} from "../src/rag/profile";
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
    // The internal-label prohibition moved to the contract canon; the prompt
    // keeps the prose pointer that routes the generator to it.
    expect(profile.analysisPrompt).toContain("Public Wording Contract in the content-field-contracts document");
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
      pdpGeoGeneratorRagManifest.brandIdentities.exampleluxe,
      pdpGeoGeneratorRagManifest.brandIdentities.examplederma,
      pdpGeoGeneratorRagManifest.brandBestPractices.exampleluxe,
      pdpGeoGeneratorRagManifest.brandBestPractices.examplederma,
      pdpGeoGeneratorRagManifest.brandLocaleExpressionGuidelines.exampleluxe,
      pdpGeoGeneratorRagManifest.brandLocaleExpressionGuidelines.examplederma,
      pdpGeoGeneratorRagManifest.brandLocaleTerminologyMaps.exampleluxe,
      pdpGeoGeneratorRagManifest.brandLocaleTerminologyMaps.examplederma
    ]));
    expect(pdpGeoRagIndex.some((entry) => entry.document === pdpGeoGeneratorRagManifest.documents.schemaOrgProduct)).toBe(true);
    expect(pdpGeoRagIndex.some((entry) => entry.document === pdpGeoGeneratorRagManifest.brandBestPractices.exampleluxe && entry.kind === "best-practice")).toBe(true);
    expect(pdpGeoRagIndex.some((entry) => entry.document === pdpGeoGeneratorRagManifest.brandBestPractices.examplederma && entry.kind === "best-practice")).toBe(true);
    expect(pdpGeoRagIndex.some((entry) => entry.document === pdpGeoGeneratorRagManifest.brandLocaleExpressionGuidelines.exampleluxe && entry.kind === "locale")).toBe(true);
    expect(pdpGeoRagIndex.some((entry) => entry.document === pdpGeoGeneratorRagManifest.brandLocaleExpressionGuidelines.examplederma && entry.kind === "locale")).toBe(true);
    expect(pdpGeoRagIndex.some((entry) => entry.document === pdpGeoGeneratorRagManifest.brandLocaleTerminologyMaps.exampleluxe && entry.kind === "terminology")).toBe(true);
    expect(pdpGeoRagIndex.some((entry) => entry.document === pdpGeoGeneratorRagManifest.brandLocaleTerminologyMaps.examplederma && entry.kind === "terminology")).toBe(true);
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
      .not.toContain("Reference Output From ExampleShop/ExampleLuxe Example (Verbatim)");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.documents.bestPractice)?.content)
      .toContain("Cross-Product Benchmarking Guidance");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.documents.bestPractice)?.content)
      .toContain("OCR Sentence Diagnostics and English RAG Use");
    // The internal-label prohibition itself now lives only in the contract
    // canon; schema-org_v2 keeps the prose pointer to it.
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.documents.contentFieldContracts)?.content)
      .toContain("Do not expose internal labels such as \"evidence signal\"");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.documents.schemaOrgProduct)?.content)
      .toContain("Public Wording Contract in the content-field-contracts document");
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
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.brandIdentities.exampleluxe)?.content)
      .toContain("Ginseng Science and Skin Longevity");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.brandIdentities.examplederma)?.content)
      .toContain("Dermocosmetic and Sensitive Skin Expertise");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.brandIdentities.exampleluxe)?.content)
      .toContain("Research Papers and Official Articles");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.brandIdentities.examplederma)?.content)
      .toContain("PubMed ID: 40099382");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.brandBestPractices.exampleluxe)?.content)
      .toContain("ExampleLuxe Best Practice v2");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.brandBestPractices.examplederma)?.content)
      .toContain("EXAMPLEDERMA Best Practice v2");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.brandBestPractices.exampleluxe)?.content)
      .toContain("What are the main benefits of [Product name], and what do the reported clinical study results show?");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.brandBestPractices.exampleluxe)?.content)
      .toContain("ExampleLuxe US output is `en-US`");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.brandBestPractices.exampleluxe)?.content)
      .not.toContain("Base Best Practice Model");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.brandBestPractices.exampleluxe)?.content)
      .not.toContain("Cross-Product Benchmarking Guidance");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.brandBestPractices.examplederma)?.content)
      .toContain("공개된 인체적용시험 결과는 어떻게 나타났나요?");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.brandBestPractices.examplederma)?.content)
      .toContain("정확한 상품명");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.brandBestPractices.examplederma)?.content)
      .toContain("페이지 본문에서는");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.brandBestPractices.examplederma)?.content)
      .toContain("유분량은 사용 전 대비 사용 직후 55%, 12시간 후에도 23% 개선되었습니다");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.brandBestPractices.examplederma)?.content)
      .not.toContain("Base Best Practice Model");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.brandBestPractices.examplederma)?.content)
      .not.toContain("Cross-Product Benchmarking Guidance");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.brandLocaleExpressionGuidelines.exampleluxe)?.content)
      .toContain("ExampleLuxe Locale Expression Guidelines v1");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.brandLocaleExpressionGuidelines.examplederma)?.content)
      .toContain("EXAMPLEDERMA Locale Expression Guidelines v1");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.brandLocaleExpressionGuidelines.exampleluxe)?.content)
      .toContain("reported clinical study results");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.brandLocaleExpressionGuidelines.examplederma)?.content)
      .toContain("상품 근거");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.brandLocaleTerminologyMaps.exampleluxe)?.content)
      .toContain("korean-ginseng-science");
    expect(profile.documents.find((document) => document.name === pdpGeoGeneratorRagManifest.brandLocaleTerminologyMaps.examplederma)?.content)
      .toContain("dermocosmetic-barrier");
  });

  it("loads nested brand RAG documents as retrievable managed chunks", async () => {
    const profile = await readPdpGeoGeneratorRagProfile();
    const product = {
      name: "Botanical Renewal Serum",
      brand: "ExampleLuxe",
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
        .filter((document) => document.name === pdpGeoGeneratorRagManifest.brandIdentities.exampleluxe)
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

    expect(chunks.some((chunk) => chunk.source === pdpGeoGeneratorRagManifest.brandIdentities.exampleluxe)).toBe(true);
    // "GEO Projection Rules" is a heading-only parent (H2 followed directly by
    // H3), so it no longer emits a noise chunk; its rag-index metadata is
    // inherited by child chunks through headingPath matching instead.
    expect(chunks.find((chunk) => chunk.title === "GEO Projection Rules")).toBeUndefined();
    const projectionChild = chunks.find((chunk) =>
      typeof chunk.metadata.headingPath === "string"
      && chunk.metadata.headingPath.includes("GEO Projection Rules")
      && chunk.title === "Product.description"
    );
    expect(projectionChild?.fieldTargets)
      .toEqual(expect.arrayContaining(["Product.description", "WebPage.description", "PDP.content", "diagnostics"]));
    expect(projectionChild?.fieldTargets ?? [])
      .not.toContain("FAQPage.mainEntity");
    expect(projectionChild?.fieldTargets ?? [])
      .not.toContain("HowTo.step");
    expect(projectionChild?.fieldTargets ?? [])
      .not.toContain("Product.additionalProperty");
    // "Identity Pillars" is also a heading-only parent; children inherit its
    // rag-index intents through headingPath matching.
    const identityPillarsChild = chunks.find((chunk) =>
      typeof chunk.metadata.headingPath === "string"
      && chunk.metadata.headingPath.includes("Identity Pillars")
      && chunk.title === "Holistic Beauty and Korean Heritage"
    );
    expect(identityPillarsChild?.intents)
      .toEqual(expect.arrayContaining(["customer", "locale"]));
    expect(identityPillarsChild?.intents ?? [])
      .not.toContain("claims");
    expect(identityPillarsChild?.intents ?? [])
      .not.toContain("evidence");
    expect(chunks.find((chunk) => chunk.title === "Research Papers and Official Articles")?.fieldTargets)
      .toEqual(expect.arrayContaining(["diagnostics", "WebPage.description", "PDP.content"]));
    expect(chunks.find((chunk) => chunk.title === "Research Papers and Official Articles")?.fieldTargets ?? [])
      .not.toContain("Product.additionalProperty");
    expect(chunks.find((chunk) => chunk.title === "Research Papers and Official Articles")?.fieldTargets ?? [])
      .not.toContain("FAQPage.mainEntity");

    const bestPracticeChunks = await new LocalVersionedRagRetriever().retrieve({
      query: createPdpGeoRagQuery(product, "en-US", "US"),
      product,
      locale: "en-US",
      market: "US",
      documents: profile.documents
        .filter((document) => document.name === pdpGeoGeneratorRagManifest.brandBestPractices.exampleluxe)
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

    expect(bestPracticeChunks.some((chunk) => chunk.source === pdpGeoGeneratorRagManifest.brandBestPractices.exampleluxe)).toBe(true);
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
        .filter((document) => document.name === pdpGeoGeneratorRagManifest.brandLocaleExpressionGuidelines.exampleluxe)
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

    expect(localeChunks.some((chunk) => chunk.source === pdpGeoGeneratorRagManifest.brandLocaleExpressionGuidelines.exampleluxe)).toBe(true);
    expect(localeChunks.find((chunk) => chunk.title === "Brand-Specific Locale Overlay")?.kind)
      .toBe("locale");

    const terminologyDocument = profile.documents.find(
      (document) => document.name === pdpGeoGeneratorRagManifest.brandLocaleTerminologyMaps.exampleluxe
    );
    expect(() => JSON.parse(terminologyDocument?.content ?? "")).not.toThrow();
    expect(JSON.parse(terminologyDocument?.content ?? "{}").concepts.some((concept: { concept: string }) =>
      concept.concept === "korean-ginseng-science"
    )).toBe(true);
  });

  it("builds retrieval queries for review-intent FAQ and public wording constraints", () => {
    const query = createPdpGeoRagQuery({
      name: "Botanical Renewal Serum",
      brand: "ExampleLuxe",
      category: "Skincare Serum",
      benefits: ["fine lines", "elasticity", "firmness"],
      effects: [],
      ingredients: ["Botanical Actives", "Retinol"],
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

    // The query names the contracts and routing concepts it needs; it must not
    // restate the rules. A query carrying a contract's own wording makes the
    // documents that paraphrase that contract outrank the contract itself.
    expect(query).toContain("answer-ready FAQ intent");
    expect(query).toContain("OCR sentence diagnostics");
    expect(query).toContain("description composition contract");
    expect(query).toContain("description separation contract");
    expect(query).toContain("public wording contract");
    expect(query).toContain("evidence routing contract");
    expect(query).toContain("CEP field mapping");
    expect(query).not.toContain("Product.description order:");
    expect(query).not.toContain("one source instruction becomes one step");
  });

  it("preserves existing managed files when a write omits them from the payload", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pdp-geo-rag-"));
    const name = pdpGeoGeneratorRagManifest.documents.geoResearch;
    const committedContent = "# GEO Research Guidance v3\n\nCommitted corpus content that must survive partial writes.\n";
    await writeFile(join(directory, name), committedContent, "utf8");

    await writePdpGeoGeneratorRagProfile({ analysisPrompt: "custom prompt" }, directory);

    expect(await readFile(join(directory, name), "utf8")).toBe(committedContent);
  });

  it("restores a missing managed file from the inline fallback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pdp-geo-rag-"));

    await writePdpGeoGeneratorRagProfile({ analysisPrompt: "custom prompt" }, directory);

    const restored = await readFile(join(directory, pdpGeoGeneratorRagManifest.documents.geoResearch), "utf8");
    expect(restored).toContain("# GEO Research Guidance v3");
  });

  it("applies explicit managed document updates from the payload", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pdp-geo-rag-"));
    const name = pdpGeoGeneratorRagManifest.documents.bestPractice;
    await writeFile(join(directory, name), "# Best Practice v1\n\nOld content.\n", "utf8");

    await writePdpGeoGeneratorRagProfile({
      analysisPrompt: "custom prompt",
      documents: [{ name, version: "v1", content: "# Best Practice v1\n\nUpdated content." }]
    }, directory);

    expect(await readFile(join(directory, name), "utf8")).toBe("# Best Practice v1\n\nUpdated content.\n");
  });

  it("reset clears custom attachments but never downgrades existing managed files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pdp-geo-rag-"));
    const name = pdpGeoGeneratorRagManifest.documents.geoResearch;
    const committedContent = "# GEO Research Guidance v3\n\nFull committed corpus content that is newer than the inline fallback.\n";
    await writeFile(join(directory, name), committedContent, "utf8");
    await mkdir(join(directory, "custom"), { recursive: true });
    await writeFile(join(directory, "custom", "attachment_v1.md"), "# Custom Attachment\n", "utf8");

    const profile = await resetPdpGeoGeneratorRagProfile(directory);

    expect(await readFile(join(directory, name), "utf8")).toBe(committedContent);
    expect(existsSync(join(directory, "custom", "attachment_v1.md"))).toBe(false);
    expect(profile.documents.some((document) => document.name === "attachment_v1.md")).toBe(false);
    expect(profile.analysisPrompt.trim()).toBe(defaultPdpGeoGeneratorRagProfile.analysisPrompt.trim());
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
    expect(bestPractice?.content).toContain("OCR Sentence Diagnostics and English RAG Use");
    expect(bestPractice?.content).toContain("natural English commerce language");
    expect(bestPractice?.content).toContain("Korean Reference Artifact Usage");
    expect(bestPractice?.content).toContain("Cross-Product Benchmarking Guidance");
    // The FAQ-count, HowTo-eligibility and description-separation rules moved to
    // the contract canon; best-practice_v1 keeps prose pointers to them.
    expect(bestPractice?.content).toContain("FAQ Contract in the content-field-contracts document");
    expect(bestPractice?.content).toContain("HowTo Contract in the content-field-contracts document");
    expect(bestPractice?.content).toContain("Description Separation Contract in the content-field-contracts document");

    const contractCanon = defaultPdpGeoGeneratorRagProfile.documents.find(
      (document) => document.name === pdpGeoGeneratorRagManifest.documents.contentFieldContracts
    );
    expect(contractCanon?.content).toContain("FAQ has no target or minimum count");
    expect(contractCanon?.content).toContain("at least one direct source action");
    expect(contractCanon?.content).toContain("Do not reuse the same description for `WebPage.description` and `Product.description`");

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

  it("keeps the inline fallback corpus identical to the committed markdown corpus", async () => {
    const profile = await readPdpGeoGeneratorRagProfile();
    for (const fallbackDocument of defaultPdpGeoGeneratorRagProfile.documents) {
      const managed = profile.documents.find((document) => document.name === fallbackDocument.name);
      expect(managed, `missing managed doc for ${fallbackDocument.name}`).toBeDefined();
      expect(fallbackDocument.content.trim(), `fallback drift: ${fallbackDocument.name}`)
        .toBe(managed!.content.trim());
    }
    expect(defaultPdpGeoGeneratorRagProfile.analysisPrompt.trim())
      .toBe(profile.analysisPrompt.trim());
  });

  it("keeps the fallback roster in sync with the manifest's document roster", () => {
    // Guards against a future task registering a new managed document in only
    // one of the two places (manifest vs. inline fallback), which would
    // silently starve the fallback profile of that document with no other
    // test catching it.
    expect(new Set(defaultPdpGeoGeneratorRagProfile.documents.map((document) => document.name)))
      .toEqual(new Set(Object.values(pdpGeoGeneratorRagManifest.documents)));
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
    expect(plan.queries.find((query) => query.target === "howToUse")?.query)
      .toContain("HowTo contract");
    expect(plan.queries.find((query) => query.target === "howToUse")?.query)
      .toContain("source-faithful step eligibility");
    expect(plan.queries.find((query) => query.target === "howToUse")?.query)
      .not.toContain("one source instruction becomes exactly one step");
  });

  it("keeps targeted description retrieval aligned with the Product and WebPage contracts", () => {
    const product = {
      name: "Reference Serum",
      brand: "Reference Lab",
      benefits: ["hydration"],
      effects: [],
      ingredients: ["Niacinamide"],
      usage: ["Apply after toner."],
      metrics: [],
      faq: [],
      reviews: { keywords: ["lightweight texture"], items: [] },
      images: [],
      options: [],
      breadcrumbs: [],
      sourceTexts: []
    };
    const plan = createPdpGeoRagQueryPlan(product, "en-US", "US", {
      queryPlanning: {
        enabled: true,
        updateTargets: ["productDescription", "webPageDescription"]
      }
    });
    const productQuery = plan.queries.find((query) => query.target === "productDescription")?.query ?? "";
    const pageQuery = plan.queries.find((query) => query.target === "webPageDescription")?.query ?? "";

    // Both subqueries point at the contracts that govern their field instead of
    // spelling the stage order out, so canonicalizing a rule into the contract
    // document cannot lower that document's own retrievability.
    expect(productQuery).toContain("description composition contract");
    expect(productQuery).toContain("causal path completeness");
    expect(productQuery).toContain("E-E-A-T trust-first claim safety");
    expect(productQuery).not.toContain("product introduction and type -> target customer");
    expect(pageQuery).toContain("content field contracts for description separation");
    expect(pageQuery).toContain("page-scope wording for the product page and source-backed brand");
    expect(pageQuery).toContain("schema role separation between the page resource and the product entity");
    expect(pageQuery).not.toContain("supported target customer -> ingredient/formula composition");
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
          fieldTargets: ["Product.description", "Product.additionalProperty"],
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
        },
        {
          id: "brand-identity-claims-1",
          source: pdpGeoGeneratorRagManifest.brandIdentities.exampleluxe,
          title: "Research Papers and Official Articles",
          kind: "custom",
          intents: ["claims", "evidence", "customer"],
          fieldTargets: ["Product.description", "Product.additionalProperty"],
          text: "Brand identity research and official articles are brand-image context only and should not become product claims.",
          metadata: {
            queryPlanTarget: "brandIdentityCoverage"
          },
          score: 0.99
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
    expect(reasoning.decisions.find((decision) => decision.principle === "evidence-backed claims")?.ragSources.join(" "))
      .not.toContain(pdpGeoGeneratorRagManifest.brandIdentities.exampleluxe);
    expect(reasoning.decisions.find((decision) => decision.principle === "target customer context")?.ragSources.join(" "))
      .toContain(pdpGeoGeneratorRagManifest.brandIdentities.exampleluxe);
  });
});
