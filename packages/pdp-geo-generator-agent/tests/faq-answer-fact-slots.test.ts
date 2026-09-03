import { describe, expect, it } from "vitest";
import {
  createReviewIntentFaqAnswer,
  faqFactSlot,
  generatePdpGeoArtifacts,
  mergeFaqAnswerFactSlots,
  orderFaqAnswerFactSlots,
  renderFaqAnswerFactSlots
} from "../src/generate";
import { normalizePdpProduct } from "../src/normalize";
import type { PdpProductSignal } from "../src/types";
import { nodeOf } from "./support/graph";

/**
 * Task 3 (실측 1145): the ingredient FAQ answer described the same
 * ingredient twice ("판테놀은 피부 장벽 관리를 돕습니다" from the
 * structured ingredient-benefit link, then "판테놀은 비타민 B5 유도체로
 * 피부 장벽 개선에 도움을 줍니다" from OCR context) and closed with a
 * "따라서 ... 추천할 수 있습니다" recap that is not part of the
 * Description Composition Contract's six-stage arc. `dedupeGeneratedSentenceParts`
 * only caught identical sentence text, so two different sentences about the
 * same fact both survived.
 *
 * These tests cover the fact-slot primitives (`generate.ts` white-box
 * exports, following the existing `createGeoDescription` /
 * `generatePdpGeoArtifacts` precedent in citation-ready-prose.test.ts) and
 * the end-to-end deterministic output for the exact duplicate shape.
 */

function cleanserProduct(): PdpProductSignal {
  // Same construction pattern as trust-warning-prevention.test.ts:
  // `normalizePdpProduct` fills in every field `PdpProductSignal` requires,
  // then `semanticFacts.ingredientBenefitLinks` is replaced outright so the
  // fixture's structured facts reach `generatePdpGeoArtifacts` exactly as
  // written -- normalize.ts's ingredient-name vocabulary gate (out of this
  // task's scope) would otherwise drop a bare Korean ingredient name like
  // "판테놀" before it ever reaches the FAQ builders under test here.
  const { product } = normalizePdpProduct({
    name: "예시더마 모이베리어365 젠틀 포밍클렌저",
    brand: "EXAMPLEDERMA",
    description: "장벽 보호 성분을 담은 클렌저입니다.",
    category: "클렌저",
    ingredients: ["Barrier Protective Formula", "판테놀", "베타인", "보타온"],
    benefits: ["피부 장벽 관리"],
    usage: ["적당량을 물과 함께 거품내어 얼굴에 마사지하듯 문지른 후 미온수로 헹굽니다."],
    // `resolveFaqIntentCoverageLimit` short-circuits to a 0-item FAQ when
    // there is neither answer-ready-FAQ guidance nor any source FAQ. A
    // minimal source entry is enough to unlock the intent-coverage FAQ that
    // includes the ingredient composition answer under test.
    faq: [{
      question: "이 클렌저는 어떤 피부에 좋나요?",
      answer: "장벽 보호 성분을 담아 건조하고 민감한 피부에도 사용할 수 있는 클렌저입니다."
    }]
  }, { hints: { locale: "ko-KR" } });
  return {
    ...product,
    semanticFacts: {
      ingredients: ["Barrier Protective Formula", "판테놀", "베타인", "보타온"],
      benefits: ["피부 장벽 관리"],
      effects: [],
      skinTypes: ["건조 피부 또는 민감 피부"],
      usageSteps: [],
      metricClaims: [],
      evidenceSentences: [],
      ingredientBenefitLinks: [
        {
          ingredient: "판테놀",
          benefit: "피부 장벽 관리",
          sentence: "판테놀은 비타민 B5 유도체로 피부 장벽 개선에 도움을 줍니다.",
          sourceText: "판테놀은 비타민 B5 유도체로 피부 장벽 개선에 도움을 줍니다."
        },
        {
          ingredient: "베타인",
          benefit: "피부 장벽 강화",
          sentence: "베타인은 아미노산 유도체로 피부 장벽을 더욱 견고하게 합니다.",
          sourceText: "베타인은 아미노산 유도체로 피부 장벽을 더욱 견고하게 합니다."
        }
      ]
    }
  };
}

function findIngredientFaqAnswer(product: PdpProductSignal): string {
  const artifacts = generatePdpGeoArtifacts({
    product,
    locale: "ko-KR",
    ragChunks: [],
    ragDocuments: []
  });
  const faqPage = nodeOf(artifacts, "FAQPage");
  const item = (faqPage?.mainEntity as Array<Record<string, any>> | undefined)
    ?.find((candidate) => /구성\s*성분과\s*효능/u.test(String(candidate.name)));
  return String(item?.acceptedAnswer?.text ?? "");
}

describe("FAQ answer fact slots (Task 3)", () => {
  it("merges the same ingredient's role restated by a structured link and by OCR context into one sentence", () => {
    const answer = findIngredientFaqAnswer(cleanserProduct());
    // Only one "판테놀은" topic-marked clause should remain -- the OCR
    // restatement ("비타민 B5 유도체로 피부 장벽 개선에 도움을 줍니다") is
    // more specific than the plain link sentence, so it is the fact that
    // survives the merge.
    expect(answer.match(/판테놀은/gu)?.length ?? 0).toBe(1);
    expect(answer).toMatch(/판테놀은[^.]*비타민\s*B5\s*유도체로[^.]*피부\s*장벽\s*개선에\s*도움을\s*줍니다/u);
  });

  it("does not publish the arc-external recommendation recap", () => {
    const answer = findIngredientFaqAnswer(cleanserProduct());
    expect(answer).not.toMatch(/따라서[^.]*추천할\s*수\s*있습니다/u);
  });

  it("keeps every other ingredient's role sentence when merging only removes the duplicate", () => {
    const answer = findIngredientFaqAnswer(cleanserProduct());
    expect(answer).toMatch(/베타인은[^.]*피부\s*장벽[^.]*돕습니다/u);
    expect(answer).toMatch(/주요\s*성분·기술로\s*구성한/u);
  });
});

describe("mergeFaqAnswerFactSlots", () => {
  it("merges two ingredientRole slots about the same subject and unions their evidenceIds", () => {
    const shortFact = faqFactSlot("ingredientRole", "판테놀은 피부 장벽 관리를 돕습니다", ["ingredient:판테놀"], "판테놀");
    const longerFact = faqFactSlot(
      "ingredientRole",
      "판테놀은 비타민 B5 유도체로 피부 장벽 개선에 도움을 줍니다",
      ["source:판테놀은 비타민 b5 유도체로 피부 장벽 개선에 도움을 줍니다"],
      "판테놀"
    );
    const merged = mergeFaqAnswerFactSlots([shortFact, longerFact]);

    expect(merged).toHaveLength(1);
    expect(merged[0]!.fact).toBe(longerFact!.fact);
    expect(merged[0]!.evidenceIds.sort()).toEqual(
      ["ingredient:판테놀", "source:판테놀은 비타민 b5 유도체로 피부 장벽 개선에 도움을 줍니다"].sort()
    );
  });

  it("keeps distinct-subject slots of the same role separate", () => {
    const pantenol = faqFactSlot("ingredientRole", "판테놀은 피부 장벽 관리를 돕습니다", ["ingredient:판테놀"], "판테놀");
    const betaine = faqFactSlot("ingredientRole", "베타인은 피부 장벽 강화를 돕습니다", ["ingredient:베타인"], "베타인");
    const merged = mergeFaqAnswerFactSlots([pantenol, betaine]);

    expect(merged).toHaveLength(2);
    expect(merged.map((slot) => slot.subject)).toEqual(["판테놀", "베타인"]);
  });

  it("drops undefined slots without producing an empty entry", () => {
    const merged = mergeFaqAnswerFactSlots([
      undefined,
      faqFactSlot("qualifier", undefined),
      faqFactSlot("review", "고객 리뷰에서는 촉촉한 사용감이 언급됩니다", ["review:촉촉한 사용감"])
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.role).toBe("review");
  });
});

describe("orderFaqAnswerFactSlots", () => {
  it("sorts slots into the six-stage arc order regardless of construction order", () => {
    const scrambled = [
      faqFactSlot("qualifier", "개인차가 있을 수 있습니다")!,
      faqFactSlot("review", "고객 리뷰에서는 촉촉한 사용감이 언급됩니다")!,
      faqFactSlot("evidence", "인체적용시험에서 개선이 확인되었습니다")!,
      faqFactSlot("productBenefit", "완제품은 피부 장벽 관리를 돕습니다")!,
      faqFactSlot("ingredientRole", "판테놀은 피부 장벽 관리를 돕습니다")!,
      faqFactSlot("composition", "주요 성분·기술로 구성한 제품입니다")!,
      faqFactSlot("target", "건조한 피부 고객을 위한 제품입니다")!,
      faqFactSlot("identity", "브랜드의 클렌저입니다")!
    ];

    const ordered = orderFaqAnswerFactSlots(scrambled);

    expect(ordered.map((slot) => slot.role)).toEqual([
      "identity", "target", "composition", "ingredientRole", "productBenefit", "evidence", "review", "qualifier"
    ]);
  });

  it("keeps the relative order of two slots that share the same role", () => {
    const first = faqFactSlot("ingredientRole", "판테놀은 피부 장벽 관리를 돕습니다")!;
    const second = faqFactSlot("ingredientRole", "세라마이드는 보습을 돕습니다")!;
    const ordered = orderFaqAnswerFactSlots([second, first]);
    // Neither slot was built after the other, so a stable sort must not
    // reorder them relative to their input position.
    expect(ordered.map((slot) => slot.fact)).toEqual([second!.fact, first!.fact]);
  });
});

describe("renderFaqAnswerFactSlots", () => {
  it("omits an empty stage entirely instead of leaving a stray connector", () => {
    const rendered = renderFaqAnswerFactSlots([
      faqFactSlot("identity", "브랜드의 클렌저입니다"),
      faqFactSlot("target", undefined),
      faqFactSlot("composition", undefined),
      faqFactSlot("productBenefit", "피부 장벽 관리를 돕습니다")
    ]);
    expect(rendered).not.toMatch(/\.\s*\./);
    expect(rendered).not.toMatch(/^\s*\./);
    expect(rendered).toBe("브랜드의 클렌저입니다. 피부 장벽 관리를 돕습니다.");
  });
});

/**
 * Regression (1027 크림 미스트 실측, v4 -> v5): arc-ordering the suitability
 * answer's slots kept a review-attributed sentence in a product-detail-intent
 * answer, which `trust-field-validator` (validate.ts:
 * `isExplicitReviewFaqQuestion` / `isReviewFaqAnswerSentence`) flags as
 * "FAQ answer mixed customer-review language into a product-detail answer."
 * The fix filters any `review`-role slot out of every product-detail
 * builder's render call (`renderProductDetailFaqAnswerFactSlots`) rather than
 * enumerating question wording -- a structural, builder-identity rule.
 */
describe("review slots are excluded from product-detail-intent answers (Task 3 fix)", () => {
  function creamMistProduct(): PdpProductSignal {
    return {
      name: "모이베리어 365 크림 미스트",
      brand: "EXAMPLEDERMA",
      description: "건조 피부와 민감 피부를 위한 고보습 크림 미스트입니다.",
      category: "크림 미스트",
      images: [],
      options: [],
      breadcrumbs: [],
      ingredients: ["세라마이드 10,000ppm"],
      benefits: ["수분 충전과 동시에 보습막을 형성합니다.", "흔들 필요 없이 사용할 수 있습니다."],
      effects: [],
      usage: [],
      metrics: [],
      // `resolveFaqIntentCoverageLimit` short-circuits to a 0-item FAQ when
      // there is neither answer-ready-FAQ guidance nor any source FAQ.
      faq: [{
        question: "이 크림 미스트는 어떤 피부에 좋나요?",
        answer: "건조 피부와 민감 피부를 위한 고보습 크림 미스트입니다."
      }],
      sourceTexts: ["작게 쪼개진 세라마이드와 수분을 묶은 특수 에멀젼 공법으로, 흔들 필요 없이 사용할 수 있다고 안내합니다."],
      // Full descriptive keyword phrases, not bare words -- `localizePublicReviewKeyword`
      // /`isUsefulPublicListValue` filter out short bare tokens like "촉촉"
      // as too generic, so a bare-word fixture would never actually exercise
      // the reported code path (confirmed by reproducing the false pass below).
      reviews: {
        rating: 4.8,
        reviewCount: 100,
        items: [{ body: "뿌린 후에는 피부가 촉촉하고 편안해지며, 끈적임 없이 산뜻하게 흡수됩니다. 미세하게 분사되어 좋아요.", rating: 5 }],
        keywords: ["촉촉한 사용감", "흡수감", "미세 분사 사용감"]
      },
      semanticFacts: {
        ingredients: ["세라마이드"],
        benefits: ["보습"],
        effects: [],
        skinTypes: [],
        usageSteps: [],
        metricClaims: [],
        evidenceSentences: [],
        ingredientBenefitLinks: []
      }
    };
  }

  it("keeps the suitability (product-detail) answer free of customer-review language", () => {
    const artifacts = generatePdpGeoArtifacts({ product: creamMistProduct(), locale: "ko-KR", ragChunks: [], ragDocuments: [] });
    const faqPage = nodeOf(artifacts, "FAQPage");
    const suitabilityItem = (faqPage?.mainEntity as Array<Record<string, any>> | undefined)
      ?.find((item) => /적합한가요|추천할\s*수\s*있나요/u.test(String(item.name)));
    expect(suitabilityItem).toBeDefined();
    expect(String(suitabilityItem?.acceptedAnswer?.text ?? "")).not.toMatch(/고객\s*리뷰|후기/u);
  });

  it("still has a home for the same review keywords: the dedicated review-intent builder is unaffected by the product-detail filter", () => {
    // ensureFaq's own ranking/coverage-limit step (unrelated to this fix) can
    // drop a low-priority candidate from a minimal synthetic fixture, so this
    // exercises the actual builder `ensureFaq` calls for the "고객 리뷰에서는
    // ..." question directly rather than depending on it surviving ranking
    // here. The claim under test is narrow and precise: removing the review
    // slot from the three product-detail builders does not remove review
    // content from the pipeline -- it was always this builder's job.
    const answer = createReviewIntentFaqAnswer("ko-KR", "모이베리어 365 크림 미스트", "촉촉, 산뜻, 흡수", undefined, undefined);
    expect(answer).toMatch(/고객\s*리뷰에서는/u);
    expect(answer).toMatch(/촉촉|산뜻|흡수/u);
  });
});

/**
 * R-E (실측 1145, 2026-09-02): 리뷰 문장이 상품상세 FAQ 답변에 섞였다.
 *
 * FAQ 항목은 `ea70445`가 고친 세 빌더가 아니라 리뷰 파생 CEP 질의에서 나온
 * 커버리지 항목이라, `role !== "review"` 필터가 닿지 않았다. 텍스트 사후
 * 필터(`removeMisroutedReviewContextFromFaqAnswer`)는 문두가 `고객 리뷰에서는`인
 * 문장만 보므로 `고객 리뷰에서 고객들은 …`을 그냥 통과시켰다.
 *
 * 같은 세 사실이 두 곳에 실린다는 것이 요점이다 — 리뷰 귀속 속성은 리뷰 문장을
 * 실어도 되고, 상품상세 FAQ 답변은 안 된다. 그래서 문장 매칭이 아니라 슬롯
 * 역할로 가른다.
 */
function reviewedCleanserProduct(): PdpProductSignal {
  const { product } = normalizePdpProduct({
    name: "예시더마 모이베리어365 클렌징폼",
    brand: "EXAMPLEDERMA",
    description: "건조하고 민감한 피부를 위한 약산성 클렌징폼입니다.",
    category: "클렌저",
    ingredients: ["판테놀", "베타인"],
    benefits: ["피부 장벽", "세정력", "저자극 세안"],
    usage: ["젖은 손에 적당량을 덜어 충분히 거품을 낸 뒤 얼굴에 부드럽게 롤링합니다."],
    reviews: { keywords: ["촉촉한 사용감", "만족도", "탄력"] },
    faq: [{
      question: "이 클렌징폼은 어떤 피부에 좋나요?",
      answer: "건조하고 민감한 피부에도 사용할 수 있는 약산성 클렌징폼입니다."
    }]
  }, { hints: { locale: "ko-KR" } });
  return {
    ...product,
    semanticFacts: {
      ingredients: ["판테놀", "베타인"],
      benefits: ["피부 장벽", "세정력", "저자극 세안"],
      effects: [],
      skinTypes: ["건조 피부 또는 민감 피부"],
      usageSteps: [],
      metricClaims: [],
      evidenceSentences: [],
      ingredientBenefitLinks: []
    }
  };
}

/** 리뷰 귀속 문장의 구조적 표지 — 리뷰를 출처로 밝히는 절. */
const REVIEW_ATTRIBUTED_CLAUSE = /고객\s*리뷰에서/u;

describe("R-E: 리뷰 파생 CEP 답변의 리뷰 문장 라우팅", () => {
  const artifacts = generatePdpGeoArtifacts({
    product: reviewedCleanserProduct(),
    locale: "ko-KR",
    ragChunks: [],
    ragDocuments: []
  });
  const faqItems = ((nodeOf(artifacts, "FAQPage")?.mainEntity ?? []) as Array<Record<string, any>>)
    .map((item) => ({ question: String(item.name ?? ""), answer: String(item.acceptedAnswer?.text ?? "") }));
  const properties = ((nodeOf(artifacts, "Product")?.additionalProperty ?? []) as Array<Record<string, string>>)
    .map((entry) => ({ name: String(entry.name ?? ""), value: String(entry.value ?? "") }));

  it("리뷰 파생 CEP가 만든 상품상세 FAQ 답변에 리뷰 문장이 없다", () => {
    const cepItem = faqItems.find((item) => /돕는\s+\S+는?\s*무엇인가요\?$/u.test(item.question));

    expect(cepItem).toBeTruthy();
    expect(cepItem?.answer).toBeTruthy();
    expect(cepItem?.answer).not.toMatch(REVIEW_ATTRIBUTED_CLAUSE);
  });

  it("리뷰 의도 FAQ는 리뷰 언어를 그대로 유지한다", () => {
    const reviewItem = faqItems.find((item) => /고객\s*리뷰/u.test(item.question));

    expect(reviewItem?.answer).toMatch(/리뷰/u);
  });

  it("리뷰 귀속 속성에는 같은 리뷰 문장이 계속 실린다", () => {
    const reviewDerived = properties.find((entry) => entry.name === "Review-derived recommendation context");

    expect(reviewDerived?.value).toMatch(REVIEW_ATTRIBUTED_CLAUSE);
  });

  it("어떤 상품상세 FAQ 답변에도 리뷰 귀속 문장이 없다", () => {
    const productDetailAnswers = faqItems
      .filter((item) => !/고객\s*리뷰/u.test(item.question))
      .map((item) => item.answer);

    for (const answer of productDetailAnswers) {
      expect(answer).not.toMatch(REVIEW_ATTRIBUTED_CLAUSE);
    }
  });
});
