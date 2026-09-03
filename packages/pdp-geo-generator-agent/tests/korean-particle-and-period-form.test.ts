import { describe, expect, it } from "vitest";
import { generatePdpGeo } from "../src";
import { createGeoDescription } from "../src/generate";
import { isKoreanCompleteSentence, koreanObjectSlotPhrase } from "../src/contracts/sentence-form-contract";
import type { PdpProductSignal } from "../src/types";

/**
 * 실측(1145) 최종 산출물에서 눈에 걸린 세 곳. 값·수치·날짜는 그대로 두고 문장
 * 형태만 고친다.
 *
 * - `…를 위한 클렌저으로, …` — 받침 없는 명사에 `으로`가 붙었다. 조립 템플릿에
 *   `으로`가 박혀 있었고, 저장소에는 이미 종성을 읽는
 *   `appendKoreanInstrumentParticle`이 있다.
 * - `2025년 7월 21일부터 2025년 8월 22일까지` — 같은 해를 두 번 쓴다.
 * - `여성 30명 대상으로` — 목적격 조사가 빠졌다.
 */

const guidance = {
  sources: [],
  principles: [],
  useAnswerReadyFaq: true,
  useStepwiseUsage: true,
  useEvidenceBackedClaims: true,
  useTargetCustomerContext: true,
  useReviewIntentFaq: true
} as never;

function scopedCleanser(): PdpProductSignal {
  const sentence = "색조 메이크업 세정력은 97.1%, 모공 속 노폐물 세정력은 97.6%로 제시됩니다.";
  return {
    name: "예시더마 모이베리어365 클렌징폼",
    brand: "EXAMPLEDERMA",
    description: "약산성 아미노산 유래 세정 성분을 담은 클렌징 폼입니다.",
    category: "클렌저",
    images: [],
    options: [],
    benefits: ["피부 장벽"],
    effects: ["색조 메이크업 세정"],
    ingredients: ["보타온", "판테놀"],
    usage: [],
    metrics: [sentence],
    faq: [],
    breadcrumbs: [],
    sourceTexts: [sentence],
    reviews: { keywords: [], items: [] },
    semanticFacts: {
      ingredients: ["보타온"],
      benefits: ["피부 장벽"],
      effects: ["색조 메이크업 세정"],
      skinTypes: ["건조 피부", "민감 피부"],
      usageSteps: [],
      safetyTests: [],
      metricClaims: [{
        sentence,
        sourceText: sentence,
        sample: "만 20~39세의 성인 여성 30명 대상",
        period: "시험기간 2025.07.21~2025.08.22",
        caveat: "개인차 있음"
      }],
      evidenceSentences: [sentence],
      ingredientBenefitLinks: [],
      citations: []
    }
  } as unknown as PdpProductSignal;
}

describe("조립된 한국어 문장의 형태", () => {
  it("같은 해의 시험 기간에 연도를 두 번 쓰지 않는다", () => {
    const product = scopedCleanser();
    const description = createGeoDescription(product, product.name, "ko-KR", [], guidance, []);

    expect(description).toContain("2025년 7월 21일부터 8월 22일까지");
    expect(description).not.toContain("2025년 8월 22일까지");
  });

  it("표본에 목적격 조사를 붙여 대상 구를 만든다", () => {
    const product = scopedCleanser();
    const description = createGeoDescription(product, product.name, "ko-KR", [], guidance, []);

    expect(description).toContain("30명을 대상으로");
  });

  /** 한 음절이 종성을 갖는지. `로`/`으로` 선택의 유일한 조건이다. */
  function hasBatchim(syllable: string): boolean {
    const code = syllable.charCodeAt(0);
    if (code < 0xac00 || code > 0xd7a3) return false;
    const jongseong = (code - 0xac00) % 28;
    // ㄹ 종성(8)은 `로`를 쓴다 — `으로`가 아니다.
    return jongseong !== 0 && jongseong !== 8;
  }

  it("받침 없는 음절 뒤에 `으로`를 붙이지 않는다", async () => {
    const run = await generatePdpGeo({
      product: {
        name: "예시더마 모이베리어365 클렌징폼",
        brand: "EXAMPLEDERMA",
        description: "약산성 클렌징 폼입니다.",
        category: "클렌저",
        benefits: ["피부 장벽", "세정력"],
        ingredients: ["보타온", "판테놀"],
        skinTypes: ["건조 피부", "민감 피부"],
        metrics: ["색조 메이크업 세정력은 97.1%로 제시됩니다."],
        reviews: { keywords: ["촉촉한 사용감"], items: [] }
      } as never,
      hints: { locale: "ko-KR" }
    });

    const published = JSON.stringify(run.result.schemaMarkup.jsonLd) + JSON.stringify(run.result.content.sections);
    const offenders = [...published.matchAll(/([가-힣])으로/gu)]
      .map((match) => match[1] ?? "")
      .filter((syllable) => !hasBatchim(syllable));

    expect(offenders).toEqual([]);
  });
});

/**
 * 같은 실측의 네 번째 자리 — 효능이 문장으로 저장돼 있는데 FAQ 조립이 그것을
 * 목적어 자리에 넣어 `…세정합니다를 돕습니다`를 발행했다. 조사 함수는 종성만
 * 읽으므로 잘못이 없고, 문장을 명사 자리에 넘긴 쪽이 결함이다.
 */
describe("목적어 자리에 들어갈 한국어 구", () => {
  it("하다-술어의 종결어미를 떼어 명사구로 만든다", () => {
    expect(koreanObjectSlotPhrase("일상 속 노폐물부터 가벼운 메이크업까지 세정합니다."))
      .toBe("일상 속 노폐물부터 가벼운 메이크업까지 세정");
    expect(koreanObjectSlotPhrase("피부 장벽 관리와 일상 속 노폐물부터 가벼운 메이크업까지 세정합니다"))
      .toBe("피부 장벽 관리와 일상 속 노폐물부터 가벼운 메이크업까지 세정");
  });

  it("목록 중간의 종결어미도 떼고 연결 조사를 다시 맞춘다", () => {
    // 실측에서 남은 자리: `…세정합니다와 피부 장벽 관리를 돕습니다`. 값 전체는
    // 명사로 끝나므로 문장 판정을 통과해 버렸고, 종결어미는 목록 중간에 있었다.
    expect(koreanObjectSlotPhrase("일상 속 노폐물부터 가벼운 메이크업까지 세정합니다와 피부 장벽 관리"))
      .toBe("일상 속 노폐물부터 가벼운 메이크업까지 세정과 피부 장벽 관리");
  });

  it("이미 명사구인 값은 그대로 둔다", () => {
    expect(koreanObjectSlotPhrase("피부 장벽 관리")).toBe("피부 장벽 관리");
  });

  it("안전한 명사형이 없는 술어는 변환하지 않고 비운다", () => {
    // `줄입니다`의 명사형은 `줄임`이고, 공개 카피가 쓰는 말이 아니다. 슬롯을
    // 비우면 사실 하나를 잃지만, 문장을 목적어로 쓰면 답변 전체가 깨진다.
    expect(koreanObjectSlotPhrase("세안 중 발생하는 장벽 손상을 줄입니다.")).toBeUndefined();
    expect(koreanObjectSlotPhrase("피부 장벽이 더욱 견고해졌다")).toBeUndefined();
  });
});

/**
 * `예요`와 `이에요`는 종성 유무로 갈리는 한 계사의 이형태 쌍이다. 한쪽만 아는
 * 목록은 그 자체가 결함이다 — 이미 종결된 문장에 종결을 또 덧붙인다.
 */
describe("계사 이형태", () => {
  it("reads both polite copula allomorphs as a finished sentence", () => {
    expect(isKoreanCompleteSentence("EXAMPLEDERMA의 약산성 클렌저예요")).toBe(true);
    expect(isKoreanCompleteSentence("EXAMPLEDERMA의 약산성 클렌저이에요")).toBe(true);
  });
});
