import { describe, expect, it } from "vitest";
import { generatePdpGeo } from "../src";

/**
 * 구성 문장의 조사는 앞 낱말의 받침이 정한다.
 *
 * 1144 실측(예시더마 모이베리어365 젠틀 포밍클렌저)에서 `Product.description`에
 * `보타온은 세라마이드와 지방산로 구성됩니다.`가 실렸다. `지방산`은 받침이
 * 있으므로 `지방산으로`다. 같은 파일에 받침을 보는 조사 헬퍼가 이미 있는데
 * 이 문장만 `로`를 붙여 쓰고 있었다.
 */
describe("구성 문장의 도구격 조사", () => {
  it("uses 으로 after a final consonant", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "예시더마 모이베리어365 젠틀 포밍클렌저",
          description: "건조하고 민감한 피부를 위한 포밍 클렌저입니다.",
          brand: "EXAMPLEDERMA",
          category: "클렌저",
          benefits: ["피부 장벽"],
          ingredients: ["보타온", "판테놀", "지방산"],
          usage: [],
          semanticFacts: {
            evidenceSentences: [
              "보타온은 판테놀과 지방산을 담아 피부 장벽 관리를 돕는 기술로 구성됩니다."
            ]
          }
        }
      },
      source: { type: "pdp-extractor" as const, url: "https://shop.example.com/web/product/view.do?prdSeq=1144" },
      hints: { locale: "ko-KR" as const, market: "KR" as const }
    } as never);

    const published = JSON.stringify(result.schemaMarkup.jsonLd) + JSON.stringify(result.content.sections);

    expect(published).not.toContain("지방산로");
  });
});
