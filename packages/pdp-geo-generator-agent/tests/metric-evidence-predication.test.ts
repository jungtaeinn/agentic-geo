import { describe, expect, it } from "vitest";
import { measurementFigures } from "../src/contracts/metric-statement-contract";

import { refinementDropsPublishedMeasurement } from "../src/copy-refiner";
import { planPayload, planningRequest } from "./support/planning";
import { createPdpGeoEvidenceLedger, planPdpGeoContent } from "../src/content-planner";
import { createGeoDescription, ensurePdpGeoFaqPlanCoverage, localizedEvidenceContext } from "../src/generate";
import type { PdpGeoContentPlan, PdpGeoReasoningResult } from "../src/types";
import { isCompressedMultiClaimMetricBlock, normalizePdpProduct, sanitizePdpSemanticFacts } from "../src/normalize";
import type { PdpProductSignal } from "../src/types";

/**
 * The metric gate used to ask "does this string contain a word I know?" — an
 * outcome list (탄력/주름/수분/보습/장벽/…) and a reporting-verb list
 * (시험/평가/측정/결과/…). A product category nobody had added to those lists
 * lost every measured figure it had: EXAMPLEDERMA 1145 (클렌징폼) shipped with
 * `metrics: 0` and `metricClaims: 0` although the extractor handed the
 * generator a clean, quotable sentence.
 *
 * The gate now asks a grammatical question instead — is a measured magnitude
 * predicated of something? — so it is category-agnostic. These tests fix both
 * halves: the sentences the word lists dropped, and the noise the gate has
 * always had to keep out.
 */

function metricSurvives(text: string): boolean {
  return sanitizePdpSemanticFacts({ metricClaims: [{ sentence: text, sourceText: text }] }).metricClaims.length > 0;
}

/** The panel fragment as the extractor left it, one caption run per line break. */
const CLEANSING_OCR_PANEL_FRAGMENT = "일상 속 노폐물부터. 가벼운 메이크업까지 세정, 장벽보호 · 딥클렌징 집앞 나갈때 가볍게 하는 색조 메이크업 97.1% 세정 "
  + "사용 전 사용 후 눈에 잘 띄어 늘 고민인 모공 속 노폐물 97.6% 세정 사용 전";

function emptyProductSignal(): PdpProductSignal {
  return {
    name: "",
    description: "",
    brand: "",
    category: "",
    images: [],
    ingredients: [],
    benefits: [],
    effects: [],
    metrics: [],
    usage: [],
    faq: [],
    options: [],
    breadcrumbs: [],
    sourceTexts: [],
    reviews: { keywords: [], items: [] }
  } as unknown as PdpProductSignal;
}

/**
 * Reasoning with evidence-backed claims switched on.
 *
 * Without it the coverage filler composes no evidence slot at all and the panel
 * never gets a chance to appear — which is exactly the state that made this
 * defect look unreproducible offline.
 */
function evidenceBackedReasoning(): PdpGeoReasoningResult {
  const principles = [
    "answer-ready FAQ",
    "stepwise HowTo",
    "evidence-backed claims",
    "target customer context",
    "review-intent FAQ"
  ];
  return {
    mode: "explicit-rag-product-reasoning",
    queryIntents: [],
    selectedSources: [],
    productEvidence: {},
    principles,
    decisions: principles.map((principle) => ({
      principle,
      enabled: true,
      confidence: 0.9,
      ragSources: ["test"],
      productEvidence: ["test"],
      rationale: "test"
    }))
  } as unknown as PdpGeoReasoningResult;
}

/** Guidance with evidence-backed claims on, for the deterministic composers. */
function evidenceBackedGuidance() {
  return {
    sources: [],
    principles: [],
    reasoning: evidenceBackedReasoning(),
    useAnswerReadyFaq: true,
    useStepwiseUsage: true,
    useEvidenceBackedClaims: true,
    useTargetCustomerContext: true,
    useReviewIntentFaq: true
  } as never;
}

/** A model plan that contributes nothing, so every FAQ item comes from coverage. */
function emptyModelPlan(): PdpGeoContentPlan {
  const emptyField = { include: false, text: "", intent: "", evidenceIds: [], confidence: 0, omitReason: "" };
  return {
    mode: "model",
    locale: "ko-KR",
    productDescription: emptyField,
    webPageDescription: emptyField,
    faq: [],
    howTo: { eligible: false, goal: "", steps: [], omitReason: "" },
    cep: [],
    warnings: []
  } as unknown as PdpGeoContentPlan;
}

/** The refined sentence the extractor produced for EXAMPLEDERMA 1145 (클렌징폼). */
const CLEANSING_METRIC_SENTENCE = "색조 메이크업 세정력은 97.1%, 모공 속 노폐물 세정력은 97.6%로 제시됩니다.";

/**
 * The same panel before segmentation: every badge figure, both before/after
 * captions and the sample/period footnote glued into one run.
 */
const CLEANSING_OCR_BLOB = "일상 속 노폐물부터 가벼운 메이크업까지 세정, 장벽보호 · 딥클렌징 집앞 나갈때 가볍게 하는 색조 메이크업 97.1% 세정 "
  + "사용 전 사용 후 눈에 잘 띄어 늘 고민인 모공 속 노폐물 97.6% 세정 사용 전 사용 후 만 20~39세의 성인 여성 30명 대상 / "
  + "시험기간 2025.07.21~2025.08.22 / 개인차 있음 (피부 각질층 내 세라마이드 함량 분석) +63.6% +84.3% +84.3% 자사 알레르겐 폼 "
  + "예시더마 클렌징폼 사용 후 사용 2주 후 사용 4주 후 *in vitro 시험 결과";

describe("metric evidence is judged by predication, not by category vocabulary", () => {
  it("keeps a measured result whose outcome word is in no vocabulary list", () => {
    expect(metricSurvives(CLEANSING_METRIC_SENTENCE)).toBe(true);
  });

  it("keeps measured results across categories the old lists never enumerated", () => {
    const acrossCategories = [
      // 세정 — the category that exposed the defect.
      "색조 메이크업 세정력은 97.1%로 나타났습니다.",
      // 자외선 차단 — an SPF endpoint.
      "자외선 차단 지속력은 4시간으로 확인되었습니다.",
      // 밀착/지속 — a base-makeup endpoint.
      "메이크업 밀착 지속력이 8시간 유지됐습니다.",
      // 농도 — a concentration, not a percentage.
      "세라마이드 함량은 10,000ppm으로 측정되었습니다.",
      // 온도 — a scale with neither % nor 배.
      "도포 직후 피부 온도가 3.2도 낮아졌습니다.",
      // 만족도 — a proportion of respondents.
      "사용자 30명 중 94%가 사용감에 만족한다고 응답했습니다."
    ];
    for (const sentence of acrossCategories) {
      expect(metricSurvives(sentence), sentence).toBe(true);
    }
  });

  it("keeps the categories the vocabulary lists did cover", () => {
    const alreadyCovered = [
      "인체적용시험 결과 사용 4주 후 피부 수분량이 55% 증가했습니다.",
      "12주 사용 후 피부 장벽 회복률이 대조군 대비 2배 높았습니다.",
      "In a 6-week study of 32 women, 93% reported visibly firmer-looking skin."
    ];
    for (const sentence of alreadyCovered) {
      expect(metricSurvives(sentence), sentence).toBe(true);
    }
  });

  it("still rejects the noise the gate exists to stop", () => {
    const noise: Array<[string, string]> = [
      ["unsegmented OCR panel", CLEANSING_OCR_BLOB],
      ["badge strip", "장벽 회복 +63.6% +84.3% +84.3% 사용 2주 후 사용 4주 후"],
      ["layout run", "일반 계면활성제. 3종 장벽보호 성분 함유 클렌징 와중에도 장벽보호!"],
      ["packshot caption", "7.05 oz. / 200 g Barrier Protective Formula. 세안 중에도 피부를 보호해주는 3종 장벽 보호 성분 함유"],
      ["commerce volume", "용량: 200ml"],
      ["commerce offer", "판매가 32,000원"],
      ["packaged volume in a sentence", "이 제품의 용량은 200ml입니다."],
      ["composition count", "3종 장벽 보호 성분을 함유합니다."],
      ["usage timing", "거품을 낸 뒤 30초간 부드럽게 롤링합니다."],
      ["question", "이 제품은 민감성 피부에도 사용 가능한가요?"],
      ["bare figure", "97.1%"],
      ["bare duration", "After 6 weeks."],
      // A packshot caption carries a magnitude and an inflected form, but they
      // belong to different fragments of a transcribed label: `weakened`
      // modifies `skin`, it does not predicate the concentration.
      ["packshot caption", "Ceramide 10,000 ppm Moisturizing & strengthening. skin’s moisture barrier For dry & weakened skin 4.05 fl.oz. / 120 mL"],
      // An English badge set beside Korean caption text must not borrow one
      // language's verb to predicate the other's figure.
      ["mixed-script panel", "4.05 / 120 mL. 철저히 검증한 피부 안전성 테스트 DERMATOLOGIST TESTED 피부과 테스트 48시간 패치를 활용한 자극여부 확인 22.12.19-22.12.22, 32명 대상"],
      ["marketing page dump", "EXAMPLEDERMA BARRIERCARE 365 CREAM MIST Ceramide 10,000 ppm Moisturizing & strengthening skin’s moisture barrier "
        + "For dry & weakened skin 4.05 / 120 mL 철저히 검증한 피부 안전성 테스트 DERMATOLOGIST TESTED 피부과 테스트 "
        + "48시간 패치를 활용한 자극여부 확인 22.12.19-22.12.22, 32명 대상 ALLERGY TESTED 하이포알러제닉 테스트 완료"]
    ];
    for (const [label, text] of noise) {
      expect(metricSurvives(text), label).toBe(false);
    }
  });

  it("restores the EXAMPLEDERMA 1145 figures end to end through normalization", () => {
    const product: Partial<PdpProductSignal> = {
      name: "예시더마 모이베리어365 클렌징폼 200g",
      brand: "EXAMPLEDERMA",
      semanticFacts: {
        ingredients: [],
        benefits: [],
        effects: [],
        skinTypes: [],
        usageSteps: [],
        safetyTests: [],
        metricClaims: [
          { sentence: "5 star", sourceText: "5 star" },
          { sentence: CLEANSING_OCR_BLOB, sourceText: CLEANSING_OCR_BLOB },
          { sentence: CLEANSING_METRIC_SENTENCE, sourceText: CLEANSING_METRIC_SENTENCE }
        ],
        evidenceSentences: [CLEANSING_METRIC_SENTENCE, CLEANSING_OCR_BLOB],
        ingredientBenefitLinks: [],
        citations: []
      }
    };

    const { product: normalized } = normalizePdpProduct(product, { hints: { locale: "ko-KR" } });

    expect(normalized.semanticFacts?.metricClaims).toHaveLength(1);
    expect(normalized.semanticFacts?.metricClaims?.[0]?.sentence).toBe(CLEANSING_METRIC_SENTENCE);
    expect(normalized.metrics).toEqual([CLEANSING_METRIC_SENTENCE]);
    // The unsegmented panel is still available as raw source evidence; what it
    // must never do is masquerade as one atomic measurement.
    expect(normalized.metrics.join(" ")).not.toContain("사용 전 사용 후");
  });

  it("does not list the same restored figure twice in the metrics array", () => {
    const { product: normalized } = normalizePdpProduct({
      name: "예시더마 모이베리어365 클렌징폼 200g",
      semanticFacts: {
        ingredients: [],
        benefits: [],
        effects: [],
        skinTypes: [],
        usageSteps: [],
        safetyTests: [],
        metricClaims: [{ sentence: CLEANSING_METRIC_SENTENCE, sourceText: CLEANSING_METRIC_SENTENCE }],
        evidenceSentences: [CLEANSING_METRIC_SENTENCE],
        ingredientBenefitLinks: [],
        citations: []
      },
      sourceTexts: [CLEANSING_METRIC_SENTENCE]
    }, { hints: { locale: "ko-KR" } });

    expect(normalized.metrics.filter((value) => value === CLEANSING_METRIC_SENTENCE)).toHaveLength(1);
  });
});

describe("a refinement may not quietly drop a measured figure", () => {
  const composed = "예시더마 모이베리어365 클렌징폼은 건조하고 민감한 피부를 위한 클렌저입니다. "
    + "색조 메이크업 세정력은 97.1%, 모공 속 노폐물 세정력은 97.6%로 제시됩니다.";

  it("flags a Product.description rewrite that loses the figure the composed text carried", () => {
    const rewrittenWithoutFigures = "예시더마 모이베리어365 클렌징폼은 건조하고 민감한 피부를 위한 클렌저입니다. "
      + "제품은 일상 속 노폐물과 가벼운 메이크업 세정을 안내합니다.";
    expect(refinementDropsPublishedMeasurement("Product.description", rewrittenWithoutFigures, composed)).toBe(true);
    expect(refinementDropsPublishedMeasurement("content.sections.description", rewrittenWithoutFigures, composed)).toBe(true);
  });

  it("allows a rewrite that keeps the figures, whatever else it changes", () => {
    const rewrittenWithFigures = "예시더마 모이베리어365 클렌징폼은 건조하고 민감한 피부를 위한 약산성 클렌저입니다. "
      + "색조 메이크업 세정력 97.1%, 모공 속 노폐물 세정력 97.6%가 제시됩니다.";
    expect(refinementDropsPublishedMeasurement("Product.description", rewrittenWithFigures, composed)).toBe(false);
  });

  it("leaves WebPage.description free to summarise without the figure", () => {
    const summarised = "예시더마 모이베리어365 클렌징폼 상품 페이지는 건조하고 민감한 피부를 위한 "
      + "약산성 클렌저의 포뮬라와 세정 특성을 소개합니다.";
    expect(refinementDropsPublishedMeasurement("WebPage.description", summarised, composed)).toBe(false);
  });
});

describe("study metadata may be compressed, the measurement may not", () => {
  const composed = "㈜리서치랩이 2022년 12월 19일부터 22일까지 성인 32명을 대상으로 진행한 시험에서 "
    + "피부 수분량은 55% 증가했습니다.";

  it("allows a rewrite that shortens the sample and period but keeps the figure", () => {
    const compressed = "2022년 12월 진행한 인체적용시험에서 피부 수분량은 55% 증가했습니다.";
    expect(refinementDropsPublishedMeasurement("Product.description", compressed, composed)).toBe(false);
  });

  it("flags a rewrite that keeps the study context but loses the figure", () => {
    const withoutFigure = "㈜리서치랩이 2022년 12월 19일부터 22일까지 성인 32명을 대상으로 진행한 시험에서 "
      + "피부 수분량 증가가 확인되었습니다.";
    expect(refinementDropsPublishedMeasurement("Product.description", withoutFigure, composed)).toBe(true);
  });
});

describe("an OCR panel cannot re-enter public copy through an FAQ answer", () => {
  it("recognises the pasted before/after panel as the block the metric gate refuses", () => {
    const pastedPanel = "예시더마 모이베리어365 클렌징폼 200g는 건조하고 민감한 피부 고객을 위한 클렌저로, 피부 장벽 관리, 세정력, 저자극 세안을 돕습니다. "
      + "일상 속 노폐물부터. 가벼운 메이크업까지 세정, 장벽보호 · 딥클렌징 집앞 나갈때 가볍게 하는 색조 메이크업 97.1% 세정 사용 전 사용 후 "
      + "눈에 잘 띄어 늘 고민인 모공 속 노폐물 97.6% 세정 사용 전.";
    expect(isCompressedMultiClaimMetricBlock(pastedPanel)).toBe(true);
  });

  it("leaves a quoted measurement sentence alone", () => {
    const quotedMeasurement = "예시더마 모이베리어365 클렌징폼 200g는 건조하고 민감한 피부 고객을 위한 클렌저입니다. "
      + "색조 메이크업 세정력은 97.1%, 모공 속 노폐물 세정력은 97.6%로 제시됩니다.";
    expect(isCompressedMultiClaimMetricBlock(quotedMeasurement)).toBe(false);
  });
});

describe("the FAQ coverage path cannot publish an OCR panel as an answer", () => {
  /**
   * The panel reached an FAQ answer through the deterministic coverage filler,
   * not the content plan: every planned FAQ item failed the plan gate, the
   * filler supplied its own items, and the composition answer's evidence slot
   * took the raw reported-detail signal — which for this product is the panel.
   * Reproduced from the live normalized product, so the test fails if the
   * evidence slot ever accepts a transcription again.
   */
  it("fills the plan without transcribing the before/after panel", () => {
    const product: PdpProductSignal = {
      ...emptyProductSignal(),
      name: "예시더마 모이베리어365 클렌징폼 200g",
      brand: "EXAMPLEDERMA",
      category: "클렌저",
      // The extractor files the panel under every outcome role it fits, which is
      // how it reaches the evidence selectors at all.
      benefits: ["피부 장벽", "세정력", "저자극 세안", CLEANSING_OCR_PANEL_FRAGMENT],
      effects: ["모공 속 노폐물 세정", CLEANSING_OCR_PANEL_FRAGMENT],
      ingredients: ["아미노산 유래 세정 성분", "보타온", "판테놀", "베타인"],
      sourceTexts: [CLEANSING_OCR_PANEL_FRAGMENT],
      semanticFacts: {
        ingredients: ["아미노산 유래 세정 성분"],
        benefits: ["피부 장벽", CLEANSING_OCR_PANEL_FRAGMENT],
        effects: ["모공 속 노폐물 세정", CLEANSING_OCR_PANEL_FRAGMENT],
        skinTypes: ["건조 피부", "민감 피부"],
        usageSteps: [],
        safetyTests: [],
        metricClaims: [],
        evidenceSentences: [CLEANSING_OCR_PANEL_FRAGMENT],
        ingredientBenefitLinks: [],
        citations: []
      }
    };

    const filled = ensurePdpGeoFaqPlanCoverage({
      plan: emptyModelPlan(),
      product,
      locale: "ko-KR",
      market: "KR",
      ragChunks: [],
      reasoning: evidenceBackedReasoning(),
      evidenceLedger: createPdpGeoEvidenceLedger(product, "ko-KR")
    });

    expect(filled.faq.length).toBeGreaterThan(0);
    for (const item of filled.faq) {
      expect(item.answer, item.question).not.toMatch(/사용\s*전\s*사용\s*후/u);
      expect(item.answer, item.question).not.toContain("딥클렌징 집앞 나갈때");
    }
  });
});

describe("an unpublishable evidence string yields nothing, never a bare particle", () => {
  /**
   * R-F replaced the `측정/평가 결과는 …입니다` shell with the empty string, and
   * every caller has to read that as "no result". This site appended a particle
   * to it instead, publishing `를 참고할 수 있습니다` — a sentence with no subject.
   */
  it("does not append a particle to an empty evidence sentence", () => {
    const unformattable = "확인 지표: 시험 결과";
    const rendered = localizedEvidenceContext("ko-KR", unformattable);
    expect(rendered ?? "").not.toMatch(/^\s*[를을은는이가]\s/u);
    expect(rendered ?? "").not.toBe("를 참고할 수 있습니다");
  });
});

describe("the gate does not decide by which nouns a measurement uses", () => {
  /**
   * A survey result is a measurement whoever the subjects were. A precondition
   * that read review vocabulary dropped one wording of a fact and kept another
   * wording of the same fact — the defect this predicate exists to remove,
   * re-introduced inside it.
   */
  it("keeps a survey result whether or not it is worded in review vocabulary", () => {
    const pairs: Array<[string, string]> = [
      ["재구매 의사는 92%로 나타났습니다.", "구매 의향은 92%로 나타났습니다."],
      ["평점은 4.6점으로 확인되었습니다.", "점수는 4.6점으로 확인되었습니다."]
    ];
    for (const [reviewWorded, neutralWorded] of pairs) {
      expect(metricSurvives(reviewWorded), reviewWorded).toBe(true);
      expect(metricSurvives(neutralWorded), neutralWorded).toBe(true);
    }
  });

  it("still drops review chatter, on structure rather than vocabulary", () => {
    // No magnitude at all.
    expect(metricSurvives("재구매 의사 있어요. 정말 좋았습니다.")).toBe(false);
    expect(metricSurvives("직접 구매해 사용해 보니 촉촉하고 편안해서 만족해요.")).toBe(false);
    // A figure with no argument for it to be predicated of.
    expect(metricSurvives("촉촉하고 좋아요 별점 5점 만점에 5점 주고 싶어요")).toBe(false);
  });
});

describe("the unit set covers the dermatology endpoints", () => {
  it("reads the skin-measurement units, including the symbol and compound forms", () => {
    const endpoints = [
      "각질층 두께는 18μm로 확인되었습니다.",
      "각질층 두께는 18µm로 확인되었습니다.",
      "각질층 두께는 18㎛로 확인되었습니다.",
      "입자 크기는 250nm로 측정되었습니다.",
      "경피수분손실량은 8.2g/m2h로 측정되었습니다.",
      "경피수분손실량은 8.2g/m²h로 측정되었습니다."
    ];
    for (const sentence of endpoints) {
      expect(metricSurvives(sentence), sentence).toBe(true);
    }
  });

  it("knowingly loses an endpoint written in a bare length", () => {
    // The accepted cost of refusing package dimensions. These were equally
    // unread before this task, so it is an improvement not taken rather than a
    // regression — recorded here so nobody re-adds `mm` without a discriminator
    // that survives both directions of the probe.
    expect(metricSurvives("모공 지름은 0.35mm로 측정되었습니다.")).toBe(false);
    expect(metricSurvives("도포 면적은 5cm로 측정되었습니다.")).toBe(false);
  });

  it("reads a scale that names itself before its figure", () => {
    // A digit-then-unit pattern never sees these; Korean also puts a particle
    // between the scale name and the number.
    expect(metricSurvives("제품의 pH는 5.5로 측정되었습니다.")).toBe(true);
    expect(metricSurvives("자외선 차단 지수는 SPF 50으로 확인되었습니다.")).toBe(true);
  });

  it("still refuses trade quantities, which share those letters", () => {
    expect(metricSurvives("이 제품의 용량은 200ml입니다.")).toBe(false);
    expect(metricSurvives("이 제품의 중량은 200g입니다.")).toBe(false);
    expect(metricSurvives("이 제품의 중량은 1kg입니다.")).toBe(false);
  });
});

describe("the refined metric sentence has one owner: Product.description", () => {
  /**
   * Once normalization restores the claim, the description composer and the FAQ
   * evidence slot can both reach the same refined sentence. Report §12 rules
   * that the description owns it — that field is the product's own summary —
   * and the FAQ takes it only when the description path does not.
   */
  function cleanserWithRefinedSentenceOnly(): PdpProductSignal {
    return {
      ...emptyProductSignal(),
      name: "예시더마 모이베리어365 클렌징폼 200g",
      brand: "EXAMPLEDERMA",
      category: "클렌저",
      benefits: ["피부 장벽", "세정력"],
      effects: ["모공 속 노폐물 세정"],
      ingredients: ["아미노산 유래 세정 성분", "보타온"],
      metrics: [CLEANSING_METRIC_SENTENCE],
      semanticFacts: {
        ingredients: ["아미노산 유래 세정 성분"],
        benefits: ["피부 장벽"],
        effects: ["모공 속 노폐물 세정"],
        skinTypes: ["건조 피부", "민감 피부"],
        usageSteps: [],
        safetyTests: [],
        // No structured fields: the refined sentence is all there is, which is
        // the condition under which both paths would otherwise take it.
        metricClaims: [{ sentence: CLEANSING_METRIC_SENTENCE, sourceText: CLEANSING_METRIC_SENTENCE }],
        evidenceSentences: [CLEANSING_METRIC_SENTENCE],
        ingredientBenefitLinks: [],
        citations: []
      }
    };
  }

  it("gives the sentence to the description and withholds it from the FAQ", () => {
    const product = cleanserWithRefinedSentenceOnly();

    const description = createGeoDescription(product, product.name, "ko-KR", [], evidenceBackedGuidance(), []);
    expect(description).toContain("97.1%");
    expect(description).toContain("97.6%");

    const filled = ensurePdpGeoFaqPlanCoverage({
      plan: emptyModelPlan(),
      product,
      locale: "ko-KR",
      market: "KR",
      ragChunks: [],
      reasoning: evidenceBackedReasoning(),
      evidenceLedger: createPdpGeoEvidenceLedger(product, "ko-KR")
    });

    expect(filled.faq.length).toBeGreaterThan(0);
    for (const item of filled.faq) {
      expect(item.answer, item.question).not.toContain("97.1%");
      expect(item.answer, item.question).not.toContain("97.6%");
    }
  });
});

describe("the reported-result rewrite does not double the adverbial particle", () => {
  /**
   * `…97.6%로 제시됩니다` already carries the `로` the rewrite supplies, so the
   * source particle has to be part of what is replaced. It was not, and the
   * published sentence read `97.6%로로 측정되었습니다`.
   */
  it("rewrites a source that already carries 로 without repeating it", () => {
    const rewritten = localizedEvidenceContext("ko-KR", CLEANSING_METRIC_SENTENCE);

    expect(rewritten).not.toMatch(/로로/u);
    expect(rewritten).toContain("97.6%");
  });
});

describe("the plan gate refuses an FAQ answer that pastes an OCR panel", () => {
  /**
   * Testing the predicate alone would not have caught concern 3: the predicate
   * was right and the wiring was what mattered. This drives `planPdpGeoContent`
   * with a planner that returns the panel as an answer and asserts the gate at
   * `content-planner.ts` excludes it, naming the check in its warning.
   */
  it("excludes it and names the check", async () => {
    const product: PdpProductSignal = {
      ...emptyProductSignal(),
      name: "예시더마 모이베리어365 클렌징폼 200g",
      brand: "EXAMPLEDERMA",
      category: "클렌저",
      benefits: ["피부 장벽", "세정력"],
      ingredients: ["아미노산 유래 세정 성분"],
      sourceTexts: [CLEANSING_OCR_PANEL_FRAGMENT]
    };
    const pastedPanel = `예시더마 모이베리어365 클렌징폼 200g는 건조하고 민감한 피부 고객을 위한 클렌저입니다. ${CLEANSING_OCR_PANEL_FRAGMENT}.`;
    const ledger = createPdpGeoEvidenceLedger(product, "ko-KR");

    const result = await planPdpGeoContent(planningRequest(product, "ko-KR", { evidenceLedger: ledger }), {
      customContentPlanner: {
        planContent: () => ({
          plan: planPayload({
            faq: [{
              include: true,
              question: "예시더마 모이베리어365 클렌징폼 200g의 구성 성분과 효능·효과는 무엇인가요?",
              answer: pastedPanel,
              intent: "composition-benefit-effect",
              cep: "",
              evidenceIds: ledger.slice(0, 1).map((item) => item.id),
              confidence: 0.9,
              omitReason: ""
            }]
          })
        })
      }
    } as never);

    expect(result.plan.faq.map((item) => item.answer)).not.toContain(pastedPanel);
    expect(result.plan.warnings.join(" ")).toContain("answer-transcription");
  });
});

describe("a customer's own sentence never becomes a measured claim", () => {
  /**
   * A well-formed first-person review is a grammatically perfect measured
   * statement — no structural predicate separates it from a lab result, and
   * separating it by vocabulary is the defect this predicate exists to remove.
   * Provenance answers it: the text came from a review container.
   */
  const reviewSentences = [
    "저는 하루 2회 사용했고 만족도는 100%입니다.",
    "구매했는데 3일 만에 각질이 30% 줄어서 좋았습니다.",
    "제가 4주 써보니 수분감은 2배로 늘었습니다.",
    "재구매했는데 트러블이 50% 줄었어요."
  ];
  const labSentence = "인체적용시험 결과 사용 4주 후 피부 수분량이 55% 증가했습니다.";

  it("excludes review-scoped source from the metric atoms and keeps product-scoped source", () => {
    const { product } = normalizePdpProduct({
      name: "테스트 세럼",
      brand: "테스트랩",
      reviews: { items: reviewSentences.map((body) => ({ body })), keywords: [] },
      sourceTexts: [labSentence]
    }, { hints: { locale: "ko-KR" } });

    for (const sentence of reviewSentences) {
      expect(product.metrics.join("\n"), sentence).not.toContain(sentence.slice(0, 12));
    }
    expect(product.metrics).toContain(labSentence);
  });

  it("reads review scope from the record, not from the container's name", () => {
    // `allStringsOutsideReview` used to inline a two-field test of its own, so a
    // record that declares its class in any other field walked through.
    const reviewSentence = "제가 4주 써보니 수분감은 2배로 늘었습니다.";
    for (const block of [{ type: "review", body: reviewSentence }, { sourceType: "testimonial", body: reviewSentence }]) {
      const { product } = normalizePdpProduct({ name: "테스트 세럼", blocks: [block] }, { hints: { locale: "ko-KR" } });
      expect(product.metrics.join("\n"), JSON.stringify(block)).not.toContain("2배로 늘었");
    }
  });

  it("keeps a survey result the product itself reports", () => {
    const { product } = normalizePdpProduct({
      name: "테스트 세럼",
      sourceTexts: ["재구매 의사는 92%로 나타났습니다.", "평점은 4.6점으로 확인되었습니다."]
    }, { hints: { locale: "ko-KR" } });
    expect(product.metrics).toHaveLength(2);
  });
});

describe("a package dimension is refused because a bare length is not a measure", () => {
  /**
   * The copula-position rule this replaced looked right and measured wrong: it
   * refused 18/18 genuine measured results (`개선율은 55%입니다`,
   * `시험 결과는 97.1%입니다`, and four strings that are fixture data in this
   * repo) while still admitting 6/14 package specs through past forms and
   * parentheticals. Korean does not mark "what a thing is" versus "what was
   * found" by copula-vs-inflection — a measured result very commonly ends in
   * 입니다. So the bare lengths come out of the unit set instead, which is where
   * they were before this task.
   */
  it("refuses every package spec shape", () => {
    const specs = [
      "용기 지름은 45mm입니다.",
      "튜브 길이는 12cm입니다.",
      "박스 규격은 60mm x 60mm x 150mm입니다.",
      "용기 지름은 45mm였습니다.",
      "용기 지름은 45mm(±1mm)입니다.",
      "펌프 높이는 98mm입니다.",
      "캡 지름은 32mm이다.",
      "스포이드 길이는 38mm입니다.",
      "패키지 두께는 2.5cm입니다.",
      "용기 폭은 45mm로 제작되었습니다.",
      "단상자 높이는 15cm로 설계되었습니다."
    ];
    for (const spec of specs) {
      expect(metricSurvives(spec), spec).toBe(false);
    }
  });

  it("keeps a measured result that merely mentions a length", () => {
    // The dimension-run pattern that went with the copula rule refused this.
    expect(metricSurvives("시험 면적 2cm x 2cm 부위에서 수분량이 55% 증가했습니다.")).toBe(true);
  });

  it("keeps the sub-millimetre lengths, which no package is described in", () => {
    expect(metricSurvives("각질층 두께는 18μm로 확인되었습니다.")).toBe(true);
    expect(metricSurvives("입자 크기는 250nm로 측정되었습니다.")).toBe(true);
  });
});

describe("a measured result is evidenced by its attribution, not by its syntax", () => {
  /**
   * Two rules were tried on syntactic position and both failed, in opposite
   * directions: refusing a copula-complement magnitude lost 18/18 genuine
   * results, and accepting one admitted `최대 할인 20%입니다`. Position is
   * evidence of syntax, never of measurement. What a measured result has and a
   * commerce line does not is an attribution — who measured, when, or on whom.
   */
  it("keeps a topic-dropped result that names who measured, when, or on whom", () => {
    // All three are fixture data elsewhere in this repo.
    const attributed = [
      "시험 대상 미공개 기준 18시간 1회 도포후, ex vivo 테스트에서 18시간 장벽에서 잔존하는 세라마이드 190%입니다.",
      "테스트 라인은 100명의 평가단이 참여했고 만족도는 87%입니다.",
      "㈜리서치랩 기준 2주 후 세라마이드 84.3%입니다."
    ];
    for (const sentence of attributed) {
      expect(metricSurvives(sentence), sentence).toBe(true);
    }
  });

  it("drops a topic-dropped figure with no attribution, whatever its unit", () => {
    const unattributed = [
      "무이자 할부 6개월입니다.",
      "최대 할인 20%입니다.",
      "평균 별점 4.7점입니다.",
      "전 성분 pH 5.5입니다.",
      "제조연월 2025년 3월, 사용기한 3년입니다.",
      "정기 배송 주기 4주입니다.",
      "무료 반품 기간 7일입니다.",
      // The gap in the earlier probe: a topic-dropped spec in a unit still read.
      "세라마이드 함량 10,000ppm입니다.",
      "용기 내압 120Pa입니다.",
      "펌프 1회 토출량 0.25mL입니다."
    ];
    for (const sentence of unattributed) {
      expect(metricSurvives(sentence), sentence).toBe(false);
    }
  });

  it("does not read a manufacturing date as a study period", () => {
    // A period is a range. A single stamped date is not an attribution.
    expect(metricSurvives("제조연월 2025년 3월, 사용기한 3년입니다.")).toBe(false);
    expect(metricSurvives("2022년 12월 19일부터 22일까지 측정한 수분량 55%입니다.")).toBe(true);
  });

  it("drops a case-marked commerce term whose unit the copula used to expose", () => {
    // The measure-noun boundary briefly admitted the copula, which read a
    // warranty term and a membership tier as measurements.
    const commerce = [
      "보증 기간은 1년입니다.",
      "상품 등급은 1등급입니다.",
      "배송 기간은 3일입니다.",
      "반품 기간은 7일입니다.",
      "사용 기한은 3년입니다.",
      "교환 기간은 14일입니다."
    ];
    for (const sentence of commerce) {
      expect(metricSurvives(sentence), sentence).toBe(false);
    }
  });

  it("drops a bare rating, which names no measurer and no occasion", () => {
    // Not a repo fixture — it entered this file from a review probe list. A
    // rating is not a study measurement, so it drops with the other
    // unattributed figures rather than being rescued.
    expect(metricSurvives("평점은 4.9점입니다.")).toBe(false);
    expect(metricSurvives("평균 별점 4.7점입니다.")).toBe(false);
    // Stated as a measured outcome, the same fact is kept.
    expect(metricSurvives("평점은 4.6점으로 확인되었습니다.")).toBe(true);
  });
});

describe("area and volume units read the same in all three spellings", () => {
  it("reads mm2, mm² and ㎟ alike", () => {
    for (const spelling of ["1.2mm2", "1.2mm²", "1.2㎟"]) {
      expect(metricSurvives(`병변 면적은 ${spelling}로 측정되었습니다.`), spelling).toBe(true);
    }
  });

  it("reads the bare-digit and symbol forms of an area alike", () => {
    expect(metricSurvives("측정 면적은 1.2m2로 확인되었습니다.")).toBe(true);
    expect(metricSurvives("측정 면적은 1.2㎡로 확인되었습니다.")).toBe(true);
  });

  it("reads a scale name separated from its figure by a qualifier", () => {
    expect(metricSurvives("제품의 pH는 약 5.5 수준으로 측정되었습니다.")).toBe(true);
    expect(metricSurvives("제품의 pH는 평균적으로 약 5.5로 측정되었습니다.")).toBe(true);
    expect(metricSurvives("이 제품의 자외선 차단 지수는 SPF 지수 50으로 확인되었습니다.")).toBe(true);
  });
});

describe("an attribution signal has to be an attribution of a measurement", () => {
  it("does not read a bare occasion as a timepoint", () => {
    // `사용 직후` names an occasion and measures no interval. Reading it as
    // attribution let every `구매 직후 …%` line through.
    const occasions = [
      "구매 직후 적립 포인트 5%입니다.",
      "사용 직후 환불 수수료 10%입니다.",
      "결제 직후 할부 수수료 3%입니다.",
      "구매 직후 등급 상승률 20%입니다."
    ];
    for (const line of occasions) {
      expect(metricSurvives(line), line).toBe(false);
    }
  });

  it("does not read a company name as evidence that anyone measured", () => {
    // Every 제조사 and 판매자 line carries one.
    const sellers = [
      "㈜테스트유통 판매 수수료 12%입니다.",
      "제조사 ㈜코스맥스 마진율 30%입니다.",
      "판매자 주식회사 뷰티몰 적립률 5%입니다.",
      "수입원 ㈜예시 유통 마진 25%입니다."
    ];
    for (const line of sellers) {
      expect(metricSurvives(line), line).toBe(false);
    }
  });

  it("still keeps the attributed results, which name a period, a timepoint or a sample", () => {
    const attributed = [
      "시험 대상 미공개 기준 18시간 1회 도포후, ex vivo 테스트에서 18시간 장벽에서 잔존하는 세라마이드 190%입니다.",
      "테스트 라인은 100명의 평가단이 참여했고 만족도는 87%입니다.",
      "㈜리서치랩 기준 2주 후 세라마이드 84.3%입니다.",
      "2022년 12월 19일부터 22일까지 측정한 수분량 55%입니다."
    ];
    for (const sentence of attributed) {
      expect(metricSurvives(sentence), sentence).toBe(true);
    }
  });
});

describe("a Hangul unit closed by the copula is read once the result is attributed", () => {
  it("keeps a result whose unit the copula closes when a study or sample is named", () => {
    expect(metricSurvives("인체적용시험 33명 대상 평점은 4.6점입니다.")).toBe(true);
    expect(metricSurvives("성인 32명 대상 피부 온도는 3.2도입니다.")).toBe(true);
    expect(metricSurvives("4주 후 개선 등급은 2등급입니다.")).toBe(true);
  });

  it("does not read the same shape without an attribution", () => {
    // The condition is what keeps a warranty term and a tier out.
    expect(metricSurvives("보증 기간은 1년입니다.")).toBe(false);
    expect(metricSurvives("상품 등급은 1등급입니다.")).toBe(false);
    expect(metricSurvives("평점은 4.9점입니다.")).toBe(false);
  });
});

describe("a discount line is commerce, and the commerce recognizer owns that", () => {
  it("drops it at the preamble rather than in the metric predicate", () => {
    // `할인가` widened to `할인` in isCommerceQuantityOrOfferText — the list that
    // already owns commerce vocabulary and already runs as this gate's preamble.
    expect(metricSurvives("할인율은 20%입니다.")).toBe(false);
    expect(metricSurvives("이 상품의 할인율은 20%입니다.")).toBe(false);
    // The structurally identical measured result is unaffected.
    expect(metricSurvives("개선율은 55%입니다.")).toBe(true);
  });
});

describe("commerce rates that borrow a study-shaped attribution", () => {
  /**
   * `4주 후 적립률은 10%입니다` satisfies the attribution test honestly — it does
   * name an elapsed timepoint — and is structurally identical to
   * `4주 후 개선율은 10%입니다`. No grammatical signal separates them, because the
   * difference is what the rate is *of*, and that is a commerce concept. So it
   * belongs to the recognizer that already owns commerce vocabulary and already
   * runs as this gate's preamble, exactly as the discount line does.
   */
  it("drops accrual, fee, instalment, and cancellation rates at the preamble", () => {
    expect(metricSurvives("4주 후 적립률은 10%입니다")).toBe(false);
    expect(metricSurvives("구매 후 30일 이내 포인트 지급률은 5%입니다")).toBe(false);
    expect(metricSurvives("2주 후 수수료는 3.5%입니다")).toBe(false);
    expect(metricSurvives("결제 후 7일 이내 취소 가능 비율은 20%입니다")).toBe(false);
    expect(metricSurvives("2025.01.01~2025.03.31 기간 할부 수수료율은 12%입니다")).toBe(false);
  });

  it("leaves attributed measurements alone", () => {
    expect(metricSurvives("인체적용시험 30명 대상 4주 후 개선율은 55%로 나타났습니다")).toBe(true);
    expect(metricSurvives("㈜리서치랩 기준 2주 후 세라마이드 84.3%입니다")).toBe(true);
    expect(metricSurvives("성인 32명 대상 피부 온도는 3.2도입니다")).toBe(true);
  });

  it("does not read 포인트 메이크업 as a commerce term", () => {
    // 포인트 is a cosmetics word before it is a loyalty word — point makeup.
    // Adding it to the commerce list would have silently dropped a real
    // cleansing measurement, which is the failure this whole task removed.
    expect(metricSurvives("30명 대상 4주 후 포인트 메이크업 세정력은 97.1%로 나타났습니다")).toBe(true);
  });
});

/**
 * 측정 규모를 읽는 곳이 둘이고 아는 단위가 달랐다.
 *
 * `normalize.ts`는 점·등급·㎛·℃·g/m²h를 측정 규모로 인정해 그런 문장을 원자
 * 지표 주장으로 받아들이는데, 수치 동일성 비교는 `%|배|ppm|시간`만 알았다.
 * 그래서 그런 측정은 각주(표본·기간)가 붙지 않고, 같은 수치의 두 어투를 접는
 * 중복 제거도 걸리지 않았다 — 이 함수의 독스트링이 스스로 막겠다고 선언한
 * 실패다.
 */
describe("수치 동일성의 단위", () => {
  it("reads the same measurement families the normalizer accepts", () => {
    expect([...measurementFigures("만족도는 4.6점으로 나타났습니다")]).toContain("4.6점");
    expect([...measurementFigures("각질층 두께는 12.4㎛로 확인되었습니다")]).toContain("12.4㎛");
    expect([...measurementFigures("피부 온도는 2.1℃ 감소했습니다")]).toContain("2.1℃");
    expect([...measurementFigures("수분량은 97.6% 증가했습니다")]).toContain("97.6%");
  });

  it("does not read a trade quantity as a measurement", () => {
    expect([...measurementFigures("본품 200g 구성")]).toHaveLength(0);
  });
});
