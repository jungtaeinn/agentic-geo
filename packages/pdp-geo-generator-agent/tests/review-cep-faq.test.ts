import { describe, expect, it } from "vitest";
import { deriveCepCandidates, deriveReviewCepCandidates, extractReviewSituationSignals, extractSituationSignals, namesUseSituation } from "../src/review-cep";
import { normalizePdpProduct } from "../src/normalize";
import { generatePdpGeo } from "../src";
import type { PdpProductSignal } from "../src/types";

/**
 * The review-derived CEP pipeline (stages 1-3). A FAQ built only from official
 * fields answers questions no buyer types; these stages read the buying and use
 * situations customers stated themselves so CEP derivation has real material.
 *
 * The contract under test is functional, not lexical: situations are recognized
 * by the grammar that encodes context of use, never by a vocabulary of known
 * situations, so a product whose reviewers describe something this repository
 * has never seen still yields it.
 */
function koreanProduct(reviewBodies: string[], overrides: Partial<PdpProductSignal> = {}): PdpProductSignal {
  const { product } = normalizePdpProduct({
    name: "모이베리어365 크림",
    brand: "EXAMPLEDERMA",
    category: "크림",
    benefits: ["피부장벽 강화", "120시간 보습 지속"],
    ingredients: ["고밀도 세라마이드 캡슐"],
    reviews: { rating: 4.9, reviewCount: 100, items: reviewBodies.map((body) => ({ body })), keywords: [] }
  }, { hints: { locale: "ko-KR" } });
  return { ...product, ...overrides };
}

describe("stage 1-2: review situation extraction", () => {
  it("reads a co-user situation out of a review clause", () => {
    const signals = extractReviewSituationSignals(koreanProduct(["아이들과 함께 쓰기 너무 좋아요. 향도 순하고 자극이 없어서 계속 쓰고 있습니다"]), "ko-KR");
    expect(signals.map((signal) => signal.situation)).toContain("아이들과 함께");
  });

  it("recognizes a situation the module has no vocabulary for", () => {
    // Nothing in the extractor knows what a night shift is; the temporal
    // grammar is what identifies it, which is why an unseen category works.
    const signals = extractReviewSituationSignals(koreanProduct(["야근할 때 쓰기 좋아요. 늦게 퇴근한 날에도 부담 없이 바를 수 있어서 자주 씁니다"]), "ko-KR");
    expect(signals.map((signal) => signal.situation)).toContain("야근할 때");
  });

  it("does not treat a sensory description as a situation", () => {
    const signals = extractReviewSituationSignals(koreanProduct(["촉촉하고 순해서 너무 좋아요. 발림성도 부드럽고 흡수도 빨라서 만족스럽습니다"]), "ko-KR");
    expect(signals.map((signal) => signal.situation)).toHaveLength(0);
  });

  it("does not treat the product itself as the situation", () => {
    const signals = extractReviewSituationSignals(koreanProduct(["이 크림과 함께 쓰면 좋아요. 다른 제품과도 잘 어울려서 계속 사용하고 있습니다"]), "ko-KR");
    expect(signals.map((signal) => signal.key)).not.toContain("크림");
  });

  it("keeps a neutral occasion stated in a clause that also carries a complaint", () => {
    // The reviewer rated it five stars, so the review recommends the product
    // even though one clause notes a caveat. Only the span reaches public
    // copy, so the occasion survives and the caveat is never published.
    const product = koreanProduct(["약간 무거운 제형이라서 겨울에 사용하는게 좋아요. 여름에는 얇게 펴 바르면 괜찮습니다"]);
    const rated = { ...product, reviews: { ...product.reviews, items: product.reviews.items.map((item) => ({ ...item, rating: 5 })) } };
    const signals = extractReviewSituationSignals(rated, "ko-KR");
    expect(signals.map((signal) => signal.situation)).toContain("겨울에");
  });

  it("ignores a review that does not recommend the product", () => {
    // A FAQ built on a situation recommends the product for it, so a complaint
    // is the wrong material even when it states a situation clearly.
    const signals = extractReviewSituationSignals(
      koreanProduct(["아이들과 함께 써봤는데 자극이 있어서 아쉬웠어요. 저희 아이에게는 잘 맞지 않았습니다"]),
      "ko-KR"
    );
    expect(signals).toHaveLength(0);
  });

  it("trusts a supplied rating over the wording of the review", () => {
    // "건조하지 않고" and "자극이나 트러블 없이" read as complaints to a cue-only
    // judge; the customer's own five-star verdict settles it either way.
    const product = koreanProduct(["세안 후에도 건조하지 않고 촉촉해서 아이들과 함께 쓰고 있어요"]);
    const rated = { ...product, reviews: { ...product.reviews, items: product.reviews.items.map((item) => ({ ...item, rating: 5 })) } };
    expect(extractReviewSituationSignals(rated, "ko-KR").map((signal) => signal.key)).toContain("아이");
  });

  it("drops a complaint that is itself the customer's stated condition", () => {
    const signals = extractReviewSituationSignals(koreanProduct(["제형이 답답해서 아쉬웠어요. 바르고 나면 무겁게 느껴져서 저에게는 잘 맞지 않았습니다"]), "ko-KR");
    expect(signals.map((signal) => signal.situation)).toHaveLength(0);
  });

  it("counts distinct reviews as support and orders by it", () => {
    const signals = extractReviewSituationSignals(koreanProduct([
      "아이들과 함께 쓰기 좋아요. 향이 순해서 온 가족이 부담 없이 사용합니다",
      "아이와 함께 사용하고 있어요. 자극이 적어서 매일 저녁 발라주고 있습니다",
      "겨울에 사용하기 좋네요. 건조한 계절에도 당김 없이 편하게 쓰고 있습니다"
    ]), "ko-KR");
    expect(signals[0]?.key).toBe("아이");
    expect(signals[0]?.support).toBe(2);
  });

  it("extracts English co-user and occasion contexts", () => {
    const { product } = normalizePdpProduct({
      name: "Barrier Cream",
      brand: "EXAMPLEDERMA",
      category: "Cream",
      benefits: ["barrier support"],
      reviews: {
        rating: 5,
        reviewCount: 10,
        items: [{ body: "I use it with my kids and it is gentle enough for their sensitive skin." }, { body: "Bought it as a gift for my mother and she really liked the texture." }],
        keywords: []
      }
    }, { hints: { locale: "en-US" } });
    const situations = extractReviewSituationSignals(product, "en-US").map((signal) => signal.situation);
    expect(situations.join(" ")).toMatch(/kids/i);
    expect(situations.join(" ")).toMatch(/gift/i);
  });
});

describe("stage 3: CEP derivation", () => {
  it("pairs a review situation with an official need", () => {
    const candidates = deriveReviewCepCandidates({
      product: koreanProduct(["아이들과 함께 쓰기 너무 좋아요. 향도 순하고 자극이 없어서 계속 쓰고 있습니다"]),
      locale: "ko-KR",
      needs: ["피부장벽 강화"]
    });
    expect(candidates[0]?.situation).toBe("아이들과 함께");
    expect(candidates[0]?.need).toBe("피부장벽 강화");
  });

  it("emits nothing when no official need is available to answer the situation", () => {
    // A review can state a situation but never what the product does, so a
    // situation with no official need is dropped rather than answered.
    const candidates = deriveReviewCepCandidates({
      product: koreanProduct(["아이들과 함께 쓰기 너무 좋아요. 향도 순하고 자극이 없어서 계속 쓰고 있습니다"]),
      locale: "ko-KR",
      needs: []
    });
    expect(candidates).toHaveLength(0);
  });

  it("excludes a context the product's own directions already describe", () => {
    // "세안 후" is answered by the usage FAQ; it is a routine step, not a
    // category entry point.
    const product = koreanProduct([
      "세안 후 사용하니 좋아요. 다음 단계 제품도 잘 흡수되어 만족합니다",
      "아이들과 함께 쓰기 좋아요. 향이 순해서 온 가족이 부담 없이 사용합니다"
    ], {
      usage: ["아침과 저녁 세안 후 토너와 세럼 단계 다음에 적당량을 덜어 바릅니다."]
    });
    const situations = deriveReviewCepCandidates({ product, locale: "ko-KR", needs: ["피부장벽 강화"] })
      .map((candidate) => candidate.key);
    expect(situations).not.toContain("세안");
    expect(situations).toContain("아이");
  });
});

describe("situational vs audience suitability", () => {
  it("separates a situational suitability question from an audience one", () => {
    // These are different search surfaces: a buyer reaches them from different
    // queries, so they must not collapse into one FAQ.
    expect(namesUseSituation("모이베리어365 크림은 아이들과 함께 사용하기에 적합한가요?", "ko-KR")).toBe(true);
    expect(namesUseSituation("건조하고 민감한 피부 고객에게 모이베리어365 크림은 적합한가요?", "ko-KR")).toBe(false);
  });
});

describe("product-stated situations", () => {
  it("reads a situation from official product copy", () => {
    // The only CEP source for a product with no reviews at all.
    const { product } = normalizePdpProduct({
      name: "모이베리어365 크림미스트",
      brand: "EXAMPLEDERMA",
      category: "미스트",
      benefits: ["수분 공급"],
      sourceTexts: ["건조할 때 수시로 분사해 수분을 보충할 수 있습니다."]
    }, { hints: { locale: "ko-KR" } });

    expect(extractSituationSignals(product, "ko-KR", "product").map((signal) => signal.situation))
      .toContain("건조할 때");
  });

  it("does not read a study timing as a situation", () => {
    // Product copy states measured timings in the same grammar as occasions.
    // "사용 4주 후" is a measurement, and a FAQ asking whether the product
    // suits being used "after 4 weeks" answers nothing.
    const { product } = normalizePdpProduct({
      name: "하이드라 세럼",
      category: "세럼",
      benefits: ["수분 공급"],
      sourceTexts: ["인체적용시험에서 32명을 대상으로 사용 4주 후 수분량이 30% 개선되었습니다."]
    }, { hints: { locale: "ko-KR" } });

    expect(extractSituationSignals(product, "ko-KR", "product")).toHaveLength(0);
  });

  it("does not relabel review text as official copy", () => {
    // Normalization copies review bodies into `sourceTexts`. Reading those as
    // product copy would route customer wording — including a complaint —
    // through the origin that has no polarity gate.
    const { product } = normalizePdpProduct({
      name: "모이베리어365 크림",
      category: "크림",
      benefits: ["피부장벽 강화"],
      reviews: {
        rating: 4.9,
        reviewCount: 10,
        items: [{ body: "아이들과 함께 쓰기 너무 좋아요. 향도 순하고 자극이 없어서 계속 쓰고 있습니다" }],
        keywords: []
      }
    }, { hints: { locale: "ko-KR" } });

    expect(extractSituationSignals(product, "ko-KR", "product")).toHaveLength(0);
    expect(extractSituationSignals(product, "ko-KR", "review").map((signal) => signal.key)).toContain("아이");
  });

  it("prefers the official statement when both origins name one situation", () => {
    const { product } = normalizePdpProduct({
      name: "모이베리어365 크림미스트",
      category: "미스트",
      benefits: ["수분 공급"],
      sourceTexts: ["건조할 때 수시로 분사해 수분을 보충할 수 있습니다."],
      reviews: {
        rating: 5,
        reviewCount: 4,
        items: [{ body: "건조할 때마다 뿌리고 있어요. 촉촉하게 유지돼서 계속 사용합니다" }],
        keywords: []
      }
    }, { hints: { locale: "ko-KR" } });

    const candidates = deriveCepCandidates({ product, locale: "ko-KR", needs: ["수분 공급"] });
    // The key drops the verb ending so "건조할 때" and "건조한 날" group as one.
    expect(candidates.filter((candidate) => candidate.key === "건조")).toHaveLength(1);
    expect(candidates.find((candidate) => candidate.key === "건조")?.origin).toBe("product");
  });

  it("keeps deriveReviewCepCandidates scoped to review-stated situations", () => {
    const { product } = normalizePdpProduct({
      name: "모이베리어365 크림미스트",
      category: "미스트",
      benefits: ["수분 공급"],
      sourceTexts: ["건조할 때 수시로 분사해 수분을 보충할 수 있습니다."]
    }, { hints: { locale: "ko-KR" } });

    expect(deriveReviewCepCandidates({ product, locale: "ko-KR", needs: ["수분 공급"] })).toHaveLength(0);
    expect(deriveCepCandidates({ product, locale: "ko-KR", needs: ["수분 공급"] })).not.toHaveLength(0);
  });
});

describe("texture and review use-feel FAQ overlap", () => {
  const reviews = {
    rating: 5,
    reviewCount: 12,
    items: [{ body: "촉촉하게 발리면서 끈적임이 적은 마무리가 만족스럽습니다.", rating: 5 }],
    keywords: ["촉촉한 사용감", "끈적임이 적은 마무리"]
  };

  async function faqQuestions(sourceTexts: string[]) {
    const run = await generatePdpGeo({
      product: {
        name: "배리어 로션",
        description: "건조하고 민감한 피부 고객을 위한 보습 로션입니다.",
        category: "로션",
        benefits: ["피부 보습 장벽 강화"],
        ingredients: ["세라마이드"],
        reviews,
        sourceTexts
      },
      hints: { locale: "ko-KR", market: "KR" }
    });
    const graph = run.result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, unknown>>;
    const faq = graph.find((node) => node["@type"] === "FAQPage");
    return ((faq?.mainEntity ?? []) as Array<{ name: string }>).map((item) => String(item.name));
  }

  it("publishes one use-feel answer when only reviews describe the texture", async () => {
    // Both entries would list the same sensory terms; the review question is
    // the one that says whose words they are.
    const questions = await faqQuestions(["세라마이드가 피부 보습 장벽 강화를 돕습니다."]);

    expect(questions.filter((question) => /제형이나\s*사용감/u.test(question))).toHaveLength(0);
    expect(questions.filter((question) => /고객\s*리뷰/u.test(question))).toHaveLength(1);
  });

  it("publishes both when the product's own copy describes the texture", async () => {
    // Now they are two different answers from two different sources: one
    // states a product fact, the other attributes an experience.
    const questions = await faqQuestions([
      "세라마이드가 피부 보습 장벽 강화를 돕습니다.",
      "촉촉한 사용감과 끈적임이 적은 마무리가 특징입니다."
    ]);

    expect(questions.filter((question) => /제형이나\s*사용감/u.test(question))).toHaveLength(1);
    expect(questions.filter((question) => /고객\s*리뷰/u.test(question))).toHaveLength(1);
  });
});
