import { describe, expect, it } from "vitest";
import { generatePdpGeo } from "../src/agent";

/**
 * Regression tests for a live 1145 KR run (2026-09-01): a measured cleansing
 * result rendered as a raw field dump —
 * "측정/평가 결과는 in vitro, 30명 대상, 시험기간 2025.07.21~2025.08.22
 * 기준 2주 후 세라마이드 84.3%입니다." — because the realizer fell back to
 * per-product regex enumeration (초미세먼지, 모공 속 노폐물, 버블 평균
 * 사이즈, 세라마이드 함량 …) and, failing that, to a generic context-join
 * ("assessment, N명 대상, 시점 기준 …") that leaked raw study metadata as a
 * parenthetical field dump. The RAG policy forbids exposing 시점/대상/기간/
 * 방법/기관 as bare labels this way.
 *
 * The fix consumes the extractor's already-structured `metricClaims[]`
 * (label/subject/value/unit/metric/baseline/period/sample/evidenceGroup/
 * caveat kept separate) instead of re-parsing prose, and excludes metrics
 * that never made it into that structure rather than dumping them.
 */

function collectPublicTexts(run: Awaited<ReturnType<typeof generatePdpGeo>>): string {
  return [
    JSON.stringify(run.result.schemaMarkup.jsonLd),
    Object.values(run.result.content.sections).join("\n"),
    (run.diagnostics.evidenceLedger ?? []).map((item) => item.text).join("\n"),
    (run.diagnostics.inferredSearchQueries ?? []).map((query) => `${query.question} ${query.answer}`).join("\n")
  ].join("\n");
}

/**
 * Only the actually-published surface (schema markup + rendered content
 * sections), excluding `diagnostics` — the ruling for unstructured metrics is
 * "exclude from public copy, keep in diagnostics", so `diagnostics.
 * evidenceLedger`/`inferredSearchQueries` legitimately retain raw source
 * text for provenance and must not be checked for exclusion.
 */
function collectPublishedTexts(run: Awaited<ReturnType<typeof generatePdpGeo>>): string {
  return [
    JSON.stringify(run.result.schemaMarkup.jsonLd),
    Object.values(run.result.content.sections).join("\n")
  ].join("\n");
}

const baseProduct = {
  name: "테스트 저자극 폼클렌저",
  brand: "테스트브랜드",
  category: "클렌저",
  description: "색조 메이크업과 모공 속 노폐물을 부드럽게 세정하는 폼클렌저입니다.",
  benefits: ["부드러운 세정력"],
  effects: ["색조 메이크업과 모공 속 노폐물 세정"],
  ingredients: ["아미노산 계면활성제"],
  usage: ["적당량을 거품 내어 얼굴에 마사지한 후 미온수로 헹궈냅니다."]
};

function cleansingGroupClaims(direction: string, withCaveat: boolean) {
  return [
    {
      label: "색조 메이크업 세정력",
      subject: "색조 메이크업",
      value: "97.1",
      unit: "%",
      metric: "세정",
      direction,
      baseline: "사용 전",
      sample: "만 20~39세 성인 여성 30명",
      period: "약 한 달",
      method: "세정력 시험",
      evidenceGroup: "세정력 시험",
      caveat: withCaveat ? "개인차가 있을 수 있습니다" : undefined,
      sentence: "색조 메이크업은 사용 전 대비 97.1% 세정되었습니다."
    },
    {
      label: "모공 속 노폐물 세정력",
      subject: "모공 속 노폐물",
      value: "97.6",
      unit: "%",
      metric: "세정",
      direction,
      sample: "만 20~39세 성인 여성 30명",
      period: "약 한 달",
      method: "세정력 시험",
      evidenceGroup: "세정력 시험",
      caveat: withCaveat ? "개인차가 있을 수 있습니다" : undefined,
      sentence: "모공 속 노폐물은 97.6% 세정되었습니다."
    }
  ];
}

function productWithClaims(claims: ReturnType<typeof cleansingGroupClaims>) {
  return {
    ...baseProduct,
    metrics: [
      "만 20~39세 성인 여성 30명을 대상으로 약 한 달간 진행한 세정력 시험에서 색조 메이크업은 사용 전 대비 97.1%, 모공 속 노폐물은 97.6% 세정되었습니다. 개인차가 있을 수 있습니다."
    ],
    semanticFacts: {
      ingredients: ["아미노산 계면활성제"],
      benefits: ["부드러운 세정력"],
      effects: [],
      skinTypes: ["모든 피부"],
      usageSteps: ["적당량을 거품 내어 얼굴에 마사지한 후 미온수로 헹궈냅니다."],
      safetyTests: [],
      metricClaims: claims,
      evidenceSentences: [],
      ingredientBenefitLinks: [],
      citations: []
    }
  };
}

describe("Korean evidenceGroup metric narrative (1145 field-dump regression)", () => {
  it("renders an observation clause + conclusion, with the caveat split into its own sentence, and no field dump", async () => {
    const run = await generatePdpGeo({
      product: productWithClaims(cleansingGroupClaims("증가", true)),
      hints: { locale: "ko-KR", market: "KR" }
    });
    const publicTexts = collectPublicTexts(run);

    // The exact defective wrapper string must never appear.
    expect(publicTexts).not.toMatch(/측정\/평가\s*결과는/);
    // No raw study-metadata field dump (assessment/sample/period joined by
    // commas ahead of "기준").
    expect(publicTexts).not.toMatch(/,[^,.!?。！？]*,[^,.!?。！？]*기준/);

    // Both subjects and values from the group survive as an observation.
    expect(publicTexts).toMatch(/색조\s*메이크업(?:은|는)[^.!?。！？]*97\.1%/);
    expect(publicTexts).toMatch(/모공\s*속\s*노폐물(?:은|는)?[^.!?。！？]*97\.6%/);
    // The conclusion clause is present and the caveat is its own sentence
    // rather than tacked onto the observation.
    expect(publicTexts).toMatch(/효과가\s*있었습니다/);
    expect(publicTexts).toMatch(/단,\s*개인차가\s*있을\s*수\s*있습니다/);
  });

  it("omits the caveat sentence entirely when the claim carries no caveat", async () => {
    const run = await generatePdpGeo({
      product: productWithClaims(cleansingGroupClaims("증가", false)),
      hints: { locale: "ko-KR", market: "KR" }
    });
    const publicTexts = collectPublicTexts(run);

    expect(publicTexts).not.toMatch(/측정\/평가\s*결과는/);
    expect(publicTexts).not.toMatch(/단,\s*개인차/);
  });

  it("does not add \"개선\" wording when the metric's direction is not an improvement/increase type", async () => {
    const run = await generatePdpGeo({
      product: productWithClaims(cleansingGroupClaims("유지", true)),
      hints: { locale: "ko-KR", market: "KR" }
    });
    const publicTexts = collectPublicTexts(run);

    expect(publicTexts).not.toMatch(/측정\/평가\s*결과는/);
    expect(publicTexts).not.toMatch(/개선(?:된|효과)/);
    // The conclusion clause should still exist, just without "개선".
    expect(publicTexts).toMatch(/효과가\s*있었습니다/);
  });

  it("excludes a raw metric string from public copy when it never resolved into a structured metricClaim", async () => {
    const unstructuredProduct = {
      ...baseProduct,
      metrics: [
        "in vitro 시험 결과, 만 20~39세 여성 30명 대상, 시험기간 2025.07.21~2025.08.22, 사용 2주 후 세라마이드 84.3%"
      ],
      semanticFacts: {
        ingredients: ["아미노산 계면활성제"],
        benefits: ["부드러운 세정력"],
        effects: [],
        skinTypes: ["모든 피부"],
        usageSteps: ["적당량을 거품 내어 얼굴에 마사지한 후 미온수로 헹궈냅니다."],
        safetyTests: [],
        // No metricClaims entry backs this raw string — the extractor never
        // structured it (comparison basis unclear), so it must not surface
        // as public copy.
        metricClaims: [],
        evidenceSentences: [],
        ingredientBenefitLinks: [],
        citations: []
      }
    };

    const run = await generatePdpGeo({
      product: unstructuredProduct,
      hints: { locale: "ko-KR", market: "KR" }
    });
    const publishedTexts = collectPublishedTexts(run);

    expect(publishedTexts).not.toMatch(/측정\/평가\s*결과는/);
    expect(publishedTexts).not.toMatch(/세라마이드\s*84\.3%/);
    expect(publishedTexts).not.toMatch(/시험기간\s*2025/);
  });

  it("excludes an unstructured metric from quickFacts/description/FAQ even when its context is joined with spaces, not commas (review reproduction)", async () => {
    // Reviewer reproduction (2026-09-01): extractEvidenceAssessmentContext
    // joins its context tokens with plain concatenation/spaces, not commas,
    // so a comma-count heuristic on the *generated* string never catches it.
    // The fix removes the dump-generating templates themselves rather than
    // filtering their output.
    const reproductionProduct = {
      ...baseProduct,
      metrics: ["Clinical test 결과 세라마이드 84.3% 개선"],
      semanticFacts: {
        ingredients: ["아미노산 계면활성제"],
        benefits: ["부드러운 세정력"],
        effects: [],
        skinTypes: ["모든 피부"],
        usageSteps: ["적당량을 거품 내어 얼굴에 마사지한 후 미온수로 헹궈냅니다."],
        safetyTests: [],
        metricClaims: [],
        evidenceSentences: [],
        ingredientBenefitLinks: [],
        citations: []
      }
    };

    const run = await generatePdpGeo({
      product: reproductionProduct,
      hints: { locale: "ko-KR", market: "KR" }
    });
    const publishedTexts = collectPublishedTexts(run);

    expect(publishedTexts).not.toMatch(/측정\/평가\s*결과는/);
    expect(publishedTexts).not.toMatch(/세라마이드\s*84\.3%/);
    expect(publishedTexts).not.toMatch(/clinical\s*(?:study|test)/i);
  });

  it("never exposes a bare \"라벨: 값\" or \"컨텍스트 기준 라벨: 값\" evidence-summary template anywhere in published copy", async () => {
    const products = [
      productWithClaims(cleansingGroupClaims("증가", true)),
      {
        ...baseProduct,
        metrics: ["Clinical test 결과 세라마이드 84.3% 개선"],
        semanticFacts: {
          ingredients: ["아미노산 계면활성제"],
          benefits: ["부드러운 세정력"],
          effects: [],
          skinTypes: ["모든 피부"],
          usageSteps: ["적당량을 거품 내어 얼굴에 마사지한 후 미온수로 헹궈냅니다."],
          safetyTests: [],
          metricClaims: [],
          evidenceSentences: [],
          ingredientBenefitLinks: [],
          citations: []
        }
      }
    ];

    for (const product of products) {
      const run = await generatePdpGeo({ product, hints: { locale: "ko-KR", market: "KR" } });
      const publishedTexts = collectPublishedTexts(run);
      expect(publishedTexts).not.toMatch(/(?:평가\s*지표|확인\s*지표|확인\s*근거|측정\s*결과|Consumer assessment|Reported result)\s*[:：]/i);
      expect(publishedTexts).not.toMatch(/기준\s*(?:평가\s*지표|확인\s*지표)\s*[:：]/);
    }
  });

  it("renders the grouped narrative for metric names outside the old per-product enumeration (regression for hardcoding removal)", async () => {
    // Neither "색조 메이크업" nor "모공 속 노폐물" appear in the retired
    // per-product regex table (초미세먼지 / 버블 평균 사이즈 / 세라마이드
    // 함량), so this only renders correctly if the realizer consumes the
    // structured claim fields generically.
    const run = await generatePdpGeo({
      product: productWithClaims(cleansingGroupClaims("증가", true)),
      hints: { locale: "ko-KR", market: "KR" }
    });
    const publicTexts = collectPublicTexts(run);

    expect(publicTexts).toMatch(/97\.1%/);
    expect(publicTexts).toMatch(/97\.6%/);
  });
});
