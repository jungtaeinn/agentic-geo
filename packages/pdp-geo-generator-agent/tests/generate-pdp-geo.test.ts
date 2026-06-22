import { describe, expect, it } from "vitest";
import { generatePdpGeo } from "../src";

describe("generatePdpGeo", () => {
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

    const graph = result.schemaMarkup.jsonLd["@graph"];
    expect(Array.isArray(graph)).toBe(true);
    expect(JSON.stringify(result.schemaMarkup.jsonLd)).toContain("\"Product\"");
    expect(JSON.stringify(result.schemaMarkup.jsonLd)).toContain("\"FAQPage\"");
    expect(JSON.stringify(result.schemaMarkup.jsonLd)).toContain("\"HowTo\"");
    expect(JSON.stringify(result.schemaMarkup.jsonLd)).toContain("\"BreadcrumbList\"");
    expect(JSON.stringify(result.schemaMarkup.jsonLd)).toContain("\"WebPage\"");
    expect(result.content.sections.productName).toContain("Hydra Barrier Cream");
    expect(result.content.sections.description).toContain("고객");
    expect(result.content.sections.description).toContain("흡수감");
    expect(result.content.sections.quickFacts).toContain("주요 성분");
    expect(result.content.html).toContain("geo-content-accordion");
    expect(result.diagnostics.recommendations.some((item) => item.field === "description")).toBe(true);
    expect(result.diagnostics.evidence.some((item) => item.source === "fieldMapping")).toBe(true);
    expect(result.diagnostics.ragMode).toBe("local-versioned-rag");
    expect(process.map((step) => step.id)).toEqual(["input", "normalize", "rag-load", "chunk", "embed", "retrieve", "rerank", "generate", "validate", "repair", "artifact"]);
    expect(process.every((step) => step.status === "done")).toBe(true);
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
              "- Compose benefit statements from target customer, core benefit, ingredient or technology, use context, review signal, and evidence.",
              "- Keep claims grounded in source facts and make generated answers easy to cite."
            ].join("\n")
          }
        ]
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const howTo = graph.find((node) => node["@type"] === "HowTo") as Record<string, any>;
    const faq = graph.find((node) => node["@type"] === "FAQPage") as Record<string, any>;

    expect(result.content.sections.howToUse).toContain("Apply morning and night after serum");
    expect(result.content.sections.howToUse).toContain("hydration");
    expect(result.content.sections.howToUse.trim()).not.toBe("1. Apply morning and night after serum.");
    expect(result.content.sections.faq).toContain("How should Ginseng Barrier Serum be used?");
    expect(result.content.sections.faq).toContain("Niacinamide");
    expect(result.content.sections.faq).toContain("Evidence signal");
    expect(howTo.step[0].text).toContain("hydration");
    expect(faq.mainEntity.some((item: any) => item.name === "How should Ginseng Barrier Serum be used?")).toBe(true);
    expect(result.diagnostics.evidence.some((item) => item.field === "rag.geoOptimizationGuidance")).toBe(true);
    expect(result.diagnostics.recommendations.some((item) => item.field === "faq")).toBe(true);
  });
});
