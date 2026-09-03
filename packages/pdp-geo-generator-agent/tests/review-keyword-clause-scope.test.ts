import { describe, expect, it } from "vitest";
import { normalizePdpProduct } from "../src/normalize";

/**
 * 실측(2026-09-02, 예시더마 1145)에서 발견. 발행된 FAQ 답변이
 * `고객 리뷰에서는 촉촉한 사용감, 만족도, 탄력이 언급되며…`라고 말했는데,
 * 원문 리뷰는 `탄력개선이 필요한 연령대 제외 모두 만족할 제품이`였다 —
 * 탄력은 그 리뷰가 상품을 추천하지 않는 대상을 가리키는 이유이고, 상품이
 * 한다고 말한 것이 아니다.
 *
 * 원인은 키워드 추출이 본문을 공백 단위 토큰으로만 읽은 것이다. 토큰은 자기를
 * 배제한 절과 분리되어 나온다. 이 커밋 이전부터 있었고 기준선 실행에도 있다.
 */

function keywordsOf(body: string): string[] {
  return normalizePdpProduct({
    name: "예시더마 모이베리어365 클렌징폼",
    description: "약산성 클렌징폼입니다.",
    category: "클렌저",
    reviews: { items: [{ body }], keywords: [] }
  }, { hints: { locale: "ko-KR" } }).product.reviews.keywords;
}

describe("리뷰 키워드는 자기를 배제한 절에서 나오지 않는다", () => {
  it("제외 절 안의 속성은 키워드가 아니다", () => {
    const keywords = keywordsOf("탄력개선이 필요한 연령대 제외 모두 만족할 제품이에요. 촉촉하고 순해서 좋아요.");

    expect(keywords.join(" ")).not.toContain("탄력");
    // 같은 리뷰의 다른 절에서 온 것은 그대로 남는다.
    expect(keywords.some((keyword) => keyword.includes("촉촉"))).toBe(true);
  });

  it("배제가 아닌 절의 속성은 그대로 남는다", () => {
    const keywords = keywordsOf("탄력도 좋아지는 느낌이고 촉촉해서 만족합니다.");

    expect(keywords.some((keyword) => keyword.includes("탄력"))).toBe(true);
  });

  it("부정을 담은 칭찬을 배제로 읽지 않는다", () => {
    const keywords = keywordsOf("세안 후에도 당김이 없고 촉촉해서 만족스러웠어요.");

    expect(keywords.some((keyword) => keyword.includes("촉촉"))).toBe(true);
  });
});
