import { describe, expect, it } from "vitest";
import { selectSchemaImages } from "../src/generate";
import type { PdpProductSignal } from "../src/types";

function minimalProduct(overrides: Partial<PdpProductSignal>): PdpProductSignal {
  return {
    name: "테스트 제품",
    images: [],
    options: [],
    benefits: [],
    effects: [],
    ingredients: [],
    usage: [],
    metrics: [],
    faq: [],
    reviews: { items: [], keywords: [] },
    breadcrumbs: [],
    sourceTexts: [],
    ...overrides
  };
}

describe("selectSchemaImages prioritizes evidence-backed images", () => {
  it("ranks evidence-backed detail images ahead of equally scored gallery shots", () => {
    const productSignal = minimalProduct({
      images: ["https://cdn.example.com/gallery-1.jpg", "https://cdn.example.com/ingredient.png"],
      sourceTexts: ["세라마이드 10,000ppm이 피부 장벽을 강화합니다"],
      sourceTextMeta: {
        "세라마이드 10,000ppm이 피부 장벽을 강화합니다": {
          imageUrls: ["https://cdn.example.com/ingredient.png"],
          ocrConfidence: 0.9
        }
      }
    });
    const selected = selectSchemaImages(productSignal, "모이베리어 365 크림", "https://example.com/p/1");
    expect(selected.indexOf("https://cdn.example.com/ingredient.png")).toBeLessThan(
      selected.indexOf("https://cdn.example.com/gallery-1.jpg")
    );
    expect(selected).toContain("https://cdn.example.com/gallery-1.jpg"); // 제거 없음
  });

  it("also promotes images cited by semanticFacts claims (metricClaims/ingredientBenefitLinks/citations)", () => {
    const productSignal = minimalProduct({
      images: ["https://cdn.example.com/gallery-2.jpg", "https://cdn.example.com/clinical.png"],
      semanticFacts: {
        ingredients: [],
        benefits: [],
        effects: [],
        skinTypes: [],
        usageSteps: [],
        evidenceSentences: [],
        metricClaims: [{ sentence: "테스트", imageUrls: ["https://cdn.example.com/clinical.png"] }],
        ingredientBenefitLinks: [],
        citations: []
      }
    });
    const selected = selectSchemaImages(productSignal, "모이베리어 365 크림", "https://example.com/p/1");
    expect(selected.indexOf("https://cdn.example.com/clinical.png")).toBeLessThan(
      selected.indexOf("https://cdn.example.com/gallery-2.jpg")
    );
    expect(selected).toContain("https://cdn.example.com/gallery-2.jpg"); // 제거 없음
  });

  it("leaves order unchanged when no evidence backs any image (negative control)", () => {
    const images = ["https://cdn.example.com/gallery-1.jpg", "https://cdn.example.com/ingredient.png"];
    const withoutEvidence = minimalProduct({ images });
    const withEmptyMeta = minimalProduct({ images, sourceTextMeta: {} });

    const selectedA = selectSchemaImages(withoutEvidence, "모이베리어 365 크림", "https://example.com/p/1");
    const selectedB = selectSchemaImages(withEmptyMeta, "모이베리어 365 크림", "https://example.com/p/1");

    expect(selectedA).toEqual(selectedB);
    expect(selectedA).toEqual(images);
  });
});
