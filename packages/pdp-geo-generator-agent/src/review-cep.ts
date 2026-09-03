import type { PdpGeoLocale, PdpProductSignal } from "./types";
import { isNegativeReviewSignalText, isPositiveReviewItem } from "./review-sentiment";

/**
 * Stages 1-3 of the review-driven FAQ pipeline: review extraction, situational
 * analysis, and Category Entry Point derivation.
 *
 * A FAQ that only restates official product fields answers a question no buyer
 * asks in those words. The situations that actually enter a category — who the
 * product is used with, what happened before it was needed, what occasion it
 * was bought for — are stated by customers in review bodies and nowhere else in
 * the source. This module reads them out so CEP derivation has real material.
 *
 * ## Why this is defined by sentence function, not by a keyword list
 *
 * A situation is recognized by what a clause *does*, never by matching a
 * vocabulary of situations. A clause is situational when it states the context
 * in which the product is used or bought, as opposed to how it felt (sensory)
 * or what it changed (outcome). Structurally that means the clause carries a
 * context marker — a grammatical companion, beneficiary, purpose, temporal, or
 * causal-state construction — and the span that marker governs names something
 * other than the product itself.
 *
 * The marker inventories below are function words and connective endings: they
 * are the grammar that encodes "context of use" in each locale. The *content*
 * of a situation is never enumerated. Whatever noun the grammar picks out is
 * the situation, so a product whose reviewers talk about newborns, night
 * shifts, or humid summers yields those situations without this file knowing
 * they exist.
 */

/** Where a situation was stated. Official copy outranks customer experience. */
export type SituationOrigin = "product" | "review";

/** One situational clause read out of the source. */
export interface ReviewSituationSignal {
  /** Whether the source was official product copy or a customer review. */
  origin: SituationOrigin;
  /** The clause the situation was read from, verbatim. */
  clause: string;
  /** The span the context marker governs — the CEP situation surface. */
  situation: string;
  /** Distinct reviews that stated a situation with the same normalized key. */
  support: number;
  /** Indexes into `product.reviews.items` that stated this situation. */
  reviewIndexes: number[];
  /** Normalized key used for grouping and de-duplication. */
  key: string;
}

/** A source-backed buying/use situation paired with the need it implies. */
export interface ReviewCepCandidate {
  situation: string;
  /** Concrete concern or desired outcome, taken from official product fields. */
  need: string;
  /** Supported selection condition; empty when the source states none. */
  constraint: string;
  /** Review clauses that support the situation, verbatim. */
  supportingClauses: string[];
  support: number;
  reviewIndexes: number[];
  origin: SituationOrigin;
  key: string;
}

/**
 * Context markers per locale. Each entry captures the span the marker governs.
 * These are grammatical constructions, not situation vocabulary — see the
 * module comment for why that distinction is load-bearing.
 */
interface SituationMarker {
  /** Captures, in group 1, the span the marker governs. */
  pattern: RegExp;
}

const ENGLISH_SITUATION_MARKERS: SituationMarker[] = [
  { pattern: /\bwith\s+(?:my|our)\s+([a-z][a-z\s]{2,28}?)(?=\s+(?:and|but|so|because|which|that|when)\b|[,.;]|$)/giu },
  { pattern: /\b(?:when|while|after|before|during)\s+([a-z][a-z\s]{2,28}?)(?=\s+(?:and|but|so|because|which|that)\b|[,.;]|$)/giu },
  { pattern: /\b(?:as|for)\s+(?:a\s+)?(gift|present|[a-z]+\s+gift)\b/giu },
  { pattern: /\bfor\s+(?:my|our)\s+([a-z][a-z\s]{2,28}?)(?=\s+(?:and|but|so|because|which|that|when)\b|[,.;]|$)/giu }
];

const SITUATION_MARKERS: Record<PdpGeoLocale, SituationMarker[]> = {
  "ko-KR": [
    // companion: "아이들과 함께", "가족이랑 같이"
    { pattern: /([가-힣A-Za-z0-9]{1,12})(?:과|와|랑|이랑)\s*(?:함께|같이)/gu },
    // companion without a case particle: "가족 다 같이 쓰니까"
    { pattern: /([가-힣A-Za-z0-9]{2,10})\s*(?:다\s*)?같이\s*(?:쓰|사용|바르|발라)/gu },
    // beneficiary: "아이에게", "부모님께"
    { pattern: /([가-힣A-Za-z0-9]{1,12})(?:에게|께)(?=\s|$)/gu },
    // purpose: "선물용으로", "여행용으로"
    { pattern: /([가-힣A-Za-z0-9]{1,12})\s*용으로/gu },
    // temporal condition: "화장할 때", "건조할 때". One eojeol only — a wider
    // span reaches back across the previous clause's ending. The quantifier is
    // lazy so the verb ending goes to the ending group rather than into the
    // span: a greedy capture read "사용할 때" as the context "사용할", which
    // slipped past the vacuous-span filter and asked whether the product suits
    // being used "when using".
    { pattern: /([가-힣A-Za-z0-9]{1,10}?)(?:할|하는|일|인|았을|었을|였을)?\s*때/gu },
    // routine position: "화장 전에", "세안 후에"
    { pattern: /([가-힣A-Za-z0-9]{1,12})\s*(?:전|후|중)(?:에|에는)?(?=\s|$)/gu },
    // occasion/season framing of an action: "겨울에 사용", "아침에 바르"
    { pattern: /([가-힣A-Za-z0-9]{1,10})에(?:는)?\s*(?:쓰|사용|바르|발라)/gu },
    // A customer-state marker ("민감성 피부여서") is deliberately absent. Its
    // endings are shared with contracted adjective stems ("흡수도 빨라서"), so it
    // admitted sensory wording, and the skin-state CEP it produced is already
    // covered by the audience suitability question.
  ],
  "ja-JP": [
    { pattern: /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z0-9]{1,12})(?:と|や)\s*(?:一緒に|ともに)/gu },
    { pattern: /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z0-9]{1,12})\s*用に/gu },
    { pattern: /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z0-9]{1,12})\s*(?:のとき|の時|するとき|する時)/gu },
    { pattern: /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-z0-9]{1,12})\s*(?:の前|の後|前に|後に)/gu }
    ],
  "en-US": ENGLISH_SITUATION_MARKERS,
  "en-GB": ENGLISH_SITUATION_MARKERS
};

/**
 * Function words that can fill a marker's span without naming any context.
 * Grammatical fillers only — never product, benefit, or occasion vocabulary.
 */
const CONTENTLESS_SPANS: Record<PdpGeoLocale, RegExp> = {
  "ko-KR": /^(?:이|그|저|것|거|수|때|점|더|좀|잘|또|매우|정말|너무|진짜|계속|그냥|약간|조금|같이|함께|제|내|나|저희|우리|사용|제품|상품|하나|여러|다시|처음|번째|정도|생각|느낌|여기|거기|고객|고객님|사람|사람들|분|분들|피부|얼굴|경우|부분|단계|테스트|시험|직후|이상|이하|기준)$/u,
  "ja-JP": /^(?:これ|それ|あれ|もの|こと|とても|すごく|少し|また|使用|製品|商品|私|自分)$/u,
  "en-US": /^(?:it|this|that|them|thing|things|use|using|product|skin|me|myself|day|days|time|times|bit|lot)$/iu,
  "en-GB": /^(?:it|this|that|them|thing|things|use|using|product|skin|me|myself|day|days|time|times|bit|lot)$/iu
};

const CLAUSE_SPLIT = /[.!?。！？\n]+|(?:[,、]\s*)/u;

/**
 * Stage 1 + 2. Reads the situational clauses a source states, in support
 * order.
 *
 * Reviews are read only when they recommend the product. A FAQ built on a
 * situation is a recommendation for that situation, and a complaint cannot
 * recommend anything — it is also the wrong material for the answer, whose
 * job is to help a buyer in that situation decide. Official product copy has
 * no such gate: it is the brand's own statement, and it is the only source of
 * situations for a product with no reviews at all.
 */
export function extractSituationSignals(
  product: PdpProductSignal,
  locale: PdpGeoLocale,
  origin: SituationOrigin
): ReviewSituationSignal[] {
  const markers = SITUATION_MARKERS[locale];
  const contentless = CONTENTLESS_SPANS[locale];
  const productVocabulary = createProductVocabulary(product);
  const grouped = new Map<string, { signal: ReviewSituationSignal; sources: Set<number> }>();

  situationSources(product, origin).forEach((body, sourceIndex) => {
    const text0 = normalizeWhitespace(body);
    if (!text0) return;
    for (const clause of text0.split(CLAUSE_SPLIT)) {
      const text = normalizeWhitespace(clause);
      if (text.length < 4) continue;
      for (const marker of markers) {
        marker.pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = marker.pattern.exec(text)) !== null) {
          const span = normalizeWhitespace(match[1] ?? "");
          if (!span || contentless.test(span)) continue;
          // A quantity is a measurement, not an occasion. Product copy states
          // study timings in the same grammar as situations ("사용 4주 후",
          // "2시간 만에"), and reading those as category entry points produces
          // a FAQ asking whether the product suits being used "after 4 weeks".
          if (namesQuantity(span)) continue;
          // Even inside a recommending review a single span can be a
          // complaint ("무거운 제형이라서"), and only the span reaches copy.
          if (isNegativeReviewSignalText(span)) continue;
          // The span has to name something other than the product itself,
          // otherwise "이 크림을 쓸 때" would register as a situation.
          if (spanNamesProduct(span, productVocabulary)) continue;
          const situation = trimSituationSurface(match[0], locale);
          const key = situationKey(span, locale);
          if (!key) continue;
          const existing = grouped.get(key);
          if (existing) {
            existing.sources.add(sourceIndex);
            continue;
          }
          grouped.set(key, {
            signal: { origin, clause: text, situation, support: 0, reviewIndexes: [], key },
            sources: new Set([sourceIndex])
          });
        }
      }
    }
  });

  return [...grouped.values()]
    .map(({ signal, sources }) => ({
      ...signal,
      support: sources.size,
      reviewIndexes: origin === "review" ? [...sources].sort((left, right) => left - right) : []
    }))
    .sort((left, right) => right.support - left.support || left.key.localeCompare(right.key));
}

/**
 * The texts a given origin contributes. Usage directions are deliberately
 * absent: a routine step is what HowTo answers, and `createRoutineVocabulary`
 * uses them to exclude the same contexts from the other product fields.
 */
function situationSources(product: PdpProductSignal, origin: SituationOrigin): string[] {
  if (origin === "review") {
    return product.reviews.items.filter(isPositiveReviewItem).map((item) => item.body ?? "");
  }
  // Normalization copies review bodies into `sourceTexts`, so an unfiltered
  // read would relabel customer text as official copy and let a complaint in
  // through the origin that has no polarity gate.
  const reviewText = product.reviews.items
    .map((item) => normalizeWhitespace(item.body ?? ""))
    .filter((body) => body.length > 0);
  const officialSourceTexts = product.sourceTexts.filter((value) => {
    const text = normalizeWhitespace(value);
    return text.length > 0 && !reviewText.some((body) => body.includes(text) || text.includes(body));
  });
  return [
    product.description ?? "",
    ...product.benefits,
    ...product.effects,
    ...officialSourceTexts,
    ...(product.semanticFacts?.evidenceSentences ?? [])
  ].filter(Boolean);
}

/** Stage 1 + 2 over customer reviews. Retained for callers reading reviews only. */
export function extractReviewSituationSignals(
  product: PdpProductSignal,
  locale: PdpGeoLocale
): ReviewSituationSignal[] {
  return extractSituationSignals(product, locale, "review");
}

/**
 * True when a sentence names a use or purchase context rather than only a
 * product attribute or a customer's skin type.
 *
 * Used to tell a *situational* suitability question ("is it right when used
 * with children?") apart from an *audience* suitability question ("is it right
 * for dry skin?"). Those are different search surfaces — a buyer reaches them
 * from different queries — so publishing both is coverage, not duplication.
 */
export function namesUseSituation(text: string, locale: PdpGeoLocale): boolean {
  const markers = SITUATION_MARKERS[locale];
  const contentless = CONTENTLESS_SPANS[locale];
  const normalized = normalizeWhitespace(text);
  return markers.some((marker) => {
    marker.pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = marker.pattern.exec(normalized)) !== null) {
      const span = normalizeWhitespace(match[1] ?? "");
      if (span && !contentless.test(span)) return true;
    }
    return false;
  });
}

/**
 * Stage 3. Pairs each supported situation with the concrete need it implies.
 *
 * The need never comes from the review: a review is experience evidence and
 * cannot establish what the product does. It comes from the official benefit
 * and effect fields, so the resulting CEP is "customer-stated situation +
 * source-stated need" — the only combination both stages of the evidence
 * contract accept.
 */
export function deriveCepCandidates(input: {
  product: PdpProductSignal;
  locale: PdpGeoLocale;
  /** Official finished-product benefits, already locale-normalized. */
  needs: string[];
  /** Supported selection condition, when the source states one. */
  constraint?: string;
  limit?: number;
}): ReviewCepCandidate[] {
  const need = normalizeWhitespace(input.needs.filter(Boolean).join(", "));
  if (!need) return [];
  const routineVocabulary = createRoutineVocabulary(input.product);
  const seen = new Set<string>();
  const signals = [
    // Official copy first. A situation the brand states is source evidence,
    // while a review states experience, so where both name the same situation
    // the official one is the stronger citation for the same answer.
    ...extractSituationSignals(input.product, input.locale, "product"),
    ...extractSituationSignals(input.product, input.locale, "review")
  ]
    // A context the product's own directions already describe is a routine
    // step, not a category entry point: "after cleansing" is answered by the
    // usage FAQ, while "after giving birth" is a situation nothing else covers.
    .filter((signal) => !routineVocabulary.some((token) => signal.key.includes(token)))
    .filter((signal) => {
      if (seen.has(signal.key)) return false;
      seen.add(signal.key);
      return true;
    });
  return signals.slice(0, input.limit ?? 6).map((signal) => ({
    situation: signal.situation,
    need,
    constraint: normalizeWhitespace(input.constraint ?? ""),
    supportingClauses: [signal.clause],
    support: signal.support,
    reviewIndexes: signal.reviewIndexes,
    origin: signal.origin,
    key: signal.key
  }));
}

/** Stage 3 over customer reviews only. */
export function deriveReviewCepCandidates(input: {
  product: PdpProductSignal;
  locale: PdpGeoLocale;
  needs: string[];
  constraint?: string;
  limit?: number;
}): ReviewCepCandidate[] {
  return deriveCepCandidates(input).filter((candidate) => candidate.origin === "review");
}

function createRoutineVocabulary(product: PdpProductSignal): string[] {
  return [...product.usage, ...(product.semanticFacts?.usageSteps ?? [])]
    .flatMap((value) => normalizeWhitespace(value).split(/[\s/·,]+/u))
    // Punctuation has to go before the comparison: a step ending "after
    // toner." yielded the token "toner." and never matched the situation key
    // "toner", so the routine step it should have excluded became a CEP.
    .map((token) => token.toLocaleLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .map((token) => token.replace(/(?:후|전|중|에|을|를|은|는|이|가)$/u, ""))
    .filter((token) => token.length >= 2);
}

/** True when a span is a measured amount rather than a place, time, or person. */
function namesQuantity(span: string): boolean {
  return /^\d/u.test(span) || /\d\s*(?:%|시간|분|초|일|주|주일|개월|년|회|번|배|층|명|mL|ml|g|kg|oz)/iu.test(span);
}

function createProductVocabulary(product: PdpProductSignal): string[] {
  return [
    product.name,
    product.originalName ?? "",
    product.brand ?? "",
    product.category ?? "",
    ...product.ingredients,
    ...product.benefits,
    ...product.effects
  ]
    .flatMap((value) => normalizeWhitespace(value).split(/[\s/·,]+/u))
    .map((token) => token.toLocaleLowerCase())
    .filter((token) => token.length >= 2);
}

function spanNamesProduct(span: string, vocabulary: string[]): boolean {
  const normalized = span.toLocaleLowerCase();
  return vocabulary.some((token) => normalized.includes(token) || token.includes(normalized));
}

/**
 * A marker's match ends on the predicate that anchored it ("가족 다 같이 쓰").
 * The situation surface is the context itself, so the dangling predicate stem
 * is dropped; downstream locale helpers attach whatever particle the sentence
 * they build needs.
 */
function trimSituationSurface(value: string, locale: PdpGeoLocale): string {
  const text = normalizeWhitespace(value);
  if (locale === "ko-KR") {
    return normalizeWhitespace(text.replace(/\s*(?:쓰|사용|바르|발라)\S*$/u, ""));
  }
  if (locale === "ja-JP") {
    return normalizeWhitespace(text.replace(/\s*(?:使|塗)\S*$/u, ""));
  }
  return text;
}

function situationKey(span: string, locale: PdpGeoLocale): string {
  const base = span.toLocaleLowerCase().replace(/\s+/gu, "");
  if (locale !== "ko-KR") {
    const singular = base.replace(/(?:es|s)$/u, "");
    return (singular.length >= 2 ? singular : base).length >= 2 ? (singular.length >= 2 ? singular : base) : "";
  }
  // Reviewers state the same situation with different endings ("아이", "아이들",
  // "아이들과"), so plural and case markers are stripped to group them. A
  // particle is only stripped when a stem survives it: "아이" ends in the same
  // syllable as the subject particle, and removing it would leave "아".
  const withoutPlural = base.replace(/들$/u, "");
  const stem = withoutPlural.length >= 2 ? withoutPlural : base;
  const withoutParticle = stem.replace(/(?:이|가|은|는|을|를|의)$/u, "");
  const key = withoutParticle.length >= 2 ? withoutParticle : stem;
  return key.length >= 2 ? key : "";
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/**
 * Stages 1-2 over every source, for the planner prompt. The planner performs
 * stages 3-5, so it receives the situations rather than finished CEP entries.
 */
export function deriveCepSituationsForPlanning(
  product: PdpProductSignal,
  locale: PdpGeoLocale
): ReviewSituationSignal[] {
  const routineVocabulary = createRoutineVocabulary(product);
  const seen = new Set<string>();
  return [
    ...extractSituationSignals(product, locale, "product"),
    ...extractSituationSignals(product, locale, "review")
  ]
    .filter((signal) => !routineVocabulary.some((token) => signal.key.includes(token)))
    .filter((signal) => {
      if (seen.has(signal.key)) return false;
      seen.add(signal.key);
      return true;
    });
}
