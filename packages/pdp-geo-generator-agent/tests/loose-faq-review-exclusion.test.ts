import { describe, expect, it } from "vitest";
import { normalizePdpProduct } from "../src/normalize";

// 실측 결함(예시더마 1027, 2026-09-01): 추출기 faq가 비어 있는 런에서
// 리뷰 스크롤 섹션(category: "review")의 물음표 문장이 loose FAQ 질문으로
// 승격되어 리뷰어 크롬("더보기 5 5 doo*** ...")까지 답변으로 발행됐다.
const REVIEW_FRAGMENT_QUESTION = "나온건가?하다가 얼굴만져보고 충분히 뿌려진거알았어요 ㅎㅎ근데 늦가을?";
const REVIEW_SCROLL_TEXT =
  "5 5 hhpp* 2026-08-18 예시더마 크림미스트 아주 곱게 분사되어 분사력이 마음에 들어요 더보기 5 5 dooh******* 2026-08-18 "
  + "처음에 뿌린줄도몰랐어요 뿌려진건가? 나온건가?하다가 얼굴만져보고 충분히 뿌려진거알았어요 ㅎㅎ근데 늦가을? "
  + "겨울에 너무좋을것같아요 건조할때쓰면 완전좋을것같은데 11월까지 잘 모셔두고있어야겠어요";

const product = {
  name: "모이베리어 365 크림 미스트",
  faq: [],
  sourceExtraction: {
    html: {
      sections: [
        {
          title: "REVIEW",
          category: "review",
          text: REVIEW_SCROLL_TEXT,
          bullets: [
            "뿌려진건가?",
            REVIEW_FRAGMENT_QUESTION,
            // 실측에서 답변으로 승격된 형태 그대로: 다음 리뷰 크롬 + "입니다" 종결.
            "겨울에 너무좋을것같아요 더보기 4 4 ycdj*** 2026-08-17 극심한 속당김을 한 번에 해결해 주는 고보습 미스트입니다."
          ]
        },
        {
          title: "FAQ",
          category: "faq",
          text: "",
          bullets: [
            "크림 미스트를 평상시 루틴으로 사용하는 경우 사용 순서는 어떻게 되나요?",
            "세안 후 하이드로 에센스, 크림 또는 로션, 크림 미스트 순서로 마무리하고 건조할 때마다 수시로 사용합니다."
          ]
        }
      ]
    }
  }
};

describe("loose FAQ harvesting excludes review-scoped text", () => {
  it("does not promote question-shaped review fragments into FAQ", () => {
    const { product: normalized } = normalizePdpProduct(product);
    const questions = normalized.faq.map((item) => item.question);

    expect(questions.some((question) => question.includes("나온건가"))).toBe(false);
    expect(questions.some((question) => question.includes("늦가을"))).toBe(false);
    expect(normalized.faq.some((item) => item.answer.includes("더보기"))).toBe(false);
  });

  it("still harvests loose Q/A from non-review sections", () => {
    const { product: normalized } = normalizePdpProduct(product);

    expect(normalized.faq.some((item) => item.question.includes("사용 순서는 어떻게 되나요"))).toBe(true);
  });
});
