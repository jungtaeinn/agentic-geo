import { describe, expect, it } from "vitest";
import { normalizePdpProduct } from "../src/normalize";

const IMG_A = "https://cdn.example.com/ingredient.png";
const IMG_B = "https://cdn.example.com/usage.png";

const product = {
  name: "모이베리어 365 크림",
  sourceExtraction: {
    ocr: {
      imageTexts: [
        { imageUrl: IMG_A, imageUrls: [IMG_A], text: "세라마이드 10,000ppm이 피부 장벽을 강화합니다", confidence: 0.9 },
        { imageUrl: IMG_B, imageUrls: [IMG_B], text: "아침 저녁 세안 후 얼굴에 도포합니다", confidence: 0.4 }
      ],
      textBlocks: [],
      sentenceInsights: [
        { imageUrl: IMG_A, imageUrls: [IMG_A], text: "세라마이드 10,000ppm이 피부 장벽을 강화합니다", category: "ingredient", keywords: ["세라마이드"] },
        { imageUrl: IMG_B, imageUrls: [IMG_B], text: "아침 저녁 세안 후 얼굴에 도포합니다", category: "usage", keywords: [] }
      ],
      semanticFacts: {
        ingredients: [], benefits: [], effects: [], skinTypes: [], usageSteps: [], evidenceSentences: [],
        metricClaims: [{
          sentence: "10,000ppm",
          // P3: the bare "세라마이드 10,000ppm" fixture text does not survive
          // sanitizePdpSemanticFacts' metric-coherence gate (isAtomicMetricEvidenceText
          // requires a quantified+outcome+evidence-frame sentence; "ppm" alone never
          // qualifies). This wording keeps the product anchor while giving the claim
          // an outcome ("장벽 기능") and an evidence frame ("시험") so it survives —
          // this test's intent is imageUrls passthrough, not metric-coherence scoping.
          sourceText: "모이베리어 365 크림에 세라마이드 10,000ppm을 배합해 4주간 사용한 시험에서 피부 장벽 기능이 32% 개선되었습니다",
          imageUrls: [IMG_A]
        }],
        ingredientBenefitLinks: [], citations: []
      }
    }
  }
};

describe("normalize keeps OCR image provenance", () => {
  it("keys sourceTextMeta by the sourceTexts value for insight-derived entries", () => {
    const { product: normalized } = normalizePdpProduct(product);
    const text = normalized.sourceTexts.find((value) => value.includes("장벽을 강화"));
    expect(text).toBeDefined();
    expect(normalized.sourceTextMeta?.[text ?? ""]?.imageUrls).toEqual([IMG_A]);
    expect(normalized.sourceTextMeta?.[text ?? ""]?.ocrConfidence).toBe(0.9);
    // 키는 sourceTexts에 실제로 남은 값이어야 한다: 계보를 잃은 유령 키가 있으면
    // 배열 재필터 이후 조회가 엉뚱한 텍스트로 흘러간다.
    for (const key of Object.keys(normalized.sourceTextMeta ?? {})) {
      expect(normalized.sourceTexts).toContain(key);
    }
  });

  it("marks low-confidence image sentences and leaves non-OCR entries without meta", () => {
    const { product: normalized } = normalizePdpProduct(product);
    const usageText = normalized.sourceTexts.find((value) => value.includes("도포합니다"));
    expect(normalized.sourceTextMeta?.[usageText ?? ""]?.ocrConfidence).toBe(0.4);
    const nameText = normalized.sourceTexts.find((value) => value === "모이베리어 365 크림");
    if (nameText) {
      expect(normalized.sourceTextMeta?.[nameText]).toBeUndefined();
    }
  });

  it("carries metricClaim imageUrls through semanticFacts normalization", () => {
    const { product: normalized } = normalizePdpProduct(product);
    const claim = normalized.semanticFacts?.metricClaims.find((item) => item.sourceText?.includes("10,000ppm"));
    expect(claim?.imageUrls).toEqual([IMG_A]);
  });
});
