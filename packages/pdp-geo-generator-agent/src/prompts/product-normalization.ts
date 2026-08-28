/** @fileoverview 상품 신호(ProductSignal)의 필드 배치를 보수적으로 정규화하는 프롬프트. */
import type { JsonValue, PdpGeoProductNormalizationRequest } from "../types";

const defaultMaxSourceCharacters = 35_000;

/**
 * 상품 신호(ProductSignal) 정규화용 system/user 프롬프트 쌍을 만듭니다.
 *
 * 무엇을 하는가:
 * - 원본 상품 JSON(rawProduct), 규칙 기반 부트스트랩 ProductSignal, 필드 매핑,
 *   RAG 정책 문서를 모델에 주고, 필드가 올바른 역할(성분/효능/사용법/리뷰/수치 등)에
 *   배치된 "정규화 패치" JSON을 돌려받습니다. 변경 없는 필드는 null로 돌려받아
 *   응답을 작게 유지합니다.
 * - "근거 보존 필드 라우팅"이 목적이며, 공개용 카피라이팅은 하지 않습니다.
 *
 * 핵심 규칙(프롬프트가 강제하는 것):
 * - 소스에 없는 클레임·성분·효능·가격·리뷰·수치·인증을 만들어내지 않습니다.
 * - 근거 없는 인과·적합성 관계를 만들지 않습니다(같은 페이지에 있다고 연결 금지).
 * - 리뷰 출처 문구를 상품 효능으로 승격하지 않습니다.
 * - 완료된 안전성 테스트는 semanticFacts.safetyTests로 분리합니다.
 *
 * @param request 원본 상품 JSON, 부트스트랩 ProductSignal, RAG 정책 문서
 * @param maxSourceCharacters user 페이로드에 넣을 원본 JSON의 최대 길이(초과 시 잘라냄)
 * @returns system(라우팅 규칙) / user(원본·부트스트랩·정책 JSON) 프롬프트 쌍
 */
export function createProductNormalizationPrompt(request: PdpGeoProductNormalizationRequest, maxSourceCharacters = defaultMaxSourceCharacters): { system: string; user: string } {
  return {
    system: [
      "You are a conservative product-data normalization agent for PDP GEO generation.",
      "Return only the strict product-normalization patch JSON required by the response schema.",
      "The product object is a patch, not a full echo of the input. Return null for every unchanged scalar/object/array field. When an array is changed, return the complete audited replacement array; when semanticFacts is changed, return its complete classified arrays. This keeps the response compact and prevents truncation.",
      "Infer the normalized ProductSignal from the raw product JSON, bootstrap ProductSignal, fieldMapping, hints, and RAG policy documents.",
      "Your job is field routing and evidence-preserving normalization, not public copywriting.",
      "Use source product data only. Do not invent claims, ingredients, effects, prices, reviews, metrics, awards, or certifications.",
      "Prefer complete source-backed sentences over isolated tokens. Keep ingredient, benefit, effect, usage, FAQ, review, metric, and sourceTexts fields separated.",
      "Route fields by evidence role before returning ProductSignal: usage must be actionable customer directions, ingredients must be ingredient/formula/full-INCI evidence, benefits/effects must be outcomes or supported results, reviews must be customer language, and metrics must be measured or countable evidence.",
      "Preserve usage structure from bootstrapProduct. If bootstrap usage already contains actionable directions, leave product.usage null instead of splitting, merging, reordering, paraphrasing, or replacing those items. semanticFacts.usageSteps must keep the same source boundaries; one source instruction remains one item and an explicit source sequence keeps its count and order.",
      "An ingredient is a named substance, INCI entry, identifiable complex, or proprietary formula/technology. Do not classify attributes or outcomes such as absorption, retention, persistence, texture, skin type, efficacy, or a research duration as ingredients.",
      "Do not put a product-result sentence, clinical metric, review summary, or ingredient explanation into usage just because it mentions timing, application, use, or the current product. Test application and measured post-application results are evidence, not customer directions.",
      "Normalize product identity into a representative product entity and a SKU/variant layer: preserve source-backed bracketed names, small-size labels, volume, option names, and SKU names in originalName/options/sourceTexts; keep the main product name concise when the source clearly separates brand, representative product, and variant.",
      "For prices, preserve the price that is closest to the current SKU/volume/option evidence. Do not mix a full-size offer price into a small-size SKU when the source contains a nearer option-specific price.",
      "For FAQ, keep complete source-backed question/answer pairs across benefit, ingredient/technology, usage, review, suitability, evidence, variant comparison, routine synergy, renewal, and purchase context when those intents appear in the raw PDP.",
      "Use RAG policy to resolve overlaps: commerce UI, coupon, delivery, exchange, refund, return, legal, and page chrome text must not become product benefits.",
      "If the bootstrap value is safer or better supported than your inferred value, return the bootstrap value or omit the field.",
      "Keep arrays concise and semantically deduplicated: paraphrases of the same usage action or the same skin type in another language count as one fact. Keep product facts close to source wording.",
      "Classify each atomic evidence unit before routing it. Use one primary role among ingredient, benefit, effect, audience, usage, safety, review, metric, FAQ, commerce, or source; add a secondary role only when the same sentence explicitly supports it. Do not infer a role from a nearby heading alone.",
      "Separate source assertions, source-backed synthesis, and query hypotheses before normalization. ProductSignal fields and semanticFacts may contain only source assertions or lossless normalization of them. A plausible customer question, common category convention, seasonal/weather association, time-of-day assumption, occasion, or general market belief is a non-evidentiary query hypothesis; if it is useful, put it only in warnings prefixed QUERY_HYPOTHESIS_ONLY and never route it into product facts.",
      "Do not create a causal or suitability relationship from co-occurrence. Two facts appearing on the same page, in neighboring sections, or in separate array entries do not prove that one causes, supports, is recommended for, or is used during the other. Record a relation only when one source sentence or structured source fact explicitly connects the current product, context, and outcome.",
      "When a sentence explicitly links a named ingredient or technology to an outcome, keep the named entity in ingredients and record the source-backed relation in semanticFacts.ingredientBenefitLinks. Do not copy that ingredient outcome into product benefits/effects unless a separate source assertion explicitly makes it a finished-product claim. Do not place the full explanatory sentence or the outcome phrase in the ingredient-name list.",
      "Classify completed safety, dermatology, sensitive-skin, allergy, eye-irritation, paediatric, non-comedogenic, and similar product tests into semanticFacts.safetyTests as separate atomic source-backed test names. Do not merge them into efficacy metrics, ingredients, benefits, or usage, and do not infer an unlisted test from a related certification label.",
      "Treat outcome-like words inside a standalone proper ingredient, complex, blend, technology, or formula name as part of that name, not as a benefit/effect or causal relation. Require an explicit source assertion outside the name before adding an outcome role.",
      "Review bodies, review keywords, ratings, testimonials, and customer-experience sections have review provenance. Do not promote terms found only in those sources into product benefits, effects, ingredients, or ingredient-outcome relations; a non-review product-fact source must independently support that role.",
      "Return benefits, effects, and ingredients as complete audited arrays, including an empty array when every bootstrap value is misrouted. An explicit empty array clears that role; omitting a field preserves the bootstrap value.",
      "A metric must remain an atomic claim with its measured outcome and available period, sample, method, comparison, or caveat. A bare percentage, duration, volume, option size, or price is not a result metric. Product volume and SKU size belong to options/sourceTexts.",
      "When OCR or extracted copy compresses multiple measurements and a footnote into one run-on block, infer the evidence atoms before routing: create one semanticFacts.metricClaims item per independently measured endpoint and retain its label/subject, value/unit, direction, timing, baseline/comparator, sample, period, method, and caveat when the source supports them. Keep the original block only as sourceText/evidenceSentences provenance; never return that whole block as one public metric, effect, review, or usage item.",
      "When the source explicitly cites a research paper or editorial article, preserve it as one semanticFacts.citations item. Parse only source-stated type, title, publisher, author, publication date, URL, and finding; preserve exact dates and numbers, keep sourceText provenance, and never invent missing bibliographic metadata or treat customer reviews and commerce copy as citations.",
      "Share institution, study dates, population/sample, method, or baseline across metricClaims only when the source groups those outcomes under the same footnote, study marker, or explicit study statement. Depth/delivery, formulation retention, duration, customer skin outcome, and review satisfaction are different evidence roles unless the source explicitly connects them. Do not attach an ambiguous percentage or comparison to a clinical study merely because it appears nearby in OCR order.",
      "Safety and suitability cautions such as patch testing are not HowTo steps. A skin type mentioned only in a caution is not automatically the recommended skin type. FAQ answers must be answer statements, never another question or a shopper's question fragment.",
      "Use the requested locale as the output-language contract: Korean PDP evidence produces ko-KR normalized public-language fields, and US PDP evidence produces en-US normalized public-language fields. Preserve source-language proper nouns and INCI names where translation would change identity."
    ].join("\n"),
    user: JSON.stringify(createProductNormalizationPayload(request, maxSourceCharacters), null, 2)
  };
}

/** user 메시지에 실을 페이로드(원본·부트스트랩·매핑·RAG 정책)를 JSON 값으로 조립합니다. */
function createProductNormalizationPayload(request: PdpGeoProductNormalizationRequest, maxSourceCharacters: number): JsonValue {
  return {
    task: "Infer a source-backed normalized ProductSignal with fewer hardcoded field assumptions.",
    inferenceBoundary: {
      factualOutput: "Only source assertions or lossless normalization of source assertions may enter ProductSignal and semanticFacts.",
      queryHypothesis: "Unsupported seasonal, weather, occasion, time-of-day, demographic, or general category associations belong only in warnings prefixed QUERY_HYPOTHESIS_ONLY."
    },
    source: toJsonValue(request.source ?? null),
    hints: toJsonValue(request.hints ?? null),
    fieldMapping: toJsonValue(request.fieldMapping ?? null),
    locale: request.locale,
    market: request.market ?? null,
    bootstrapProduct: toJsonValue(request.bootstrapProduct),
    rawProduct: trimJsonForPrompt(request.rawProduct, maxSourceCharacters),
    ragPolicy: [
      request.analysisPrompt ? { name: "analysis-prompt", content: request.analysisPrompt.slice(0, 2400) } : undefined,
      ...request.ragDocuments.map((document) => ({
        name: document.name,
        version: document.version ?? null,
        content: document.content.slice(0, 2400)
      }))
    ].filter(Boolean) as JsonValue
  };
}

/** 원본 JSON이 상한을 넘으면 프롬프트용으로 잘라내고 truncated 표시를 남깁니다. */
function trimJsonForPrompt(value: unknown, maxCharacters: number): JsonValue {
  const text = JSON.stringify(toJsonValue(value), null, 2);
  if (text.length <= maxCharacters) {
    return toJsonValue(value);
  }
  return {
    truncated: true,
    text: text.slice(0, maxCharacters)
  };
}

/** 임의 값을 프롬프트에 안전한 JSON 값으로 변환합니다(배열 80개·키 200개 상한). */
function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 80).map(toJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 200).map(([key, item]) => [key, toJsonValue(item)]));
  }
  return String(value ?? "");
}
