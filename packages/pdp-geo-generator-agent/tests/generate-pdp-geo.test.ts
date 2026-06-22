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
    const serialized = JSON.stringify(result.schemaMarkup.jsonLd);

    expect(result.content.sections.howToUse).toContain("Apply morning and night after serum");
    expect(result.content.sections.howToUse).toContain("hydration");
    expect(result.content.sections.howToUse.trim()).not.toBe("1. Apply morning and night after serum.");
    expect(result.content.sections.faq).toContain("How should Ginseng Barrier Serum be used?");
    expect(result.content.sections.faq).toContain("What do customer reviews highlight about Ginseng Barrier Serum?");
    expect(result.content.sections.faq).toContain("Niacinamide");
    expect(result.content.sections.faq).toContain("Available product information");
    expect(result.content.sections.faq).not.toContain("Evidence signal");
    expect(result.content.sections.faq).not.toContain("Review signals");
    expect(serialized).not.toMatch(/Evidence signal|Review signals|technology signals|main benefit signal/i);
    expect(result.content.sections.faq).not.toContain("Can I use it daily?");
    expect(result.content.sections.faq).not.toContain("A. Apply morning and night after serum.");
    expect(howTo.step[0].text).toContain("hydration");
    expect(howTo.step[0].name).toBe("Step 1");
    expect(faq.mainEntity.some((item: any) => item.name === "How should Ginseng Barrier Serum be used?")).toBe(true);
    expect(faq.mainEntity.some((item: any) => item.name === "Can I use it daily?")).toBe(false);
    expect(faq.mainEntity.some((item: any) => item.name === "What do customer reviews highlight about Ginseng Barrier Serum?")).toBe(true);
    expect(result.diagnostics.evidence.some((item) => item.field === "rag.geoOptimizationGuidance")).toBe(true);
    expect(result.diagnostics.recommendations.some((item) => item.field === "faq")).toBe(true);
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
    expect(webPage.description).toContain("detailed benefit, ingredient, usage, and customer-review information");
    expect(webPage.description).toContain("fine lines and wrinkles");
    expect(webPage.description).toContain("Korean Ginseng Actives");
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

    expect(webPage.description).toContain("In a self-assessment of 32 women after 6 weeks of use");
    expect(webPage.description).toContain("100% of participants agreed that skin felt firmer and more elastic");
    expect(webPage.description).toContain("93% of participants agreed that fine lines and wrinkles felt diminished");
    expect(product.description).toContain("Korean Ginseng Actives (Ginsenomics), a patented ingredient described as amplifying rare ginseng compounds");
    expect(product.description).toContain("Ginseng Peptide, described as supporting the look of skin firmness and elasticity");
    expect(product.description).toContain("Use it morning and night after toner");
    expect(product.description).toContain("Customer reviews mention smooth and firmness, which supports the product's texture");
    expect(product.description).toContain("Reported results come from a self-assessment of 32 women after 6 weeks of use");
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
});
