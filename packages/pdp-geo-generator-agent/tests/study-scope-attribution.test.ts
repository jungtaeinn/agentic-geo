import { describe, expect, it } from "vitest";
import { annotatedFigureScopes, readReportedStudyScope } from "../src/contracts/metric-statement-contract";
import { sanitizePdpSemanticFacts } from "../src/normalize";
import {
  hasAnalysisLabelArtifact,
  leadingBareReportingLabelPattern,
  leadingInternalLabelPattern,
  leadingLabelFieldPattern
} from "../src/contracts/analysis-label-contract";
import { normalizePdpProduct } from "../src/normalize";

/**
 * Fable 리뷰(2026-09-02)가 실행으로 확인한 회귀 4건. 전부 이 세션의 변경이
 * 만든 것이고, 셋은 발행되는 사실을 틀리게 한다.
 */

describe("표본은 날짜의 일(日)에서 읽히지 않는다", () => {
  it("`2024.03.29 인체적용시험`을 `29 인`으로 읽지 않는다", () => {
    const scope = readReportedStudyScope("시험기간 2024.03.04~2024.03.29 인체적용시험 22명 대상 / 개인차 있음");

    expect(scope?.sample).toBe("22명 대상");
  });

  it("표본이 없는 각주에서는 표본을 만들지 않는다", () => {
    const scope = readReportedStudyScope("시험기간 2024.03.04~2024.03.29 인체적용시험 / 개인차 있음");

    expect(scope?.sample).toBeUndefined();
    expect(scope?.period).toContain("2024.03.04");
  });

  it("한정어가 붙은 표본을 한정어 없는 것보다 우선한다", () => {
    // 인구 수식어(`여성`)는 나이 범위가 함께 있을 때만 구조적으로 잡힌다 —
    // 어휘를 열거하지 않으려면 `인체적용시험 22명`의 `인체적용시험`도 같은
    // 자리에 오므로 수식어 일반화는 방법 이름을 표본으로 만든다.
    expect(readReportedStudyScope("1인 1회 사용 / 여성 32명 대상")?.sample).toBe("32명 대상");
    expect(readReportedStudyScope("만 20~39세의 성인 여성 30명 대상")?.sample).toBe("만 20~39세의 성인 여성 30명 대상");
  });
});

describe("각주가 모호하면 표본을 붙이지 않는다", () => {
  const twoStudyPanel = [
    "사용 직후 보습 2배 증가 사용 2주 후 수분 2배 증가",
    "※ 22명 대상 / 개인차 있음",
    "사용 4주 후 탄력 2배 증가 사용 8주 후 주름 15.2% 개선",
    "※ 30명 대상 / 시험기간 2024.05.01~2024.05.28 / 개인차 있음"
  ].join(" ");

  it("두 각주가 같은 수치를 설명하면 어느 쪽도 붙이지 않는다", () => {
    const claim = "사용 4주 후 탄력이 2배 증가했습니다.";
    const facts = sanitizePdpSemanticFacts({
      metricClaims: [
        { sentence: twoStudyPanel, sourceText: twoStudyPanel },
        { sentence: claim, sourceText: claim }
      ]
    } as never);

    const carried = facts.metricClaims.find((item) => item.sentence === claim);
    expect(carried).toBeDefined();
    expect(carried?.sample).toBeUndefined();
  });

  it("한 각주만 설명하는 수치는 그 각주의 표본을 받는다", () => {
    const claim = "사용 8주 후 주름이 15.2% 개선되었습니다.";
    const facts = sanitizePdpSemanticFacts({
      metricClaims: [
        { sentence: twoStudyPanel, sourceText: twoStudyPanel },
        { sentence: claim, sourceText: claim }
      ]
    } as never);

    expect(facts.metricClaims.find((item) => item.sentence === claim)?.sample).toBe("30명 대상");
  });

  it("각주 안의 기관 표기가 길어도 한 각주로 읽는다", () => {
    const panel = "사용 4주 후 보습이 30% 증가 ※ (주)글로벌의학연구센터 여성 32명 대상 / 시험기간 2025.01.02~2025.02.16 / 개인차 있음";
    const scopes = annotatedFigureScopes(panel);

    expect(scopes).toHaveLength(1);
    expect(scopes[0]?.scope.sample).toBe("32명 대상");
    expect(scopes[0]?.scope.period).toContain("2025.01.02");
    expect(scopes[0]?.scope.caveat).toContain("개인차");
  });
});

describe("라벨 제거는 다음 단어를 먹지 않는다", () => {
  it("조사로 읽으려면 그 뒤가 경계여야 한다", () => {
    expect("측정 결과 이마 주름이 개선되었습니다.".replace(leadingLabelFieldPattern, ""))
      .toBe("측정 결과 이마 주름이 개선되었습니다.");
    expect("시험 결과 가려움이 감소했습니다.".replace(leadingBareReportingLabelPattern, ""))
      .toBe("가려움이 감소했습니다.");
    // 라벨이 실제로 주어 자리에 오면 여전히 제거된다.
    expect("측정 결과는 다음과 같습니다.".replace(leadingLabelFieldPattern, ""))
      .toBe("다음과 같습니다.");
    expect("평가 지표: 84.3% 증가".replace(leadingLabelFieldPattern, "")).toBe("84.3% 증가");
  });

  it("판정 쪽도 같은 경계를 읽는다", () => {
    expect(hasAnalysisLabelArtifact("측정 결과 이마 주름이 개선되었습니다.")).toBe(false);
    expect(hasAnalysisLabelArtifact("측정 결과는 다음과 같습니다.")).toBe(true);
  });
});

describe("리뷰 키워드는 배제된 명사구만 버린다", () => {
  function keywordsOf(body: string): string[] {
    return normalizePdpProduct({
      name: "예시더마 모이베리어365 클렌징폼",
      description: "약산성 클렌징폼입니다.",
      category: "클렌저",
      reviews: { items: [{ body }], keywords: [] }
    }, { hints: { locale: "ko-KR" } }).product.reviews.keywords;
  }

  it("구두점 뒤에 공백이 없어도 절을 나눈다", () => {
    const keywords = keywordsOf("보습 좋아요.촉촉하고 흡수 빨라요.향 빼고 다 좋아요");

    expect(keywords.some((keyword) => keyword.includes("촉촉"))).toBe(true);
  });

  it("긍정 문장 안의 `아닌`을 배제로 읽지 않는다", () => {
    const keywords = keywordsOf("건성이 아닌 피부에도 촉촉해요 보습 만족");

    expect(keywords.some((keyword) => keyword.includes("촉촉"))).toBe(true);
  });

  it("배제 표지 뒤의 속성은 남는다", () => {
    const keywords = keywordsOf("가격 말고는 다 만족합니다 보습 탄력 피부결 다 좋아요");

    expect(keywords.length).toBeGreaterThan(0);
  });

  it("배제 표지 앞의 속성은 버린다", () => {
    const keywords = keywordsOf("탄력개선이 필요한 연령대 제외 모두 만족할 제품이에요. 촉촉하고 순해서 좋아요.");

    expect(keywords.join(" ")).not.toContain("탄력");
    expect(keywords.some((keyword) => keyword.includes("촉촉"))).toBe(true);
  });
});

describe("`시험 결과` 부사어는 산문에서 살아남는다", () => {
  /**
   * `시험 결과 보습량이 2배 증가했습니다`의 `시험 결과`는 필드 이름이 아니라
   * 부사어이고, 지우면 문장이 무엇을 근거로 말하는지가 사라진다. 그래서 산문일
   * 수 있는 값에는 구분자 없는 제거를 쓰지 않는다.
   */
  const adverbial = "시험 결과 보습량이 2배 증가했습니다.";

  it("내부 라벨만 구분자 없이 지운다", () => {
    expect(adverbial.replace(leadingInternalLabelPattern, "")).toBe(adverbial);
    expect("측정/평가 결과 84.3% 증가".replace(leadingInternalLabelPattern, "")).toBe("84.3% 증가");
    expect("확인 지표: 84.3% 증가".replace(leadingInternalLabelPattern, "")).toBe("84.3% 증가");
  });

  it("라벨 접두 조각임이 확정된 값에서만 `시험 결과`를 지운다", () => {
    expect(adverbial.replace(leadingBareReportingLabelPattern, "")).toBe("보습량이 2배 증가했습니다.");
  });
});

describe("표본 부사구는 조사를 겹치지 않는다", () => {
  it("원문이 이미 `대상`으로 끝나도 `대상을 대상으로`가 되지 않는다", async () => {
    const { createGeoDescription } = await import("../src/generate");
    const sentence = "피부 보습이 사용 4주 후 30% 증가했습니다.";
    const product = {
      name: "하이드라 배리어 크림",
      description: "건조한 피부를 위한 크림입니다.",
      category: "크림",
      images: [], options: [], benefits: ["보습"], effects: [], ingredients: ["세라마이드"],
      usage: [], metrics: [sentence], faq: [], breadcrumbs: [], sourceTexts: [sentence],
      reviews: { keywords: [], items: [] },
      semanticFacts: {
        ingredients: ["세라마이드"], benefits: ["보습"], effects: [], skinTypes: ["건조 피부"],
        usageSteps: [], safetyTests: [],
        metricClaims: [{
          subject: "피부 보습", value: "30", unit: "%", metric: "보습량", direction: "증가",
          timing: "사용 4주 후", method: "인체적용시험",
          sample: "만 20~39세 여성 22명 대상", period: "시험기간 2024.03.04~2024.04.01",
          sentence, sourceText: sentence
        }],
        evidenceSentences: [sentence], ingredientBenefitLinks: [], citations: []
      }
    } as never;
    const description = createGeoDescription(product, "하이드라 배리어 크림", "ko-KR", [], {
      sources: [], principles: [], useAnswerReadyFaq: true, useStepwiseUsage: true,
      useEvidenceBackedClaims: true, useTargetCustomerContext: true, useReviewIntentFaq: true
    } as never, []);

    expect(description).not.toContain("대상을 대상으로");
    expect(description).toContain("22명을 대상으로");
  });
});
