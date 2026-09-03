import type { EvalProductId } from "./fixtures";

/**
 * Golden query set for the citation-visibility benchmark.
 *
 * Coverage: 4 fixture products x 4 CEP-informed customer questions. The CEP
 * dimensions follow `src/rag/cep_v1.md` (situation/need, routine, selection/
 * comparison, concern/safety) so the queries probe how a generative engine
 * answers the questions real customers actually ask, not brand-side phrasing.
 *
 * FROZEN eval inputs, same rule as `fixtures/products.ts` and
 * `evals/goldens.ts`: never tune queries to make scores go up. Legitimate
 * edits are adding new products/dimensions or fixing factual query errors,
 * and both require regenerating the baseline in the same commit.
 *
 * `targetSlot` is the index of the PDP document inside the 5-source set
 * ([0..3] distractors reordered around it). Keeping it constant across the
 * paired vanilla/generated runs cancels slot-position bias by design, so a
 * single fixed value is used for every golden.
 */

export type GeoCepFocus = "need" | "routine" | "selection" | "concern";

export interface GeoEvalGolden {
  id: string;
  productId: EvalProductId;
  locale: "en-US" | "ko-KR";
  market: "US" | "KR";
  /** Customer question posed to the simulated generative engine. */
  query: string;
  /** CEP dimension this query probes, for reports. */
  cepFocus: GeoCepFocus;
}

export { GEO_EVAL_TARGET_SLOT } from "../citation/probe";

export const geoEvalGoldens: GeoEvalGolden[] = [
  // --- ExampleLuxe Botanical Ginseng Rejuvenating Serum (en-US) ---
  {
    id: "CGRS-NEED",
    productId: "exampleluxe-cgr-serum",
    locale: "en-US",
    market: "US",
    query: "What serum actually helps with fine lines and loss of firmness on dry skin?",
    cepFocus: "need"
  },
  {
    id: "CGRS-ROUTINE",
    productId: "exampleluxe-cgr-serum",
    locale: "en-US",
    market: "US",
    query: "How should I use a retinol serum in my nighttime skincare routine without irritation?",
    cepFocus: "routine"
  },
  {
    id: "CGRS-SELECT",
    productId: "exampleluxe-cgr-serum",
    locale: "en-US",
    market: "US",
    query: "Are capsule-type retinol serums better than regular retinol serums, and how do I choose one?",
    cepFocus: "selection"
  },
  {
    id: "CGRS-CONCERN",
    productId: "exampleluxe-cgr-serum",
    locale: "en-US",
    market: "US",
    query: "Can I use an anti-aging ginseng serum every day, and which skin types is it suitable for?",
    cepFocus: "concern"
  },

  // --- ExampleLuxe Essential Activating Serum (en-US) ---
  {
    id: "FCAS-NEED",
    productId: "exampleluxe-fcas-vi",
    locale: "en-US",
    market: "US",
    query: "Which serum improves dull, uneven skin tone within about a month?",
    cepFocus: "need"
  },
  {
    id: "FCAS-ROUTINE",
    productId: "exampleluxe-fcas-vi",
    locale: "en-US",
    market: "US",
    query: "What should I apply first right after cleansing, before toner and moisturizer?",
    cepFocus: "routine"
  },
  {
    id: "FCAS-SELECT",
    productId: "exampleluxe-fcas-vi",
    locale: "en-US",
    market: "US",
    query: "Is a first-step activating serum worth adding to a routine, and how do I pick a good one?",
    cepFocus: "selection"
  },
  {
    id: "FCAS-CONCERN",
    productId: "exampleluxe-fcas-vi",
    locale: "en-US",
    market: "US",
    query: "I have combination skin that gets red easily — what hydrating first serum is safe to try?",
    cepFocus: "concern"
  },

  // --- EXAMPLEDERMA 모이베리어365 캡슐 토너 (ko-KR) ---
  {
    id: "ACT-NEED",
    productId: "examplederma-capsule-toner",
    locale: "ko-KR",
    market: "KR",
    query: "세안 후 당김이 심한 건성 피부에 좋은 보습 토너는 어떤 게 있나요?",
    cepFocus: "need"
  },
  {
    id: "ACT-ROUTINE",
    productId: "examplederma-capsule-toner",
    locale: "ko-KR",
    market: "KR",
    query: "세라마이드 토너는 스킨케어 순서에서 언제, 어떻게 사용하는 게 좋나요?",
    cepFocus: "routine"
  },
  {
    id: "ACT-SELECT",
    productId: "examplederma-capsule-toner",
    locale: "ko-KR",
    market: "KR",
    query: "장벽 보습 토너를 고를 때 성분이나 제형에서 뭘 확인해야 하나요?",
    cepFocus: "selection"
  },
  {
    id: "ACT-CONCERN",
    productId: "examplederma-capsule-toner",
    locale: "ko-KR",
    market: "KR",
    query: "여드름성 피부나 임산부도 쓸 수 있는 저자극 토너가 있을까요?",
    cepFocus: "concern"
  },

  // --- EXAMPLEDERMA 모이베리어 365 크림 미스트 (ko-KR) ---
  {
    id: "ACM-NEED",
    productId: "examplederma-cream-mist",
    locale: "ko-KR",
    market: "KR",
    query: "사무실에서 수시로 뿌려도 건조해지지 않는 보습 미스트 추천해주세요.",
    cepFocus: "need"
  },
  {
    id: "ACM-ROUTINE",
    productId: "examplederma-cream-mist",
    locale: "ko-KR",
    market: "KR",
    query: "크림 미스트는 세안 후 스킨케어 순서에서 언제 사용하는 게 맞나요?",
    cepFocus: "routine"
  },
  {
    id: "ACM-SELECT",
    productId: "examplederma-cream-mist",
    locale: "ko-KR",
    market: "KR",
    query: "일반 수분 미스트와 크림 미스트는 뭐가 다르고 어떤 걸 골라야 하나요?",
    cepFocus: "selection"
  },
  {
    id: "ACM-CONCERN",
    productId: "examplederma-cream-mist",
    locale: "ko-KR",
    market: "KR",
    query: "민감성 피부가 겨울철 속건조를 잡으려면 어떤 미스트를 써야 하나요?",
    cepFocus: "concern"
  }
];
