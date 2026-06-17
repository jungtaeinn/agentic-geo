import { describe, expect, it } from "vitest";
import { refineGeoProductResult } from "../src/refine";
import type { ProductExtractionResult } from "../src/types";

const baseResult: ProductExtractionResult = {
  source: "https://example.com/products/serum",
  sourceType: "url",
  geoProduct: {
    name: "Ginseng Serum",
    price: { raw: "215.00", amount: 215, currency: "USD" },
    description: "A serum with ginseng.",
    images: [],
    options: [],
    benefits: ["radiance"],
    effects: [],
    ingredients: ["ginseng"],
    usage: [],
    metrics: [],
    faq: [],
    reviews: {
      rating: 4.8,
      reviewCount: 418,
      items: [],
      keywords: []
    },
    sourceExtraction: {
      html: {
        description: "A serum with ginseng.",
        sections: [],
        faq: []
      },
      ocr: {
        imageTexts: [],
        textBlocks: []
      }
    },
    aiAnalysis: {
      keywords: {
        product: [],
        price: [],
        benefit: ["radiance"],
        effect: [],
        ingredient: ["ginseng"],
        usage: [],
        faq: [],
        review: [],
        metric: [],
        trend: [],
        unknown: []
      },
      categorizedSections: [],
      summary: "Base fixture."
    },
    categorizedProductInfo: {
      benefits: ["radiance"],
      effects: [],
      ingredients: ["ginseng"],
      usage: [],
      metrics: [],
      faq: []
    },
    customerReviewAnalysis: {
      rating: 4.8,
      reviewCount: 418,
      items: [],
      keywords: [],
      reviewSignals: [],
      ratingSummary: "Rating 4.8 · 418 reviews"
    },
    contentAnalysis: {
      sections: [],
      reviewSignals: [],
      ratingSummary: "Rating 4.8 · 418 reviews"
    },
    ocr: {
      textBlocks: [],
      keywords: {
        product: [],
        price: [],
        benefit: ["radiance"],
        effect: [],
        ingredient: ["ginseng"],
        usage: [],
        faq: [],
        review: [],
        metric: [],
        trend: [],
        unknown: []
      }
    },
    rag: {
      chunks: []
    }
  },
  generatedAt: "2026-06-16T00:00:00.000Z",
  ragProfile: "pdp-extractor-default"
};

describe("refineGeoProductResult", () => {
  it("updates GEO RAW JSON fields from a natural language instruction", () => {
    const { result, changes } = refineGeoProductResult({
      result: baseResult,
      instruction: "metrics에 6 weeks와 100%를 추가하고 성분에 peptide도 넣어줘"
    });

    expect(changes).toContain("metrics");
    expect(changes).toContain("ingredients");
    expect(result.geoProduct.metrics).toEqual(expect.arrayContaining(["6 weeks", "100%"]));
    expect(result.geoProduct.ingredients).toContain("peptide");
    expect(result.geoProduct.ocr.keywords.metric).toEqual(expect.arrayContaining(["6 weeks", "100%"]));
    expect(JSON.stringify(result)).not.toContain("confidence");
    expect(JSON.stringify(result)).not.toContain("imageUrl");
  });

  it("merges inline JSON patches into geoProduct", () => {
    const { result } = refineGeoProductResult({
      result: baseResult,
      instruction: "다음 JSON 반영 {\"geoProduct\":{\"benefits\":[\"firming\"],\"reviews\":{\"keywords\":[\"repurchase\"]}}}"
    });

    expect(result.geoProduct.benefits).toEqual(expect.arrayContaining(["radiance", "firming"]));
    expect(result.geoProduct.reviews.keywords).toContain("repurchase");
  });
});
