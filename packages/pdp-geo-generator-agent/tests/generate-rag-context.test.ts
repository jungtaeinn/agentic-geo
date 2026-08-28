import { describe, expect, it, vi } from "vitest";
import { generatePdpGeo, pdpGeoGeneratorRagManifest } from "../src";

/**
 * 생성에 공급되는 컨텍스트 — RAG 문서 스코핑·계약 도달·커버리지, 로케일 용어집.
 *
 * generate-pdp-geo.test.ts에서 주제별로 분리했다(어서션은 그대로).
 */

describe("generatePdpGeo", () => {
  it("keeps deterministic English WebPage descriptions page-scope centered", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "Barrier Hydro Soothing Cream",
          description: "Hydrating cream for dry skin and skin barrier care.",
          category: "Cream",
          benefits: ["hydration", "skin barrier care"],
          ingredients: ["Compressed Hyaluronic Acid", "Ceramide"],
          usage: ["Apply morning and night after serum."]
        }
      },
      hints: {
        locale: "en-US",
        market: "US"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const webPage = graph.find((node) => (Array.isArray(node["@type"]) ? node["@type"].includes("WebPage") : node["@type"] === "WebPage")) as Record<string, any>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const description = String(webPage.description);

    expect(description).toContain("Barrier Hydro Soothing Cream product page");
    expect(description).toContain("introduces the cream.");
    expect(description).toMatch(/identifies customers with dry skin as the intended audience.*lists .*Compressed Hyaluronic Acid.*highlighted formula components.*documents hydration.*product benefits/i);
    expect(description).not.toMatch(/purchase decisions|directions and routine order/i);
    expect(String(product.description)).toContain("Compressed Hyaluronic Acid");
    expect(String(product.description)).toContain("Ceramide");
    expect(String(product.description)).toContain("The product's documented benefit is hydration");
    expect(String(product.description)).not.toMatch(/(?:includes|combines|uses)[^.]*\bto support\b/i);
    expect(description).not.toMatch(/Decision details on the page|It connects those decision details|source-backed evidence reports|usage guidance covers/i);
    expect(description).not.toBe(String(product.description));
  });
  it("uses locale-natural ingredient and formula predicates for English and Japanese descriptions", async () => {
    const english = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "EXAMPLEDERMA BarrierCare365 Capsule Toner",
          description: "A barrier moisturizing capsule toner for dry or sensitive skin after cleansing.",
          brand: "EXAMPLEDERMA",
          category: "Toner",
          benefits: ["barrier hydration", "skin barrier moisture"],
          effects: ["supports skin barrier hydration after cleansing"],
          ingredients: [
            "PHA water",
            "high-density ceramide capsules",
            "patent-pending Water Suspension Floating Formula"
          ],
          usage: [
            "EXAMPLEDERMA BarrierCare365 Capsule Toner uses patent-pending Water Suspension Floating Formula with PHA water and high-density ceramide capsules.",
            "Dispense an appropriate amount into your palm.",
            "Spread gently over skin and pat to absorb."
          ],
          sourceTexts: [
            "Recommended for dry or sensitive skin after cleansing.",
            "PHA water and high-density ceramide capsules are presented with patent-pending Water Suspension Floating Formula.",
            "How to use. Dispense an appropriate amount into your palm. Spread gently over skin and pat to absorb."
          ]
        }
      },
      hints: {
        locale: "en-US",
        market: "US"
      }
    });

    const englishGraph = english.result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const englishWebPage = englishGraph.find((node) => (Array.isArray(node["@type"]) ? node["@type"].includes("WebPage") : node["@type"] === "WebPage")) as Record<string, any>;
    const englishProduct = englishGraph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const englishHowTo = englishGraph.find((node) => node["@type"] === "HowTo") as Record<string, any> | undefined;
    const englishProperties = Object.fromEntries((englishProduct.additionalProperty as Array<Record<string, any>>).map((item) => [item.name, item.value]));

    expect(String(englishWebPage.description)).toContain("EXAMPLEDERMA BarrierCare365 Capsule Toner product page");
    expect(String(englishWebPage.description)).not.toMatch(/can be (?:checked|viewed|confirmed)|key ingredients? (?:and|\/) technolog(?:y|ies)|patent[-\s]?pending[^.]*formula's/i);
    expect(String(englishProduct.description)).toMatch(/(?:includes|combines|uses) /i);
    expect(String(englishProduct.description)).toMatch(/documented benefit is .*hydration/i);
    expect(String(englishProduct.description)).not.toMatch(/(?:includes|combines|uses)[^.]*\bto support\b/i);
    expect(String(englishProduct.description)).not.toMatch(/formula highlights|active-ingredient story|patent[-\s]?pending[^.]*formula's|key ingredients? (?:and|\/) technolog(?:y|ies)/i);
    expect(englishHowTo?.step).toHaveLength(1);
    expect(english.result.content.sections.howToUse).not.toMatch(/Water Suspension Floating Formula|uses patent[-\s]?pending/i);
    expect(String(englishProperties.Usage)).not.toMatch(/Water Suspension Floating Formula|uses patent[-\s]?pending/i);

    const japanese = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "EXAMPLEDERMA バリアケア365 カプセルトナー",
          description: "洗顔後の乾燥肌や敏感肌に向けたバリア保湿カプセルトナー。",
          brand: "EXAMPLEDERMA",
          category: "化粧水",
          benefits: ["バリア保湿", "うるおい"],
          effects: ["洗顔後の肌のバリア保湿をサポート"],
          ingredients: [
            "PHAウォーター",
            "高密度セラミドカプセル",
            "特許出願中のハイドロクオールフローティングフォーミュラ"
          ],
          usage: [
            "EXAMPLEDERMA バリアケア365 カプセルトナーは特許出願中のハイドロクオールフローティングフォーミュラ処方を使用しています。",
            "手のひらに適量を取ります。",
            "肌になじませます。"
          ],
          sourceTexts: [
            "乾燥肌や敏感肌におすすめです。",
            "PHAウォーターと高密度セラミドカプセルを特許出願中のハイドロクオールフローティングフォーミュラで紹介しています。",
            "使い方。手のひらに適量を取り、肌になじませます。"
          ]
        }
      },
      hints: {
        locale: "ja-JP",
        market: "JP"
      }
    });

    const japaneseGraph = japanese.result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const japaneseWebPage = japaneseGraph.find((node) => (Array.isArray(node["@type"]) ? node["@type"].includes("WebPage") : node["@type"] === "WebPage")) as Record<string, any>;
    const japaneseProduct = japaneseGraph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const japaneseHowTo = japaneseGraph.find((node) => node["@type"] === "HowTo") as Record<string, any>;
    const japaneseProperties = Object.fromEntries((japaneseProduct.additionalProperty as Array<Record<string, any>>).map((item) => [item.name, item.value]));

    expect(String(japaneseWebPage.description)).toContain("EXAMPLEDERMA バリアケア365 カプセルトナーの商品ページ");
    expect(String(japaneseWebPage.description)).not.toMatch(/確認できる|確認できます|見られます|主な成分・技術|成分\/技術|特許\s*出願[^。]*処方の/);
    expect(String(japaneseProduct.description)).toMatch(/(?:配合|採用|もとに)/);
    expect(String(japaneseProduct.description)).toMatch(/主なベネフィット|うるおい|バリアケア/);
    expect(String(japaneseProduct.description)).not.toMatch(/主な成分・技術|確認できる|特許\s*出願[^。]*処方の/);
    expect(JSON.stringify(japaneseHowTo?.step ?? [])).not.toMatch(/ハイドロクオールフローティングフォーミュラ|処方を使用/);
    expect(String(japaneseProperties.Usage)).not.toMatch(/ハイドロクオールフローティングフォーミュラ|処方を使用/);
  });
  it("scopes package brand RAG to the normalized product brand", async () => {
    const retrievalDocumentNames: string[][] = [];

    await generatePdpGeo(
      {
        product: {
          name: "BARRIERCARE 365 Cream",
          brand: "EXAMPLEDERMA",
          description: "Cream for dry and sensitive skin barrier care.",
          benefits: ["skin barrier support", "hydration"],
          ingredients: ["Ceramide"],
          usage: ["Apply after toner and serum."]
        },
        hints: {
          locale: "en-US",
          market: "US"
        },
        rag: {
          mode: "managed-vector-store-rag",
          provider: "custom",
          maxChunks: 8
        }
      },
      {
        customRetriever: {
          async retrieve(request) {
            retrievalDocumentNames.push(request.documents.map((document) => document.name));
            return [
              {
                id: "schema",
                source: pdpGeoGeneratorRagManifest.documents.schemaOrgProduct,
                title: "Schema",
                text: "Schema guidance.",
                kind: "schema",
                intents: ["schema"],
                fieldTargets: ["Product.description"],
                metadata: {},
                score: 0.9
              },
              {
                id: "geo",
                source: pdpGeoGeneratorRagManifest.documents.geoResearch,
                title: "GEO",
                text: "GEO guidance.",
                kind: "geo-research",
                intents: ["evidence"],
                fieldTargets: ["PDP.content"],
                metadata: {},
                score: 0.89
              },
              {
                id: "cep",
                source: pdpGeoGeneratorRagManifest.documents.cep,
                title: "CEP",
                text: "CEP guidance.",
                kind: "cep",
                intents: ["customer"],
                fieldTargets: ["FAQPage.mainEntity"],
                metadata: {},
                score: 0.88
              },
              {
                id: "eeat",
                source: pdpGeoGeneratorRagManifest.documents.eeat,
                title: "E-E-A-T",
                text: "Claim safety guidance.",
                kind: "eeat",
                intents: ["claims"],
                fieldTargets: ["Product.description"],
                metadata: {},
                score: 0.87
              },
              {
                id: "official",
                source: pdpGeoGeneratorRagManifest.documents.officialAiSearchPlatformDocs,
                title: "Official Docs",
                text: "Official docs guidance.",
                kind: "official-docs",
                intents: ["retrieval"],
                fieldTargets: ["diagnostics"],
                metadata: {},
                score: 0.86
              },
              {
                id: "best",
                source: pdpGeoGeneratorRagManifest.brandBestPractices.examplederma,
                title: "Best Practice",
                text: "EXAMPLEDERMA best practice guidance.",
                kind: "best-practice",
                intents: ["evidence"],
                fieldTargets: ["PDP.content"],
                metadata: {},
                score: 0.85
              },
              {
                id: "locale",
                source: pdpGeoGeneratorRagManifest.brandLocaleExpressionGuidelines.examplederma,
                title: "Locale",
                text: "EXAMPLEDERMA locale guidance.",
                kind: "locale",
                intents: ["locale"],
                fieldTargets: ["PDP.content"],
                metadata: {},
                score: 0.84
              },
              {
                id: "terminology",
                source: pdpGeoGeneratorRagManifest.brandLocaleTerminologyMaps.examplederma,
                title: "Terminology",
                text: "EXAMPLEDERMA terminology guidance.",
                kind: "terminology",
                intents: ["locale"],
                fieldTargets: ["PDP.content"],
                metadata: {},
                score: 0.83
              }
            ];
          }
        }
      }
    );

    const primaryRetrievalDocuments = retrievalDocumentNames.find((names) => names.length > 3) ?? [];
    expect(primaryRetrievalDocuments).toContain(pdpGeoGeneratorRagManifest.brandIdentities.examplederma);
    expect(primaryRetrievalDocuments).toContain(pdpGeoGeneratorRagManifest.brandBestPractices.examplederma);
    expect(primaryRetrievalDocuments).toContain(pdpGeoGeneratorRagManifest.brandLocaleExpressionGuidelines.examplederma);
    expect(primaryRetrievalDocuments).toContain(pdpGeoGeneratorRagManifest.brandLocaleTerminologyMaps.examplederma);
    expect(primaryRetrievalDocuments).toContain(pdpGeoGeneratorRagManifest.documents.bestPractice);
    expect(primaryRetrievalDocuments).toContain(pdpGeoGeneratorRagManifest.documents.localeExpressionGuidelines);
    expect(primaryRetrievalDocuments).toContain(pdpGeoGeneratorRagManifest.documents.localeTerminologyMap);
    expect(primaryRetrievalDocuments).not.toContain(pdpGeoGeneratorRagManifest.brandIdentities.exampleluxe);
    expect(primaryRetrievalDocuments).not.toContain(pdpGeoGeneratorRagManifest.brandBestPractices.exampleluxe);
    expect(primaryRetrievalDocuments).not.toContain(pdpGeoGeneratorRagManifest.brandLocaleExpressionGuidelines.exampleluxe);
    expect(primaryRetrievalDocuments).not.toContain(pdpGeoGeneratorRagManifest.brandLocaleTerminologyMaps.exampleluxe);
    expect(retrievalDocumentNames.some((names) =>
      names.length === 1 && names[0] === pdpGeoGeneratorRagManifest.brandIdentities.examplederma
    )).toBe(true);
  });
  it("excludes the analysis prompt from documents sent to retrieval while keeping it in the policy checklist", async () => {
    const retrievalDocumentNames: string[][] = [];

    const { result } = await generatePdpGeo(
      {
        product: {
          name: "Hydra Barrier Cream",
          description: "Daily hydration cream for moisture barrier care.",
          benefits: ["hydration"],
          usage: ["Apply after serum."]
        },
        hints: { locale: "ko-KR", market: "KR" },
        rag: { mode: "managed-vector-store-rag", provider: "custom", maxChunks: 8 }
      },
      {
        customRetriever: {
          async retrieve(request) {
            retrievalDocumentNames.push(request.documents.map((document) => document.name));
            return [];
          }
        }
      }
    );

    expect(retrievalDocumentNames.length).toBeGreaterThan(0);
    for (const names of retrievalDocumentNames) {
      expect(names).not.toContain(pdpGeoGeneratorRagManifest.analysisPrompt);
    }
    // The analysis prompt is a prompt contract, not retrievable knowledge: it must
    // still compile into the policy checklist even though retrieval never sees it.
    expect(result.diagnostics.policyCoverage?.totalRules ?? 0).toBeGreaterThan(0);
  });
  it("keeps the default best-practice corpus alongside brand overlays for brand-matched products", async () => {
    const retrievalDocumentNames: string[][] = [];

    await generatePdpGeo(
      {
        product: {
          name: "예시더마 배리어케어365 크림",
          brand: "EXAMPLEDERMA",
          category: "크림",
          description: "저자극 보습 크림",
          benefits: ["보습"],
          usage: ["세안 후 적당량을 바릅니다."]
        },
        hints: { locale: "ko-KR", market: "KR" },
        rag: {
          mode: "managed-vector-store-rag",
          provider: "custom",
          maxChunks: 8
        }
      },
      {
        customRetriever: {
          async retrieve(request) {
            retrievalDocumentNames.push(request.documents.map((document) => document.name));
            return [];
          }
        }
      }
    );

    const loadedDocuments = retrievalDocumentNames.find((names) => names.length > 3) ?? [];
    expect(loadedDocuments).toContain(pdpGeoGeneratorRagManifest.documents.bestPractice);
    expect(loadedDocuments).toContain(pdpGeoGeneratorRagManifest.brandBestPractices.examplederma);
    expect(loadedDocuments).toContain(pdpGeoGeneratorRagManifest.documents.localeExpressionGuidelines);
    expect(loadedDocuments).toContain(pdpGeoGeneratorRagManifest.documents.localeTerminologyMap);
    expect(loadedDocuments).not.toContain(pdpGeoGeneratorRagManifest.brandBestPractices.exampleluxe);
  });
  it("falls back to the default best-practice RAG when no brand best-practice matches", async () => {
    const retrievalDocumentNames: string[][] = [];

    await generatePdpGeo(
      {
        product: {
          name: "Hydra Barrier Cream",
          brand: "Agentic Beauty",
          description: "Cream for dry skin barrier care.",
          benefits: ["hydration"],
          ingredients: ["Ceramide"],
          usage: ["Apply after toner."]
        },
        hints: {
          locale: "en-US",
          market: "US"
        },
        rag: {
          mode: "managed-vector-store-rag",
          provider: "custom",
          maxChunks: 8
        }
      },
      {
        customRetriever: {
          async retrieve(request) {
            retrievalDocumentNames.push(request.documents.map((document) => document.name));
            return [
              {
                id: "schema",
                source: pdpGeoGeneratorRagManifest.documents.schemaOrgProduct,
                title: "Schema",
                text: "Schema guidance.",
                kind: "schema",
                intents: ["schema"],
                fieldTargets: ["Product.description"],
                metadata: {},
                score: 0.9
              },
              {
                id: "geo",
                source: pdpGeoGeneratorRagManifest.documents.geoResearch,
                title: "GEO",
                text: "GEO guidance.",
                kind: "geo-research",
                intents: ["evidence"],
                fieldTargets: ["PDP.content"],
                metadata: {},
                score: 0.89
              },
              {
                id: "cep",
                source: pdpGeoGeneratorRagManifest.documents.cep,
                title: "CEP",
                text: "CEP guidance.",
                kind: "cep",
                intents: ["customer"],
                fieldTargets: ["FAQPage.mainEntity"],
                metadata: {},
                score: 0.88
              },
              {
                id: "eeat",
                source: pdpGeoGeneratorRagManifest.documents.eeat,
                title: "E-E-A-T",
                text: "Claim safety guidance.",
                kind: "eeat",
                intents: ["claims"],
                fieldTargets: ["Product.description"],
                metadata: {},
                score: 0.87
              },
              {
                id: "official",
                source: pdpGeoGeneratorRagManifest.documents.officialAiSearchPlatformDocs,
                title: "Official Docs",
                text: "Official docs guidance.",
                kind: "official-docs",
                intents: ["retrieval"],
                fieldTargets: ["diagnostics"],
                metadata: {},
                score: 0.86
              },
              {
                id: "best",
                source: pdpGeoGeneratorRagManifest.documents.bestPractice,
                title: "Best Practice",
                text: "Default best practice guidance.",
                kind: "best-practice",
                intents: ["evidence"],
                fieldTargets: ["PDP.content"],
                metadata: {},
                score: 0.85
              },
              {
                id: "locale",
                source: pdpGeoGeneratorRagManifest.documents.localeExpressionGuidelines,
                title: "Locale",
                text: "Locale guidance.",
                kind: "locale",
                intents: ["locale"],
                fieldTargets: ["PDP.content"],
                metadata: {},
                score: 0.84
              },
              {
                id: "terminology",
                source: pdpGeoGeneratorRagManifest.documents.localeTerminologyMap,
                title: "Terminology",
                text: "Terminology guidance.",
                kind: "terminology",
                intents: ["locale"],
                fieldTargets: ["PDP.content"],
                metadata: {},
                score: 0.83
              }
            ];
          }
        }
      }
    );

    const primaryRetrievalDocuments = retrievalDocumentNames.find((names) => names.length > 3) ?? [];
    expect(primaryRetrievalDocuments).toContain(pdpGeoGeneratorRagManifest.documents.bestPractice);
    expect(primaryRetrievalDocuments).toContain(pdpGeoGeneratorRagManifest.documents.localeExpressionGuidelines);
    expect(primaryRetrievalDocuments).toContain(pdpGeoGeneratorRagManifest.documents.localeTerminologyMap);
    expect(primaryRetrievalDocuments).not.toContain(pdpGeoGeneratorRagManifest.brandIdentities.exampleluxe);
    expect(primaryRetrievalDocuments).not.toContain(pdpGeoGeneratorRagManifest.brandIdentities.examplederma);
    expect(primaryRetrievalDocuments).not.toContain(pdpGeoGeneratorRagManifest.brandBestPractices.exampleluxe);
    expect(primaryRetrievalDocuments).not.toContain(pdpGeoGeneratorRagManifest.brandBestPractices.examplederma);
    expect(primaryRetrievalDocuments).not.toContain(pdpGeoGeneratorRagManifest.brandLocaleExpressionGuidelines.exampleluxe);
    expect(primaryRetrievalDocuments).not.toContain(pdpGeoGeneratorRagManifest.brandLocaleExpressionGuidelines.examplederma);
    expect(primaryRetrievalDocuments).not.toContain(pdpGeoGeneratorRagManifest.brandLocaleTerminologyMaps.exampleluxe);
    expect(primaryRetrievalDocuments).not.toContain(pdpGeoGeneratorRagManifest.brandLocaleTerminologyMaps.examplederma);
  });
  it("keeps the canonical field contracts in the final inference context when maxChunks is constrained", async () => {
    const cases = [
      {
        product: {
          name: "BARRIERCARE 365 Cream",
          brand: "EXAMPLEDERMA",
          description: "Cream for dry and sensitive skin barrier care.",
          benefits: ["skin barrier support", "hydration"],
          ingredients: ["Ceramide"],
          usage: ["Apply after toner and serum."]
        },
        expectedBrandIdentitySource: pdpGeoGeneratorRagManifest.brandIdentities.examplederma,
        unexpectedBestPracticeSource: pdpGeoGeneratorRagManifest.documents.bestPractice
      },
      {
        product: {
          name: "Hydra Barrier Cream",
          brand: "Agentic Beauty",
          description: "Cream for dry skin barrier care.",
          benefits: ["hydration"],
          ingredients: ["Ceramide"],
          usage: ["Apply after toner."]
        },
        expectedBrandIdentitySource: undefined,
        unexpectedBestPracticeSource: pdpGeoGeneratorRagManifest.brandBestPractices.examplederma
      }
    ];

    for (const testCase of cases) {
      const { result } = await generatePdpGeo(
        {
          product: testCase.product,
          hints: {
            locale: "en-US",
            market: "US"
          },
          rag: {
            mode: "managed-vector-store-rag",
            provider: "custom",
            maxChunks: 1
          }
        },
        {
          customRetriever: {
            async retrieve(request) {
              if (request.documents.length === 1) {
                const source = request.documents[0]?.name ?? "unknown";
                return [{
                  id: `coverage-${source}`,
                  source,
                  title: "Coverage fallback",
                  text: `Coverage guidance from ${source}.`,
                  kind: "custom",
                  intents: ["general"],
                  fieldTargets: ["diagnostics"],
                  metadata: {},
                  score: 0.1
                }];
              }

              return [
                {
                  id: "schema-primary",
                  source: pdpGeoGeneratorRagManifest.documents.schemaOrgProduct,
                  title: "Schema",
                  text: "High scoring schema guidance.",
                  kind: "schema",
                  intents: ["schema"],
                  fieldTargets: ["Product.description"],
                  metadata: {},
                  score: 0.99
                },
                {
                  id: "official-primary",
                  source: pdpGeoGeneratorRagManifest.documents.officialAiSearchPlatformDocs,
                  title: "Official Docs",
                  text: "High scoring official docs guidance.",
                  kind: "official-docs",
                  intents: ["retrieval"],
                  fieldTargets: ["diagnostics"],
                  metadata: {},
                  score: 0.98
                }
              ];
            }
          }
        }
      );

      const selectedSources = result.diagnostics.selectedRagChunks.map((chunk) => chunk.source);
      // maxChunks is 1 here, so this pins the top of coverageRagKindOrder: the
      // single slot goes to the canonical field contracts, the document every
      // other corpus document defers to, and the high-scoring schema/official
      // -docs chunks the stub returns still lose it. That geo-research, CEP and
      // E-E-A-T all survive at a realistic budget is covered by the eight-chunk
      // single-query test below.
      expect(result.diagnostics.selectedRagChunks.some((chunk) => chunk.kind === "field-contracts")).toBe(true);
      expect(selectedSources).not.toContain(pdpGeoGeneratorRagManifest.documents.schemaOrgProduct);
      expect(selectedSources).not.toContain(testCase.unexpectedBestPracticeSource);
      if (testCase.expectedBrandIdentitySource) {
        expect(selectedSources).toContain(testCase.expectedBrandIdentitySource);
        expect(result.diagnostics.selectedRagChunks.find((chunk) => chunk.source === testCase.expectedBrandIdentitySource)?.metadata.queryPlanTarget)
          .toBe("brandIdentityCoverage");
      } else {
        expect(selectedSources.some((source) => source.startsWith("brands/"))).toBe(false);
      }
      expect(result.diagnostics.reasoning?.selectedSources ?? [])
        .toEqual(expect.arrayContaining([expect.stringContaining(pdpGeoGeneratorRagManifest.documents.contentFieldContracts)]));
    }
  });
  it("applies Japanese locale terminology and avoids unsupported wording", async () => {
    const { result } = await generatePdpGeo({
      product: {
        productName: "Barrier Moist Cream",
        description: "A rich cream for hydration and skin barrier support.",
        benefits: ["hydration", "skin barrier support"],
        ingredients: ["Ceramide", "Hyaluronic Acid"],
        howToUse: "夜のスキンケアの最後に使用します。",
        reviews: {
          keywords: ["肌なじみ", "うるおい"]
        }
      },
      hints: {
        locale: "ja-JP",
        market: "JP",
        category: "クリーム"
      }
    });

    expect(result.locale).toBe("ja-JP");
    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const webPage = graph.find((node) => (Array.isArray(node["@type"]) ? node["@type"].includes("WebPage") : node["@type"] === "WebPage")) as Record<string, any>;
    expect(result.content.sections.productName).toContain("Barrier Moist Cream");
    expect(result.content.sections.description).toMatch(/うるおい|保湿|バリア/);
    expect(String(webPage.description)).not.toBe(String(product.description));
    expect(String(webPage.description)).toContain("商品ページ");
    expect(String(webPage.description)).toMatch(/ベネフィット|成分\/技術|使い方/);
    expect(String(webPage.description)).not.toMatch(/確認根拠|整理します|示します|確認できる結果|商品詳細の根拠/);
    expect(result.diagnostics.terminology.locale).toBe("ja-JP");
    expect(result.diagnostics.terminology.appliedTerms.length).toBeGreaterThan(0);
    expect(result.schemaMarkup.scriptTag).toContain("application/ld+json");
  });
  it("merges brand and default terminology maps with brand precedence", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "예시더마 배리어케어365 크림",
          brand: "EXAMPLEDERMA",
          category: "크림",
          description: "수분 보습과 피부 장벽 케어",
          benefits: ["보습", "장벽"],
          usage: ["세안 후 사용합니다."]
        }
      },
      hints: {
        locale: "ko-KR",
        market: "KR"
      }
    });

    // 공통 맵의 hydration(보습) 개념은 브랜드 상품에서도 감지되어야 한다(브랜드 맵이 공통 맵을 대체하지 않고 병합되어야 함).
    const appliedConcepts = result.diagnostics.terminology.appliedTerms.map((term) => term.concept);
    expect(appliedConcepts).toEqual(expect.arrayContaining(["hydration"]));
  });
  it("selects package GEO, CEP, and E-E-A-T RAG chunks during generation", async () => {
    let capturedBody: Record<string, any> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, any>;
      capturedBody ??= requestBody;
      const planningInput = JSON.parse(String(requestBody.input ?? "{}")) as Record<string, any>;
      const ledger = planningInput.evidenceLedger as Array<Record<string, string>>;
      const identityId = ledger.find((item) => item.role === "identity")?.id ?? ledger[0]?.id;
      const descriptionId = ledger.find((item) => item.role === "description")?.id ?? identityId;
      const benefitId = ledger.find((item) => item.role === "benefit")?.id ?? descriptionId;
      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          locale: "en-US",
          productDescription: {
            include: true,
            text: "Hydra Barrier Serum is a lightweight serum for dry-feeling skin and barrier support.",
            intent: "product-entity-summary",
            evidenceIds: [identityId, descriptionId, benefitId],
            confidence: 0.95,
            omitReason: ""
          },
          webPageDescription: {
            include: true,
            text: "This page explains the supported hydration and barrier-care facts for Hydra Barrier Serum.",
            intent: "page-coverage-summary",
            evidenceIds: [identityId, benefitId],
            confidence: 0.91,
            omitReason: ""
          },
          faq: [],
          howTo: { eligible: false, ordered: false, goal: "", steps: [], evidenceIds: [], confidence: 0.9, omitReason: "Only one usage note is available." },
          cep: [],
          warnings: []
        }),
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15
        }
      }), { status: 200 });
    }));

    try {
      const { result } = await generatePdpGeo({
        source: {
          type: "manual-json",
          url: "https://example.com/hydra-barrier-serum"
        },
        hints: {
          locale: "en-US",
          market: "US",
          updateTargets: ["faq", "howToUse"]
        },
        product: {
          name: "Hydra Barrier Serum",
          brand: "Example Beauty",
          category: "Skincare Serum",
          description: "A lightweight serum for dry-feeling skin and barrier support.",
          benefits: ["hydration", "skin barrier support"],
          ingredients: ["Niacinamide", "Ceramide"],
          usage: ["Apply morning and night after toner."],
          reviews: {
            keywords: ["lightweight", "absorbs quickly", "comfortable for dry-feeling skin"],
            items: [{ body: "It absorbs quickly and feels lightweight after toner.", rating: 5 }]
          }
        },
        rag: {
          maxChunks: 12,
          scoreThreshold: 0,
          queryPlanning: {
            enabled: true,
            updateTargets: ["faq", "howToUse"]
          }
        }
      }, {
        provider: "openai",
        apiKey: "test-key",
        model: "test-model"
      });

      const selectedKinds = result.diagnostics.selectedRagChunks.map((chunk) => chunk.kind);
      const payload = JSON.parse(String(capturedBody?.input ?? "{}")) as Record<string, any>;
      const strategicKinds = payload.taskGuidance.map((item: Record<string, unknown>) => item.kind);
      const hydratedKinds = result.diagnostics.hydratedRagDocuments?.map((document) => document.kind);

      expect(result.diagnostics.ragQueryPlan?.mode).toBe("agentic-subquery-planning");
      expect(result.diagnostics.ragQueryPlan?.queries.map((query) => query.target)).toEqual(expect.arrayContaining(["faq", "howToUse"]));
      expect(selectedKinds).toEqual(expect.arrayContaining(["geo-research", "cep", "eeat"]));
      expect(strategicKinds).toEqual(expect.arrayContaining(["geo-research", "cep", "eeat"]));
      expect(hydratedKinds).toEqual(expect.arrayContaining(["geo-research", "cep", "eeat"]));
      expect(payload.strategicFullDocuments).toBeUndefined();
      expect(payload.evidenceLedger.length).toBeGreaterThan(5);
      expect(capturedBody?.text?.format?.type).toBe("json_schema");
      // Prompt-size budget. Raised from 50K to 55K when the geo-research/schema
      // knowledge docs moved to v2 (richer paper coverage) and the CEP/E-E-A-T
      // description-arc guidance was added to the planner system prompt.
      expect(JSON.stringify(capturedBody).length).toBeLessThan(55_000);
      expect(result.diagnostics.evidence.some((item) => item.field === "content.plan")).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("keeps GEO, CEP, and E-E-A-T coverage under explicit single-query retrieval with eight final chunks", async () => {
    const { result } = await generatePdpGeo({
      source: {
        type: "manual-json",
        url: "https://example.com/products/gentle-cleansing-foam"
      },
      hints: {
        locale: "en-US",
        market: "US"
      },
      product: {
        name: "Gentle Cleansing Foam",
        brand: "ExampleLuxe",
        category: "Cleansing Foam",
        description: "A soft lathering cleanser for clean, hydrated-feeling skin.",
        benefits: ["hydration", "removes impurities"],
        ingredients: ["Hydro-cleansing formula"],
        usage: ["Lather with water, massage onto damp skin, and rinse with lukewarm water."],
        reviews: {
          keywords: [],
          items: []
        }
      },
      rag: {
        maxChunks: 8,
        scoreThreshold: 0,
        queryPlanning: {
          enabled: false
        }
      }
    });

    const selectedKinds = result.diagnostics.selectedRagChunks.map((chunk) => chunk.kind);
    const selectedSources = result.diagnostics.selectedRagChunks.map((chunk) => chunk.source);
    const hydratedKinds = result.diagnostics.hydratedRagDocuments?.map((document) => document.kind);
    const reasoningSources = result.diagnostics.reasoning?.decisions.flatMap((decision) => decision.ragSources) ?? [];

    expect(result.diagnostics.ragQueryPlan?.mode).toBe("single-query");
    expect(selectedKinds).toEqual(expect.arrayContaining(["geo-research", "cep", "eeat"]));
    // Brand documents are now overlays coexisting with the default corpus
    // (see scopeBrandRagDocuments), so they compete with the default
    // best-practice/locale/terminology documents for the 8 final chunk
    // slots. Brand identity and the matched brand's best-practice overlay
    // each hold a protected slot and always survive; the default
    // best-practice document still wins the shared "best-practice"
    // coverage slot. The locale overlays carry no protected slot, so they
    // lose to their default counterparts under this constrained budget.
    expect(selectedSources).toEqual(expect.arrayContaining([
      pdpGeoGeneratorRagManifest.documents.bestPractice,
      pdpGeoGeneratorRagManifest.brandIdentities.exampleluxe,
      pdpGeoGeneratorRagManifest.brandBestPractices.exampleluxe
    ]));
    expect(selectedSources).not.toContain(pdpGeoGeneratorRagManifest.brandIdentities.examplederma);
    expect(hydratedKinds).toEqual(expect.arrayContaining(["geo-research", "cep", "eeat"]));
    // best-practice_v1 is in the final context (asserted above) but not in the
    // routed reasoning sources: under the general query its winning section is
    // "RAG Corpus Orchestration", a routing map that names every document and
    // topic, so it outranks the field sections on a query that names contracts
    // and fields. That section carries retrieval/general intents, which no
    // reasoning principle routes. Per-target subqueries pull the field sections
    // instead, so this only shows up on the single-query opt-out.
    expect(reasoningSources).toEqual(expect.arrayContaining([
      expect.stringContaining("geo-research"),
      expect.stringContaining("cep"),
      expect.stringContaining("eeat"),
      expect.stringContaining(pdpGeoGeneratorRagManifest.documents.contentFieldContracts),
      expect.stringContaining(pdpGeoGeneratorRagManifest.brandIdentities.exampleluxe)
    ]));
    expect(result.diagnostics.runtimeUsage?.steps.find((step) => step.stage === "reranking")?.details)
      .toContain("contextual hybrid reranking");
  });
  it("keeps the matched brand best-practice overlay in the final context under a tight chunk budget", async () => {
    const { result } = await generatePdpGeo({
      source: {
        type: "manual-json",
        url: "https://example.com/products/gentle-cleansing-foam"
      },
      hints: {
        locale: "en-US",
        market: "US"
      },
      product: {
        name: "Gentle Cleansing Foam",
        brand: "ExampleLuxe",
        category: "Cleansing Foam",
        description: "A soft lathering cleanser for clean, hydrated-feeling skin.",
        benefits: ["hydration", "removes impurities"],
        ingredients: ["Hydro-cleansing formula"],
        usage: ["Lather with water, massage onto damp skin, and rinse with lukewarm water."],
        reviews: {
          keywords: [],
          items: []
        }
      },
      rag: {
        maxChunks: 8,
        scoreThreshold: 0,
        queryPlanning: {
          enabled: false
        }
      }
    });

    const selectedSources = result.diagnostics.selectedRagChunks.map((chunk) => chunk.source);
    const reasoningSources = result.diagnostics.reasoning?.decisions.flatMap((decision) => decision.ragSources) ?? [];

    // The brand best-practice overlay carries only brand-unique deltas, so it
    // ties with the default best-practice document on score and would lose the
    // single shared "best-practice" coverage slot to it (stable sort favours the
    // earlier-loaded default). A protected coverage slot keeps the matched
    // brand's overlay in the final context for brand-matched products.
    expect(selectedSources).toContain(pdpGeoGeneratorRagManifest.brandBestPractices.exampleluxe);
    expect(selectedSources).toContain(pdpGeoGeneratorRagManifest.documents.bestPractice);
    expect(selectedSources).not.toContain(pdpGeoGeneratorRagManifest.brandBestPractices.examplederma);
    // Brand best-practice chunks are policy evidence (kind "best-practice"), not
    // brand-identity context, so they must reach principle reasoning normally.
    expect(reasoningSources).toEqual(expect.arrayContaining([
      expect.stringContaining(pdpGeoGeneratorRagManifest.brandBestPractices.exampleluxe)
    ]));
  });
  it("does not grant protected coverage slots to documents a managed vector store returns off-request", async () => {
    // Managed vector-store retrieval searches the whole store and ignores the
    // single-document coverage request, so it can answer with anything --
    // including another brand's overlay. Neither may be floored into a
    // protected slot.
    const offRequestSources = [
      "unrelated-marketing-deck_v1.md",
      pdpGeoGeneratorRagManifest.brandBestPractices.examplederma,
      pdpGeoGeneratorRagManifest.brandIdentities.examplederma
    ];

    const { result } = await generatePdpGeo(
      {
        product: {
          name: "Botanical Renewal Serum",
          brand: "ExampleLuxe",
          category: "Serum",
          description: "A ginseng serum for fine lines and firmness.",
          benefits: ["fine lines", "firmness"],
          ingredients: ["Botanical Actives"],
          usage: ["Apply after toner."]
        },
        hints: {
          locale: "en-US",
          market: "US"
        },
        rag: {
          mode: "managed-vector-store-rag",
          provider: "custom",
          maxChunks: 4
        }
      },
      {
        customRetriever: {
          async retrieve(request) {
            // Deliberately non-cooperative: ignore request.documents entirely,
            // exactly as OpenAiVectorStoreRetriever does.
            if (request.documents.length === 1) {
              return offRequestSources.map((source, index) => ({
                id: `off-request-${index + 1}`,
                source,
                title: "Off-request chunk",
                text: `Guidance the store returned instead of ${request.documents[0]?.name ?? "unknown"}.`,
                kind: "custom" as const,
                intents: ["general"],
                fieldTargets: ["diagnostics"],
                metadata: {},
                score: 0.1
              }));
            }

            return [{
              id: "geo-primary",
              source: pdpGeoGeneratorRagManifest.documents.geoResearch,
              title: "GEO",
              text: "High scoring GEO research guidance.",
              kind: "geo-research" as const,
              intents: ["retrieval"],
              fieldTargets: ["Product.description"],
              metadata: {},
              score: 0.99
            }];
          }
        }
      }
    );

    // Neither coverage retrieval could resolve a chunk from the document it
    // asked for, so no chunk may carry a brand coverage tag, be score-floored
    // to 0.93, or hold a protected slot.
    const brandCoverageTargets = ["brandIdentityCoverage", "brandBestPracticeCoverage"];
    const brandCoverageChunks = result.diagnostics.selectedRagChunks
      .filter((chunk) => brandCoverageTargets.includes(String(chunk.metadata.queryPlanTarget)));
    expect(brandCoverageChunks).toEqual([]);

    for (const source of offRequestSources) {
      const chunk = result.diagnostics.selectedRagChunks.find((candidate) => candidate.source === source);
      expect(chunk?.metadata.queryPlanTarget).not.toBe("brandIdentityCoverage");
      expect(chunk?.metadata.queryPlanTarget).not.toBe("brandBestPracticeCoverage");
      expect(chunk?.score ?? 0).toBeLessThan(0.93);
    }

    // Protected slots expand the budget past maxChunks; none was granted here.
    expect(result.diagnostics.selectedRagChunks.length).toBeLessThanOrEqual(4);
  });
});
