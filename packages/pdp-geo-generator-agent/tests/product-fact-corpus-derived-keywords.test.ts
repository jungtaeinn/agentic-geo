import { describe, expect, it } from "vitest";
import { normalizePdpProductWithAgent, type PdpProductSignal } from "../src";

// 재실측(예시더마 1027) 회귀: 리뷰어가 언급한 "히알루론산"(이 제품의 성분이 아님)이
// geoProduct.ocr.keywords.ingredient 같은 파생 키워드 배열에도 나타났고, 그 배열이
// 제품-사실 코퍼스의 근거로 쓰여 모델 정규화가 성분으로 채택해버렸다. 파생 키워드
// 컬렉션은 근거가 될 수 없고, 원문 텍스트만 근거가 될 수 있어야 한다.
function bootstrapProduct(): PdpProductSignal {
  return {
    name: "테스트 크림",
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
    sourceTexts: []
  };
}

describe("product-fact corpus excludes derived keyword collections", () => {
  it("rejects an ingredient whose only source is a review sentence, even when it also appears in a derived keyword array", async () => {
    const rawProduct = {
      name: "테스트 크림",
      sourceExtraction: {
        ocr: {
          keywords: {
            // 실측 오염 경로 재현: 파생 키워드 배열에 리뷰 유래 토큰이 섞여 들어온다.
            ingredient: ["세라마이드", "히알루론산"]
          },
          sentenceInsights: [
            { text: "세라마이드 10,000ppm이 피부 장벽을 강화합니다", category: "ingredient" },
            {
              text: "아무리 토너쓰고 팩도 하고 히알루론산 앰플 발라도 해결이 안됬는데 이 크림 쓰고 좋아졌어요",
              category: "review"
            }
          ]
        }
      }
    };

    const normalized = await normalizePdpProductWithAgent({
      rawProduct,
      bootstrapProduct: bootstrapProduct(),
      locale: "ko-KR",
      market: "KR",
      ragDocuments: []
    }, {
      customProductNormalizer: {
        normalizeProduct: () => ({
          product: {
            ingredients: ["히알루론산"]
          }
        })
      }
    });

    expect(normalized.product.ingredients).not.toContain("히알루론산");
    expect(normalized.warnings.join(" ")).toMatch(/no role-coherent source-backed values remained/i);
  });

  it("still accepts an ingredient backed by a non-review OCR sentence", async () => {
    const rawProduct = {
      name: "테스트 크림",
      sourceExtraction: {
        ocr: {
          keywords: {
            ingredient: ["세라마이드", "히알루론산"]
          },
          sentenceInsights: [
            { text: "세라마이드 10,000ppm이 피부 장벽을 강화합니다", category: "ingredient" },
            {
              text: "아무리 토너쓰고 팩도 하고 히알루론산 앰플 발라도 해결이 안됬는데 이 크림 쓰고 좋아졌어요",
              category: "review"
            }
          ]
        }
      }
    };

    const normalized = await normalizePdpProductWithAgent({
      rawProduct,
      bootstrapProduct: bootstrapProduct(),
      locale: "ko-KR",
      market: "KR",
      ragDocuments: []
    }, {
      customProductNormalizer: {
        normalizeProduct: () => ({
          product: {
            ingredients: ["세라마이드"]
          }
        })
      }
    });

    expect(normalized.product.ingredients).toContain("세라마이드");
  });
});
