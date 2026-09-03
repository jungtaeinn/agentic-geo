import { describe, expect, it } from "vitest";
import { generatePdpGeo, ModelBackedContentPlanner } from "../src";
import { normalizePdpProduct } from "../src/normalize";
import { normalizePdpProductWithAgent } from "../src/product-normalizer";
import { ensurePdpGeoFaqPlanCoverage } from "../src/generate";
import { validatePdpGeoArtifacts } from "../src/validate";
import type { PdpGeoContentPlanningRequest, PdpGeoContentPlan, PdpProductSignal } from "../src/types";
import { graphOf as graphNodes } from "./support/graph";

describe("wording quality regressions", () => {
  it("does not treat product keyword bags or aggregate ratings as qualitative review evidence", async () => {
    const input = {
      geoProduct: {
        name: "Ginseng Firming Serum",
        description: "A serum for firmness and hydration.",
        category: "Serum",
        benefits: ["firmness", "hydration"],
        keywords: ["firming", "moisturizing", "refined skin texture"],
        reviews: {
          rating: 4.8,
          reviewCount: 854,
          items: []
        }
      }
    };

    const normalized = normalizePdpProduct(input).product;
    expect(normalized.reviews.keywords).toEqual([]);

    const { result } = await generatePdpGeo({
      product: input,
      hints: { locale: "en-US", market: "US" }
    });
    const graph = graphNodes(result);
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const serialized = JSON.stringify(graph);

    expect(product.aggregateRating).toMatchObject({ ratingValue: 4.8, reviewCount: 854 });
    expect(serialized).not.toMatch(/Customer review context|Customers? (?:highlight|mention)|Positive reviews?/i);
  });

  it("allows an authoritative model patch to clear bootstrap review keywords without clearing rating data", async () => {
    const bootstrapProduct: PdpProductSignal = {
      name: "Ginseng Firming Serum",
      description: "A serum for firmness and hydration.",
      category: "Serum",
      images: [],
      options: [],
      benefits: ["firmness"],
      effects: [],
      ingredients: [],
      usage: [],
      metrics: [],
      faq: [],
      reviews: { rating: 4.8, reviewCount: 854, items: [], keywords: ["firmness"] },
      breadcrumbs: [],
      sourceTexts: ["firmness"]
    };
    const normalized = await normalizePdpProductWithAgent({
      rawProduct: bootstrapProduct,
      bootstrapProduct,
      locale: "en-US",
      market: "US",
      ragDocuments: []
    }, {
      customProductNormalizer: {
        normalizeProduct: () => ({
          product: {
            reviews: { rating: 4.8, reviewCount: 854, items: [], keywords: [] }
          }
        })
      }
    });

    expect(normalized.product.reviews).toMatchObject({ rating: 4.8, reviewCount: 854, keywords: [] });
  });

  it("renders one structured instrumental result as natural English prose", async () => {
    const sourceSentence = "After 6 weeks of use, 100% showed improvement in fine lines, wrinkles, elasticity, and firmness. Instrumental result, 32 women, with daily use.";
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "Botanical Ginseng Rejuvenating Serum",
          description: "A serum for firmness, hydration, and anti-aging care.",
          category: "Serum",
          benefits: ["firmness", "hydration", "anti-aging care"],
          effects: ["improved fine lines, wrinkles, elasticity, and firmness"],
          semanticFacts: {
            metricClaims: [{
              label: "improvement in fine lines, wrinkles, elasticity and firmness",
              subject: "fine lines, wrinkles, elasticity, firmness",
              value: "100",
              unit: "%",
              metric: "improvement rate",
              direction: "improve",
              timing: "after 6 weeks of use",
              sample: "32 women",
              method: "instrumental result, with daily use",
              sentence: sourceSentence,
              sourceText: sourceSentence
            }],
            evidenceSentences: [sourceSentence]
          },
          sourceTexts: [sourceSentence]
        }
      },
      hints: { locale: "en-US", market: "US" }
    });
    const graph = graphNodes(result);
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const properties = product.additionalProperty as Array<Record<string, any>>;
    const reported = String(properties.find((item) => item.name === "Reported details")?.value ?? "");
    const serialized = JSON.stringify(graph);

    expect(serialized).toContain("In an instrumental assessment of 32 women who used the product daily, 100% of participants showed improvement in fine lines, wrinkles, elasticity, and firmness after 6 weeks of use.");
    // The methodology-labelled summary was retired: it republished this exact
    // value under a second name. The evidence now has one home, and the name it
    // carries makes no methodology claim, so it cannot mislabel a
    // self-assessment as clinical either.
    expect(reported).toContain("In an instrumental assessment");
    expect(properties.some((item) => /result summary|assessment summary/i.test(String(item.name)))).toBe(false);
    expect(reported).not.toMatch(/\((?:timing|sample|method)\s/i);
    expect(result.diagnostics.validationFindings).toEqual([]);
  });

  it("reports raw metric metadata, dependent English fragments, and unsupported qualitative reviews", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "Ginseng Firming Serum",
          description: "A firming serum.",
          category: "Serum",
          reviews: { rating: 4.8, reviewCount: 854, items: [], keywords: [] }
        }
      },
      hints: { locale: "en-US", market: "US" }
    });
    const schemaMarkup = structuredClone(result.schemaMarkup);
    const product = (schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>)
      .find((node) => node["@type"] === "Product") as Record<string, any>;
    product.description = "A firming serum. improvement in firmness 100% (timing after 6 weeks, sample 32 women, method instrumental result). Customers highlight firmness in reviews.";

    const validation = validatePdpGeoArtifacts({
      schemaMarkup,
      content: result.content,
      fallbackProductName: "Ginseng Firming Serum",
      fallbackDescription: product.description,
      locale: "en-US",
      sourceProduct: result.diagnostics.normalizedProduct
    });

    expect(validation.validationFindings.some((finding) => /structured metric metadata/i.test(finding.issue))).toBe(true);
    expect(validation.validationFindings.some((finding) => /sentence fragment/i.test(finding.issue))).toBe(true);
    expect(validation.validationFindings.some((finding) => /without review-body/i.test(finding.issue))).toBe(true);
  });

  it("keeps the complete usage instruction, emits one HowTo step, and canonicalizes typed skin types", async () => {
    const fullUsage = "Apply morning and night after toner, gently pressing into skin until absorbed.";
    const fragment = "apply morning and night after toner";
    const input = {
      geoProduct: {
        name: "Botanical Ginseng Rejuvenating Serum",
        description: "A serum for firmness and hydration.",
        category: "Serum",
        benefits: ["firmness", "hydration"],
        usage: [fullUsage, fragment],
        semanticFacts: {
          skinTypes: ["Normal, dry, combination, and oily skin types."],
          usageSteps: [fullUsage, fragment]
        },
        sourceTexts: ["Works best for normal, dry, combination, and oily skin types.", fullUsage, fragment]
      }
    };

    const normalized = normalizePdpProduct(input).product;
    expect(normalized.usage).toEqual([fullUsage]);
    expect(normalized.semanticFacts?.usageSteps).toEqual([fullUsage]);
    expect(normalized.semanticFacts?.skinTypes).toEqual([
      "normal skin",
      "dry skin",
      "combination skin",
      "oily skin"
    ]);

    const { result } = await generatePdpGeo({
      product: input,
      hints: { locale: "en-US", market: "US" }
    });
    const nodes = graphNodes(result);
    const howTo = nodes.find((node) => node["@type"] === "HowTo") as Record<string, any>;
    const product = nodes.find((node) => node["@type"] === "Product") as Record<string, any>;
    const recommendedSkinType = product.additionalProperty
      .find((item: Record<string, any>) => item.name === "Recommended skin type")?.value;
    expect(howTo.step).toHaveLength(1);
    expect(`${howTo.step[0].text}.`).toBe(fullUsage);
    expect(recommendedSkinType).toBe("normal, dry, combination, or oily skin");
  });

  it("retains supported description sentences when another model sentence fails the evidence audit", async () => {
    class AuditedPlanner extends ModelBackedContentPlanner {
      override async planContent(request: PdpGeoContentPlanningRequest) {
        const evidenceIds = request.evidenceLedger.map((item) => item.id);
        const plan: Omit<PdpGeoContentPlan, "mode"> = {
          locale: request.locale,
          productDescription: {
            include: true,
            text: "Partial Evidence Serum is a serum. It cures eczema overnight.",
            intent: "product summary",
            evidenceIds,
            confidence: 0.9,
            omitReason: ""
          },
          webPageDescription: {
            include: true,
            text: "The Partial Evidence Serum product page presents the serum. It promises instant eczema treatment.",
            intent: "page summary",
            evidenceIds,
            confidence: 0.9,
            omitReason: ""
          },
          faq: [],
          howTo: {
            eligible: false,
            ordered: false,
            goal: "",
            steps: [],
            evidenceIds: [],
            confidence: 0.9,
            omitReason: "No usage evidence."
          },
          cep: [],
          warnings: []
        };
        return { plan };
      }
    }

    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "Partial Evidence Serum",
          description: "A serum for hydration.",
          category: "Serum",
          benefits: ["hydration"]
        }
      },
      hints: { locale: "en-US", market: "US" }
    }, {
      provider: "custom",
      contentPlanning: { enabled: true, provider: "custom" },
      customContentPlanner: new AuditedPlanner({ provider: "custom" } as any),
      copyRefinement: { enabled: false }
    });
    const graph = graphNodes(result);
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const webPage = graph.find((node) => (Array.isArray(node["@type"]) ? node["@type"].includes("WebPage") : node["@type"] === "WebPage")) as Record<string, any>;

    expect(product.description).toBe("Partial Evidence Serum is a serum.");
    expect(webPage.description).toContain("Partial Evidence Serum product page");
    expect(JSON.stringify(graph)).not.toMatch(/eczema|instant treatment/i);
  });

  it("deduplicates assessment and usage FAQ intents when deterministic coverage is merged", () => {
    const sourceSentence = "After 6 weeks of use, 100% showed improvement in firmness. Instrumental result, 32 women, with daily use.";
    const product = normalizePdpProduct({
      geoProduct: {
        name: "FAQ Evidence Serum",
        description: "A serum for firmness and hydration.",
        category: "Serum",
        benefits: ["firmness", "hydration"],
        ingredients: ["Ginseng Peptide"],
        usage: ["Apply morning and night after toner."],
        semanticFacts: {
          metricClaims: [{
            label: "improvement in firmness",
            subject: "firmness",
            value: "100",
            unit: "%",
            direction: "improve",
            timing: "after 6 weeks of use",
            sample: "32 women",
            method: "instrumental result, with daily use",
            sentence: sourceSentence,
            sourceText: sourceSentence
          }]
        },
        sourceTexts: [sourceSentence, "Apply morning and night after toner."]
      }
    }).product;
    const plan: PdpGeoContentPlan = {
      mode: "model",
      locale: "en-US",
      productDescription: { include: false, text: "", intent: "", evidenceIds: [], confidence: 0, omitReason: "" },
      webPageDescription: { include: false, text: "", intent: "", evidenceIds: [], confidence: 0, omitReason: "" },
      faq: [
        {
          include: true,
          question: "What did the reported instrumental assessment show for FAQ Evidence Serum?",
          answer: "After 6 weeks, 100% showed improvement in firmness in an instrumental assessment of 32 women.",
          intent: "evidence-measurement",
          cep: "",
          evidenceIds: ["metric"],
          confidence: 0.9,
          omitReason: ""
        },
        {
          include: true,
          question: "How should FAQ Evidence Serum be used?",
          answer: "Apply morning and night after toner.",
          intent: "usage",
          cep: "",
          evidenceIds: ["usage"],
          confidence: 0.9,
          omitReason: ""
        }
      ],
      howTo: { eligible: true, ordered: true, goal: "How to use FAQ Evidence Serum", steps: [], evidenceIds: [], confidence: 0.9, omitReason: "" },
      cep: [],
      warnings: []
    };

    const completed = ensurePdpGeoFaqPlanCoverage({
      plan,
      product,
      locale: "en-US",
      market: "US",
      ragChunks: [],
      evidenceLedger: []
    });
    const questions = completed.faq.map((item) => item.question);

    expect(questions).toHaveLength(4);
    expect(questions.filter((question) => /assessment|clinical|instrumental/i.test(question))).toHaveLength(1);
    expect(questions.filter((question) => /used|routine/i.test(question))).toHaveLength(1);
    expect(completed.faq.find((item) => /assessment|clinical|instrumental/i.test(item.question))?.answer)
      .toBe("In an instrumental assessment of 32 women who used the product daily, 100% of participants showed improvement in firmness after 6 weeks of use.");
  });
});
