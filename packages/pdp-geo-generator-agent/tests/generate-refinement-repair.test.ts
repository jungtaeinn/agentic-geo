import { describe, expect, it, vi } from "vitest";
import { ModelBackedCopyRefiner, generatePdpGeo } from "../src";
import { validateAndRepairPdpGeoArtifacts } from "../src/validate";

/**
 * 모델 개입 이후 — 정규화·키워드·카피 리파인 호출과 그 결과에 대한 결정적 리페어.
 *
 * generate-pdp-geo.test.ts에서 주제별로 분리했다(어서션은 그대로).
 */

describe("generatePdpGeo", () => {
  it("uses an optional product normalization agent before keyword normalization", async () => {
    const { result } = await generatePdpGeo(
      {
        product: {
          upstreamPayload: {
            displayLabel: "Agentic Repair Serum",
            storyLine: "Agentic Repair Serum supports barrier support with Beta Glucan.",
            activeBlob: "Beta Glucan",
            benefitCopy: "barrier support",
            ritualCopy: "Apply after toner."
          }
        },
        source: {
          type: "rest-api",
          url: "https://example.com/products/agentic-repair-serum"
        },
        hints: {
          locale: "en-US",
          market: "US"
        }
      },
      {
        customProductNormalizer: {
          async normalizeProduct(request) {
            expect(request.bootstrapProduct.name).toBe("Untitled product");
            expect(request.analysisPrompt).toContain("typed RAG index");
            expect(request.ragDocuments.some((document) => document.name === "schema-org-product_v2.md")).toBe(true);
            return {
              product: {
                name: "Agentic Repair Serum",
                description: "Agentic Repair Serum supports barrier support with Beta Glucan.",
                ingredients: ["Beta Glucan"],
                benefits: ["barrier support"],
                usage: ["Apply after toner."],
                sourceTexts: [
                  "Agentic Repair Serum supports barrier support with Beta Glucan.",
                  "Apply after toner."
                ]
              },
              usage: {
                inputTokens: 30,
                outputTokens: 20,
                totalTokens: 50
              }
            };
          }
        }
      }
    );

    const finalStep = result.diagnostics.runtimeUsage?.steps.find((step) => step.stage === "final");

    expect(result.content.sections.productName).toBe("Agentic Repair Serum");
    expect(result.diagnostics.normalizedProduct.name).toBe("Agentic Repair Serum");
    expect(result.diagnostics.normalizedProduct.ingredients).toContain("Beta Glucan");
    expect(result.diagnostics.normalizedProduct.benefits).toContain("barrier support");
    expect(result.diagnostics.evidence.some((item) => item.field === "product.normalization" && item.source === "llm")).toBe(true);
    expect(finalStep?.called).toBe(true);
    expect(finalStep?.tokenUsage?.totalTokens).toBe(50);
    expect(finalStep?.details).toContain("product signal normalization");
    expect(result.diagnostics.runtimeUsage?.tokenTotals.totalTokens).toBe(50);
  });
  it("uses an optional keyword normalizer before filtering misspelled review keyword candidates", async () => {
    const { result } = await generatePdpGeo(
      {
        product: {
          geoProduct: {
            name: "Hydra Texture Cream",
            description: "수분 장벽과 피부결 케어를 위한 크림입니다.",
            category: "크림",
            benefits: ["수분감", "피부결"],
            ingredients: ["히알루론산"],
            reviews: {
              keywords: ["피부걸", "흡수감"],
              items: [
                { body: "바르고 나면 피부결이 매끄럽고 흡수감이 좋아요.", rating: 5 }
              ]
            }
          }
        },
        hints: {
          locale: "ko-KR",
          market: "KR"
        }
      },
      {
        customKeywordNormalizer: {
          async normalizeKeywords(request) {
            expect(request.reviewKeywords).toContain("피부걸");
            return {
              corrections: [
                {
                  original: "피부걸",
                  normalized: "피부결",
                  confidence: 0.94,
                  reason: "single Hangul typo"
                }
              ]
            };
          }
        }
      }
    );

    expect(result.diagnostics.normalizedProduct.reviews.keywords).toContain("피부결");
    expect(result.diagnostics.normalizedProduct.reviews.keywords).not.toContain("피부걸");
    expect(result.diagnostics.evidence.some((item) => item.source === "llm" && item.value.includes("피부걸 -> 피부결"))).toBe(true);
    expect(result.content.sections.description).toContain("피부결");
  });
  it("uses an optional Gen AI copy refiner after deterministic schema generation", async () => {
    const refinedProductDescription = "Hydra Balance Essence is an essence for dry skin. The formula includes Hyaluronic Acid. Its documented benefits are hydration and barrier support. After use, it reports 105% hydration improvement.";
    const refinedWebPageDescription = "This Hydra Balance Essence product page covers the essence's ingredients, documented benefits, directions, and reported results.";
    const refinedIngredientEffectDetail = "Hyaluronic Acid is a listed formula ingredient. Hydration and barrier support are documented finished-product benefits.";
    const refinedReportedDetails = "After use, Hydra Balance Essence shows 105% hydration improvement without adding unsupported study details.";
    const refinedFaqAnswer = "Hydra Balance Essence is positioned for dry-skin customers comparing hydration and barrier support. Hyaluronic Acid explains the ingredient focus, while the reported 105% hydration improvement gives the answer a concrete evidence point.";

    const { result } = await generatePdpGeo(
      {
        product: {
          geoProduct: {
            name: "Hydra Balance Essence",
            description: "A hydrating essence for dry skin.",
            category: "Essence",
            benefits: ["hydration", "barrier support"],
            effects: ["After use, 105% hydration improvement."],
            ingredients: ["Hyaluronic Acid"],
            usage: ["Apply morning and night after cleansing."],
            metrics: ["105% hydration improvement"]
          }
        },
        hints: {
          locale: "en-US",
          market: "US"
        }
      },
      {
        customCopyRefiner: {
          async refineCopy(request) {
            expect(request.schemaMarkup.jsonLd["@graph"]).toBeTruthy();
            expect(request.content.sections.description).toContain("Hydra Balance Essence");
            return {
              schemaDescriptions: {
                product: refinedProductDescription,
                webPage: refinedWebPageDescription
              },
              schemaProperties: {
                "Ingredient/effect detail": refinedIngredientEffectDetail,
                "Reported details": refinedReportedDetails
              },
              faqAnswers: [
                {
                  answer: refinedFaqAnswer
                }
              ],
              contentSections: {
                description: refinedProductDescription,
                quickFacts: `Key ingredients include Hyaluronic Acid.\n${refinedReportedDetails}`
              },
              usage: {
                inputTokens: 120,
                outputTokens: 80,
                totalTokens: 200
              }
            };
          }
        }
      }
    );

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const webPage = graph.find((node) => (Array.isArray(node["@type"]) ? node["@type"].includes("WebPage") : node["@type"] === "WebPage")) as Record<string, any>;
    const faqPage = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
    const additionalProperties = product.additionalProperty as Array<Record<string, any>>;
    const finalStep = result.diagnostics.runtimeUsage?.steps.find((step) => step.stage === "final");

    expect(product.description).toBe(refinedProductDescription);
    expect(webPage.description).toBe(refinedWebPageDescription);
    expect(additionalProperties.find((item) => item.name === "Ingredient/effect detail")?.value).toBe(refinedIngredientEffectDetail);
    expect(additionalProperties.find((item) => item.name === "Reported details")?.value).toBe(refinedReportedDetails);
    expect(faqPage.mainEntity[0].acceptedAnswer.text).toBe(refinedFaqAnswer);
    expect(result.content.sections.description).toBe(refinedProductDescription);
    expect(result.content.sections.quickFacts).toContain(refinedReportedDetails);
    expect(result.content.sections.faq).toContain(refinedFaqAnswer);
    expect(result.content.html).toBe("");
    expect(result.diagnostics.evidence.some((item) => item.field === "copy.refinement" && item.source === "llm")).toBe(true);
    expect(result.diagnostics.evidence.some((item) => item.field === "schema.Product.additionalProperty.Reported details" && item.source === "llm")).toBe(true);
    expect(finalStep?.called).toBe(true);
    expect(finalStep?.tokenUsage?.totalTokens).toBe(200);
    expect(result.diagnostics.runtimeUsage?.tokenTotals.totalTokens).toBe(200);
  });
  it("keeps Product.description product-centric and rejects duplicated WebPage refinements", async () => {
    const invalidProductPageDescription = "This Hydra Balance Essence product page summarizes hydration, barrier support, Hyaluronic Acid, and morning-and-night routine context for dry skin customers.";
    const productEntityDescription = "Hydra Balance Essence is an essence for dry skin. The formula includes Hyaluronic Acid. Its documented benefits are hydration and barrier support.";
    const duplicateWebPageDescription = `This Hydra Balance Essence product page introduces ${productEntityDescription}`;

    const { result } = await generatePdpGeo(
      {
        product: {
          geoProduct: {
            name: "Hydra Balance Essence",
            description: "A hydrating essence for dry skin.",
            category: "Essence",
            benefits: ["hydration", "barrier support"],
            ingredients: ["Hyaluronic Acid"],
            usage: ["Apply morning and night after cleansing."]
          }
        },
        hints: {
          locale: "en-US",
          market: "US"
        }
      },
      {
        customCopyRefiner: {
          async refineCopy() {
            return {
              schemaDescriptions: {
                product: invalidProductPageDescription,
                webPage: duplicateWebPageDescription
              },
              contentSections: {
                description: productEntityDescription
              }
            };
          }
        }
      }
    );

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const webPage = graph.find((node) => (Array.isArray(node["@type"]) ? node["@type"].includes("WebPage") : node["@type"] === "WebPage")) as Record<string, any>;

    expect(product.description).toBe(productEntityDescription);
    expect(product.description).not.toBe(invalidProductPageDescription);
    expect(String(product.description)).not.toMatch(/product\s+page|PDP|page\s+(?:covers|introduces|summarizes)/i);
    expect(webPage.description).not.toBe(duplicateWebPageDescription);
    expect(String(webPage.description)).toMatch(/product page|product-detail page|PDP/i);
    expect(result.content.sections.description).toBe(productEntityDescription);
    expect(result.diagnostics.evidence.some((item) =>
      item.field === "copy.refinement.warning"
      && item.value.includes("Product.description refinement rejected because Product descriptions must describe the product entity")
    )).toBe(true);
    expect(result.diagnostics.evidence.some((item) =>
      item.field === "copy.refinement.warning"
      && item.value.includes("WebPage.description refinement rejected because it is a detailed Product.description clone")
    )).toBe(true);
  });
  it("rejects stock WebPage helper phrasing returned by copy refinement", async () => {
    const stockWebPageDescription = "The page helps answer customer questions about hydration, barrier support, hyaluronic acid, and morning-and-night routine use.";

    const { result } = await generatePdpGeo(
      {
        product: {
          geoProduct: {
            name: "Hydra Balance Essence",
            description: "A hydrating essence for dry skin.",
            category: "Essence",
            benefits: ["hydration", "barrier support"],
            ingredients: ["Hyaluronic Acid"],
            usage: ["Apply morning and night after cleansing."]
          }
        },
        hints: {
          locale: "en-US",
          market: "US"
        }
      },
      {
        customCopyRefiner: {
          async refineCopy() {
            return {
              schemaDescriptions: {
                webPage: stockWebPageDescription
              }
            };
          }
        }
      }
    );

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const webPage = graph.find((node) => (Array.isArray(node["@type"]) ? node["@type"].includes("WebPage") : node["@type"] === "WebPage")) as Record<string, any>;

    expect(webPage.description).not.toBe(stockWebPageDescription);
    expect(webPage.description).not.toMatch(/The page helps answer|helps answer/i);
    expect(result.diagnostics.evidence.some((item) =>
      item.field === "copy.refinement.warning"
      && item.value.includes("WebPage.description refinement rejected")
    )).toBe(true);
  });
  it("rejects English WebPage description refinements that route readers to FAQ or HowTo instead of product facts", async () => {
    const routedWebPageDescription = "This Hydra Balance Essence product page introduces a hydrating essence for dry skin with Hyaluronic Acid and barrier support. Usage guidance and FAQ are provided so shoppers can check how to apply it morning and night, ingredient details, and purchase information.";

    const { result } = await generatePdpGeo(
      {
        product: {
          geoProduct: {
            name: "Hydra Balance Essence",
            description: "A hydrating essence for dry skin with Hyaluronic Acid and barrier support.",
            category: "Essence",
            benefits: ["hydration", "barrier support"],
            ingredients: ["Hyaluronic Acid"],
            usage: ["Apply morning and night after cleansing."]
          }
        },
        hints: {
          locale: "en-US",
          market: "US"
        }
      },
      {
        customCopyRefiner: {
          async refineCopy() {
            return {
              schemaDescriptions: {
                webPage: routedWebPageDescription
              }
            };
          }
        }
      }
    );

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const webPage = graph.find((node) => (Array.isArray(node["@type"]) ? node["@type"].includes("WebPage") : node["@type"] === "WebPage")) as Record<string, any>;

    expect(webPage.description).not.toBe(routedWebPageDescription);
    expect(webPage.description).not.toMatch(/Usage guidance and FAQ are provided|can check how to apply/i);
    expect(result.diagnostics.evidence.some((item) =>
      item.field === "copy.refinement.warning"
      && /WebPage\.description refinement rejected/.test(item.value)
      && /FAQ|HowTo|usage/i.test(item.value)
    )).toBe(true);
  });
  it("rejects brand-identity research or patent signals as Product.additionalProperty evidence when product evidence does not support them", async () => {
    const brandIdentityScience = "EXAMPLEDERMA Derma Lab research papers and patents support this cream's barrier technology.";

    const { result } = await generatePdpGeo(
      {
        product: {
          geoProduct: {
            name: "EXAMPLEDERMA Barrier Cream",
            brand: "EXAMPLEDERMA",
            description: "A barrier cream for dry and sensitive skin.",
            category: "Cream",
            benefits: ["barrier support", "hydration"],
            ingredients: ["Ceramide"],
            sourceTexts: ["Ceramide formula technology supports hydration and skin barrier care."]
          }
        },
        hints: {
          locale: "en-US",
          market: "US"
        }
      },
      {
        customCopyRefiner: {
          async refineCopy() {
            return {
              schemaProperties: {
                "Brand science": brandIdentityScience
              }
            };
          }
        }
      }
    );

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const properties = product.additionalProperty as Array<Record<string, any>>;

    expect(properties.find((item) => item.name === "Brand science")?.value).not.toBe(brandIdentityScience);
    expect(JSON.stringify(properties)).not.toContain("Derma Lab research papers and patents");
    expect(result.diagnostics.evidence.some((item) =>
      item.field === "copy.refinement.warning"
      && item.value.includes("brand identity papers, patents, or research-center signals cannot be used as product evidence")
    )).toBe(true);
  });
  it("sends GEO, CEP, and E-E-A-T strategic guidance to model-backed copy refinement", async () => {
    let capturedBody: Record<string, any> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, any>;
      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          schemaDescriptions: {
            product: "Hydra Balance Essence is an essence for dry skin that highlights hydration, barrier support, hyaluronic acid, and morning-and-night use.",
            webPage: "This Hydra Balance Essence page summarizes hydration, barrier support, hyaluronic acid, and morning-and-night use for comparison-ready product understanding."
          },
          schemaProperties: {
            "Ingredient/effect detail": "Hyaluronic Acid is tied to hydration and barrier support in the supplied evidence.",
            "Reported details": "The supplied product evidence does not include a numeric result, so reported details remain unchanged."
          },
          faqAnswers: [
            {
              question: "Who is Hydra Balance Essence for?",
              answer: "Hydra Balance Essence is for dry-skin shoppers comparing hydration, barrier support, and hyaluronic acid in a morning-and-night routine."
            }
          ],
          contentSections: {
            description: "Hydra Balance Essence is an essence for dry skin that highlights hydration, barrier support, hyaluronic acid, and morning-and-night use.",
            quickFacts: "Key ingredients include Hyaluronic Acid.",
            faq: "Q. Who is Hydra Balance Essence for?\nA. Hydra Balance Essence is for dry-skin shoppers comparing hydration, barrier support, and hyaluronic acid."
          },
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
      const refiner = new ModelBackedCopyRefiner({
        provider: "openai",
        apiKey: "test-key",
        model: "test-model"
      });
      await refiner.refineCopy({
        locale: "en-US",
        product: {
          name: "Hydra Balance Essence",
          description: "A hydrating essence for dry skin.",
          images: [],
          options: [],
          benefits: ["hydration", "barrier support"],
          effects: [],
          ingredients: ["Hyaluronic Acid"],
          usage: ["Apply morning and night after cleansing."],
          metrics: [],
          faq: [],
          reviews: {
            keywords: ["lightweight"],
            items: []
          },
          breadcrumbs: [],
          sourceTexts: ["Hydra Balance Essence helps skin feel hydrated after cleansing."]
        },
        schemaMarkup: {
          jsonLd: {
            "@context": "https://schema.org",
            "@graph": [
              {
                "@type": "WebPage",
                description: "Current webpage description."
              },
              {
                "@type": "Product",
                description: "Current product description."
              }
            ]
          },
          scriptTag: ""
        },
        content: {
          sections: {
            productName: "Hydra Balance Essence",
            description: "Current product description.",
            quickFacts: "",
            benefits: "",
            ingredients: "",
            howToUse: "",
            faq: ""
          },
          html: ""
        },
        ragChunks: [
          {
            id: "geo-1",
            source: "geo-research_v1.md",
            title: "Answer-ready product fact selection",
            text: "Generative engines surface concise, source-backed product facts that answer comparison and usage questions.",
            kind: "geo-research",
            intents: ["claims"],
            fieldTargets: ["Product.description"],
            metadata: {},
            score: 0.92
          },
          {
            id: "cep-1",
            source: "cep_v1.md",
            title: "Customer entry points",
            text: "Map the product to customer entry points such as dry skin, routine timing, and comparison context.",
            kind: "cep",
            intents: ["customer"],
            fieldTargets: ["WebPage.description"],
            metadata: {},
            score: 0.91
          },
          {
            id: "eeat-1",
            source: "eeat_v1.md",
            title: "Evidence quality",
            text: "Keep benefit statements verifiable and grounded in page evidence.",
            kind: "eeat",
            intents: ["evidence"],
            fieldTargets: ["Product.description"],
            metadata: {},
            score: 0.9
          },
          {
            id: "best-practice-1",
            source: "brands/exampleluxe/best-practice_v2.md",
            title: "ExampleLuxe US BestPractice Tone",
            text: "Use refined, assured US English with balanced cadence, natural evidence transitions, and direct customer attribution.",
            kind: "best-practice",
            intents: ["locale", "claims"],
            fieldTargets: ["Product.description", "WebPage.description"],
            metadata: {},
            score: 0.89
          }
        ],
        reasoning: undefined
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(capturedBody?.instructions).toContain("GEO research/geo-paper, CEP, and E-E-A-T");
    expect(capturedBody?.instructions).toContain("Top priority: make public copy more likely to be selected, quoted, or cited by AI answer engines");
    expect(capturedBody?.instructions).toContain("active BestPractice guidance as the style benchmark");
    expect(capturedBody?.instructions).toContain("For Korean and English faqAnswers");
    expect(capturedBody?.instructions).toContain("Do not solve copy quality by copying a fixed template");
    expect(capturedBody?.instructions).toContain("six-part buyer-answer narrative");
    expect(capturedBody?.instructions).toContain("compact page/brand/scope summary");
    expect(capturedBody?.instructions).toContain("source-stated research or related-article citation");
    expect(capturedBody?.instructions).toContain("Build each FAQ question backwards from a natural recommendation or comparison query");
    expect(capturedBody?.instructions).toContain("schemaProperties");
    expect(capturedBody?.instructions).toContain("faqAnswers");
    const payload = JSON.parse(String(capturedBody?.input ?? "{}")) as Record<string, any>;
    expect(payload.task).toContain("AI-exposure-worthy");
    expect(payload.currentCopy.schemaProperties).toBeTruthy();
    expect(Array.isArray(payload.currentCopy.faqAnswers)).toBe(true);
    expect(payload.extractionPriorities).toEqual(expect.arrayContaining([
      expect.stringContaining("AI answer engine can quote"),
      expect.stringContaining("customer-entry-point"),
      expect.stringContaining("E-E-A-T")
    ]));
    expect(payload.strategicExposureGuidance).toHaveLength(3);
    expect(payload.strategicExposureGuidance.map((item: Record<string, unknown>) => item.kind)).toEqual(["geo-research", "cep", "eeat"]);
    expect(payload.bestPracticeToneGuidance).toHaveLength(1);
    expect(payload.bestPracticeToneGuidance[0].kind).toBe("best-practice");
    expect(payload.toneApplicationPolicy.join(" ")).toContain("Never copy a BestPractice example");
  });
  it("sends CEP narrative, volume isolation, and generative FAQ intent guidance to copy refinement", async () => {
    let capturedBody: Record<string, any> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, any>;
      return new Response(JSON.stringify({
        output_text: JSON.stringify({ warnings: [] }),
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
      }), { status: 200 });
    }));

    try {
      const refiner = new ModelBackedCopyRefiner({
        provider: "openai",
        apiKey: "test-key",
        model: "test-model"
      });
      await refiner.refineCopy({
        locale: "ko-KR",
        product: {
          name: "예시더마 모이베리어365 캡슐 토너",
          description: "장벽보습 캡슐 토너",
          images: [],
          options: [],
          benefits: ["장벽 보습"],
          effects: [],
          ingredients: ["고밀도 세라마이드 캡슐"],
          usage: [],
          metrics: [],
          faq: [],
          reviews: {
            keywords: ["장벽 보습"],
            items: [
              { body: "10.14 fl. oz. / 300 mL" },
              { body: "촉촉하고 장벽 보습이 잘 느껴져요." },
              { body: "좋아요" },
              { body: "300정" }
            ]
          },
          breadcrumbs: [],
          sourceTexts: ["고밀도 세라마이드 캡슐이 장벽 보습을 돕는다."]
        },
        schemaMarkup: {
          jsonLd: {
            "@context": "https://schema.org",
            "@graph": [
              { "@type": "WebPage", description: "현재 웹페이지 설명입니다." },
              { "@type": "Product", description: "현재 상품 설명입니다." }
            ]
          },
          scriptTag: ""
        },
        content: {
          sections: {
            productName: "예시더마 모이베리어365 캡슐 토너",
            description: "현재 상품 설명입니다.",
            quickFacts: "",
            benefits: "",
            ingredients: "",
            howToUse: "",
            faq: ""
          },
          html: ""
        },
        ragChunks: [],
        inferredSearchQueries: [
          {
            kind: "indirect",
            question: "피부가 많이 건조하고 당김이 느껴질 때 어떤 제품을 선택하면 좋나요?",
            keywords: ["수분감", "피부 장벽"],
            answer: "장벽보습 캡슐 토너를 비교할 수 있습니다.",
            source: "review-derived-cep",
            mentionsProductOrBrand: false
          }
        ]
      });

      const instructions = String(capturedBody?.instructions ?? "");
      const input = String(capturedBody?.input ?? "");

      expect(instructions).toContain("volume/size strings");
      expect(instructions).toContain("six-part buyer-answer narrative");
      expect(instructions).toContain("compact page/brand/scope summary");
      expect(instructions).toContain("Build each FAQ question backwards from a natural recommendation or comparison query");
      expect(instructions).toContain("네, or 아니요,");
      expect(input).toContain("generativeQueryIntents");
      expect(input).toContain("피부가 많이 건조하고 당김이 느껴질 때");
      expect(input).not.toContain("10.14 fl. oz. / 300 mL");
      expect(input).toContain("촉촉하고 장벽 보습이 잘 느껴져요.");
      expect(input).not.toContain("300정");
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("retries AI Studio copy refinement without temperature and keeps token totals", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          message: "Unsupported value: 'temperature' does not support 0.0 with this model. Only the default (1) value is supported.",
          code: "unsupported_value"
        }
      }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                schemaDescriptions: {
                  product: "Hydra Balance Essence highlights hydration, barrier support, hyaluronic acid, and morning-and-night use.",
                  webPage: "This Hydra Balance Essence page summarizes hydration, barrier support, hyaluronic acid, and usage context."
                },
                contentSections: {
                  description: "Hydra Balance Essence highlights hydration, barrier support, hyaluronic acid, and morning-and-night use."
                },
                warnings: []
              })
            }
          }
        ],
        usage: {
          input_tokens: 13,
          output_tokens: 8
        }
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const refiner = new ModelBackedCopyRefiner({
        provider: "aistudio",
        apiKey: "studio-key",
        endpoint: "https://dev-aistudio.example.com:8082/v1/agent/abc",
        deployment: "gpt-5.5",
        temperature: 0
      });
      const result = await refiner.refineCopy({
        locale: "en-US",
        product: {
          name: "Hydra Balance Essence",
          description: "A hydrating essence for dry skin.",
          images: [],
          options: [],
          benefits: ["hydration", "barrier support"],
          effects: [],
          ingredients: ["Hyaluronic Acid"],
          usage: ["Apply morning and night after cleansing."],
          metrics: [],
          faq: [],
          reviews: {
            keywords: [],
            items: []
          },
          breadcrumbs: [],
          sourceTexts: ["Hydra Balance Essence helps skin feel hydrated after cleansing."]
        },
        schemaMarkup: {
          jsonLd: {
            "@context": "https://schema.org",
            "@graph": [
              {
                "@type": "WebPage",
                description: "Current webpage description."
              },
              {
                "@type": "Product",
                description: "Current product description."
              }
            ]
          },
          scriptTag: ""
        },
        content: {
          sections: {
            productName: "Hydra Balance Essence",
            description: "Current product description.",
            quickFacts: "",
            benefits: "",
            ingredients: "",
            howToUse: "",
            faq: ""
          },
          html: ""
        },
        ragChunks: [],
        reasoning: undefined
      });

      const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}")) as Record<string, unknown>;
      const retryBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body ?? "{}")) as Record<string, unknown>;

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(firstBody.temperature).toBe(0);
      expect("temperature" in retryBody).toBe(false);
      expect(result.usage?.inputTokens).toBe(13);
      expect(result.usage?.outputTokens).toBe(8);
      expect(result.usage?.totalTokens).toBe(21);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("runs final Korean sentence QA over schema markup and content artifacts", () => {
    const repaired = validateAndRepairPdpGeoArtifacts({
      locale: "ko-KR",
      fallbackProductName: "테스트 수딩 크림",
      fallbackDescription: "테스트 수딩 크림은 수분감를 핵심 효능으로 제시합니다.",
      schemaMarkup: {
        jsonLd: {
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "WebPage",
              "@id": "https://example.com/product#webpage",
              url: "https://example.com/product",
              name: "테스트 수딩 크림",
              description: "테스트 수딩 크림 상품 페이지는 고객이 크림을 비교할 때 필요한 정보를 정리합니다. 확인된 결과/정보로 https: //cdn.example.com/fileupload/reviews/2026/06/18/JPEG_20260618_223402_7170014327977572094_1781789656867.jpg?format=webp를 참고할 수 있습니다."
            },
            {
              "@type": "Product",
              "@id": "https://example.com/product#product",
              name: "테스트 수딩 크림",
              description: "테스트 수딩 크림은 수분감를 핵심 효능으로 제시합니다. 확인된 상품 정보는 고밀도 세라마이드 캡슐, 히알루론산 성분/기술은 피부 장벽 효능 맥락과 연결되어 크림 비교에 필요한 핵심 케어 근거를 설명합니다입니다. 쿨링을 주는 성분은 ... 설계되었습니다. 대표 고객 리뷰에서는 \"너무 예뻐요 만족합니다\", \"믿고 쓰는 브랜드 피부에 수분감이 많아서 좋아요\"처럼 설명되며, 피부결를 같은 반복 표현도 함께 확인됩니다.",
              review: [
                {
                  "@type": "Review",
                  reviewBody: "속단김이나 건조함에는 정말 좋나요 메이크업 전에 쓰기 좋어요. 리뉴널 욘기조 예뻐요."
                }
              ],
              additionalProperty: [
                {
                  "@type": "PropertyValue",
                  name: "Key ingredients",
                  value: "히알루론산, 각 크림에는 피부타입과 피부고민을 고려한 캡슐이 함유되어 있습니다.캡슐은 장벽을 튼튼하게 …"
                },
                {
                  "@type": "PropertyValue",
                  name: "Reported details",
                  value: "https: //images-kr. exampleshop. com/fileupload/reviews/2026/06/18/JPEG_20260618_223402_7170014327977572094_1781789656867. jpg? format=webp"
                },
                {
                  "@type": "PropertyValue",
                  name: "Ingredient/effect detail",
                  value: "고밀도 세라마이드 캡슐, 히알루론산 성분/기술은 피부 장벽 효능 맥락과 연결되어 크림 비교에 필요한 핵심 케어 근거를 설명합니다"
                },
                {
                  "@type": "PropertyValue",
                  name: "Key benefit",
                  value: "수분감를"
                }
              ]
            },
            {
              "@type": "FAQPage",
              "@id": "https://example.com/product#faq",
              mainEntity: [
                {
                  "@type": "Question",
                  name: "테스트 수딩 크림은 어떻게 사용하면 좋나요?",
                  acceptedAnswer: {
                    "@type": "Answer",
                    text: "확인 가능한 정보로 고객 리뷰 표현: 피부결를 포함합니다."
                  }
                },
                {
                  "@type": "Question",
                  name: "예시더마 모이베리어365 하이드로 수딩크림 정보는 무엇으로 확인할 수 있나요?",
                  acceptedAnswer: {
                    "@type": "Answer",
                    text: "고밀도 세라마이드 캡슐과 히알루론산은 민감한 피부 루틴을 찾는 고객에게 피부 장벽, 수분감, 쿨링감, 피부결 케어의 성분적 배경을 제공하는 포인트입니다. 고객 리뷰의 피부결, 만족도, 촉촉한 사용감 표현은 사용감과 케어 포인트를 구체화합니다."
                  }
                }
              ]
            }
          ]
        },
        scriptTag: ""
      },
      content: {
        sections: {
          productName: "테스트 수딩 크림",
          description: "테스트 수딩 크림은 수분감를 핵심 효능으로 제시합니다. 쿨링을 주는 성분은 ... 설계되었습니다.",
          quickFacts: "핵심 효능: 수분감를\n확인된 정보: https: //cdn.example.com/fileupload/reviews/2026/06/18/JPEG_20260618_223402_7170014327977572094_1781789656867.jpg?format=webp",
          benefits: "- 피부결를\n- 리뉴얼 전 제품에서 고객님들이 만족하셨던 속성 (수분감",
          ingredients: "- 히알루론산\n- 각 크림에는 ... 장벽을 튼튼하게 …",
          howToUse: "1. 얼굴 전체에 부드럽게 펴 바릅니다.",
          faq: "Q. 테스트 수딩 크림은 어떻게 사용하면 좋나요?\nA. 확인 가능한 정보로 고객 리뷰 표현: 피부결를 포함합니다."
        },
        html: "<div class=\"geo-content-accordion\"><script>alert(1)</script></div>"
      }
    });

    const serialized = JSON.stringify(repaired.schemaMarkup.jsonLd);
    const graph = repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const faq = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
    const productProperties = product.additionalProperty as Array<Record<string, any>>;

    expect(serialized).not.toMatch(/images-kr\.exampleshop|fileupload\/reviews|확인된 결과\/정보에 따르면|확인된 상품 정보에 따르면|확인된 상품 정보는|핵심 케어 근거|…|\.{3,}|수분감를|피부결를|너무 예뻐요 만족합니다", "믿고 쓰는|동일한 캡슐인가요\?|합니다입니다|설명합니다를|근거 설명합니다|찾은 고객|\. 에 초점/);
    expect(serialized).not.toMatch(/성분 구성, 기대 효능, 사용감 차이|함께 보여줍니다|효능어|성분어|사용감어|제품 탐색 문맥|탐색 문맥에서/);
    expect(product.description).toContain("수분감을");
    expect(product.description).toContain("고밀도 세라마이드 캡슐과 히알루론산은 피부 장벽 케어를 뒷받침하는 크림의 핵심 포인트");
    expect(product.review[0].reviewBody).toContain("속단김");
    expect(product.review[0].reviewBody).toContain("좋어요");
    expect(product.review[0].reviewBody).toContain("리뉴널 욘기조");
    expect(productProperties.some((item) => item.name === "Reported details")).toBe(false);
    expect(productProperties.some((item) => item.name === "Key ingredients")).toBe(false);
    expect(productProperties.find((item) => item.name === "Ingredient/effect detail")?.value).toContain("크림의 핵심 포인트입니다");
    expect(productProperties.find((item) => item.name === "Key benefit")?.value).toBe("수분감");
    expect(faq.mainEntity.some((item: any) => item.name === "테스트 수딩 크림은 어떻게 사용하면 좋나요?")).toBe(false);
    const repairedMismatchFaq = faq.mainEntity.find((item: any) => item.name.includes("성분, 효능, 사용감"));
    expect(repairedMismatchFaq?.name).toBe("예시더마 모이베리어365 하이드로 수딩크림의 성분, 효능, 사용감은 어떤 정보로 정리되나요?");
    expect(repairedMismatchFaq?.acceptedAnswer.text).toContain("피부 장벽, 수분감, 쿨링감, 피부결");
    expect(repairedMismatchFaq?.acceptedAnswer.text).not.toMatch(/고객 리뷰|리뷰 표현|후기/);
    expect(repaired.content.sections.description).toContain("수분감을");
    expect(repaired.content.sections.quickFacts).not.toContain("images-kr.exampleshop");
    expect(repaired.content.html).toBe("");
    expect(repaired.validationWarnings.some((warning) => warning.includes("Final sentence QA repaired"))).toBe(true);
    expect(repaired.validationRepairs.some((repair) => repair.field === "content.sections.description" && String(repair.before).includes("수분감를") && String(repair.after).includes("수분감을"))).toBe(true);
    expect(repaired.validationRepairs.some((repair) => repair.field === "content.html")).toBe(false);
    expect(repaired.validationRepairs.some((repair) => repair.field === "Product.additionalProperty" && JSON.stringify(repair.before).includes("Reported details") && repair.after === null)).toBe(true);
  });
  it("repairs duplicated Korean Usage PropertyValue step artifacts", () => {
    const repaired = validateAndRepairPdpGeoArtifacts({
      locale: "ko-KR",
      fallbackProductName: "예시더마 모이베리어365 바디로션",
      fallbackDescription: "건조 피부를 위한 고보습 바디로션입니다.",
      schemaMarkup: {
        jsonLd: {
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "Product",
              "@id": "https://example.com/product#product",
              name: "예시더마 모이베리어365 바디로션",
              description: "건조 피부를 위한 고보습 바디로션입니다.",
              additionalProperty: [
                {
                  "@type": "PropertyValue",
                  name: "Usage",
                  value: "1단계: 샤워 후 손바닥에 적당량 덜어주세요; 2단계:. 1 샤워 후 손바닥에 적당량 덜어주세요"
                }
              ]
            }
          ]
        },
        scriptTag: ""
      },
      content: {
        sections: {
          productName: "예시더마 모이베리어365 바디로션",
          description: "건조 피부를 위한 고보습 바디로션입니다.",
          quickFacts: "",
          benefits: "",
          ingredients: "",
          howToUse: "1. 샤워 후 손바닥에 적당량 덜어주세요",
          faq: ""
        },
        html: ""
      }
    });

    const graph = repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const usageValue = String((product.additionalProperty as Array<Record<string, any>>)[0]?.value ?? "");

    expect(usageValue).toBe("샤워 후 손바닥에 적당량 덜어주세요");
    expect(repaired.validationRepairs.some((repair) => repair.field === "Product.additionalProperty.Usage")).toBe(true);
  });
  it("repairs public FAQ labels, metric decimals, and evidence duration consistency", () => {
    const repaired = validateAndRepairPdpGeoArtifacts({
      locale: "en-US",
      fallbackProductName: "Essential Activating Serum",
      fallbackDescription: "Essential Activating Serum supports visible-aging care.",
      schemaMarkup: {
        jsonLd: {
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "WebPage",
              name: "Essential Activating Serum",
              description: "Essential Activating Serum cites home usage evidence after 4 weeks and 8 weeks of daily use."
            },
            {
              "@type": "Product",
              name: "Essential Activating Serum",
              description: "Instrumental results after 4 weeks and 8 weeks of daily use include +5. 9% improvement in skin elasticity.",
              additionalProperty: [
                {
                  "@type": "PropertyValue",
                  name: "Reported details",
                  value: "Consumer assessment: +5. 9% improvement in the look of skin elasticity, +9. 9% strengthened moisture barrier, and +14. 5% increased hydration after 4 weeks of use."
                }
              ]
            },
            {
              "@type": "FAQPage",
              mainEntity: [
                {
                  "@type": "Question",
                  name: "KEY INGREDIENTS",
                  acceptedAnswer: {
                    "@type": "Answer",
                    text: "KEY INGREDIENTS details mention fermented ginseng."
                  }
                }
              ]
            }
          ]
        },
        scriptTag: ""
      },
      content: {
        sections: {
          productName: "Essential Activating Serum",
          description: "Essential Activating Serum supports visible-aging care.",
          quickFacts: "Reported details: +5. 9% improvement in skin elasticity.",
          benefits: "Visible-aging care",
          ingredients: "Fermented ginseng",
          howToUse: "Apply morning and night.",
          faq: "Q. KEY INGREDIENTS\nA. KEY INGREDIENTS details mention fermented ginseng."
        },
        html: "<div class=\"geo-content-accordion\"></div>"
      }
    });

    const graph = repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const webPage = graph.find((node) => (Array.isArray(node["@type"]) ? node["@type"].includes("WebPage") : node["@type"] === "WebPage")) as Record<string, any>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const faq = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
    const reportedDetails = String(product.additionalProperty[0].value);
    const serialized = JSON.stringify(repaired.schemaMarkup.jsonLd);

    expect(reportedDetails).toContain("+5.9% improvement in the look of skin elasticity");
    expect(reportedDetails).toContain("+9.9% strengthened moisture barrier");
    expect(reportedDetails).toContain("+14.5% increased hydration");
    expect(String(webPage.description)).not.toMatch(/8 weeks/i);
    expect(String(product.description)).not.toMatch(/8 weeks/i);
    expect(faq).toBeUndefined();
    expect(serialized).not.toMatch(/KEY INGREDIENTS|\+5\. 9|\+9\. 9|\+14\. 5/);
    expect(repaired.validationRepairs.some((repair) => repair.source === "field-contract-validator" && repair.field === "WebPage.description")).toBe(true);
    expect(repaired.validationRepairs.some((repair) => repair.field === "FAQPage.mainEntity" && String(repair.issue).includes("section heading"))).toBe(true);
  });
  it("repairs WebPage description sentences that list usage with ingredient technology coverage", () => {
    const repaired = validateAndRepairPdpGeoArtifacts({
      locale: "ko-KR",
      fallbackProductName: "예시더마 모이베리어365 캡슐 토너",
      fallbackDescription: "예시더마 모이베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
      schemaMarkup: {
        jsonLd: {
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "WebPage",
              name: "예시더마 모이베리어365 캡슐 토너",
              description: "예시더마 모이베리어365 캡슐 토너 상품 페이지는 건조 피부 또는 민감 피부 고객이 토너를 선택할 때 필요한 상품 정보를 안내합니다. 고객은 PHA 워터에 띄워진 고밀도 세라마이드 캡슐, 세라마이드·콜레스테롤·지방산, 하이드로겔 플로팅 포뮬러, 사용법을 확인하고 사용 직후 수분량 1.3배 증가 결과를 함께 비교할 수 있습니다."
            },
            {
              "@type": "Product",
              name: "예시더마 모이베리어365 캡슐 토너",
              description: "예시더마 모이베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다."
            }
          ]
        },
        scriptTag: ""
      },
      content: {
        sections: {
          productName: "예시더마 모이베리어365 캡슐 토너",
          description: "예시더마 모이베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
          quickFacts: "핵심 정보",
          benefits: "보습",
          ingredients: "고밀도 세라마이드 캡슐",
          howToUse: "손바닥에 적당량을 덜어냅니다",
          faq: "Q. 어떤 제품인가요?\nA. 민감 피부를 위한 보습 토너입니다."
        },
        html: "<div class=\"geo-content-accordion\"></div>"
      }
    });

    const graph = repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const webPage = graph.find((node) => (Array.isArray(node["@type"]) ? node["@type"].includes("WebPage") : node["@type"] === "WebPage")) as Record<string, any>;
    const description = String(webPage.description);

    expect(description).not.toContain("하이드로겔 플로팅 포뮬러, 사용법을 확인");
    expect(description).toContain("성분/기술 정보를 확인");
    expect(description).not.toContain("사용법은 HowTo 영역에서 별도로 확인할 수 있습니다");
    expect(description).not.toMatch(/사용법|사용 방법/);
    expect(repaired.validationRepairs.some((repair) => repair.source === "field-contract-validator" && repair.field === "WebPage.description")).toBe(true);
  });
  it("repairs WebPage description sentences that mix concrete HowTo steps with FAQ topics", () => {
    const repaired = validateAndRepairPdpGeoArtifacts({
      locale: "ko-KR",
      fallbackProductName: "예시더마 모이베리어365 캡슐 토너",
      fallbackDescription: "예시더마 모이베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
      schemaMarkup: {
        jsonLd: {
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "WebPage",
              name: "예시더마 모이베리어365 캡슐 토너",
              description: "예시더마 모이베리어365 캡슐 토너 상품 페이지는 민감 피부 또는 건조 피부가 피부 장벽 케어와 속보습을 비교할 때 참고할 수 있는 세라마이드 캡슐 수분 토너 정보를 다룹니다. 손바닥에 적당량을 덜어 얼굴 전체에 펴 바른 뒤 가볍게 두드려 흡수시키는 방법과 캡슐이 워터에 떠 있는 이유, 크림 캡슐 동일 여부를 FAQ와 HowTo에서 확인할 수 있습니다. 외부자극인 Tape Stripping에 의한 장벽 손상 회복, 세정에 의한 장벽 손상 즉시 회복, 피부결과 투명도 개선 결과, 구매 정보와 FAQ가 함께 제공됩니다."
            },
            {
              "@type": "Product",
              name: "예시더마 모이베리어365 캡슐 토너",
              description: "예시더마 모이베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다."
            }
          ]
        },
        scriptTag: ""
      },
      content: {
        sections: {
          productName: "예시더마 모이베리어365 캡슐 토너",
          description: "예시더마 모이베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
          quickFacts: "핵심 정보",
          benefits: "보습",
          ingredients: "고밀도 세라마이드 캡슐",
          howToUse: "손바닥에 적당량을 덜어냅니다",
          faq: "Q. 어떤 제품인가요?\nA. 민감 피부를 위한 보습 토너입니다."
        },
        html: "<div class=\"geo-content-accordion\"></div>"
      }
    });

    const graph = repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const webPage = graph.find((node) => (Array.isArray(node["@type"]) ? node["@type"].includes("WebPage") : node["@type"] === "WebPage")) as Record<string, any>;
    const description = String(webPage.description);

    expect(description).not.toMatch(/민감 피부 또는 건조 피부가[^.]*비교할 때/);
    expect(description).toMatch(/민감 피부 또는 건조 피부 고객이/);
    expect(description).toContain("피부 장벽 케어와 속보습을 비교할 때 세라마이드 캡슐 수분 토너 상품을 확인할 수 있습니다");
    expect(description).not.toMatch(/효과적인|추천합니다/);
	    expect(description).not.toMatch(/손바닥에 적당량|얼굴 전체에 펴 바른|FAQ와 HowTo/);
	    expect(description).not.toMatch(/FAQ에서는|FAQ와 HowTo|구매 정보|FAQ가 함께 제공|캡슐이 워터에 떠 있는 이유|크림 캡슐 동일 여부/);
	    expect(description).toContain("피부결과 투명도 개선 결과입니다");
	    expect(description).not.toMatch(/제시합니다|제시됩니다|나타났습니다/);
		    expect(repaired.validationRepairs.some((repair) => repair.source === "field-contract-validator" && repair.field === "WebPage.description")).toBe(true);
		  });
		  it("splits Korean WebPage description sentences that merge ingredient lists with numeric evidence", () => {
		    const repaired = validateAndRepairPdpGeoArtifacts({
		      locale: "ko-KR",
		      fallbackProductName: "예시더마 모이베리어365 캡슐 토너",
		      fallbackDescription: "예시더마 모이베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
		      schemaMarkup: {
		        jsonLd: {
		          "@context": "https://schema.org",
		          "@graph": [
		            {
		              "@type": "WebPage",
		              name: "예시더마 모이베리어365 캡슐 토너",
		              description: "예시더마 모이베리어365 캡슐 토너 상품 페이지에서는 건조 피부 또는 민감 피부 고객에게 장벽 보습, 수분 진정, 피부결 정돈을 돕는 고보습 장벽 캡슐 토너를 추천합니다. 고밀도 세라마이드 캡슐, PHA 워터, 하이드로겔 플로팅 포뮬러, 세라마이드/콜레스테롤/지방산 구성과 18시간 장벽 세라마이드 잔존 ex vivo 테스트 결과 190%, 사용 7일 후 피부결 7.9% 및 투명도 6.0% 개선 수치가 선택의 핵심 근거로를 제공합니다."
		            },
		            {
		              "@type": "Product",
		              name: "예시더마 모이베리어365 캡슐 토너",
		              description: "예시더마 모이베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다."
		            }
		          ]
		        },
		        scriptTag: ""
		      },
		      content: {
		        sections: {
		          productName: "예시더마 모이베리어365 캡슐 토너",
		          description: "예시더마 모이베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
		          quickFacts: "핵심 정보",
		          benefits: "보습",
		          ingredients: "고밀도 세라마이드 캡슐",
		          howToUse: "화장솜에 적당량을 덜어 피부결을 따라 부드럽게 닦아냅니다",
		          faq: "Q. 어떤 제품인가요?\nA. 민감 피부를 위한 보습 토너입니다."
		        },
		        html: "<div class=\"geo-content-accordion\"></div>"
		      }
		    });

		    const graph = repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
		    const webPage = graph.find((node) => (Array.isArray(node["@type"]) ? node["@type"].includes("WebPage") : node["@type"] === "WebPage")) as Record<string, any>;
		    const description = String(webPage.description);

		    expect(description).not.toMatch(/근거로를|선택의 핵심 근거/);
      expect(description).toContain("핵심 성분/기술은 고밀도 세라마이드 캡슐, PHA 워터, 하이드로겔 플로팅 포뮬러, 세라마이드·콜레스테롤·지방산 구성이며, 장벽 보습, 수분 진정, 피부결 정돈을 뒷받침합니다");
      expect(description).not.toMatch(/핵심 성분\/기술은 [^.]+ 구성입니다\./);
			    expect(description).toContain("ex vivo 테스트 기준, 18시간 장벽 세라마이드 잔존율은 190%이고, 사용 7일 후 피부결은 7.9%, 투명도는 6.0% 개선되었습니다");
			    expect(description).not.toMatch(/수치가 제시됩니다|결과가 제시됩니다|나타났습니다/);
			    expect(repaired.validationRepairs.some((repair) => repair.source === "field-contract-validator" && repair.field === "WebPage.description")).toBe(true);
			  });
			  it("repairs Korean WebPage description patent technology and FAQ-topic navigation sentences", () => {
			    const repaired = validateAndRepairPdpGeoArtifacts({
			      locale: "ko-KR",
			      fallbackProductName: "예시더마 모이베리어365 캡슐 토너",
			      fallbackDescription: "예시더마 모이베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
			      schemaMarkup: {
			        jsonLd: {
			          "@context": "https://schema.org",
			          "@graph": [
			            {
			              "@type": "WebPage",
			              name: "예시더마 모이베리어365 캡슐 토너",
			              description: "예시더마 모이베리어365 캡슐 토너 상품 페이지에서는 건조 민감 피부 고객에게 피부 장벽 케어와 100시간 보습 지속을 내세우는 고보습 세라마이드 캡슐 토너를 소개합니다. 핵심 기술은 PHA 워터에 띄워진 고밀도 세라마이드 캡슐, 하이드로겔 플로팅 포뮬러, 하이드로겔 서스펜션이며 특허 출원 번호는 KR102023-0133775입니다. Tape Stripping 테스트에서 외부자극에 의한 장벽 손상은 사용 직후 60.5%, 사용 7일 후 87.3% 회복된 것으로 제시됩니다. 캡슐이 워터 안에 떠 있는 이유와 모이베리어365 크림 캡슐 관련 질문도 함께 다룹니다."
			            },
			            {
			              "@type": "Product",
			              name: "예시더마 모이베리어365 캡슐 토너",
			              description: "예시더마 모이베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다."
			            }
			          ]
			        },
			        scriptTag: ""
			      },
			      content: {
			        sections: {
			          productName: "예시더마 모이베리어365 캡슐 토너",
			          description: "예시더마 모이베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
			          quickFacts: "핵심 정보",
			          benefits: "보습",
			          ingredients: "고밀도 세라마이드 캡슐",
			          howToUse: "화장솜에 적당량을 덜어 피부결을 따라 부드럽게 닦아냅니다",
			          faq: "Q. 어떤 제품인가요?\nA. 민감 피부를 위한 보습 토너입니다."
			        },
			        html: "<div class=\"geo-content-accordion\"></div>"
			      }
			    });

			    const graph = repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
			    const webPage = graph.find((node) => (Array.isArray(node["@type"]) ? node["@type"].includes("WebPage") : node["@type"] === "WebPage")) as Record<string, any>;
			    const description = String(webPage.description);

			    expect(description).not.toMatch(/특허 출원 번호|KR102023-0133775|질문도 함께 다룹니다|크림 캡슐 관련 질문/);
			    expect(description).toContain("피부 장벽 케어와 100시간 보습 지속을 뒷받침하는 핵심 성분/기술은 PHA 워터에 띄워진 고밀도 세라마이드 캡슐, 하이드로겔 플로팅 포뮬러, 하이드로겔 서스펜션입니다");
			    expect(description).toContain("Tape Stripping 테스트 기준, 외부자극에 의한 장벽 손상은 사용 직후 60.5%, 사용 7일 후 87.3% 회복되었습니다");
			    expect(description).not.toMatch(/사용 직후는|사용 7일 후는|제시됩니다|나타났습니다/);
			    expect(repaired.validationRepairs.some((repair) => repair.source === "field-contract-validator" && repair.field === "WebPage.description")).toBe(true);
			  });
			  it("repairs Korean FAQ comparison answers that mix patent identifiers with formula technology", () => {
			    const repaired = validateAndRepairPdpGeoArtifacts({
			      locale: "ko-KR",
			      fallbackProductName: "예시더마 모이베리어365 캡슐 토너",
			      fallbackDescription: "예시더마 모이베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
			      schemaMarkup: {
			        jsonLd: {
			          "@context": "https://schema.org",
			          "@graph": [
			            {
			              "@type": "Product",
			              name: "예시더마 모이베리어365 캡슐 토너",
			              description: "예시더마 모이베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다."
			            },
			            {
			              "@type": "FAQPage",
			              mainEntity: [
			                {
			                  "@type": "Question",
			                  name: "모이베리어365 크림에 함유된 캡슐과 동일한 캡슐인가요?",
			                  acceptedAnswer: {
			                    "@type": "Answer",
			                    text: "예시더마 모이베리어365 캡슐 토너의 캡슐은 PHA 워터에 띄워진 고밀도 세라마이드 캡슐 특허 출원 포뮬러로 설명됩니다. 모이베리어365 크림 캡슐과 동일하다고 단정하기는 어렵고, 이 토너는 물에 녹지 않는 세라마이드를 캡슐 형태로 워터에 띄운 하이드로겔 플로팅 포뮬러 기술과 특허출원번호 KR102023-0133775가 제시됩니다."
			                  }
			                }
			              ]
			            }
			          ]
			        },
			        scriptTag: ""
			      },
			      content: {
			        sections: {
			          productName: "예시더마 모이베리어365 캡슐 토너",
			          description: "예시더마 모이베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
			          quickFacts: "핵심 정보",
			          benefits: "보습",
			          ingredients: "고밀도 세라마이드 캡슐",
			          howToUse: "화장솜에 적당량을 덜어 피부결을 따라 부드럽게 닦아냅니다",
			          faq: "Q. 모이베리어365 크림에 함유된 캡슐과 동일한 캡슐인가요?\nA. 예시더마 모이베리어365 캡슐 토너의 캡슐은 PHA 워터에 띄워진 고밀도 세라마이드 캡슐 특허 출원 포뮬러로 설명됩니다."
			        },
			        html: "<div class=\"geo-content-accordion\"></div>"
			      }
			    });

			    const graph = repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
			    const faq = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
			    const answer = String(faq.mainEntity[0].acceptedAnswer.text);

			    expect(answer).toBe("공개된 상품 정보만으로는 모이베리어365 크림 캡슐과 동일하다고 단정하기 어렵습니다. 예시더마 모이베리어365 캡슐 토너의 캡슐은 PHA 워터에 띄워진 고밀도 세라마이드 캡슐로 설명됩니다.");
				    expect(answer).not.toMatch(/특허출원번호|KR102023-0133775|포뮬러 기술|하이드로겔 플로팅 포뮬러 기술/);
				    expect(repaired.validationRepairs.some((repair) => repair.source === "field-contract-validator" && repair.field === "FAQPage.mainEntity.acceptedAnswer.text")).toBe(true);
				  });
					  it("repairs Korean suitability FAQ metric endings into direct effect wording", () => {
					    const repaired = validateAndRepairPdpGeoArtifacts({
				      locale: "ko-KR",
				      fallbackProductName: "예시더마 모이베리어365 캡슐 토너",
				      fallbackDescription: "예시더마 모이베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
				      schemaMarkup: {
				        jsonLd: {
				          "@context": "https://schema.org",
				          "@graph": [
				            {
				              "@type": "Product",
				              name: "예시더마 모이베리어365 캡슐 토너",
				              description: "예시더마 모이베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다."
				            },
				            {
				              "@type": "FAQPage",
				              mainEntity: [
				                {
				                  "@type": "Question",
				                  name: "예시더마 모이베리어365 캡슐 토너는 어떤 고객에게 추천할 수 있나요?",
				                  acceptedAnswer: {
				                    "@type": "Answer",
				                    text: "예시더마 모이베리어365 캡슐 토너는 민감·건조 피부와 피부 장벽 약화가 고민인 고객에게 추천할 수 있는 고보습 캡슐 토너입니다. 세라마이드 캡슐로 속보습부터 피부장벽까지 채워주는 제품으로 소개되며, 피부 장벽 케어, 고보습 케어, 진정 케어와 사용 직후 수분량 1.3배 증가 결과가 제시됩니다."
				                  }
				                }
				              ]
				            }
				          ]
				        },
				        scriptTag: ""
				      },
				      content: {
				        sections: {
				          productName: "예시더마 모이베리어365 캡슐 토너",
				          description: "예시더마 모이베리어365 캡슐 토너는 민감 피부를 위한 보습 토너입니다.",
				          quickFacts: "핵심 정보",
				          benefits: "보습",
				          ingredients: "고밀도 세라마이드 캡슐",
				          howToUse: "화장솜에 적당량을 덜어 피부결을 따라 부드럽게 닦아냅니다",
				          faq: "Q. 예시더마 모이베리어365 캡슐 토너는 어떤 고객에게 추천할 수 있나요?\nA. 민감·건조 피부와 피부 장벽 약화가 고민인 고객에게 추천할 수 있습니다."
				        },
				        html: "<div class=\"geo-content-accordion\"></div>"
				      }
				    });

				    const graph = repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
				    const faq = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
				    const answer = String(faq.mainEntity[0].acceptedAnswer.text);

				    expect(answer).toContain("사용 직후 수분량 1.3배 증가 효과가 있습니다");
					    expect(answer).not.toMatch(/결과가 제시됩니다/);
					    expect(repaired.validationRepairs.some((repair) => repair.source === "field-contract-validator" && repair.field === "FAQPage.mainEntity.acceptedAnswer.text")).toBe(true);
					  });
						  it("rewrites positive Korean review-intent FAQ and removes negative raw review text", () => {
					    const repaired = validateAndRepairPdpGeoArtifacts({
					      locale: "ko-KR",
					      fallbackProductName: "예시더마 모이베리어365 클렌징폼",
					      fallbackDescription: "예시더마 모이베리어365 클렌징폼은 건조 피부 또는 민감 피부를 위한 장벽보호 폼 클렌저입니다.",
					      schemaMarkup: {
					        jsonLd: {
					          "@context": "https://schema.org",
					          "@graph": [
					            {
					              "@type": "Product",
					              name: "예시더마 모이베리어365 클렌징폼",
					              description: "예시더마 모이베리어365 클렌징폼은 건조 피부 또는 민감 피부를 위한 장벽보호 폼 클렌저입니다."
					            },
					            {
					              "@type": "FAQPage",
					              mainEntity: [
					                {
					                  "@type": "Question",
					                  name: "뽀득거리지도 미끌거리지도 않아요 약산성과 약알칼리성의 중간인 느낌?",
					                  acceptedAnswer: {
					                    "@type": "Answer",
					                    text: "예시더마 모이베리어365 클렌징폼은 고객 리뷰에서 뽀득하거나 미끌거리는 느낌보다 크리미하고 세안 후 촉촉한 데일리 폼클렌저로 언급됩니다. 약산성 아미노산 유래 세정 성분과 Barrier Protective Formula가 장벽 손상 방어와 클렌징 중 장벽보호 포인트로 표시됩니다."
					                  }
					                },
					                {
					                  "@type": "Question",
					                  name: "5 5 sunh6712 2026-06-08 무난하게 데일리로 사용하기 좋아요 성분이 착해서 그런지 민감성, 건성인 피부에도 트러블 올라오지 않고 좋아요 조금 아쉬운 부분이 있다면 세안할때 향이 좀 약품냄새? ?",
					                  acceptedAnswer: {
					                    "@type": "Answer",
					                    text: "예시더마 모이베리어365 클렌징폼은 고객 리뷰에서 민감성·건성 피부에도 데일리로 쓰기 무난하고 세안 후 촉촉하다는 반응이 있습니다. 다만 일부 리뷰에는 세안할 때 약품 냄새처럼 느껴졌다는 아쉬움도 함께 언급됩니다."
					                  }
					                },
					                {
					                  "@type": "Question",
					                  name: "예시더마 모이베리어365 클렌징폼은 어떤 고객에게 추천할 수 있나요?",
					                  acceptedAnswer: {
					                    "@type": "Answer",
					                    text: "예시더마 모이베리어365 클렌징폼은 건조 피부 또는 민감 피부 고객에게 추천할 수 있는 장벽보호 폼 클렌저입니다. Barrier Protective Formula와 약산성 아미노산 유래 세정 성분이 클렌징 중 장벽보호를 뒷받침합니다."
					                  }
					                }
					              ]
					            }
					          ]
					        },
					        scriptTag: ""
					      },
					      content: {
					        sections: {
					          productName: "예시더마 모이베리어365 클렌징폼",
					          description: "예시더마 모이베리어365 클렌징폼은 건조 피부 또는 민감 피부를 위한 장벽보호 폼 클렌저입니다.",
					          quickFacts: "핵심 정보",
					          benefits: "장벽보호",
					          ingredients: "Barrier Protective Formula, 약산성 아미노산 유래 세정 성분",
					          howToUse: "적당량을 덜어 거품을 낸 뒤 얼굴을 부드럽게 마사지하고 미온수로 깨끗이 헹굽니다.",
					          faq: "Q. 뽀득거리지도 미끌거리지도 않아요 약산성과 약알칼리성의 중간인 느낌?\nA. 예시더마 모이베리어365 클렌징폼은 고객 리뷰에서 크리미하고 세안 후 촉촉한 데일리 폼클렌저로 언급됩니다.\n\nQ. 5 5 sunh6712 2026-06-08 무난하게 데일리로 사용하기 좋아요 성분이 착해서 그런지 민감성, 건성인 피부에도 트러블 올라오지 않고 좋아요 조금 아쉬운 부분이 있다면 세안할때 향이 좀 약품냄새? ?\nA. 예시더마 모이베리어365 클렌징폼은 고객 리뷰에서 민감성·건성 피부에도 데일리로 쓰기 무난하고 세안 후 촉촉하다는 반응이 있습니다.\n\nQ. 예시더마 모이베리어365 클렌징폼은 어떤 고객에게 추천할 수 있나요?\nA. 예시더마 모이베리어365 클렌징폼은 건조 피부 또는 민감 피부 고객에게 추천할 수 있는 장벽보호 폼 클렌저입니다."
					        },
					        html: "<div class=\"geo-content-accordion\"></div>"
					      }
					    });

					    const graph = repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
					    const faq = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
					    const questions = faq.mainEntity.map((item: any) => String(item.name));
					    const answers = faq.mainEntity.map((item: any) => String(item.acceptedAnswer.text));
					    const serializedFaq = JSON.stringify(faq);

					    expect(questions).toEqual([
					      "고객 리뷰는 예시더마 모이베리어365 클렌징폼의 어떤 사용감을 강조하나요?",
					      "예시더마 모이베리어365 클렌징폼은 어떤 고객에게 추천할 수 있나요?"
					    ]);
					    expect(serializedFaq).not.toMatch(/sunh6712|2026-06-08|뽀득거리지도 미끌거리지도 않아요|무난하게 데일리로 사용하기 좋아요|약품냄새/);
					    expect(answers[0]).toMatch(/균형 잡힌 세정감|크리미한 사용감|세안 후 촉촉함/);
					    expect(answers[0]).not.toMatch(/Barrier Protective Formula|약산성 아미노산|장벽 손상 방어/);
					    expect(answers[1]).toContain("장벽보호 폼 클렌저");
					    expect(serializedFaq).not.toMatch(/약품 냄새|향에 대한 체감|아쉬운/);
					    expect(repaired.content.sections.faq).not.toMatch(/sunh6712|2026-06-08|뽀득거리지도 미끌거리지도 않아요|무난하게 데일리로 사용하기 좋아요|약품냄새|약품 냄새|아쉬운/);
					    expect(repaired.content.sections.faq).toContain("고객 리뷰는 예시더마 모이베리어365 클렌징폼의 어떤 사용감을 강조하나요?");
					    expect(repaired.content.sections.faq).toContain("예시더마 모이베리어365 클렌징폼은 어떤 고객에게 추천할 수 있나요?");
					    expect(repaired.validationRepairs.some((repair) => repair.source === "field-contract-validator" && repair.field === "FAQPage.mainEntity")).toBe(true);
					    expect(repaired.validationRepairs.some((repair) => repair.source === "field-contract-validator" && repair.field === "content.sections.faq")).toBe(true);
					  });
					  it("repairs Korean usage FAQ answers that leak raw review expectation text", () => {
				    const badAnswer = "예시더마 모이베리어365 젠틀 포밍클렌저는 세럼, 앰플, 에센스 등 스킨케어 루틴 단계와 함께 사용할 수 있습니다. 사용법은 아직 본격적으로 사용해 보지는 않았는데 워낙 평이 좋아서 기대가 많이 되네요입니다. 판테놀, 세라마이드, BotanON® 기술 성분/기술 맥락과 함께 루틴 선택 기준을 제공합니다.";
				    const repaired = validateAndRepairPdpGeoArtifacts({
				      locale: "ko-KR",
				      fallbackProductName: "예시더마 모이베리어365 젠틀 포밍클렌저",
				      fallbackDescription: "예시더마 모이베리어365 젠틀 포밍클렌저는 건조 민감 피부를 위한 장벽보호 폼 클렌저입니다.",
				      schemaMarkup: {
				        jsonLd: {
				          "@context": "https://schema.org",
				          "@graph": [
				            {
				              "@type": "Product",
				              name: "예시더마 모이베리어365 젠틀 포밍클렌저",
				              description: "예시더마 모이베리어365 젠틀 포밍클렌저는 건조 민감 피부를 위한 장벽보호 폼 클렌저입니다."
				            },
				            {
				              "@type": "FAQPage",
				              mainEntity: [
				                {
				                  "@type": "Question",
				                  name: "예시더마 모이베리어365 젠틀 포밍클렌저는 어떤 루틴에서 함께 쓰기 좋나요?",
				                  acceptedAnswer: {
				                    "@type": "Answer",
				                    text: badAnswer
				                  }
				                }
				              ]
				            }
				          ]
				        },
				        scriptTag: ""
				      },
				      content: {
				        sections: {
				          productName: "예시더마 모이베리어365 젠틀 포밍클렌저",
				          description: "예시더마 모이베리어365 젠틀 포밍클렌저는 건조 민감 피부를 위한 장벽보호 폼 클렌저입니다.",
				          quickFacts: "핵심 정보",
				          benefits: "장벽보호",
				          ingredients: "판테놀, 세라마이드, BotanON® 기술",
				          howToUse: "적당량을 덜어 물과 함께 거품을 낸 뒤 미온수로 깨끗이 헹굽니다.",
				          faq: `Q. 예시더마 모이베리어365 젠틀 포밍클렌저는 어떤 루틴에서 함께 쓰기 좋나요?\nA. ${badAnswer}`
				        },
				        html: "<div class=\"geo-content-accordion\"></div>"
				      }
				    });

				    const graph = repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
				    const faq = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
				    const answer = String(faq.mainEntity[0].acceptedAnswer.text);

				    expect(answer).toBe("예시더마 모이베리어365 젠틀 포밍클렌저는 세럼, 앰플, 에센스 등 스킨케어 루틴 단계와 함께 사용할 수 있습니다.");
				    expect(JSON.stringify(repaired.schemaMarkup.jsonLd)).not.toMatch(/아직 본격적으로|평이 좋아서|기대가 많이|성분\/기술\s*맥락|루틴 선택 기준/);
				    expect(repaired.content.sections.faq).not.toMatch(/아직 본격적으로|평이 좋아서|기대가 많이|성분\/기술\s*맥락|루틴 선택 기준/);
				    expect(repaired.validationRepairs.some((repair) => repair.source === "field-contract-validator" && repair.field === "FAQPage.mainEntity.acceptedAnswer.text")).toBe(true);
				    expect(repaired.validationRepairs.some((repair) => repair.source === "field-contract-validator" && repair.field === "content.sections.faq")).toBe(true);
				  });
				  it("keeps distinct Korean concern-benefit and ingredient-benefit FAQ questions", () => {
				    const repaired = validateAndRepairPdpGeoArtifacts({
				      locale: "ko-KR",
				      fallbackProductName: "예시더마 모이베리어365 젠틀 포밍클렌저",
				      fallbackDescription: "예시더마 모이베리어365 젠틀 포밍클렌저는 건조 피부 또는 민감 피부를 위한 저자극 포밍 클렌저입니다.",
				      schemaMarkup: {
				        jsonLd: {
				          "@context": "https://schema.org",
				          "@graph": [
				            {
				              "@type": "Product",
				              name: "예시더마 모이베리어365 젠틀 포밍클렌저",
				              description: "예시더마 모이베리어365 젠틀 포밍클렌저는 건조 피부 또는 민감 피부를 위한 저자극 포밍 클렌저입니다."
				            },
				            {
				              "@type": "FAQPage",
				              mainEntity: [
				                {
				                  "@type": "Question",
				                  name: "예시더마 모이베리어365 젠틀 포밍클렌저는 어떤 피부 고민과 효능에 적합한가요?",
				                  acceptedAnswer: {
				                    "@type": "Answer",
				                    text: "예시더마 모이베리어365 젠틀 포밍클렌저는 건조 피부 또는 민감 피부의 저자극 세안, 피부 장벽 케어, 보습력 개선, 피부결 사이 노폐물 세정에 적합한 포밍 클렌저입니다."
				                  }
				                },
				                {
				                  "@type": "Question",
				                  name: "EXAMPLEDERMA 예시더마 모이베리어365 젠틀 포밍클렌저의 주요 성분과 효능은 무엇인가요?",
				                  acceptedAnswer: {
				                    "@type": "Answer",
				                    text: "EXAMPLEDERMA 예시더마 모이베리어365 젠틀 포밍클렌저의 주요 성분/기술은 Barrier Protective Formula, 판테놀, 베타인, 보타온입니다. 판테놀은 피부 장벽 강화, 피부 진정 개선, 피부 보습 개선에 연결되고, 보타온은 피부장벽 구성 강화와 피부 보습력 개선에 연결됩니다."
				                  }
				                },
				                {
				                  "@type": "Question",
				                  name: "예시더마 모이베리어365 젠틀 포밍클렌저는 어떻게 사용하나요?",
				                  acceptedAnswer: {
				                    "@type": "Answer",
				                    text: "적당량을 덜어 물과 함께 거품을 낸 뒤 얼굴에 부드럽게 마사지하고 미온수로 깨끗이 헹굽니다."
				                  }
				                }
				              ]
				            }
				          ]
				        },
				        scriptTag: ""
				      },
				      content: {
				        sections: {
				          productName: "예시더마 모이베리어365 젠틀 포밍클렌저",
				          description: "예시더마 모이베리어365 젠틀 포밍클렌저는 건조 피부 또는 민감 피부를 위한 저자극 포밍 클렌저입니다.",
				          quickFacts: "핵심 정보",
				          benefits: "저자극 세안",
				          ingredients: "Barrier Protective Formula, 판테놀, 베타인, 보타온",
				          howToUse: "적당량을 덜어 물과 함께 거품을 낸 뒤 얼굴에 부드럽게 마사지하고 미온수로 깨끗이 헹굽니다.",
				          faq: "Q. 예시더마 모이베리어365 젠틀 포밍클렌저는 어떤 피부 고민과 효능에 적합한가요?\nA. 건조 피부 또는 민감 피부의 저자극 세안에 적합합니다.\n\nQ. EXAMPLEDERMA 예시더마 모이베리어365 젠틀 포밍클렌저의 주요 성분과 효능은 무엇인가요?\nA. 주요 성분/기술은 Barrier Protective Formula, 판테놀, 베타인, 보타온입니다."
				        },
				        html: "<div class=\"geo-content-accordion\"></div>"
				      }
				    });

				    const graph = repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
				    const faq = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
				    const questions = faq.mainEntity.map((item: Record<string, any>) => String(item.name));

				    expect(questions).toContain("EXAMPLEDERMA 예시더마 모이베리어365 젠틀 포밍클렌저의 주요 성분과 효능은 무엇인가요?");
				    expect(questions).toContain("예시더마 모이베리어365 젠틀 포밍클렌저는 어떤 피부 고민과 효능에 적합한가요?");
				    expect(questions).toContain("예시더마 모이베리어365 젠틀 포밍클렌저는 어떻게 사용하나요?");
				    expect(repaired.content.sections.faq).toContain("EXAMPLEDERMA 예시더마 모이베리어365 젠틀 포밍클렌저의 주요 성분과 효능은 무엇인가요?");
				    expect(repaired.content.sections.faq).toContain("예시더마 모이베리어365 젠틀 포밍클렌저는 어떤 피부 고민과 효능에 적합한가요?");
				    expect(repaired.validationRepairs.some((repair) =>
				      repair.source === "field-contract-validator"
				      && repair.field === "FAQPage.mainEntity"
				      && String(repair.issue).includes("overlapping ingredient-benefit")
				    )).toBe(false);
				    expect(repaired.validationRepairs.some((repair) =>
				      repair.source === "field-contract-validator"
				      && repair.field === "content.sections.faq"
				      && String(repair.issue).includes("overlapping ingredient-benefit")
				    )).toBe(false);
				  });
  it("repairs merged internal FAQ section markers while HTML CONTENT remains disabled", () => {
    const repaired = validateAndRepairPdpGeoArtifacts({
      locale: "en-US",
      fallbackProductName: "Gentle Cleansing Foam",
      fallbackDescription: "Gentle Cleansing Foam is a cleanser for clean, hydrated-feeling skin.",
      schemaMarkup: {
        jsonLd: {
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "Product",
              name: "Gentle Cleansing Foam",
              description: "Gentle Cleansing Foam is a cleanser for clean, hydrated-feeling skin."
            }
          ]
        },
        scriptTag: ""
      },
      content: {
        sections: {
          productName: "Gentle Cleansing Foam",
          description: "Gentle Cleansing Foam is a cleanser for clean, hydrated-feeling skin.",
          quickFacts: "Key benefit: hydration",
          benefits: "- Hydration",
          ingredients: "- Hydro-cleansing formula",
          howToUse: "1. Lather with water and massage onto damp skin.",
          faq: "Q. What does Gentle Cleansing Foam do?\nA. It supports clean, hydrated-feeling skin. Q. How should Gentle Cleansing Foam be used?\nA. 1based on the product detail, lather with water and rinse."
        },
        html: "<div class=\"geo-content-accordion\"></div>"
      }
    });

    expect(repaired.content.sections.faq).toContain("\n\nQ. How should Gentle Cleansing Foam be used?");
    expect(repaired.content.sections.faq).toContain("\nA. 1 based on the product detail");
    expect(repaired.content.html).toBe("");
    expect(repaired.validationRepairs.some((repair) => repair.field === "content.sections.faq")).toBe(true);
  });
  it("repairs final schema descriptions when Product and WebPage roles collapse", () => {
    const productFallback = "Hydra Balance Essence is an essence for dry skin with Hyaluronic Acid and hydration support.";
    const repaired = validateAndRepairPdpGeoArtifacts({
      locale: "en-US",
      fallbackProductName: "Hydra Balance Essence",
      fallbackDescription: productFallback,
      schemaMarkup: {
        jsonLd: {
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "WebPage",
              name: "Hydra Balance Essence product page",
              description: `This Hydra Balance Essence product page introduces ${productFallback}`
            },
            {
              "@type": "Product",
              name: "Hydra Balance Essence",
              description: "This Hydra Balance Essence product page summarizes hydration and Hyaluronic Acid for dry skin customers."
            }
          ]
        },
        scriptTag: ""
      },
      content: {
        sections: {
          productName: "Hydra Balance Essence",
          description: productFallback,
          quickFacts: "Key ingredient: Hyaluronic Acid",
          benefits: "Hydration support",
          ingredients: "Hyaluronic Acid",
          howToUse: "Apply morning and night after cleansing.",
          faq: "Q. Who is Hydra Balance Essence for?\nA. It is for dry skin customers comparing hydration support."
        },
        html: "<div class=\"geo-content-accordion\"></div>"
      }
    });

    const graph = repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const webPage = graph.find((node) => (Array.isArray(node["@type"]) ? node["@type"].includes("WebPage") : node["@type"] === "WebPage")) as Record<string, any>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;

    expect(product.description).toBe(productFallback);
    expect(String(product.description)).not.toMatch(/product\s+page|PDP|page\s+(?:covers|introduces|summarizes)/i);
    expect(webPage.description).not.toBe(product.description);
    expect(String(webPage.description)).toContain("Hydra Balance Essence product page");
    expect(repaired.validationRepairs.some((repair) =>
      repair.field === "Product.description"
      && String(repair.issue).includes("product page or page coverage")
    )).toBe(true);
    expect(repaired.validationRepairs.some((repair) =>
      repair.field === "WebPage.description"
      && String(repair.issue).includes("repeated Product.description")
    )).toBe(true);
  });
});
