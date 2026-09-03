import type { EvalContentPlanInput, EvalContentSections, EvalEvidenceItem } from "../types";
import { generateEngineAnswer, geoEvalEngineId, type GeoEvalEngineConfig } from "./engine";
import {
  attributeCitationsToSections,
  scoreCitationVisibility,
  type AttributableSection,
  type CitationSectionAttribution
} from "./metrics";
import {
  evaluateUtilityGate,
  judgeKeypointCoverage,
  PDP_COPY_UTILITY_GATE_THRESHOLDS,
  type KeypointCoverageScore,
  type UtilityGateResult
} from "./utility";

/** Fixed index of the target PDP document within each 5-source probe set. */
export const GEO_EVAL_TARGET_SLOT = 2;


/**
 * Inline citation probe — the app-facing variant of the citation-visibility
 * benchmark, designed to run right after `generatePdpGeo` inside a request.
 *
 * Differences from the frozen benchmark (`runner.ts`):
 * - Queries are derived per product (content-plan FAQ questions first, then
 *   CEP statements, then locale/category templates) instead of frozen goldens.
 * - Distractors are locale/category-parameterized templates instead of the
 *   frozen per-fixture corpus.
 * - No disk cache (texts are unique per product; serverless-safe).
 * - The score is a ONE-SHOT PAIRED diagnostic for this product — "how much
 *   better does the generated content compete for citations than the vanilla
 *   PDP text" — never a cross-product or cross-run comparison, and never a
 *   production citation-probability estimate.
 *
 * Both variants compete on identical queries, distractors, engine, and target
 * slot within one probe run, so the paired delta stays attributable to the
 * generated content alone.
 */

export type CitationProbeQuerySource = "content-plan-faq" | "content-plan-cep" | "template";

export interface CitationProbeQuery {
  query: string;
  source: CitationProbeQuerySource;
}

export interface CitationProbeContext {
  /** Generated PDP text (flattened content sections). */
  generatedText: string;
  /** Pre-generation PDP text (extracted source or normalized-product dump). */
  vanillaText: string;
  locale: string;
  category?: string;
  brand?: string;
  productName?: string;
  benefits?: string[];
  /** Preferred query source: included FAQ questions and CEP entries. */
  contentPlan?: Pick<EvalContentPlanInput, "faq" | "cep">;
  /** Enables the keypoint-coverage judge when provided. */
  evidenceLedger?: EvalEvidenceItem[];
  /** Explicit query override; skips derivation entirely. */
  queries?: string[];
  /**
   * Labeled sections of the generated text. When provided, each query result
   * additionally reports which section earned the citations (deterministic
   * lexical attribution, no extra LLM calls).
   */
  generatedSections?: AttributableSection[];
  /**
   * Image-derived sections of the generated text (one per source image URL,
   * from published-copy provenance). When provided, results additionally
   * report which image's content earned the citations — the same
   * deterministic lexical attribution as `generatedSections`.
   */
  imageSections?: AttributableSection[];
}

export interface CitationProbeOptions {
  engine: GeoEvalEngineConfig;
  /** Judge model for keypoint coverage; defaults to `engine`. */
  judge?: GeoEvalEngineConfig;
  /** Number of customer queries to probe (default 3, each costs 2 engine calls). */
  maxQueries?: number;
  /** Run the evidence keypoint-coverage judge (extra LLM calls). */
  includeUtility?: boolean;
}

export interface CitationProbeShare {
  wordpos: number;
  word: number;
  pos: number;
}

export interface CitationProbeQueryResult {
  query: string;
  querySource: CitationProbeQuerySource;
  vanilla: CitationProbeShare;
  generated: CitationProbeShare;
  delta: CitationProbeShare;
  hallucinatedCitations: number[];
  /** Which generated-content section earned the citations (when sections were provided). */
  sectionAttribution?: CitationSectionAttribution[];
  /** Which source image's content earned the citations (when image sections were provided). */
  imageAttribution?: CitationSectionAttribution[];
}

export interface CitationProbeResult {
  engineId: string;
  probedAt: string;
  queries: CitationProbeQueryResult[];
  mean: {
    vanilla: CitationProbeShare;
    generated: CitationProbeShare;
    delta: CitationProbeShare;
  };
  keypointCoverage?: KeypointCoverageScore;
  gate: UtilityGateResult;
  warnings: string[];
  /** Cross-query section attribution, weighted by each query's cited sentences. */
  sectionAttribution?: CitationSectionAttribution[];
  /** Cross-query image attribution, weighted by each query's cited sentences. */
  imageAttribution?: CitationSectionAttribution[];
  /** Fixed interpretation guard surfaced to UIs alongside the numbers. */
  interpretation: string;
}

/** Flattens the generated content sections into the engine-facing source text. */
export function buildGeneratedSourceText(sections: EvalContentSections): string {
  return [
    sections.productName,
    sections.description,
    sections.quickFacts,
    sections.benefits,
    sections.ingredients,
    sections.howToUse,
    sections.faq
  ].filter((section) => section.trim().length > 0).join("\n\n");
}

export const CITATION_PROBE_INTERPRETATION =
  "Paired one-shot diagnostic for this product only: generated vs vanilla PDP text competing on identical queries, distractors, and engine. Not a production citation-probability estimate and not comparable across products or runs.";

/** Runs the inline paired citation probe. Throws only on total failure; per-query failures degrade to warnings. */
export async function runCitationProbe(
  context: CitationProbeContext,
  options: CitationProbeOptions
): Promise<CitationProbeResult> {
  const warnings: string[] = [];
  const maxQueries = Math.max(1, options.maxQueries ?? 3);
  const probeQueries = resolveProbeQueries(context, maxQueries, warnings);
  if (probeQueries.length === 0) {
    throw new Error("Citation probe could not derive any customer query for this product.");
  }
  if (!context.generatedText.trim() || !context.vanillaText.trim()) {
    throw new Error("Citation probe requires non-empty generated and vanilla texts.");
  }

  const distractors = buildProbeDistractors(context.locale, context.category);
  const vanillaSources = insertTarget(distractors, context.vanillaText);
  const generatedSources = insertTarget(distractors, context.generatedText);

  const settled = await Promise.all(probeQueries.map(async (probeQuery): Promise<CitationProbeQueryResult | undefined> => {
    try {
      const [vanillaAnswer, generatedAnswer] = await Promise.all([
        generateEngineAnswer(options.engine, probeQuery.query, vanillaSources),
        generateEngineAnswer(options.engine, probeQuery.query, generatedSources)
      ]);
      const vanilla = scoreCitationVisibility(vanillaAnswer.answer, vanillaSources.length, GEO_EVAL_TARGET_SLOT);
      const generated = scoreCitationVisibility(generatedAnswer.answer, generatedSources.length, GEO_EVAL_TARGET_SLOT);
      const sectionAttribution = context.generatedSections && context.generatedSections.length > 0
        ? attributeCitationsToSections(generatedAnswer.answer, GEO_EVAL_TARGET_SLOT, context.generatedSections)
        : undefined;
      const imageAttribution = context.imageSections && context.imageSections.length > 0
        ? attributeCitationsToSections(generatedAnswer.answer, GEO_EVAL_TARGET_SLOT, context.imageSections)
        : undefined;
      return {
        query: probeQuery.query,
        querySource: probeQuery.source,
        vanilla: toShare(vanilla),
        generated: toShare(generated),
        delta: {
          wordpos: round(generated.wordpos - vanilla.wordpos),
          word: round(generated.word - vanilla.word),
          pos: round(generated.pos - vanilla.pos)
        },
        hallucinatedCitations: [...new Set([
          ...vanilla.shares.hallucinatedCitations,
          ...generated.shares.hallucinatedCitations
        ])].sort((a, b) => a - b),
        sectionAttribution,
        imageAttribution
      };
    } catch (error) {
      warnings.push(`Query "${probeQuery.query}" failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }));
  const queryResults = settled.filter((result): result is CitationProbeQueryResult => result !== undefined);
  if (queryResults.length === 0) {
    throw new Error(`Citation probe failed for every query. ${warnings.join(" / ")}`);
  }

  let keypointCoverage: KeypointCoverageScore | undefined;
  if (options.includeUtility) {
    const ledger = context.evidenceLedger ?? [];
    if (ledger.length === 0) {
      warnings.push("Utility judge skipped: evidence ledger is empty.");
    } else {
      try {
        keypointCoverage = (await judgeKeypointCoverage(options.judge ?? options.engine, ledger, context.generatedText)).score;
      } catch (error) {
        warnings.push(`Keypoint-coverage judge failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const mean = {
    vanilla: meanShare(queryResults.map((result) => result.vanilla)),
    generated: meanShare(queryResults.map((result) => result.generated)),
    delta: meanShare(queryResults.map((result) => result.delta))
  };

  return {
    engineId: geoEvalEngineId(options.engine),
    probedAt: new Date().toISOString(),
    queries: queryResults,
    mean,
    keypointCoverage,
    gate: evaluateUtilityGate({ visibilityDelta: mean.delta.wordpos, keypointCoverage }, PDP_COPY_UTILITY_GATE_THRESHOLDS),
    warnings,
    sectionAttribution: combineAttributions(queryResults, (result) => result.sectionAttribution),
    imageAttribution: combineAttributions(queryResults, (result) => result.imageAttribution),
    interpretation: CITATION_PROBE_INTERPRETATION
  };
}

/**
 * Combines per-query attributions into a cross-query result, weighting each
 * query by its cited-sentence count. Shared by section and image attribution
 * — `pick` selects which per-query attribution array to combine.
 */
function combineAttributions(
  queryResults: CitationProbeQueryResult[],
  pick: (result: CitationProbeQueryResult) => CitationSectionAttribution[] | undefined
): CitationSectionAttribution[] | undefined {
  const attributed = queryResults.filter((result) => {
    const attribution = pick(result);
    return attribution && attribution.length > 0;
  });
  if (attributed.length === 0) {
    return undefined;
  }
  const buckets = new Map<string, { weight: number; count: number; sentences: string[] }>();
  let totalWeight = 0;
  for (const result of attributed) {
    const attribution = pick(result) ?? [];
    const queryWeight = attribution.reduce((sum, item) => sum + item.citedSentences, 0);
    for (const item of attribution) {
      const bucket = buckets.get(item.sectionId) ?? { weight: 0, count: 0, sentences: [] };
      bucket.weight += item.share * queryWeight;
      bucket.count += item.citedSentences;
      for (const sentence of item.sentences) {
        if (bucket.sentences.length < 4 && !bucket.sentences.includes(sentence)) {
          bucket.sentences.push(sentence);
        }
      }
      buckets.set(item.sectionId, bucket);
    }
    totalWeight += queryWeight;
  }
  if (totalWeight === 0) {
    return undefined;
  }
  return [...buckets.entries()]
    .map(([sectionId, bucket]) => ({
      sectionId,
      share: round(bucket.weight / totalWeight),
      citedSentences: bucket.count,
      sentences: bucket.sentences
    }))
    .sort((a, b) => b.share - a.share);
}

// ---------------------------------------------------------------------------
// Query derivation (pure)
// ---------------------------------------------------------------------------

/**
 * Derives customer queries for the probe. Priority: explicit override >
 * content-plan FAQ questions (already customer-intent, evidence-bound) >
 * content-plan CEP entries > locale/category templates. Deduplicated,
 * capped at `maxQueries`.
 */
export function deriveProbeQueries(context: CitationProbeContext, maxQueries: number): CitationProbeQuery[] {
  const korean = isKorean(context.locale);
  const category = context.category?.trim() || (korean ? "제품" : "product");
  const queries: CitationProbeQuery[] = [];
  const seen = new Set<string>();

  const push = (query: string, source: CitationProbeQuerySource): void => {
    const trimmed = query.trim();
    const key = trimmed.toLowerCase();
    if (trimmed.length >= 8 && !seen.has(key) && queries.length < maxQueries) {
      seen.add(key);
      queries.push({ query: trimmed, source });
    }
  };

  for (const item of context.contentPlan?.faq ?? []) {
    if (item.include && item.question.trim()) {
      push(item.question, "content-plan-faq");
    }
  }

  for (const cep of context.contentPlan?.cep ?? []) {
    const need = cep.need.trim();
    if (!need) {
      continue;
    }
    const situation = cep.situation.trim();
    push(
      korean
        ? `${need}에 도움이 되는 ${category} 추천해주세요.${situation ? ` (${situation})` : ""}`
        : `Which ${category} helps with ${need}${situation ? ` (${situation})` : ""}?`,
      "content-plan-cep"
    );
  }

  const benefit = context.benefits?.find((value) => value.trim().length > 0)?.trim();
  const templates = korean
    ? [
      benefit ? `${benefit}에 좋은 ${category}는 어떤 게 있나요?` : `어떤 ${category}를 골라야 하나요?`,
      `${category}는 스킨케어 순서에서 언제 어떻게 사용하는 게 좋나요?`,
      `${category}를 고를 때 성분이나 제형에서 뭘 확인해야 하나요?`
    ]
    : [
      benefit ? `What ${category} is good for ${benefit}?` : `How do I choose a good ${category}?`,
      `How and when should I use a ${category} in my routine?`,
      `What should I check when choosing a ${category}?`
    ];
  for (const template of templates) {
    push(template, "template");
  }

  return queries;
}

function resolveProbeQueries(context: CitationProbeContext, maxQueries: number, warnings: string[]): CitationProbeQuery[] {
  if (context.queries && context.queries.length > 0) {
    return context.queries.slice(0, maxQueries).map((query) => ({ query, source: "template" as const }));
  }
  const derived = deriveProbeQueries(context, maxQueries);
  if (derived.every((query) => query.source === "template")) {
    warnings.push("No content-plan FAQ/CEP queries available; probe used generic category templates.");
  }
  return derived;
}

// ---------------------------------------------------------------------------
// Distractor templates (pure)
// ---------------------------------------------------------------------------

/**
 * Locale/category-parameterized competitor documents, mirroring the frozen
 * benchmark's style coverage: category blog / fictional competitor product
 * page (invented brand names on purpose) / marketplace listing / community
 * thread. Deterministic given (locale, category), and shared verbatim by the
 * vanilla and generated variants inside one probe run.
 */
export function buildProbeDistractors(locale: string, category?: string): string[] {
  const korean = isKorean(locale);
  const item = category?.trim() || (korean ? "제품" : "product");

  if (korean) {
    return [
      `${item} 고르는 법 총정리. 같은 ${item}(이)라도 피부 타입과 사용 상황에 따라 만족도가 크게 갈립니다. 먼저 자신의 주요 고민을 한 가지로 정리하고, 그 고민에 맞는 핵심 성분이 충분히 들어 있는지 전성분표에서 확인하세요. 사용감은 리뷰보다 샘플이나 소용량으로 직접 확인하는 것이 정확합니다. 어떤 ${item}(이)든 최소 2주 이상 꾸준히 사용해 보고 판단하는 것이 좋으며, 새 제품은 팔 안쪽에 패치 테스트 후 얼굴에 사용하는 편이 안전합니다.`,
      `루미필드 데일리 ${item}. 판테놀과 마데카소사이드, 저분자 히알루론산을 담아 데일리 사용에 부담이 없습니다. 피부과 테스트 완료, 민감성 피부 사용 가능. 아침저녁 세안 후 적당량을 부드럽게 흡수시켜 주세요. 무향, 무색소. 루미필드 — 매일의 피부 습관을 만드는 브랜드.`,
      `${item} 특가 — 재고 있음, 오늘 주문 시 내일 도착. 상품 정보: 국내 정식 수입, 사용 부위 얼굴. 함께 많이 구매한 상품: 화장솜, 수분 크림, 선크림. 포토 리뷰 작성 시 적립금 지급. 교환/반품은 미개봉 상품에 한해 7일 이내 가능합니다. 판매자 공지: 배송 지역에 따라 1-2일 지연될 수 있습니다.`,
      `커뮤니티 글: ${item} 뭐 쓰는지 궁금해요. 요즘 쓰던 게 단종돼서 갈아탈 곳을 찾는 중입니다. 댓글 1: 저는 성분 단순한 걸로 정착했어요, 이것저것 많이 든 건 오히려 안 맞더라고요. 댓글 2: 유튜버 추천템 사봤는데 저한테는 별로였어요. 결국 직접 써봐야 압니다. 댓글 3: 세일 기간에 소용량부터 사보세요. 댓글 4: 저자극이라고 광고해도 전성분은 꼭 확인하세요.`
    ];
  }

  return [
    `How to choose a ${item} that actually works for you. Start by narrowing your main concern to one thing, then check the ingredient list for actives that address it at a meaningful position. Texture preferences matter more than marketing: try a sample or travel size before committing. Give any ${item} at least two weeks of consistent use before judging results, and patch test new formulas on your inner arm first.`,
    `NovaField Daily ${item}. A gentle daily formula with panthenol, madecassoside, and low-molecular hyaluronic acid. Dermatologist tested, suitable for sensitive skin. Apply morning and evening after cleansing. Fragrance-free, no added colorants. NovaField — everyday skin habits, simplified.`,
    `${item} — In stock, ships in 1-2 business days. Product details: for facial use, imported, authenticity guaranteed by the marketplace seller program. Frequently bought together: cotton pads, moisturizer, sunscreen. Write a photo review for reward points. Returns accepted within 7 days for unopened items only.`,
    `Forum thread: What ${item} is everyone using? Mine got discontinued and I need a replacement. Reply 1: I settled on something with a short ingredient list — the kitchen-sink formulas broke me out. Reply 2: Bought an influencer pick and it did nothing for me, you really have to test yourself. Reply 3: Grab a mini size during sales before buying full size. Reply 4: "Gentle" on the label means nothing, read the full ingredient list.`
  ];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function insertTarget(distractors: string[], targetText: string): string[] {
  const sources = [...distractors];
  sources.splice(GEO_EVAL_TARGET_SLOT, 0, targetText);
  return sources;
}

function isKorean(locale: string): boolean {
  return locale.toLowerCase().startsWith("ko");
}

function toShare(score: { wordpos: number; word: number; pos: number }): CitationProbeShare {
  return { wordpos: round(score.wordpos), word: round(score.word), pos: round(score.pos) };
}

function meanShare(shares: CitationProbeShare[]): CitationProbeShare {
  const count = Math.max(1, shares.length);
  return {
    wordpos: round(shares.reduce((sum, share) => sum + share.wordpos, 0) / count),
    word: round(shares.reduce((sum, share) => sum + share.word, 0) / count),
    pos: round(shares.reduce((sum, share) => sum + share.pos, 0) / count)
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
