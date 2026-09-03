import { describe, expect, it } from "vitest";
import { normalizePdpProduct } from "../src/normalize";

// 재실측(예시더마 1027, v3) 회귀: Task 6은 모델 정규화 경로(product-normalizer.ts)만
// 막았고, 결정적 부트스트랩 정규화(normalize.ts)에는 같은 결함이 남아 있었다.
// sourceExtraction.html.sections[9](category "review")에서만 등장하는
// "히알루론산"(이 제품 성분이 아님)이 ocr.keywords.ingredient / aiAnalysis.keywords.ingredient
// 같은 파생 키워드 버킷의 bare 토큰으로도 존재했고, normalize.ts의 sectionTexts()가
// 키 이름("ingredient")만으로 그 버킷을 무비판 채택해 ingredients 배열로 승격시켰다.
function rawProductWithReviewLeakedKeyword() {
  return {
    name: "테스트 크림",
    description: "세라마이드가 피부 장벽을 강화하는 크림입니다.",
    sourceExtraction: {
      html: {
        sections: [
          {
            title: "REVIEW",
            category: "review",
            // 원문에서 "히알루론산"의 유일한 출처: 리뷰어가 예전에 쓰던 다른 제품 언급.
            text: "아무리 토너쓰고 팩도 하고 히알루론산 앰플 발라도 해결이 안됬는데 이 크림 쓰고 좋아졌어요"
          }
        ]
      },
      ocr: {
        keywords: {
          // 실측 오염 경로 재현: 분류기가 리뷰 문장 속 단어를 성분 버킷에도 넣는다.
          ingredient: ["세라마이드", "히알루론산"]
        }
      }
    }
  };
}

describe("bootstrap normalization excludes derived keyword buckets uncorroborated by outside-review prose", () => {
  it("does not promote a bare keyword token whose only textual home is a review section", () => {
    const { product } = normalizePdpProduct(rawProductWithReviewLeakedKeyword());
    expect(product.ingredients).not.toContain("히알루론산");
    expect(JSON.stringify(product.ingredients)).not.toContain("히알루론산");
  });

  it("still promotes a keyword-bucket token corroborated by non-review prose elsewhere", () => {
    const { product } = normalizePdpProduct(rawProductWithReviewLeakedKeyword());
    expect(product.ingredients.some((value) => value.includes("세라마이드"))).toBe(true);
  });

  // 리뷰어 권고: 파생 버킷(ocr.keywords.* 등)이 아닌 구조적 섹션 키(예: 페이지가 직접
  // 작성한 "ingredient" 계열 필드)는 corroboration 없이도 direct 채택되어야 한다 —
  // 이 신뢰 규칙이 이번 수정으로 손상되지 않았음을 고정한다.
  it("promotes a structural (non-derived) section key's own value without requiring corroboration", () => {
    const rawProduct = {
      name: "테스트 크림",
      // 이 값은 소스 어디에도 다시 등장하지 않는다 — direct 채택이 아니라면 승격될 수 없다.
      ingredientHighlight: "Panthenol"
    };
    const { product } = normalizePdpProduct(rawProduct);
    expect(product.ingredients).toContain("Panthenol");
  });
});
