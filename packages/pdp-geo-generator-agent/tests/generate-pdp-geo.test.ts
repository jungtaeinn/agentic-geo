import { describe, expect, it, vi } from "vitest";
import { generatePdpGeo, ModelBackedCopyRefiner } from "../src";
import { validateAndRepairPdpGeoArtifacts } from "../src/validate";

describe("generatePdpGeo", () => {
  it("keeps product-detail image URLs in diagnostics beyond the first 12 images", async () => {
    const images = Array.from({ length: 20 }, (_, index) => `https://cdn.example.com/pdp/detail-${index + 1}.png`);
    const editorImage = "https://assets.example.com/upload/editor/f4652a02-f514-4936-ac7e-00f5fcab61b4.png";
    images.splice(15, 0, editorImage);

    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "Barrier Hydro Soothing Cream",
          description: "Hydrating cream for skin barrier moisture care.",
          images,
          benefits: ["hydration"],
          ingredients: ["Compressed Hyaluronic Acid"]
        }
      },
      source: {
        type: "pdp-extractor",
        url: "https://example.com/products/barrier-hydro-soothing-cream"
      }
    });

    expect(result.diagnostics.normalizedProduct.images).toContain(editorImage);
  });

  it("generates GEO schema markup and HTML from arbitrary REST JSON with field mapping", async () => {
    const { result, process } = await generatePdpGeo({
      product: {
        item: {
          title: "Hydra Barrier Cream",
          body: "Daily cream for dry skin, hydration, and skin barrier support.",
          maker: "Agentic Beauty",
          taxonomy: "Cream",
          amount: "32000",
          currencyCode: "KRW",
          detail: {
            hero: "Niacinamide, Ceramide, and Panax Ginseng Root Extract support moisture barrier care.",
            use: "Apply morning and night after serum.",
            good: "Hydration and skin barrier support for dry skin."
          }
        },
        reviewList: [
          { body: "촉촉하고 흡수감이 좋아요.", rating: 5 }
        ],
        reviewMeta: {
          rating: 4.8,
          count: 418,
          keywords: ["촉촉", "흡수감", "피부결"]
        }
      },
      source: {
        type: "rest-api",
        url: "https://example.com/products/hydra-barrier-cream"
      },
      hints: {
        locale: "ko-KR",
        market: "KR",
        category: "크림"
      },
      fieldMapping: {
        name: "item.title",
        description: "item.body",
        brand: "item.maker",
        category: "item.taxonomy",
        price: "item.amount",
        currency: "item.currencyCode",
        ingredients: "item.detail.hero",
        usage: "item.detail.use",
        benefits: "item.detail.good",
        reviews: "reviewList",
        rating: "reviewMeta.rating",
        reviewCount: "reviewMeta.count"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const webPage = graph.find((node) => node["@type"] === "WebPage") as Record<string, any>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    expect(Array.isArray(graph)).toBe(true);
    expect(JSON.stringify(result.schemaMarkup.jsonLd)).toContain("\"Product\"");
    expect(JSON.stringify(result.schemaMarkup.jsonLd)).toContain("\"FAQPage\"");
    expect(JSON.stringify(result.schemaMarkup.jsonLd)).toContain("\"HowTo\"");
    expect(JSON.stringify(result.schemaMarkup.jsonLd)).toContain("\"BreadcrumbList\"");
    expect(JSON.stringify(result.schemaMarkup.jsonLd)).toContain("\"WebPage\"");
    expect(result.content.sections.productName).toContain("Hydra Barrier Cream");
    expect(result.content.sections.description).toContain("고객");
    expect(result.content.sections.description).toContain("흡수감");
    expect(webPage.description).toContain("상품 페이지");
    expect(product.description).toBe(result.content.sections.description);
    expect(webPage.description).not.toBe(product.description);
    expect(result.content.sections.quickFacts).toContain("주요 성분");
    expect(result.content.sections.quickFacts).not.toMatch(/사용 맥락|검색\/비교 맥락|성분\/효능 포인트|Use context|Search context|Ingredient\/effect detail/i);
    expect(result.content.html).toContain("geo-content-accordion");
    expect(result.diagnostics.recommendations.some((item) => item.field === "description")).toBe(true);
    expect(result.diagnostics.evidence.some((item) => item.source === "fieldMapping")).toBe(true);
    expect(result.diagnostics.ragMode).toBe("local-versioned-rag");
    expect(process.map((step) => step.id)).toEqual(["input", "normalize", "rag-load", "chunk", "embed", "retrieve", "rerank", "generate", "validate", "repair", "artifact"]);
    expect(process.every((step) => step.status === "done")).toBe(true);
  });

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
            expect(request.ragDocuments.some((document) => document.name === "schema-org-product_v1.md")).toBe(true);
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
    expect(result.content.sections.productName).toContain("Barrier Moist Cream");
    expect(result.content.sections.description).toMatch(/うるおい|保湿|バリア/);
    expect(result.diagnostics.terminology.locale).toBe("ja-JP");
    expect(result.diagnostics.terminology.appliedTerms.length).toBeGreaterThan(0);
    expect(result.schemaMarkup.scriptTag).toContain("application/ld+json");
  });

  it("filters noisy category, review keywords, and usage tokens before schema generation", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "First Care Activating Serum VI",
          description: "Hydrating serum with Korean Ginseng Actives for daily skincare.",
          brand: "Sulwhasoo",
          category: "usage",
          benefits: ["hydration", "firming"],
          ingredients: [
            "KOREAN GINSENG ACTIVES (AKA GINSENOMICS ™)- Patented ingredient that amplifies the rare and potent anti-aging compounds found in Ginseng.",
            "NIACINAMIDE"
          ],
          usage: [
            "Use morning and night, after applying toner. Warm three pumps between fingers and apply to your face and neck with upward motions.",
            "apply",
            "morning",
            "night",
            "pump"
          ],
          reviews: {
            keywords: ["rating", "smooth", "Review", "NIACINAMIDE"],
            items: [
              { body: "rating" },
              { body: "The texture feels smooth and absorbs quickly without feeling heavy.", rating: 5 }
            ]
          }
        }
      },
      source: {
        type: "pdp-extractor",
        url: "https://example.com/products/first-care-activating-serum"
      },
      hints: {
        locale: "en-US",
        market: "US"
      }
    });

    const serialized = JSON.stringify(result.schemaMarkup.jsonLd);
    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, any>;

    expect(serialized).not.toContain("GEO-ready PDP name");
    expect(product.name).toBe("First Care Activating Serum VI");
    expect(product.description).toContain("hydration");
    expect(product.category).not.toBe("usage");
    expect(product.review?.[0]?.reviewBody).toContain("smooth");
    expect(serialized).not.toContain("\"reviewBody\":\"rating\"");
    expect(howTo.step).toHaveLength(2);
    expect(howTo.step[0].text).toContain("Use morning and night");
    expect(howTo.step[1].text).toContain("Warm three pumps");
    expect(serialized).not.toContain("\"text\":\"apply\"");
    expect(result.content.sections.howToUse).not.toContain("3. apply");
    expect(result.content.sections.description).not.toContain("PDP name");
  });

  it("keeps HowTo usage scoped to the current product when extractor text includes related ritual products", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "Gentle Cleansing Foam",
          description: "A soft lathering cleanser for clean, hydrated-feeling skin.",
          brand: "Sulwhasoo",
          category: "Cleansing Foam",
          benefits: ["hydration", "removes impurities"],
          ingredients: ["Hydro-cleansing formula"],
          usage: [
            "Step 1 Dispense 2-3 pumps of GENTLE CLEASING OIL onto dry hands and gently massage onto dry face.",
            "Gently massage with a rolling motion and melt makeup away.",
            "Step 2 Dispense a dime-sized amount of GENTLE CLEANSING FOAM onto wet palms and lather with water.",
            "Massage foam onto face and rinse with lukewarm water."
          ],
          reviews: {
            keywords: ["gentle", "clean"],
            items: []
          }
        }
      },
      source: {
        type: "pdp-extractor",
        url: "https://example.com/products/gentle-cleansing-foam"
      },
      hints: {
        locale: "en-US",
        market: "US"
      }
    });

    const serialized = JSON.stringify(result.schemaMarkup.jsonLd);
    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, any>;
    const howToText = JSON.stringify(howTo.step);

    expect(serialized).not.toMatch(/gentle cleas?ing oil/i);
    expect(howToText).toMatch(/gentle cleansing foam|massage foam/i);
    expect(result.content.sections.howToUse).not.toMatch(/gentle cleas?ing oil/i);
    expect(result.content.sections.howToUse).not.toMatch(/melt makeup/i);
    expect(result.diagnostics.normalizedProduct.usage.join("\n")).not.toMatch(/gentle cleas?ing oil/i);
    expect(result.diagnostics.normalizedProduct.usage.join("\n")).not.toMatch(/melt makeup/i);
  });

  it("scopes usage generically instead of relying on a cleansing-oil-specific blocklist", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "Hydra Barrier Cream",
          description: "A daily cream for dry skin and moisture barrier support.",
          brand: "Agentic Beauty",
          category: "Cream",
          benefits: ["hydration", "barrier support"],
          ingredients: ["Ceramide", "Niacinamide"],
          usage: [
            "Apply Brightening Serum to clean skin.",
            "Massage until absorbed.",
            "Apply Hydra Barrier Cream as the final moisturizing step.",
            "Pat gently until absorbed."
          ],
          reviews: {
            keywords: ["hydrating", "comfortable"],
            items: []
          }
        }
      },
      source: {
        type: "manual-json",
        url: "https://example.com/products/hydra-barrier-cream"
      },
      hints: {
        locale: "en-US",
        market: "US"
      }
    });

    const serialized = JSON.stringify(result.schemaMarkup.jsonLd);
    const usage = result.diagnostics.normalizedProduct.usage.join("\n");

    expect(serialized).not.toMatch(/brightening serum/i);
    expect(usage).not.toMatch(/brightening serum|massage until absorbed/i);
    expect(result.content.sections.howToUse).toMatch(/hydra barrier cream|final moisturizing step|pat gently/i);
  });

  it("routes field evidence by RAG contract without product-specific cleanup rules", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "Revive Balance Lotion EX",
          description: "A lightweight lotion for hydration, comfort, and smooth-feeling skin.",
          brand: "Example Beauty",
          category: "Lotion",
          benefits: ["hydration", "comfort", "smooth texture"],
          effects: [
            "After toning, Revive Balance Lotion EX delivers 24-hour hydration, helping skin feel soft and balanced. Instrumental test on 33 participants.",
            "96% agreed skin felt moisturized for longer after daily use."
          ],
          ingredients: [
            "Botanical Complex: A formula technology described as supporting comfort and moisture.",
            "Ingredients: WATER / AQUA / EAU, GLYCERIN, BUTYLENE GLYCOL, PANTHENOL, CAMELLIA SINENSIS LEAF EXTRACT"
          ],
          usage: [
            "After toner, apply 2 pumps of Revive Balance Lotion EX to face and neck morning and night.",
            "After toning, Revive Balance Lotion EX delivers 24-hour hydration, helping skin feel soft and balanced. Instrumental test on 33 participants."
          ],
          reviews: {
            keywords: ["smooth", "comfortable", "hydrating"],
            items: []
          }
        }
      },
      source: {
        type: "manual-json",
        url: "https://example.com/products/revive-balance-lotion-ex"
      },
      hints: {
        locale: "en-US",
        market: "US"
      }
    });

    const serialized = JSON.stringify(result.schemaMarkup.jsonLd);
    const normalizedUsage = result.diagnostics.normalizedProduct.usage.join("\n");

    expect(normalizedUsage).toContain("apply 2 pumps");
    expect(normalizedUsage).not.toMatch(/delivers 24-hour hydration|Instrumental test|agreed skin felt/i);
    expect(result.content.sections.howToUse).toContain("apply 2 pumps");
    expect(result.content.sections.howToUse).not.toMatch(/delivers 24-hour hydration|Instrumental test|agreed skin felt/i);
    expect(result.content.sections.ingredients).toMatch(/Botanical Complex|Full ingredients/i);
    expect(result.content.sections.ingredients).not.toMatch(/customer-described|review language|routine fit|usage guidance|delivers 24-hour hydration|Instrumental test/i);
    expect(result.content.sections.benefits).not.toMatch(/Instrumental test|routine fit|review language around/i);
    expect(serialized).not.toMatch(/routine fit|review language around|Product details add/i);
  });

  it("does not append benefit or conflicting category terms to a product name that already has a product type", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "Gentle Cleansing Foam",
          description: "A soft lather that removes impurities while supporting hydration and comfort.",
          images: [
            "https://us.sulwhasoo.com/cdn/shop/files/SWS_Thumbnail_GCF_1080x1080_200ml.jpg"
          ],
          benefits: ["hydration", "oil control", "Benefits"],
          effects: [
            "AFTER 3 DAYS OF USE 96% AGREED FOAM FEELS GENTLE WITHOUT IRRITATION 86% AGREED PRODUCT THOROUGHLY CLEANSES MAKEUP RESIDUE 83% AGREED SKIN FEELS HYDRATED AFTER CLEANSING 1Based on a 3-day independent consumer study on 30 women 30-49."
          ],
          ingredients: [
            "Sulwhasoo’s proprietary hydro-cleansing formula leaves your skin hydrated and removes grime from pores after cleansing.",
            "WATER / AQUA / EAU, POTASSIUM COCOYL GLYCINATE, DISODIUM COCOAMPHODIACETATE"
          ],
          usage: [
            "Lather two pumps of cleansing foam and massage into damp skin morning and night, then rinse with lukewarm water."
          ],
          reviews: {
            rating: 4.8,
            reviewCount: 848,
            items: [
              { body: "Rating 4.8 · 848 reviews" }
            ]
          },
          sourceExtraction: {
            ocr: {
              textBlocks: [
                "Concentrated Ginseng Rejuvenating Serum Mini, Korean travel sized serum, product shot.",
                "Concentrated Ginseng Rejuvenating Cream Rich, korean cream, pack shot.",
                "Person applying a skincare product to their hand with text 'Gentle, Non-Stripping Formula' in the corner."
              ],
              imageTexts: [
                {
                  imageUrl: "https://us.sulwhasoo.com/cdn/shop/files/BRAND.COM_1080x1080_NewCGRSerum_01.Packshot_50ml.jpg",
                  text: "Concentrated Ginseng Rejuvenating Serum Mini, Korean travel sized serum, product shot."
                }
              ]
            }
          }
        }
      },
      source: {
        type: "pdp-extractor",
        url: "https://us.sulwhasoo.com/products/gentle-cleansing-foam?variant=41663478792237"
      },
      hints: {
        locale: "en-US",
        market: "US"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const webPage = graph.find((node) => node["@type"] === "WebPage") as Record<string, any>;
    const serialized = JSON.stringify(result);

    expect(result.content.sections.productName).toBe("Gentle Cleansing Foam");
    expect(product.name).toBe("Gentle Cleansing Foam");
    expect(product.description).toContain("Gentle Cleansing Foam is a cleanser");
    expect(product.description).toContain("hydro-cleansing formula");
    expect(product.description).toContain("hydrated");
    expect(product.description).toContain("Reported assessment of 30 women evidence covers");
    expect(product.description).not.toContain("is a product");
    expect(product.description).not.toMatch(/hydratedMulberry|:Helps|Formula details state that/i);
    expect(product.description).not.toMatch(/\bBenefits\b/);
    expect(product.description).not.toMatch(/Rating 4\.?\s*8|848 reviews|Representative customer reviews/i);
    expect(product.review).toBeUndefined();
    expect(product.category).toBeUndefined();
    expect(webPage.name).toBe("Gentle Cleansing Foam");
    expect(webPage.description).not.toContain("evaluate the serum");
    expect(webPage.description).toContain("summarizes specific product facts");
    expect(webPage.description).toContain("about the cleanser for customers");
    expect(webPage.description).toContain("hydro-cleansing formula");
    expect(webPage.description).toContain("product-detail evidence about foam gentleness");
    expect(webPage.description).not.toMatch(/customers concerned with dryness evaluating|hydratedMulberry|:Helps/i);
    expect(webPage.description).not.toMatch(/\bBenefits\b/);
    expect(result.content.sections.quickFacts).toContain("Consumer assessment");
    expect(result.content.sections.benefits).not.toMatch(/96%|86%|83%|1based|Product details add In/i);
    expect(JSON.stringify({ schemaMarkup: result.schemaMarkup, content: result.content })).not.toMatch(/1based|Product details pair In|Product details include In|Product details add In/i);
    expect((product.additionalProperty as Array<Record<string, any>>).some((item) =>
      item.name === "Reported details" && String(item.value).includes("96%")
    )).toBe(true);
    expect(JSON.stringify(result.schemaMarkup.jsonLd)).not.toContain("Gentle Cleansing Foam hydration Serum");
    expect(serialized).not.toMatch(/product shot|pack shot|travel sized serum|model applying product|person applying|with text|in the corner|Concentrated Ginseng Rejuvenating Serum Mini|Concentrated Ginseng Rejuvenating Cream Rich/i);
    expect(result.diagnostics.normalizedProduct.sourceTexts.join("\n")).not.toMatch(/product shot|pack shot|model applying product|person applying|with text|in the corner/i);
    expect(result.diagnostics.normalizedProduct.ingredients.join("\n")).not.toMatch(/product shot|pack shot|Concentrated Ginseng/i);
    expect(result.diagnostics.normalizedProduct.benefits).not.toContain("Benefits");
    expect(result.diagnostics.ocrSentences).toHaveLength(0);
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
    const refinedProductDescription = "Hydra Balance Essence is an essence for dry skin, highlighting hydration, barrier support, hyaluronic acid, and a morning-and-night routine without adding unsupported claims.";
    const refinedWebPageDescription = "This Hydra Balance Essence product page summarizes hydration, barrier support, hyaluronic acid, and morning-and-night usage so customers can compare the essence using product-backed details.";

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
          async refineCopy(request) {
            expect(request.schemaMarkup.jsonLd["@graph"]).toBeTruthy();
            expect(request.content.sections.description).toContain("Hydra Balance Essence");
            return {
              schemaDescriptions: {
                product: refinedProductDescription,
                webPage: refinedWebPageDescription
              },
              contentSections: {
                description: refinedProductDescription
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
    const webPage = graph.find((node) => node["@type"] === "WebPage") as Record<string, any>;
    const finalStep = result.diagnostics.runtimeUsage?.steps.find((step) => step.stage === "final");

    expect(product.description).toBe(refinedProductDescription);
    expect(webPage.description).toBe(refinedWebPageDescription);
    expect(result.content.sections.description).toBe(refinedProductDescription);
    expect(result.content.html).toContain(refinedProductDescription);
    expect(result.diagnostics.evidence.some((item) => item.field === "copy.refinement" && item.source === "llm")).toBe(true);
    expect(finalStep?.called).toBe(true);
    expect(finalStep?.tokenUsage?.totalTokens).toBe(200);
    expect(result.diagnostics.runtimeUsage?.tokenTotals.totalTokens).toBe(200);
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
          contentSections: {
            description: "Hydra Balance Essence is an essence for dry skin that highlights hydration, barrier support, hyaluronic acid, and morning-and-night use."
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
          }
        ],
        reasoning: undefined
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(capturedBody?.instructions).toContain("GEO research/geo-paper, CEP, and E-E-A-T");
    const payload = JSON.parse(String(capturedBody?.input ?? "{}")) as Record<string, any>;
    expect(payload.task).toContain("AI-exposure-worthy");
    expect(payload.extractionPriorities).toEqual(expect.arrayContaining([
      expect.stringContaining("customer-entry-point"),
      expect.stringContaining("E-E-A-T")
    ]));
    expect(payload.strategicExposureGuidance).toHaveLength(3);
    expect(payload.strategicExposureGuidance.map((item: Record<string, unknown>) => item.kind)).toEqual(["geo-research", "cep", "eeat"]);
  });

  it("selects package GEO, CEP, and E-E-A-T RAG chunks during generation", async () => {
    let capturedBody: Record<string, any> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, any>;
      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          schemaDescriptions: {
            product: "Hydra Barrier Serum is a serum for dry-feeling skin that highlights barrier support, niacinamide, ceramide, and morning-and-night use.",
            webPage: "This Hydra Barrier Serum page summarizes barrier support, niacinamide, ceramide, usage, and review language for comparison-ready product evaluation."
          },
          contentSections: {
            description: "Hydra Barrier Serum is a serum for dry-feeling skin with niacinamide, ceramide, and lightweight review language."
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
      const strategicKinds = payload.strategicExposureGuidance.map((item: Record<string, unknown>) => item.kind);
      const hydratedKinds = result.diagnostics.hydratedRagDocuments?.map((document) => document.kind);
      const fullDocumentKinds = payload.strategicFullDocuments.map((item: Record<string, unknown>) => item.kind);

      expect(result.diagnostics.ragQueryPlan?.mode).toBe("agentic-subquery-planning");
      expect(result.diagnostics.ragQueryPlan?.queries.map((query) => query.target)).toEqual(expect.arrayContaining(["faq", "howToUse"]));
      expect(selectedKinds).toEqual(expect.arrayContaining(["geo-research", "cep", "eeat"]));
      expect(strategicKinds).toEqual(expect.arrayContaining(["geo-research", "cep", "eeat"]));
      expect(hydratedKinds).toEqual(expect.arrayContaining(["geo-research", "cep", "eeat"]));
      expect(fullDocumentKinds).toEqual(expect.arrayContaining(["geo-research", "cep", "eeat"]));
      expect(payload.strategicFullDocuments.find((item: Record<string, unknown>) => item.kind === "eeat")?.content)
        .toContain("Trust-First Claim Safety");
      expect(payload.strategicFullDocuments.find((item: Record<string, unknown>) => item.kind === "cep")?.content)
        .toContain("CEP Identification and Prioritization");
      expect(payload.strategicFullDocuments.find((item: Record<string, unknown>) => item.kind === "geo-research")?.content)
        .toContain("Research-Backed GEO Principles");
      expect(payload.hydrationPolicy).toEqual(expect.arrayContaining([
        expect.stringContaining("Selected chunks are the highest-priority")
      ]));
      expect(result.diagnostics.evidence.some((item) => item.field === "copy.refinement" && item.value.includes("GEO research, CEP, and E-E-A-T"))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps GEO, CEP, and E-E-A-T coverage under single-query retrieval with eight final chunks", async () => {
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
        brand: "Sulwhasoo",
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
        scoreThreshold: 0
      }
    });

    const selectedKinds = result.diagnostics.selectedRagChunks.map((chunk) => chunk.kind);
    const hydratedKinds = result.diagnostics.hydratedRagDocuments?.map((document) => document.kind);
    const reasoningSources = result.diagnostics.reasoning?.decisions.flatMap((decision) => decision.ragSources) ?? [];

    expect(result.diagnostics.ragQueryPlan?.mode).toBe("single-query");
    expect(selectedKinds).toEqual(expect.arrayContaining(["geo-research", "cep", "eeat"]));
    expect(hydratedKinds).toEqual(expect.arrayContaining(["geo-research", "cep", "eeat"]));
    expect(reasoningSources).toEqual(expect.arrayContaining([
      expect.stringContaining("geo-research"),
      expect.stringContaining("cep"),
      expect.stringContaining("eeat")
    ]));
    expect(result.diagnostics.runtimeUsage?.steps.find((step) => step.stage === "reranking")?.details)
      .toContain("contextual hybrid reranking");
  });

  it("uses OCR sentence insights to enrich effect, ingredient, full ingredient, and schema notes", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "Concentrated Ginseng Rejuvenating Serum",
          description: "A serum with Korean Ginseng Actives.",
          category: "Serum",
          benefits: [],
          effects: [],
          ingredients: [],
          usage: ["Apply morning and night after toner."],
          reviews: {
            keywords: [],
            items: []
          },
          sourceExtraction: {
            ocr: {
              sentenceInsights: [
                {
                  imageUrl: "https://example.com/ginseng-peptide.jpg",
                  category: "ingredient",
                  text: "Ginseng Peptide™ is a 6-peptide blend that combines a potent ginseng-extracted peptide with 5 other peptides.",
                  keywords: ["Ginseng Peptide", "peptide"]
                },
                {
                  imageUrl: "https://example.com/ginseng-peptide.jpg",
                  category: "effect",
                  text: "This advanced formula, working synergistically with Korean Ginseng Actives, enhances skin firmness, elasticity, and resilience, helping to diminish visible signs of aging.",
                  keywords: ["Korean Ginseng Actives", "firmness", "elasticity", "resilience"]
                },
                {
                  imageUrl: "https://example.com/ginseng-peptide.jpg",
                  category: "ingredient",
                  text: "INGREDIENTS: WATER / AQUA / EAU, GLYCERIN, NIACINAMIDE, PANAX GINSENG ROOT EXTRACT, GINSENG PEPTIDE, RETINOL.",
                  keywords: ["NIACINAMIDE", "PANAX GINSENG ROOT EXTRACT", "RETINOL"]
                }
              ]
            }
          }
        }
      },
      hints: {
        locale: "en-US",
        market: "US",
        category: "Serum"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const additionalProperties = product.additionalProperty as Array<Record<string, any>>;
    const positiveNotes = product.positiveNotes.itemListElement as Array<Record<string, any>>;
    const ocrDiagnostics = result.diagnostics.ocrSentences;

    expect(result.content.sections.description).toMatch(/supports|formula|texture|routine|visible benefits|key actives|comfort/);
    expect(result.content.sections.description).not.toContain("This advanced formula, working synergistically");
    expect(result.content.sections.description).not.toContain("concise ingredient/effect claim for product comparison");
    expect(result.content.sections.ingredients).toContain("Ginseng Peptide");
    expect(result.content.sections.ingredients).toContain("Full ingredients: WATER / AQUA / EAU");
    expect(additionalProperties.some((item) => item.name === "Ingredient/effect detail" && /formula|texture|routine|benefit|comfort/.test(String(item.value)))).toBe(true);
    expect(additionalProperties.some((item) => item.name === "Full ingredients" && String(item.value).includes("PANAX GINSENG ROOT EXTRACT"))).toBe(true);
    expect(positiveNotes.map((item) => item.name)).toEqual(expect.arrayContaining(["skin resilience", "elasticity", "firmness"]));
    expect(ocrDiagnostics.find((item) => item.text.includes("6-peptide blend"))?.imageUrls).toEqual(["https://example.com/ginseng-peptide.jpg"]);
    expect(JSON.stringify(result.schemaMarkup.jsonLd)).not.toMatch(/ingredient\/effect claim|Citation highlight|citation highlight|benefit terms|ingredient context|use-feel comparison|product discovery context|Product detail context|comparison intent|comparison-led|texture language|use-feel language|benefit language|ingredient terms|ingredient and technology term|product benefit term/i);
  });

  it("classifies raw OCR image text into varied Korean ingredient and benefit schema content", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "에스트라 아토베리어365 하이드로 수딩크림",
          description: "민감하고 수분이 부족한 지성 피부를 위한 수딩 크림입니다.",
          brand: "AESTURA",
          category: "Cream",
          usage: ["아침과 저녁 스킨케어 마지막 단계에서 얼굴 전체에 부드럽게 펴 바릅니다."],
          reviews: {
            keywords: ["수분감", "산뜻함", "피부결"],
            items: []
          },
          sourceExtraction: {
            ocr: {
              images: [
                {
                  imageUrl: "https://example.com/aestura-hero.jpg",
                  lines: [
                    "아토베리어365",
                    "하이드로 수딩크림",
                    "민감하고 수분이 부족한 지성 피부의",
                    "유수분 밸런스를 맞추고",
                    "속수분을 채워주는 장벽수분 캡슐크림"
                  ]
                },
                {
                  imageUrl: "https://example.com/aestura-ingredients.jpg",
                  text: [
                    "압축 히알루론산",
                    "특허 기술로 1/100 사이즈로 압축한",
                    "히알루론산의 흡수 빠른 수분 충전으로",
                    "탁월한 수분 지속 효과",
                    "징크",
                    "피지 조절에 효과적인 징크로",
                    "과잉 유분 컨트롤",
                    "고밀도 세라마이드 캡슐",
                    "길이가 긴 롱체인 세라마이드와",
                    "연결고리를 조여주는 링커 세라마이드로",
                    "민감피부의 짧고 부족한 세라마이드를",
                    "보완해 보다 촘촘하고 견고한 구조의",
                    "캡슐로 장벽 보습"
                  ].join("\n")
                }
              ]
            }
          }
        }
      },
      hints: {
        locale: "ko-KR",
        market: "KR",
        category: "크림"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const additionalProperties = product.additionalProperty as Array<Record<string, any>>;
    const keyIngredients = additionalProperties.find((item) => item.name === "Key ingredients")?.value;
    const ingredientEffectDetail = additionalProperties.find((item) => item.name === "Ingredient/effect detail")?.value;
    const serialized = JSON.stringify(result.schemaMarkup.jsonLd);
    const ocrDiagnostics = result.diagnostics.ocrSentences;

    expect(product.description).toContain("압축 히알루론산");
    expect(product.description).toMatch(/징크|고밀도 세라마이드 캡슐|피부 장벽|유분 컨트롤|수분감/);
    expect(result.content.sections.quickFacts).toMatch(/압축 히알루론산|징크|고밀도 세라마이드 캡슐/);
    expect(result.content.sections.benefits).toMatch(/수분감|유분 컨트롤|피부 장벽/);
    expect(result.content.sections.benefits).toMatch(/1\/100|과잉 유분|롱체인|링커 세라마이드|장벽 보습/);
    expect(result.content.sections.faq).toMatch(/압축 히알루론산|징크|고밀도 세라마이드 캡슐/);
    expect(result.content.sections.faq).toMatch(/1\/100|과잉 유분|롱체인|장벽 보습|수분감|유분 컨트롤|피부 장벽/);
    expect(result.content.sections.faq).not.toMatch(/OCR|인용|What does .* explain/);
    expect(result.content.sections.ingredients).toContain("압축 히알루론산");
    expect(result.content.sections.ingredients).toContain("징크");
    expect(result.content.sections.ingredients).toContain("고밀도 세라마이드 캡슐");
    expect(String(keyIngredients)).toMatch(/압축 히알루론산|징크|고밀도 세라마이드 캡슐/);
    expect(String(ingredientEffectDetail)).toMatch(/수분감|유분 컨트롤|피부 장벽|핵심 포인트|성분 포인트|성분 정보|주요 확인 요소/);
    expect(String(ingredientEffectDetail)).not.toMatch(/성분\/기술은\s*[^.]*맞물려 제품 특징을 구체화합니다/);
    expect(ocrDiagnostics.some((item) => item.text === "압축 히알루론산. 특허 기술로 1/100 사이즈로 압축한 히알루론산의 흡수 빠른 수분 충전으로 탁월한 수분 지속 효과")).toBe(true);
    expect(ocrDiagnostics.some((item) => item.text === "징크. 피지 조절에 효과적인 징크로 과잉 유분 컨트롤")).toBe(true);
    expect(ocrDiagnostics.some((item) => item.text === "고밀도 세라마이드 캡슐. 길이가 긴 롱체인 세라마이드와 연결고리를 조여주는 링커 세라마이드로 민감피부의 짧고 부족한 세라마이드를 보완해 보다 촘촘하고 견고한 구조의 캡슐로 장벽 보습")).toBe(true);
    expect(ocrDiagnostics.some((item) => item.text.includes("압축 히알루론산") && item.intents.includes("ingredient") && item.intents.includes("effect"))).toBe(true);
    expect(ocrDiagnostics.some((item) => item.text.includes("징크") && item.schemaFields.includes("content.sections.benefits"))).toBe(true);
    expect(ocrDiagnostics.some((item) => item.text.includes("고밀도 세라마이드 캡슐") && item.geoUse === "ingredient_effect_evidence")).toBe(true);
    expect(ocrDiagnostics.find((item) => item.text.includes("압축 히알루론산"))?.imageUrls).toEqual(["https://example.com/aestura-ingredients.jpg"]);
    expect(ocrDiagnostics.every((item) => item.text.length > 0 && item.schemaFields.length > 0 && item.geoUse.length > 0)).toBe(true);
    expect(serialized).not.toMatch(/효능어|성분어|사용감어|성분 구성, 기대 효능, 사용감 차이|함께 보여줍니다|제품 탐색 문맥|탐색 문맥에서/);
  });

  it("reconstructs English OCR heading and body lines as semantic sentences", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "Barrier Hydro Cream",
          description: "A lightweight cream for hydration and skin barrier support.",
          brand: "AESTURA",
          category: "Cream",
          sourceExtraction: {
            ocr: {
              images: [
                {
                  imageUrl: "https://example.com/english-ingredient-panel.jpg",
                  lines: [
                    "Compressed Hyaluronic Acid",
                    "Patented technology compresses hyaluronic acid to 1/100 size",
                    "for fast moisture charging and lasting hydration",
                    "Zinc",
                    "Helps control excess oil and sebum",
                    "High-density Ceramide Capsule",
                    "Long-chain ceramide and linker ceramide help reinforce",
                    "skin barrier moisture for sensitive skin"
                  ]
                }
              ]
            }
          }
        }
      },
      hints: {
        locale: "en-US",
        market: "US",
        category: "Cream"
      }
    });

    const ocrDiagnostics = result.diagnostics.ocrSentences;

    expect(ocrDiagnostics.some((item) => item.text === "Compressed Hyaluronic Acid. Patented technology compresses hyaluronic acid to 1/100 size for fast moisture charging and lasting hydration")).toBe(true);
    expect(ocrDiagnostics.some((item) => item.text === "Zinc. Helps control excess oil and sebum")).toBe(true);
    expect(ocrDiagnostics.some((item) => item.text === "High-density Ceramide Capsule. Long-chain ceramide and linker ceramide help reinforce skin barrier moisture for sensitive skin")).toBe(true);
    expect(ocrDiagnostics.some((item) => item.text.includes("Compressed Hyaluronic Acid") && item.intents.includes("ingredient") && item.intents.includes("benefit"))).toBe(true);
    expect(ocrDiagnostics.find((item) => item.text.includes("Compressed Hyaluronic Acid"))?.imageUrls).toEqual(["https://example.com/english-ingredient-panel.jpg"]);
    expect(ocrDiagnostics.every((item) => !item.text.includes(": Patented technology") && !item.text.includes(": Helps control"))).toBe(true);
    expect(result.content.sections.benefits).toMatch(/Compressed Hyaluronic Acid|Zinc|High-density Ceramide Capsule/);
    expect(result.content.sections.benefits).toMatch(/1\/100|excess oil|Long-chain|barrier moisture/);
    expect(result.content.sections.faq).toMatch(/Compressed Hyaluronic Acid|Zinc|High-density Ceramide Capsule/);
    expect(result.content.sections.faq).not.toMatch(/What does .* explain about|OCR|citation/i);
  });

  it("keeps varied Korean GEO content from existing product, RAG, and review data when OCR is absent", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "에스트라 아토베리어365 하이드로 수딩크림",
          description: "민감하고 수분이 부족한 지성 피부를 위한 산뜻한 장벽 수분 크림입니다.",
          brand: "AESTURA",
          category: "Cream",
          benefits: ["수분감", "피부 장벽", "유분 컨트롤", "산뜻한 사용감"],
          effects: ["수분감을 높인 워터 크림 제형으로 피부에 닿을 때 시원하고 산뜻한 쿨링감을 제공합니다."],
          ingredients: ["압축 히알루론산", "고밀도 세라마이드 캡슐", "징크"],
          usage: ["아침과 저녁 스킨케어 마지막 단계에서 얼굴 전체에 부드럽게 펴 바릅니다."],
          reviews: {
            keywords: ["수분감", "산뜻함", "피부결", "촉촉한 사용감"],
            items: [
              { body: "가볍게 발리고 수분감이 오래 남아서 지성 피부에도 부담이 적어요.", rating: 5 },
              { body: "피부결이 매끈해 보이고 산뜻해서 아침 루틴에 쓰기 좋아요.", rating: 5 }
            ]
          }
        }
      },
      hints: {
        locale: "ko-KR",
        market: "KR",
        category: "크림"
      },
      rag: {
        maxChunks: 10,
        scoreThreshold: 0,
        documents: [
          {
            name: "geo-answer-composition_v1.md",
            content: [
              "# GEO Answer Composition",
              "",
              "- Compose benefit statements from target customer, benefit, ingredient or technology, usage context, review signal, and evidence.",
              "- If OCR evidence is not present, use existing mapped product facts, selected RAG chunks, and customer review language to keep descriptions, benefits, HowTo, and FAQ varied."
            ].join("\n")
          }
        ]
      }
    });

    const serialized = JSON.stringify(result.schemaMarkup.jsonLd);

    expect(result.diagnostics.ocrSentences).toHaveLength(0);
    expect(result.content.sections.benefits).toMatch(/수분감|피부 장벽|유분 컨트롤|산뜻한 사용감/);
    expect(result.content.sections.benefits).toMatch(/압축 히알루론산|고밀도 세라마이드 캡슐|징크|리뷰 표현|사용감 맥락|루틴/);
    expect(result.content.sections.faq).toMatch(/압축 히알루론산|수분감|피부 장벽|산뜻함|피부결|촉촉한 사용감/);
    expect(result.content.sections.howToUse).toContain("아침과 저녁 스킨케어 마지막 단계");
    expect(result.content.sections.quickFacts).toMatch(/주요 성분|고객 리뷰|비교할 때/);
    expect(result.content.sections.quickFacts).not.toMatch(/사용 맥락|검색\/비교 맥락|성분\/효능 포인트|Use context|Search context|Ingredient\/effect detail/i);
    expect(result.content.sections.benefits).not.toContain("상품 JSON에서 확인된 효능/혜택 정보가 충분하지 않습니다.");
    expect(serialized).not.toMatch(/OCR|What does .* explain|인용|상품 상세의 압축 히알루론산 설명/);
  });

  it("reconstructs HowTo and FAQ with selected GEO RAG guidance instead of exposing raw source text only", async () => {
    const { result } = await generatePdpGeo({
      product: {
        name: "Ginseng Barrier Serum",
        description: "Daily serum for hydration and skin barrier care.",
        category: "Serum",
        benefits: ["hydration", "skin barrier support"],
        ingredients: ["Niacinamide", "Panax Ginseng Root Extract"],
        usage: ["Apply morning and night after serum."],
        faq: [
          {
            question: "Can I use it daily?",
            answer: "Apply morning and night after serum."
          }
        ],
        reviews: {
          rating: 4.7,
          reviewCount: 128,
          keywords: ["absorbs quickly", "hydration"]
        }
      },
      hints: {
        locale: "en-US",
        market: "US",
        category: "Serum"
      },
      rag: {
        maxChunks: 10,
        scoreThreshold: 0,
        documents: [
          {
            name: "geo-answer-composition_v1.md",
            content: [
              "# GEO Answer Composition",
              "",
              "- Reconstruct PDP content into answer-ready FAQ and stepwise HowTo sections.",
              "- Compose benefit statements from target customer, core benefit, ingredient or technology, usage context, review signal, and evidence.",
              "- Keep claims grounded in source facts and make generated answers easy to synthesize."
            ].join("\n")
          }
        ]
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, any>;
    const faq = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
    const serialized = JSON.stringify(result.schemaMarkup.jsonLd);

    expect(result.content.sections.howToUse).toContain("Apply morning and night after serum");
    expect(result.content.sections.howToUse).not.toContain("hydration");
    expect(result.content.sections.howToUse.trim()).toBe("1. Apply morning and night after serum");
    expect(result.content.sections.faq).toContain("How should Ginseng Barrier Serum be used?");
    expect(result.content.sections.faq).toContain("What do customer reviews highlight about Ginseng Barrier Serum?");
    expect(result.content.sections.faq).toContain("Niacinamide");
    expect(result.content.sections.faq).toContain("Product details");
    expect(result.content.sections.faq).not.toContain("Product detail context");
    expect(result.content.sections.faq).not.toContain("Available product information");
    expect(result.content.sections.faq).not.toContain("Evidence signal");
    expect(result.content.sections.faq).not.toContain("Review signals");
    expect(serialized).not.toMatch(/Evidence signal|Review signals|technology signals|main benefit signal|benefit terms|ingredient context|use-feel comparison|product discovery context|Product detail context|comparison intent|comparison-led|texture language|use-feel language|benefit language|ingredient terms|ingredient and technology term|product benefit term/i);
    expect(result.content.sections.faq).not.toContain("Can I use it daily?");
    expect(result.content.sections.faq).not.toContain("A. Apply morning and night after serum.");
    expect(howTo.step[0].text).toBe("Apply morning and night after serum");
    expect(howTo.step[0].name).toBe("Step 1");
    expect(faq.mainEntity.some((item: any) => item.name === "How should Ginseng Barrier Serum be used?")).toBe(true);
    expect(faq.mainEntity.some((item: any) => item.name === "Can I use it daily?")).toBe(false);
    expect(faq.mainEntity.some((item: any) => item.name === "What do customer reviews highlight about Ginseng Barrier Serum?")).toBe(true);
    expect(result.diagnostics.evidence.some((item) => item.field === "rag.geoOptimizationGuidance")).toBe(true);
    expect(result.diagnostics.recommendations.some((item) => item.field === "faq")).toBe(true);
    expect(result.diagnostics.ragUsage.length).toBeGreaterThan(0);
    expect(result.diagnostics.ragUsage.some((item) => item.principle === "answer-ready FAQ" && item.references.some((reference) => reference.fieldTargets.includes("FAQPage.mainEntity")))).toBe(true);
    expect(result.diagnostics.ragUsage.some((item) => item.principle === "stepwise HowTo" && item.references.some((reference) => reference.fieldTargets.includes("HowTo.step")))).toBe(true);
  });

  it("keeps positiveNotes and benefit context free of marketing fragments and clinical sample fragments", async () => {
    const { result } = await generatePdpGeo({
      product: {
        name: "Concentrated Ginseng Rejuvenating Serum",
        description: "A serum formulated with Korean Ginseng Actives and Retinol for visible plumpness and firmness.",
        category: "Serum",
        benefits: [
          "Formulated with our advanced capsule technology, enriched with Korean Ginseng Actives™ and Retinol. This powerhouse serum melts into skin on contact improving the look of plumpness, skin resilience, and fine lines and wrinkles, while delivering essential nutrients."
        ],
        effects: [
          "After 6 weeks of use 100% of users showed improvement in: Fine Lines & Wrinkles* Elasticity* Firmness* *Instrumental result, 32 women"
        ],
        ingredients: ["Korean Ginseng Actives™", "Retinol"],
        usage: [
          "Use morning and night, after applying toner. Warm three pumps between fingers and apply to your face and neck with upward motions.",
          "Warm three pumps of serum between fingers and apply to your face and neck with upward motions."
        ],
        reviews: {
          keywords: ["smooth", "moisture", "firmness"],
          items: [
            { body: "My skin feels smoother and firmer, and the serum absorbs without heaviness.", rating: 5 }
          ]
        }
      },
      source: {
        type: "manual-json",
        url: "https://example.com/products/concentrated-ginseng-rejuvenating-serum"
      },
      hints: {
        locale: "en-US",
        market: "US",
        category: "Serum"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const webPage = graph.find((node) => node["@type"] === "WebPage") as Record<string, any>;
    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, any>;
    const notes = product.positiveNotes.itemListElement.map((item: any) => item.name);
    const serialized = JSON.stringify(result.schemaMarkup.jsonLd);

    expect(notes).toEqual(expect.arrayContaining(["fine lines and wrinkles", "elasticity", "firmness", "plumpness"]));
    expect(webPage.description).toContain("summarizes specific product facts");
    expect(webPage.description).toContain("fine lines and wrinkles");
    expect(webPage.description).toContain("Korean Ginseng Actives");
    expect(webPage.description).toContain("The page states that");
    expect(webPage.description).toContain("Usage guidance covers");
    expect(webPage.description).toContain("smooth");
    expect(product.description).toContain("fine lines and wrinkles");
    expect(product.description).toContain("Korean Ginseng Actives");
    expect(product.description).toContain("Retinol");
    expect(product.description).toContain("Use it morning and night after toner, then warm three pumps");
    expect(product.description).not.toContain("aroun…");
    expect(product.description).not.toContain("making the benefit and ingredient story understandable");
    expect(product.description).not.toContain("product page");
    expect(product.description).toContain("Representative customer reviews describe it as");
    expect(product.description).toContain("My skin feels smoother and firmer");
    expect(product.description).toContain("repeated review language such as");
    expect(product.description).toContain("smooth");
    expect(product.description).toContain("moisture");
    expect(product.description).toContain("firmness");
    expect(product.description).toContain("100% of users showed improvement");
    expect(product.description).not.toContain("Source information includes 6 weeks");
    expect(webPage.description).not.toBe(product.description);
    expect(notes.some((name: string) => /Formulated with|while delivering|32 women|Instrumental result/i.test(name))).toBe(false);
    expect(serialized).not.toContain("Formulated with our advanced capsule technology routine");
    expect(serialized).not.toContain("\"name\":\"32 women\"");
    expect(howTo.step).toHaveLength(2);
  });

  it("normalizes uppercase self-assessment result fragments before using them in descriptions", async () => {
    const { result } = await generatePdpGeo({
      product: {
        name: "Concentrated Ginseng Rejuvenating Serum",
        description: "A ginseng serum for firmness, elasticity, and fine lines.",
        category: "Serum",
        benefits: ["fine lines and wrinkles", "firmness", "elasticity"],
        effects: [
          "100% AGREED SKIN FEELS FIRMER AND MORE ELASTIC2 100% AGREED SKIN TEXTURE FEELS IMPROVED AND MORE EVEN2 93% AGREED FINE LINES AND WRINKLES FEEL DIMINISHED2 2Self-assessment test conducted 6 weeks after use on 32 women"
        ],
        ingredients: [
          "KOREAN GINSENG ACTIVES (AKA GINSENOMICS ™)- Patented ingredient that amplifies the rare and potent anti-aging compounds found in Ginseng",
          "Ginseng Peptide - Helps support the look of skin firmness and elasticity, synergistically enhancing the benefits of Korean Ginseng Actives"
        ],
        usage: ["Use morning and night, after applying toner."],
        reviews: {
          keywords: ["smooth", "firmness"]
        }
      },
      source: {
        type: "manual-json",
        url: "https://example.com/products/concentrated-ginseng-rejuvenating-serum"
      },
      hints: {
        locale: "en-US",
        market: "US",
        category: "Serum"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const webPage = graph.find((node) => node["@type"] === "WebPage") as Record<string, any>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const faq = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;
    const serialized = JSON.stringify({ webPage, product, faq });
    const productSerialized = JSON.stringify(product);
    const additionalProperties = new Map(product.additionalProperty.map((item: any) => [item.name, item.value]));
    const positiveNotes = product.positiveNotes.itemListElement.map((item: any) => item.name);

    expect(webPage.description).toContain("product-detail evidence about firmness and visible-aging care");
    expect(product.description).toContain("Korean Ginseng Actives (Ginsenomics), a patented ingredient described as amplifying rare ginseng compounds");
    expect(product.description).toContain("Ginseng Peptide, described as supporting the look of skin firmness and elasticity");
    expect(product.description).toContain("Use it morning and night after toner");
    expect(product.description).toContain("Customer reviews mention smooth and firmness, which supports the product's texture");
    expect(product.description).toContain("Reported self-assessment of 32 women after 6 weeks of use evidence covers firmness and visible-aging care");
    expect(product.description).not.toContain("Reported product details include In a");
    expect(product.description).not.toContain("product page");
    expect(product.description).not.toContain("…");
    expect(product.additionalProperty.some((item: any) => item.name === "Quick facts")).toBe(false);
    expect(product.additionalProperty.some((item: any) => /\\n|\n/.test(String(item.value)))).toBe(false);
    expect(additionalProperties.get("Target customer")).toContain("customers");
    expect(additionalProperties.get("Key benefit")).toBe("fine lines and wrinkles");
    expect(additionalProperties.get("Reported details")).toContain("In a self-assessment of 32 women after 6 weeks of use");
    expect(additionalProperties.get("Reported details")).not.toMatch(/elastic2|even2|diminished2|\(32 women\)/i);
    expect(additionalProperties.get("Key ingredients")).toContain("Korean Ginseng Actives (Ginsenomics), Ginseng Peptide");
    expect(positiveNotes).toEqual(expect.arrayContaining(["fine lines and wrinkles", "firmness", "elasticity"]));
    expect(productSerialized).not.toContain("AGREED");
    expect(productSerialized).not.toMatch(/Self-assessme…|Strengthen…|GINSENG ACTIVES \(AKA|2Self-assessment|elastic2|even2|diminished2|\(32 women\)/i);
    expect(productSerialized).not.toContain("\\n");
    expect(serialized).not.toContain("AGREED");
    expect(serialized).not.toMatch(/Self-assessme…|Strengthen…|GINSENG ACTIVES \(AKA|2Self-assessment|elastic2|even2|diminished2|\(32 women\)/i);
  });

  it("cleans Korean Aestura-style OCR, review typos, and property chunks before schema generation", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "에스트라 아토베리어365 하이드로 수딩크림",
          description: "민감 피부를 위한 산뜻한 수분 크림입니다.",
          brand: "AESTURA",
          category: "Cream",
          benefits: [
            "hydration",
            "리뉴얼 전 제품에서 고객님들이 만족하셨던 속성 (수분감, smooth texture, 피부결",
            "리뉴얼 전 제품에서 고객님들이 만족하셨던 속성 (수분감, 쿨링, 붉은기 개선, 저자극)은 유지 또는 더 강화되었습니다.여기에 핵심 기능인 수분과 장벽 개선을 위해 압축 히알루론산, 고밀도 세라마이드 캡슐이 더해졌고 민감 피부를 위한 안전성 테스트도 강화하였습니다.",
            "쿨링 효과는 어떤 성분이 해주는 것인가요?",
            "쿨링을 주는 화학적 성분은 자칫 피부에 자극을 줄 수 있기 때문에 수분감을 높인 워터 크림 특화 제형을 통해 피부에 닿음과 동시에 시원하고 산뜻한 쿨링감을 줄 수 있게 설계되었습니다.",
            "각 크림에는 피부타입과 피부고민을 고려한 최적의 함량의 캡슐이 함유되어 있습니다.캡슐은 우리 피부 지질과 유사성분/구조로 이루어져 있으며 캡슐 형태이기 때문에 손상된 피부장벽 빈틈을 오래 잡아주며 장벽을 튼튼하게 강화시켜줍니다."
          ],
          effects: [
            "쿨링을 주는 화학적 성분은 자칫 피부에 자극을 줄 수 있기 때문에 수분감을 높인 워터 크림 특화 제형을 통해 피부에 닿음과 동시에 시원하고 산뜻한 쿨링감을 줄 수 있게 설계되었습니다."
          ],
          ingredients: [
            "쿨링을 주는 화학적 성분은 ... 설계되었습니다.",
            "두 크림에 함유된 캡슐은 자사의 특허 성분인 ‘고밀도 세라마이드 캡슐’로 동일합니다.",
            "아토베리어365 크림에 함유된 캡슐과 동일한 캡슐인가요?",
            "캡슐이 있어서 좋은 이유는 무엇인가요?",
            "각 크림에는 피부타입과 피부고민을 고려한 최적의 함량의 캡슐이 함유되어 있습니다.캡슐은 우리 피부 지질과 유사성분/구조로 이루어져 있으며 캡슐 형태이기 때문에 손상된 피부장벽 빈틈을 오래 잡아주며 장벽을 튼튼하게 …",
            "히알루론산"
          ],
          usage: [
            "아침과 저녁 스킨케어 마지막 단계에서 얼굴 전체에 부드럽게 펴 바릅니다.",
            "여드름성 피부가 사용해도 괜찮은가요?",
            "여드름성 피부 사용적합 테스트인 논코메도제닉 테스트를 완료한 제품입니다.",
            "영유아나 임산부가 사용해도 되나요?",
            "소아과 피부 테스트를 진행한 품목으로 영유아, 어린이가 사용해도 무방하며, 임산부가 우려할 만한 성분도 함유되어 있지 않습니다.다만 우려가 되는 경우 연약한 피부 부위(귀 뒤, 팔 안쪽 등)에 먼저 테스트 후 사용하시고 필요 시, 전문가와 상담 후 사용하시기 바랍니다."
          ],
          metrics: [
            "아토베리어365 크림에 함유된 캡슐과 동일한 캡슐인가요?",
            "https://images-kr.amoremall.com/fileupload/reviews/2026/06/18/JPEG_20260618_223402_7170014327977572094_1781789656867.jpg?format=webp"
          ],
          reviews: {
            keywords: ["피부결", "만족합니다", "촉촉하고", "보습력도", "smooth texture"],
            items: [
              {
                body: "에스트라는 그냥 너무 좋아요 많은 말도 필요없고 속단김이나 건조함 잡는데는 정말 좋나요 메이크업 전에 무거운 베이스가 싫은데 에스트라는 아주 가벼우면서도 건조함을 잘 채워줘서 좋어요 모든 베이스 라인을 다 에스트라로 바꿀 정도니까 말할것도 없네요 리뉴널 욘기조 너무 예뻐요 만족합니다",
                rating: 5
              },
              { body: "믿고 쓰는 브랜드 피부에 수분감이 많아서 좋아요", rating: 5 },
              { body: "너무 좋아요, 촉촉하고, 향도 무향이고, 보습력도 정말 좋아요!", rating: 5 }
            ]
          }
        }
      },
      source: {
        type: "pdp-extractor",
        url: "https://www.aestura.com/web/product/view.do?prdSeq=1148"
      },
      hints: {
        locale: "ko-KR",
        market: "KR"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const webPage = graph.find((node) => node["@type"] === "WebPage") as Record<string, any>;
    const additionalProperties = product.additionalProperty as Array<Record<string, any>>;
    const keyIngredients = additionalProperties.find((item) => item.name === "Key ingredients")?.value;
    const reportedDetails = additionalProperties.find((item) => item.name === "Reported details")?.value;
    const searchIntentContext = additionalProperties.find((item) => item.name === "Search intent context")?.value;
    const reviewUseFeelContext = additionalProperties.find((item) => item.name === "Review use-feel context")?.value;
    const reviewBodies = product.review.map((review: any) => review.reviewBody).join(" ");
    const positiveNotes = product.positiveNotes.itemListElement.map((item: any) => item.name).join(" ");
    const serialized = JSON.stringify(result.schemaMarkup.jsonLd);
    const normalized = result.diagnostics.normalizedProduct;

    expect(result.content.sections.productName).toBe("에스트라 아토베리어365 하이드로 수딩크림");
    expect(product.name).toBe("에스트라 아토베리어365 하이드로 수딩크림");
    expect(product.category).toBe("크림");
    expect(webPage.description).toContain("수분감");
    expect(product.description).toContain("고밀도 세라마이드 캡슐");
    expect(product.description).toContain("히알루론산");
    expect(product.description).toMatch(/주요 성분\/기술|성분 설명|사용감과 케어 체감|주요 성분 설명/);
    expect(product.description).not.toContain("\", \"");
    expect(product.description).not.toContain("대표 고객 리뷰에서는 \"");
    expect(product.description).not.toMatch(/성분 구성, 기대 효능, 사용감 차이|함께 보여줍니다|효능어|성분어|사용감어|제품 탐색 문맥|탐색 문맥에서|효능과 사용감 차이를 설명하는 기준|연결해 확인할 수 있습니다|확인된 결과\/정보에 따르면|확인된 상품 정보에 따르면|핵심 케어 근거|합니다입니다|습니다입니다|입니다입니다|설명합니다를|근거 설명합니다|찾은 고객|\. 에 초점/);
    expect(result.content.sections.quickFacts).toMatch(/주요 성분|비교할 때|고객 리뷰/);
    expect(result.content.sections.quickFacts).not.toMatch(/사용 맥락|검색\/비교 맥락|성분\/효능 포인트|Use context|Search context|Ingredient\/effect detail/i);
    expect(result.content.sections.benefits).toMatch(/성분 맥락|사용감 맥락|효능 축|루틴|케어 맥락|선택 기준|체감 장점/);
    expect(result.content.sections.benefits).toContain("사용감 맥락");
    expect(result.content.sections.ingredients).toMatch(/고밀도 세라마이드 캡슐|히알루론산|수분감|피부 장벽|리뷰 표현|루틴/);
    expect(result.content.sections.faq).toMatch(/성분 설명에는|성분 역할, 수분감, 사용감, 피부 고민 선택 기준|상품 상세의/);
    expect(result.content.sections.faq).toMatch(/수분감|장벽 케어|유분 컨트롤|피부 고민/);
    expect(result.content.sections.faq).not.toMatch(/성분 역할과 기대 효능의 비교 기준을 제시합니다|What does|OCR|인용/);
    expect(result.content.sections.faq).toContain("사용감을 판단하는 데 도움이 됩니다");
    expect(keyIngredients).toContain("고밀도 세라마이드 캡슐");
    expect(keyIngredients).toContain("히알루론산");
    expect(keyIngredients).not.toContain("쿨링을 주는 화학적 성분");
    expect(searchIntentContext).toMatch(/기반|포인트|리뷰 표현|루틴|수분감|피부 장벽|쿨링감/);
    expect(reviewUseFeelContext).toContain("사용감");
    expect(String(reportedDetails ?? "")).not.toContain("인가요");
    expect(reviewBodies).toContain("속단김");
    expect(reviewBodies).toContain("좋아요");
    expect(reviewBodies).toContain("리뉴널 욘기조");
    expect(positiveNotes).toContain("수분감");
    expect(positiveNotes).toContain("피부결");
    expect(positiveNotes).not.toMatch(/hydration|smooth texture|만족합니다|촉촉하고|리뉴얼 전 제품/);
    expect(normalized.benefits.join(" ")).not.toMatch(/쿨링 효과는 어떤 성분|각 크림에는|리뉴얼 전 제품에서 고객님들이 만족/);
    expect(normalized.effects.join(" ")).not.toMatch(/쿨링 효과는 어떤 성분/);
    expect(normalized.ingredients.join(" ")).not.toMatch(/쿨링 효과는 어떤 성분|아토베리어365 크림에 함유된 캡슐과 동일한 캡슐인가요|캡슐이 있어서 좋은 이유는 무엇인가요|^성분$/);
    expect(normalized.usage.join(" ")).not.toMatch(/여드름성 피부가 사용해도 괜찮은가요|영유아나 임산부가 사용해도 되나요|논코메도제닉 테스트를 완료/);
    expect(normalized.usage).toEqual(["아침과 저녁 스킨케어 마지막 단계에서 얼굴 전체에 부드럽게 펴 바릅니다."]);
    expect(normalized.faq.some((item) => item.question === "쿨링 효과는 어떤 성분이 해주는 것인가요?" && item.answer.includes("시원하고 산뜻한 쿨링감"))).toBe(true);
    expect(normalized.faq.some((item) => item.question === "여드름성 피부가 사용해도 괜찮은가요?" && item.answer.includes("논코메도제닉 테스트"))).toBe(true);
    expect(result.diagnostics.ocrSentences.every((item) => !/문장입니다|재구성합니다|활용합니다/.test(item.geoUse))).toBe(true);
    expect(serialized).not.toMatch(/images-kr\.amoremall|fileupload\/reviews|인용 포인트|Citation highlight|성분 구성, 기대 효능, 사용감 차이|함께 보여줍니다|효능어|성분어|사용감어|제품 탐색 문맥|탐색 문맥에서|효능과 사용감 차이를 설명하는 기준|연결해 확인할 수 있습니다|확인된 결과\/정보에 따르면|확인된 상품 정보에 따르면|핵심 케어 근거|성분\/기술은\s*[^.]*맞물려 제품 특징을 구체화합니다|…|\.{3,}|hydration Cream|smooth texture|property value|합니다입니다|설명합니다를|근거 설명합니다|찾은 고객|\. 에 초점/i);
    expect(additionalProperties.every((item) => !String(item.value).endsWith("?"))).toBe(true);
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
              description: "테스트 수딩 크림 상품 페이지는 고객이 크림을 비교할 때 필요한 정보를 정리합니다. 확인된 결과/정보로 https: //images-kr.amoremall.com/fileupload/reviews/2026/06/18/JPEG_20260618_223402_7170014327977572094_1781789656867.jpg?format=webp를 참고할 수 있습니다."
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
                  value: "https: //images-kr. amoremall. com/fileupload/reviews/2026/06/18/JPEG_20260618_223402_7170014327977572094_1781789656867. jpg? format=webp"
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
              ],
              positiveNotes: {
                "@type": "ItemList",
                itemListElement: [
                  { "@type": "ListItem", position: 1, name: "피부결를" },
                  { "@type": "ListItem", position: 2, name: "리뉴얼 전 제품에서 고객님들이 만족하셨던 속성 (수분감" }
                ]
              }
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
                  name: "에스트라 아토베리어365 하이드로 수딩크림 정보는 무엇으로 확인할 수 있나요?",
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
          quickFacts: "핵심 효능: 수분감를\n확인된 정보: https: //images-kr.amoremall.com/fileupload/reviews/2026/06/18/JPEG_20260618_223402_7170014327977572094_1781789656867.jpg?format=webp",
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
    const notes = product.positiveNotes.itemListElement as Array<Record<string, any>>;

    expect(serialized).not.toMatch(/images-kr\.amoremall|fileupload\/reviews|확인된 결과\/정보에 따르면|확인된 상품 정보에 따르면|확인된 상품 정보는|핵심 케어 근거|…|\.{3,}|수분감를|피부결를|너무 예뻐요 만족합니다", "믿고 쓰는|동일한 캡슐인가요\?|합니다입니다|설명합니다를|근거 설명합니다|찾은 고객|\. 에 초점/);
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
    expect(notes).toHaveLength(1);
    expect(notes[0]?.name).toBe("피부결");
    expect(faq.mainEntity[0].name).toBe("테스트 수딩 크림은 어떻게 사용하면 좋나요?");
    expect(faq.mainEntity[0].acceptedAnswer.text).toBe("고객 리뷰의 피부결 표현은 사용감과 케어 포인트를 보완합니다.");
    const repairedMismatchFaq = faq.mainEntity.find((item: any) => item.name.includes("성분, 효능, 사용감"));
    expect(repairedMismatchFaq?.name).toBe("에스트라 아토베리어365 하이드로 수딩크림의 성분, 효능, 사용감은 어떤 정보로 정리되나요?");
    expect(repairedMismatchFaq?.acceptedAnswer.text).toContain("상품 상세의 성분/효능 정보와 고객 리뷰 표현을 기준으로");
    expect(repairedMismatchFaq?.acceptedAnswer.text).toContain("피부 장벽, 수분감, 쿨링감, 피부결");
    expect(repaired.content.sections.description).toContain("수분감을");
    expect(repaired.content.sections.quickFacts).not.toContain("images-kr.amoremall");
    expect(repaired.content.html).not.toContain("<script>");
    expect(repaired.content.html).not.toMatch(/images-kr\.amoremall|fileupload\/reviews|…|\.{3,}|수분감를|피부결를/);
    expect(repaired.validationWarnings.some((warning) => warning.includes("Final sentence QA repaired"))).toBe(true);
    expect(repaired.validationRepairs.some((repair) => repair.field === "content.sections.description" && String(repair.before).includes("수분감를") && String(repair.after).includes("수분감을"))).toBe(true);
    expect(repaired.validationRepairs.some((repair) => repair.field === "content.html" && String(repair.before).includes("<script>") && String(repair.after).includes("geo-content-accordion"))).toBe(true);
    expect(repaired.validationRepairs.some((repair) => repair.field === "Product.additionalProperty" && JSON.stringify(repair.before).includes("Reported details") && repair.after === null)).toBe(true);
  });

  it("validates field evidence contracts after generation without product-specific blocks", () => {
    const repaired = validateAndRepairPdpGeoArtifacts({
      locale: "en-US",
      fallbackProductName: "Adaptive Barrier Cream",
      fallbackDescription: "Adaptive Barrier Cream supports barrier care and hydration.",
      schemaMarkup: {
        jsonLd: {
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "Product",
              name: "Adaptive Barrier Cream",
              description: "Adaptive Barrier Cream supports barrier care and hydration."
            },
            {
              "@type": "HowTo",
              name: "How to use Adaptive Barrier Cream",
              step: [
                {
                  "@type": "HowToStep",
                  position: 1,
                  text: "Adaptive Barrier Cream improves hydration by 96% in a 33 participant instrumental test."
                },
                {
                  "@type": "HowToStep",
                  position: 2,
                  text: "Apply a thin layer to clean skin morning and night."
                }
              ]
            }
          ]
        },
        scriptTag: ""
      },
      content: {
        sections: {
          productName: "Adaptive Barrier Cream",
          description: "Adaptive Barrier Cream supports barrier care and hydration.",
          quickFacts: "Key benefit: barrier care",
          benefits: [
            "- Barrier support",
            "- 96% of 33 participants agreed skin looked more hydrated after an instrumental test."
          ].join("\n"),
          ingredients: [
            "- Ceramide complex supports the formula story.",
            "- review language around smooth, moisturized skin",
            "- routine fit: Apply after toner."
          ].join("\n"),
          howToUse: [
            "1. Adaptive Barrier Cream improves hydration by 96% in a 33 participant instrumental test.",
            "2. Apply a thin layer to clean skin morning and night."
          ].join("\n"),
          faq: "Q. What does Adaptive Barrier Cream support?\nA. It supports barrier care and hydration."
        },
        html: "<div class=\"geo-content-accordion\"></div>"
      }
    });

    const graph = repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, any>;
    const howToStepText = JSON.stringify(howTo.step);

    expect(howToStepText).toContain("Apply a thin layer to clean skin morning and night.");
    expect(howToStepText).not.toMatch(/instrumental test|96%|33 participant/i);
    expect(repaired.content.sections.howToUse).toContain("Apply a thin layer to clean skin morning and night.");
    expect(repaired.content.sections.howToUse).not.toMatch(/instrumental test|96%|33 participant/i);
    expect(repaired.content.sections.ingredients).toContain("Ceramide complex supports the formula story.");
    expect(repaired.content.sections.ingredients).not.toMatch(/review language around|routine fit|Apply after toner/i);
    expect(repaired.content.sections.benefits).toContain("Barrier support");
    expect(repaired.content.sections.benefits).not.toMatch(/instrumental test|96%|33 participant/i);
    expect(repaired.validationRepairs.some((repair) => repair.source === "field-contract-validator" && repair.field === "HowTo.step.text")).toBe(true);
    expect(repaired.validationRepairs.some((repair) => repair.source === "field-contract-validator" && repair.field === "content.sections.howToUse")).toBe(true);
    expect(repaired.validationRepairs.some((repair) => repair.source === "field-contract-validator" && repair.field === "content.sections.ingredients")).toBe(true);
    expect(repaired.validationRepairs.some((repair) => repair.source === "field-contract-validator" && repair.field === "content.sections.benefits")).toBe(true);
  });

  it("repairs merged FAQ section markers before rebuilding public HTML", () => {
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
    expect(repaired.content.html).toContain("How should Gentle Cleansing Foam be used?");
    expect(repaired.validationRepairs.some((repair) => repair.field === "content.sections.faq")).toBe(true);
  });
});
