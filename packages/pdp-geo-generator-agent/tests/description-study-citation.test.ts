import { describe, expect, it, vi } from "vitest";
import { planPdpGeoContent } from "../src/content-planner";
import { normalizePdpProduct } from "../src/normalize";
import { planningRequest, planPayload } from "./support/planning";

/**
 * The description contract's fifth stage is the source-stated study citation.
 * A run against the EXAMPLEDERMA 모이베리어365 크림 PDP dropped exactly that stage:
 * the ledger held every metric atom, yet the sentence was removed as an
 * unsupported claim unit, leaving a three-stage description.
 *
 * The cause was not a missing fact. The metric atoms serialize their period as
 * `period=2023.02.02-2023.03.23`, while natural Korean prose renders the same
 * dates as `2023년 2월 2일부터 3월 23일까지`. The numeric gate compared those as
 * loose numerals, so the prose date read as a numeric relationship absent from
 * the evidence — a formatting difference judged as a fabricated measurement.
 *
 * Calendar dates are provenance, not measurements. They are compared as dates
 * so the gate keeps doing its real job: stopping an outcome the study never
 * reported.
 */
const product = normalizePdpProduct({
  name: "모이베리어365 크림",
  description: "데일리 케어에 맞게 진화된 보타온 기술이 건조하고 민감한 피부의 장벽 기능을 강화시켜줍니다.",
  brand: "EXAMPLEDERMA",
  category: "크림",
  benefits: ["피부장벽 강화", "120시간 보습 지속"],
  ingredients: ["고밀도 세라마이드 캡슐", "롱체인 세라마이드"],
  metrics: ["사용 직후 보습량 2배 증가", "단 10분 만에 손상장벽 2배 개선"]
}, { hints: { locale: "ko-KR" } }).product;

const productWithStudy = {
  ...product,
  semanticFacts: {
    ingredients: ["고밀도 세라마이드 캡슐", "롱체인 세라마이드"],
    benefits: ["피부장벽 강화", "120시간 보습 지속"],
    effects: [],
    skinTypes: ["건조 피부", "민감 피부"],
    usageSteps: [],
    safetyTests: [],
    metricClaims: [
      {
        label: "보습량",
        subject: "제품 사용 부위",
        value: "2",
        unit: "배",
        metric: "보습량",
        direction: "증가",
        timing: "사용 직후",
        baseline: "사용 전",
        period: "2023.02.02-2023.03.23",
        sample: "스스로 피부가 민감하다고 느끼고 건조 고민이 있는 성인 32명",
        method: "인체적용시험",
        institution: "(주)엘리드",
        evidenceGroup: "엘리드 인체적용시험",
        sentence: "사용 직후 보습량 2배 증가",
        sourceText: "(주)엘리드, 2023.02.02-2023.03.23, 성인 32명 대상 인체적용시험 완료"
      },
      {
        label: "손상장벽",
        subject: "손상장벽",
        value: "2",
        unit: "배",
        metric: "개선",
        direction: "개선",
        timing: "사용 10분 만에",
        baseline: "사용 전",
        period: "2023.02.02-2023.03.23",
        sample: "스스로 피부가 민감하다고 느끼고 건조 고민이 있는 성인 32명",
        method: "인체적용시험",
        institution: "(주)엘리드",
        evidenceGroup: "엘리드 인체적용시험",
        sentence: "단 10분 만에 손상장벽 2배 개선",
        sourceText: "(주)엘리드, 2023.02.02-2023.03.23, 성인 32명 대상 인체적용시험 완료"
      }
    ],
    evidenceSentences: [],
    ingredientBenefitLinks: [],
    citations: []
  }
} as typeof product;

const request = planningRequest(productWithStudy, "ko-KR");
const metricIds = request.evidenceLedger
  .filter((item) => item.role === "metric")
  .map((item) => item.id);

const STUDY_SENTENCE = "(주)엘리드가 2023년 2월 2일부터 3월 23일까지 성인 32명을 대상으로 진행한 인체적용시험에서 "
  + "사용 직후 보습량은 사용 전 대비 2배 증가했고, 사용 10분 만에 손상 장벽은 사용 전 대비 2배 개선됐습니다.";

async function planWith(text: string, evidenceIds: string[]) {
  const plan = planPayload({
    productDescription: {
      include: true,
      text,
      intent: "product-entity-summary",
      evidenceIds,
      confidence: 0.9,
      omitReason: ""
    }
  });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    output: [{ content: [{ type: "output_text", text: JSON.stringify(plan) }] }]
  }), { status: 200 })));
  try {
    return await planPdpGeoContent(request, {
      contentPlanning: { enabled: true, provider: "openai", apiKey: "key", model: "gpt-test" }
    });
  } finally {
    vi.unstubAllGlobals();
  }
}

describe("study-citation stage of Product.description", () => {
  it("keeps the study citation when a later sentence is unpublishable", async () => {
    // The shape the real run produced: the model cited identity, audience,
    // benefit and ingredient atoms for the whole paragraph, citing neither the
    // metric nor the review atoms the ledger held, and closed with a bare
    // review-keyword list the wording rules reject.
    //
    // Dropping that closing sentence is correct. Dropping the whole
    // description with it was not: the study citation is the description
    // contract's fifth stage, and it is supported by evidence of its own.
    const citedIds = request.evidenceLedger
      .filter((item) => ["identity", "audience", "benefit", "ingredient", "description"].includes(item.role))
      .map((item) => item.id);
    const result = await planWith(
      "EXAMPLEDERMA 모이베리어365 크림은 건조 피부 또는 민감 피부가 고민인 고객을 위한 보습 크림으로, 피부장벽 강화와 120시간 보습 지속을 내세웁니다. "
      + `${STUDY_SENTENCE} 고객 리뷰에서는 촉촉한 사용감이 언급됩니다.`,
      citedIds
    );

    expect(result.plan.productDescription.include).toBe(true);
    expect(result.plan.productDescription.text).toContain("인체적용시험");
    expect(result.plan.productDescription.text).toContain("2배");
    // Only the offending sentence is removed.
    expect(result.plan.productDescription.text).not.toContain("언급됩니다");
    expect(result.plan.warnings.join(" ")).toMatch(/removed unsupported claim unit/);
  });

  it("recovers metric atoms the plan never cited", async () => {
    // Recovery is what makes the sentence survivable: the plan cited no metric
    // atom, so without it the study sentence has nothing to check against.
    const citedIds = request.evidenceLedger
      .filter((item) => item.role === "identity")
      .map((item) => item.id);
    const result = await planWith(
      `EXAMPLEDERMA 모이베리어365 크림입니다. ${STUDY_SENTENCE}`,
      citedIds
    );

    expect(result.plan.productDescription.text).toContain("인체적용시험");
    expect(result.plan.productDescription.evidenceIds).toEqual(
      expect.arrayContaining([expect.stringContaining("ev-metric")])
    );
  });

  it("keeps a study sentence whose dates are written as locale prose", async () => {
    const result = await planWith(
      `EXAMPLEDERMA 모이베리어365 크림은 건조 피부 또는 민감 피부가 고민인 고객을 위한 보습 크림입니다. ${STUDY_SENTENCE}`,
      metricIds
    );

    expect(result.plan.productDescription.include).toBe(true);
    expect(result.plan.productDescription.text).toContain("인체적용시험");
    expect(result.plan.productDescription.text).toContain("2배");
    expect(result.plan.warnings.join(" ")).not.toMatch(/removed unsupported claim unit/);
  });

  it("still rejects an outcome the cited study never reported", async () => {
    // The gate's real job. A study that measured a 2x change cannot be cited
    // for a 5x one, whatever the date formatting.
    const result = await planWith(
      "EXAMPLEDERMA 모이베리어365 크림은 (주)엘리드가 2023년 2월 2일부터 3월 23일까지 성인 32명을 대상으로 진행한 "
      + "인체적용시험에서 사용 직후 보습량이 사용 전 대비 5배 증가했습니다.",
      metricIds
    );

    expect(result.plan.productDescription.text).not.toContain("5배");
  });

  it("still rejects a study date the cited evidence does not state", async () => {
    const result = await planWith(
      "EXAMPLEDERMA 모이베리어365 크림은 (주)엘리드가 2024년 7월 1일부터 8월 15일까지 성인 32명을 대상으로 진행한 "
      + "인체적용시험에서 사용 직후 보습량이 사용 전 대비 2배 증가했습니다.",
      metricIds
    );

    expect(result.plan.productDescription.text).not.toContain("2024년");
  });
});
