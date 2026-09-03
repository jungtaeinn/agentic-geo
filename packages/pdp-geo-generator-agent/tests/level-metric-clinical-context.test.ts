import { describe, expect, it } from "vitest";
import { createGeoDescription } from "../src/generate";
import type { PdpProductSignal } from "../src/types";

/**
 * 수준을 말하는 지표는 변화를 말하는 지표와 같은 대접을 받아야 한다.
 *
 * `hasSemanticClinicalClaimContext`가 변화 방향 어휘(증가·개선·감소…)를 요구했다.
 * `세정력은 97.1%`는 변화가 아니라 수준이라 그 어휘가 없고, 그래서 표본과
 * 기간이 원자에 들어와 있어도 임상 클레임으로 인식되지 않아 조건이 붙은 구조
 * 문장이 조립되지 않았다. Task 9가 지표 판정에서 성과 어휘 열거를 걷어낸 것과
 * 같은 결함이 이 지점에 남아 있었고, 실측에서 E-E-A-T가 3회 중 2회 미달로
 * 나타났다(발행 문장에 표본이 실리는지가 모델의 우연에 달려 있었다).
 */

function cleanserWithScopedLevelMetric(): PdpProductSignal {
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

describe("수준을 말하는 지표도 자기 시험 조건을 싣는다", () => {
  it("변화 방향 어휘가 없어도 표본과 기간이 발행 문장에 들어간다", () => {
    const product = cleanserWithScopedLevelMetric();
    const description = createGeoDescription(product, product.name, "ko-KR", [], {
      sources: [],
      principles: [],
      useAnswerReadyFaq: true,
      useStepwiseUsage: true,
      useEvidenceBackedClaims: true,
      useTargetCustomerContext: true,
      useReviewIntentFaq: true
    } as never, []);

    expect(description).toContain("97.1%");
    // 이 두 어서션이 E-E-A-T 감점의 유일한 원인을 고정한다.
    expect(description).toMatch(/30명/u);
    expect(description).toMatch(/2025\.07\.21|2025년\s*7월/u);
  });
});

describe("지표 문장은 그 문장만으로 주체와 단서를 갖는다", () => {
  /**
   * 답변엔진은 문장 하나를 들어낸다. 수치만 있고 무엇의 수치인지 없으면 그
   * 문장은 이 상품에 귀속되지 않고, 단서가 빠지면 계약이 요구하는 형태가
   * 아니다(계획서 7c 1단·2단).
   */
  it("상품명과 개인차 단서를 함께 싣는다", () => {
    const product = cleanserWithScopedLevelMetric();
    const description = createGeoDescription(product, product.name, "ko-KR", [], {
      sources: [],
      principles: [],
      useAnswerReadyFaq: true,
      useStepwiseUsage: true,
      useEvidenceBackedClaims: true,
      useTargetCustomerContext: true,
      useReviewIntentFaq: true
    } as never, []);

    const metricSentence = description
      .split(/(?<=니다\.)\s*/u)
      .find((sentence) => sentence.includes("97.1%")) ?? "";

    expect(metricSentence).toContain("30명을 대상으로");
    expect(metricSentence).toContain("예시더마 모이베리어365 클렌징폼");
    // 상품명 반복을 줄이는 예산이 이 문장의 이름까지 지시어로 바꾸면 안 된다 —
    // 단독으로 인용되는 문장이라 이름이 있어야 이 상품에 귀속된다.
    expect(metricSentence).not.toContain("이 제품");
    expect(description).toMatch(/개인차/u);
  });
});

describe("시험 결과를 묻는 FAQ는 결과를 담을 때만 그렇게 묻는다", () => {
  /**
   * 실측(1145 h1~h3, 3/3)에서 `…어떤 효능이 있고, 시험 결과로도 확인되나요?`라는
   * 질문의 답변에 시험 결과가 한 글자도 없었다. 상품에 그런 근거가 있는지와
   * 이 답변이 그것을 받는지는 다른 문제이고, 지표의 주인이 Product.description
   * 하나이므로 이 답변의 근거 슬롯은 의도적으로 비어 있다.
   */
  it("답변에 결과가 없으면 질문도 시험을 약속하지 않는다", async () => {
    const { generatePdpGeo } = await import("../src");
    const product = cleanserWithScopedLevelMetric();
    const run = await generatePdpGeo({ product: product as never, hints: { locale: "ko-KR" } });

    const faq = (run.result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>)
      .find((node) => node["@type"] === "FAQPage");
    for (const item of (faq?.mainEntity ?? []) as Array<Record<string, any>>) {
      if (/시험\s*결과로도\s*확인되나요/u.test(String(item.name ?? ""))) {
        expect(String(item.acceptedAnswer?.text ?? ""), String(item.name)).toMatch(/\d/u);
      }
    }
  });
});
