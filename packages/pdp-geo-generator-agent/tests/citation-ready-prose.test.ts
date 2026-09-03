import { describe, expect, it } from "vitest";
import { createGeoDescription, generatePdpGeoArtifacts, isCitationReadyProse, selectDescriptionEfficacyDetails } from "../src/generate";
import type { PdpProductSignal } from "../src/types";

/**
 * 결정적 산문 경로의 자립성 게이트.
 *
 * 픽스처 문장은 2026-08-31 예시더마 1027 실측에서 결정적 폴백이 그대로
 * 발행한 원문이다. 어휘가 아니라 문장의 기능(선행사 없는 지시어 개시,
 * 라벨 직렬화 전사)을 고정한다.
 */

const antecedentLessDemonstrativeSentence = "이 때 시멘트가 촘촘하게 발리지 않으면 벽돌이 무너지게 되는 것처럼 피부 장벽에서도 지질의 역할이 매우 중요한데, 이 지질은 세라마이드/콜레스테롤/지방산이라는 성분으로 이루어져있고 층층이 쌓인 층판형 구조를 가지고 있습니다.";
const labelSerializedSentence = "시험기관: 피엔케이피부임상연구센타 시험기간: 2023.10.05~2023.10.10 시험대상: 성인 여성 20명";
const footnoteSerializedSentence = "크림 밀착 오일로 피부 보습까지 * 개인차가 있을 수 있습니다. * 인체적용시험 결과에 한함. * 시험기관: 피엔케이피부임상연구센타 * 시험기간: 2023.10.05~2023.10.10 * 시험대상: 성인 여성 20명";
/**
 * 라벨 쌍이 하나도 없이 각주 마커만으로 직렬화된 전사.
 *
 * `normalizeReportedDetail`이 `*`를 지우고 나면 마커 절 계수가 0이 되어
 * 직렬화 판정이 사라진다 — 마커만으로 걸리는 이 문장은 산문 게이트가
 * 정규화보다 먼저 도는지를 홀로 고정한다(라벨 쌍이 섞이면 정규화 이후에도
 * 걸려버려 순서 결함이 드러나지 않는다).
 */
const markerOnlySerializedSentence = "4주간 사용 후 피부 장벽 기능이 32% 개선되었습니다 * 개인차가 있을 수 있습니다 * 인체적용시험 결과에 한함";
/** 불릿이 붙은 채로 원장에 실린 같은 문장 — 마커가 문두 앵커를 우회하지 못하는지 고정한다. */
const bulletedDemonstrativeSentence = `- ${antecedentLessDemonstrativeSentence}`;
/** 같은 어휘를 쓰는 자립 문장 — 필터가 "그 문장"만 거르는지 고정한다. */
const selfContainedCeramideSentence = "세라마이드는 피부 장벽을 강화하고 피부 내 수분을 유지하는 데 도움을 주는 성분입니다.";
const selfContainedPanthenolSentence = "판테놀은 건조로 예민해진 피부를 진정시키는 데 도움을 주는 성분입니다.";
/** 자립 요약형 근거 — 게이트가 정상 요약값까지 비워버리면 이 앵커가 깨진다. */
const selfContainedStudyResultSentence = "인체적용시험 결과 사용 4주 후 피부 수분량이 33.7% 증가했습니다.";

describe("isCitationReadyProse", () => {
  it("rejects sentences that open with an antecedent-less demonstrative", () => {
    expect(isCitationReadyProse(antecedentLessDemonstrativeSentence)).toBe(false);
    expect(isCitationReadyProse("이처럼 세라마이드가 포함된 제품은 장벽 케어에 효과적입니다.")).toBe(false);
  });

  it("rejects label-serialized raw transcriptions", () => {
    expect(isCitationReadyProse("크림 밀착 오일로 피부 보습까지 * 개인차가 있을 수 있습니다. * 인체적용시험 결과에 한함. * 시험기관: 피엔케이피부임상연구센타 * 시험기간: 2023.10.05~2023.10.10 * 시험대상: 성인 여성 20명")).toBe(false);
    expect(isCitationReadyProse(labelSerializedSentence)).toBe(false);
  });

  it("accepts self-contained product sentences (콜론 1회 포함)", () => {
    expect(isCitationReadyProse("세라마이드는 피부 장벽을 강화하고 피부 내 수분을 유지하는 데 도움을 주는 성분입니다.")).toBe(true);
    expect(isCitationReadyProse("주요 성분: 세라마이드 10,000ppm이 함유되어 있습니다.")).toBe(true);
  });

  it("keeps sentences whose opening word merely starts with a demonstrative syllable", () => {
    expect(isCitationReadyProse("이온화된 미네랄 워터가 피부 장벽의 수분 보유력을 높이는 데 도움을 줍니다.")).toBe(true);
    expect(isCitationReadyProse("그린티 추출물이 피지 밸런스를 정돈해 피부결 개선에 도움을 줍니다.")).toBe(true);
    expect(isCitationReadyProse("저자극 테스트를 완료한 포뮬러로 예민한 피부에도 사용할 수 있습니다.")).toBe(true);
    expect(isCitationReadyProse("이중 세안 후 마지막 단계에 사용하면 수분 보유에 도움을 줍니다.")).toBe(true);
  });

  it("keeps English prose that is not opened by a demonstrative", () => {
    expect(isCitationReadyProse("Ceramide supports the skin barrier and helps retain moisture.")).toBe(true);
    expect(isCitationReadyProse("This helps the skin barrier retain moisture after cleansing.")).toBe(false);
  });

  it("sees through a bullet or list number in front of the demonstrative", () => {
    expect(isCitationReadyProse(`- ${antecedentLessDemonstrativeSentence}`)).toBe(false);
    expect(isCitationReadyProse("• 이 때 세라마이드가 부족하면 피부 장벽이 무너집니다.")).toBe(false);
    expect(isCitationReadyProse("① 이 지질은 세라마이드로 이루어진 층판형 구조를 가지고 있습니다.")).toBe(false);
    expect(isCitationReadyProse("1. 이는 피부 장벽의 보습 성분을 보완하는 원리입니다.")).toBe(false);
    expect(isCitationReadyProse("* This supports the skin barrier after cleansing.")).toBe(false);
  });

  it("keeps a marker-prefixed sentence whose first word is not a demonstrative", () => {
    expect(isCitationReadyProse("- 세라마이드는 피부 장벽을 강화하는 데 도움을 주는 성분입니다.")).toBe(true);
    expect(isCitationReadyProse("1. 이온화된 미네랄 워터가 수분 보유력을 높이는 데 도움을 줍니다.")).toBe(true);
  });

  it("keeps Japanese lexicalized forms that only look like demonstratives", () => {
    expect(isCitationReadyProse("そのまま洗い流すだけで肌のうるおいを保ちます。")).toBe(true);
    expect(isCitationReadyProse("それぞれの肌悩みに合わせて使い分けることができます。")).toBe(true);
    expect(isCitationReadyProse("この製品は肌のバリア機能をサポートします。")).toBe(false);
    expect(isCitationReadyProse("これは洗顔後の最初のステップとして使う化粧水です。")).toBe(false);
  });
});

function symptomProduct(overrides: Partial<PdpProductSignal> = {}): PdpProductSignal {
  return {
    name: "예시더마 모이베리어365 크림",
    brand: "예시더마",
    description: "피부 장벽 보습 케어를 돕는 크림입니다.",
    images: [],
    options: [],
    benefits: ["보습", "피부 장벽 케어"],
    effects: [footnoteSerializedSentence, labelSerializedSentence, selfContainedStudyResultSentence],
    ingredients: ["세라마이드", "판테놀"],
    usage: [],
    metrics: ["피부 수분량 33.7% 증가"],
    faq: [],
    reviews: { items: [], keywords: [] },
    breadcrumbs: [],
    sourceTexts: [
      bulletedDemonstrativeSentence,
      footnoteSerializedSentence,
      labelSerializedSentence,
      selfContainedCeramideSentence,
      selfContainedPanthenolSentence,
      selfContainedStudyResultSentence
    ],
    semanticFacts: {
      ingredients: ["세라마이드", "판테놀"],
      benefits: ["보습"],
      effects: [],
      skinTypes: [],
      usageSteps: [],
      metricClaims: [],
      evidenceSentences: [bulletedDemonstrativeSentence, footnoteSerializedSentence, labelSerializedSentence],
      ingredientBenefitLinks: []
    },
    ...overrides
  };
}

function testGuidance(): Parameters<typeof createGeoDescription>[4] {
  return {
    sources: [],
    principles: [],
    reasoning: {} as Parameters<typeof createGeoDescription>[4]["reasoning"],
    useAnswerReadyFaq: true,
    useStepwiseUsage: true,
    useEvidenceBackedClaims: true,
    useTargetCustomerContext: true,
    useReviewIntentFaq: true
  };
}

describe("createGeoDescription", () => {
  it("never publishes the raw demonstrative or label-serialized source sentences", () => {
    const product = symptomProduct();

    const description = createGeoDescription(product, product.name, "ko-KR", [], testGuidance(), []);

    expect(description).not.toContain("시멘트");
    expect(description).not.toContain("시험기관:");
  });

  it("keeps the self-contained sentences that use the same vocabulary", () => {
    const product = symptomProduct();

    const description = createGeoDescription(product, product.name, "ko-KR", [], testGuidance(), []);

    expect(description).toContain("세라마이드는 피부 장벽을 강화하고");
    expect(description).toContain("판테놀은 건조로 예민해진 피부를 진정");
  });
});

describe("selectDescriptionEfficacyDetails", () => {
  it("drops a marker-only serialized transcription before normalization erases its markers", () => {
    expect(isCitationReadyProse(markerOnlySerializedSentence)).toBe(false);

    const details = selectDescriptionEfficacyDetails(
      symptomProduct({ effects: [markerOnlySerializedSentence], sourceTexts: [], metrics: [], benefits: [] }),
      "ko-KR",
      3
    );

    expect(details.join(" ")).not.toContain("개인차가 있을 수 있습니다");
    expect(details.join(" ")).not.toContain("인체적용시험 결과에 한함");
  });

  it("still selects the self-contained study result from the same path", () => {
    const details = selectDescriptionEfficacyDetails(
      symptomProduct({ effects: [selfContainedStudyResultSentence], sourceTexts: [], metrics: [], benefits: [] }),
      "ko-KR",
      3
    );

    expect(details.join(" ")).toContain("33.7");
  });
});

describe("generatePdpGeoArtifacts", () => {
  it("keeps label-serialized provenance out of the summary-style additionalProperty values", () => {
    const { schemaMarkup } = generatePdpGeoArtifacts({
      product: symptomProduct(),
      locale: "ko-KR",
      ragChunks: [],
      ragDocuments: []
    });

    expect(JSON.stringify(schemaMarkup.jsonLd)).not.toContain("시험기관:");
    expect(JSON.stringify(schemaMarkup.jsonLd)).not.toContain("시멘트");
  });

  /**
   * 1145 실측: `Reported details`가 차트 라벨 연쇄(`… 97.1% 세정 사용 전 사용 후
   * … 사용 2주 후 사용 4주 후 …`)를 그대로 실었다. 같은 수치가 구조화 지표로
   * 표본·기간과 함께 원장에 있는데도 원문 쪽이 이겼고, 그래서 발행된 수치에
   * 표본이 없다는 신뢰 감점까지 함께 났다. 구조화 지표가 있으면 그쪽이 정본이다.
   */
  it("prefers the structured metric claim over the raw chart-label transcription", () => {
    const chartLabelChain = "일상 속 노폐물부터 가벼운 메이크업까지 세정, 장벽보호 · 딥클렌징 집앞 나갈때 가볍게 하는 색조 메이크업 97.1% 세정 사용 전 사용 후 눈에 잘 띄어 늘 고민인 모공 속 노폐물 97.6% 세정 사용 전 사용 후 사용 2주 후 사용 4주 후";
    const { schemaMarkup } = generatePdpGeoArtifacts({
      product: symptomProduct({
        metrics: [chartLabelChain, "색조 메이크업 97.1% 세정"],
        effects: [chartLabelChain],
        sourceTexts: [chartLabelChain],
        semanticFacts: {
          ingredients: ["세라마이드"],
          benefits: [],
          effects: [],
          skinTypes: [],
          usageSteps: [],
          evidenceSentences: [],
          ingredientBenefitLinks: [],
          citations: [],
          metricClaims: [
            {
              subject: "색조 메이크업",
              value: "97.1",
              unit: "%",
              metric: "세정",
              period: "2025.07.21~2025.08.22",
              sample: "만 20~39세 성인 여성 30명",
              caveat: "개인차 있음",
              sentence: "색조 메이크업 97.1% 세정",
              sourceText: "색조 메이크업 97.1% 세정 결과를 제시하며, 시험 대상은 만 20~39세 성인 여성 30명이고 시험 기간은 2025.07.21~2025.08.22로 안내됩니다."
            }
          ]
        } as never
      }),
      locale: "ko-KR",
      ragChunks: [],
      ragDocuments: []
    });

    const product = (schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>)
      .find((node) => node["@type"] === "Product");
    const reported = String((product?.additionalProperty as Array<Record<string, string>> | undefined)
      ?.find((entry) => entry.name === "Reported details")?.value ?? "");

    expect(reported).not.toContain("사용 전 사용 후");
    expect(reported).not.toContain("딥클렌징");
    expect(reported).toContain("30명");
  });

  it("still publishes the self-contained study result as a summary-style property", () => {
    const { schemaMarkup } = generatePdpGeoArtifacts({
      product: symptomProduct(),
      locale: "ko-KR",
      ragChunks: [],
      ragDocuments: []
    });

    const product = (schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>)
      .find((node) => node["@type"] === "Product");
    const summary = (product?.additionalProperty as Array<Record<string, string>> | undefined)
      ?.find((entry) => /^(?:Reported details|Clinical result summary|Reported assessment summary)$/.test(entry.name ?? ""));

    expect(summary?.value).toContain("33.7");
  });
});
