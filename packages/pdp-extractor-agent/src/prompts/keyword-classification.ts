/** @fileoverview OCR 전사 텍스트를 상품 근거(효능/성분/사용법 등)로 분류하는 프롬프트. */
import type { KeywordClassificationRequest } from "../llm/types";

export interface KeywordClassificationPromptParts {
  system: string;
  user: string;
}

/**
 * OCR로 옮겨 적은 상품 상세 텍스트를 "의미 있는 상품 근거"로 분류하는
 * system/user 분리형 프롬프트 쌍을 만듭니다.
 *
 * 무엇을 하는가:
 * - image-ocr 프롬프트가 전사한 텍스트(및 롱스크롤 섹션 텍스트)를 입력으로 받아,
 *   키워드를 효능/효과/성분/사용법/FAQ/리뷰/가격/수치 카테고리로 분류하고,
 *   문장 단위 인사이트와 semanticFacts(성분-효능 연결, 수치 클레임, 인용 등)를
 *   엄격한 JSON으로 돌려받습니다.
 * - 이 결과가 다운스트림의 상품 설명·FAQ·스키마 마크업 생성의 근거 원장
 *   (evidence ledger)이 됩니다.
 *
 * 핵심 규칙(프롬프트가 강제하는 것):
 * - 근거 없는 상품 클레임 생성 금지 — 입력으로 준 텍스트만 사실의 출처가 됩니다.
 * - OCR 줄바꿈으로 끊긴 문장은 의미 단위로 복원한 뒤 분류합니다.
 * - 장바구니/배송/환불 같은 커머스 UI 문구는 상품 근거로 분류하지 않습니다.
 * - 신뢰도(confidence)가 낮은 전사에서 나온 수치는 수치 클레임으로 승격하지 않습니다.
 * - 런타임 RAG 프로필(정책 문서)은 분류 참고용일 뿐, 상품 사실을 만들 수 없습니다.
 *
 * @param request OCR 전사 결과, 상품명/출처, 런타임 RAG 정책 문서
 * @returns system(분류 규칙·JSON 계약) / user(실제 OCR 근거) 프롬프트 쌍
 */
export function createKeywordClassificationPromptParts(request: KeywordClassificationRequest): KeywordClassificationPromptParts {
  return {
    system: createKeywordClassificationSystemPrompt(request),
    user: createKeywordClassificationUserPrompt(request)
  };
}

/**
 * system 프롬프트를 지원하지 않는 프로바이더와 테스트를 위해
 * system/user를 하나로 합친 단일 프롬프트를 만듭니다.
 *
 * @param request OCR 전사 결과, 상품명/출처, 런타임 RAG 정책 문서
 * @returns system 지시와 user 근거가 합쳐진 단일 프롬프트 문자열
 */
export function createKeywordClassificationPrompt(request: KeywordClassificationRequest): string {
  const prompt = createKeywordClassificationPromptParts(request);

  return [
    "System instructions:",
    prompt.system,
    "User evidence:",
    prompt.user
  ].join("\n\n");
}

/** 분류 규칙·출력 JSON 계약·RAG 프로필을 결합한 system 지시문을 만듭니다. */
function createKeywordClassificationSystemPrompt(request: KeywordClassificationRequest): string {
  const ragProfileText = createRagProfileText(request);

  return [
    "You classify product-detail-page OCR and long-scroll section text for a GEO product extraction agent.",
    "Return strict JSON with {\"keywords\":[{\"keyword\":\"\",\"category\":\"benefit|effect|ingredient|usage|faq|review|product|price|metric|unknown\",\"confidence\":0.0}],\"sentenceInsights\":[{\"text\":\"\",\"category\":\"benefit|effect|ingredient|usage|faq|review|product|price|metric|unknown\",\"keywords\":[\"\"],\"confidence\":0.0,\"source\":\"llm\",\"semanticFacts\":{}}],\"semanticFacts\":{\"ingredients\":[\"\"],\"benefits\":[\"\"],\"effects\":[\"\"],\"skinTypes\":[\"\"],\"usageSteps\":[\"\"],\"metricClaims\":[{\"label\":\"\",\"subject\":\"\",\"value\":\"\",\"unit\":\"\",\"timing\":\"\",\"period\":\"\",\"sample\":\"\",\"method\":\"\",\"caveat\":\"\",\"sentence\":\"\",\"sourceText\":\"\"}],\"evidenceSentences\":[\"\"],\"ingredientBenefitLinks\":[{\"ingredient\":\"\",\"benefit\":\"\",\"effect\":\"\",\"sentence\":\"\",\"sourceText\":\"\"}],\"citations\":[{\"type\":\"research|article\",\"title\":\"\",\"publisher\":\"\",\"author\":\"\",\"publishedAt\":\"\",\"url\":\"\",\"finding\":\"\",\"sourceText\":\"\"}]},\"summary\":\"\"}.",
    "Do not invent product claims. Use only the provided user evidence text for product facts.",
    "For sentenceInsights, return source-backed semantic evidence statements, not raw OCR dumps. Reconstruct the meaning of the OCR copy into concise product facts that can improve downstream description, benefit/effect, ingredient, usage, metric, FAQ, or schema markup fields.",
    "Each sentenceInsight.text should explain what the OCR sentence means for the product: connect ingredient/technology + benefit/effect/customer selection criterion when the source supports that connection. Keep important claim terms, numbers, time windows, sample/target wording, and ingredient names close enough to the source for audit.",
    "Do not include internal/source phrases such as OCR, image, visual, product detail, 상품 상세, 근거, evidence, source, or 설명은 in public sentenceInsights unless those exact words are part of a consumer-facing product claim.",
    "Before creating sentenceInsights, reconstruct wrapped OCR lines into semantic sentences or paragraphs: join adjacent lines when the next line continues the same clause, noun phrase, ingredient explanation, clinical-result row, or usage instruction. Do not split only because the OCR text has a line break, missing period, or visual column wrap.",
    "Use grammar and meaning to decide boundaries: keep headings separate from body copy, join broken phrases such as ingredient names or explanatory clauses, and split only when a new claim, new label, list item, FAQ item, or full ingredients label begins.",
    "When a visual sentence connects an ingredient/technology to a benefit or effect, keep the full sentence and classify it by the strongest downstream field while listing related ingredient/effect keywords.",
    "Ignore image alt/caption/nearby text when it only describes a model, scene, product shot, layout, or image placement. Sentence insights must be citation-ready product facts, metrics, ingredients, benefits, effects, usage, FAQ, or review evidence.",
    "Treat hidden PDP accordion/tab text such as Benefits, Ingredients, How to Use, Directions, Clinical Results, and FAQ as first-class product evidence when it is present in the user evidence.",
    "Use section headings as classification hints, but classify by the actual body text when the heading is generic or site-specific.",
    "Do not classify cart, purchase-layer, coupon, loyalty point, delivery, exchange, refund, return, escrow, or legal notice text as product benefit/effect/ingredient/usage evidence.",
    "For Korean PDPs, map 효능/피부 고민/상품 장점 to benefit only when the body describes skin/product value; map 효과/개선/결과 to effect; map 주요 성분/전성분/원료 to ingredient; map 사용법/사용 방법 to usage.",
    "Prefer concrete skincare evidence such as ingredients, clinical result wording, benefits, quantitative metrics, usage instructions, FAQ questions, price, and review signals.",
    "For quantitative claims, preserve the exact metric and period shown in the OCR text; include sample size, respondent group, test target, or measurement timing only when the evidence text provides it. Never convert a percentage into 'agreed' unless the source explicitly says agreed or equivalent survey consent wording.",
    "Some evidence blocks carry a transcription confidence between 0 and 1 measuring how legibly the OCR pass could read the source image. Treat numbers, percentages, and units from low-confidence evidence (below 0.6) as unreliable: do not promote them into metricClaims or quantitative sentenceInsights unless the same value also appears in higher-confidence evidence, and lower the confidence of any keyword or insight built from that evidence.",
    "Populate semanticFacts as the primary downstream contract: ingredients are ingredient or technology names, benefits/effects are consumer-facing care outcomes, skinTypes are recommended or explicitly targeted skin types, usageSteps are actionable directions only, metricClaims are measurable results with label/value/sample/period/method/caveat when present, ingredientBenefitLinks connect ingredients or technologies to outcomes only when the source states the relationship, and citations preserve explicitly cited research/article title, publisher, author, date, URL, finding, and original source text without inventing missing metadata.",
    "Use semanticFacts to express meaning, not exact visual layout. Do not hard-code product-specific terms or infer missing values. Leave arrays empty when evidence is absent.",
    "Classify before/after-use measurement rows, clinical timelines, treatment/control labels such as 제품 사용/무도포, and result tables as metric or effect, not usage. Classify usage only when the text is an actionable customer direction: a sentence that tells the customer when, where, how, or how often to use the product. Judge by the directive function of the sentence, not by a fixed verb list, so any application method the dosage form requires (spreading, spraying, rinsing, wiping, and so on) qualifies equally. An explicitly numbered usage sequence (사용법 1 ... 2 ...) is ordered usage steps; keep one source instruction per step and preserve the source numbering and order.",
    "Keep claim terms and sentenceInsights source-backed so downstream RAG can audit them.",
    "The runtime RAG profile is extraction policy and classification reference, not product evidence. It can guide category decisions but must not create product facts.",
    "If runtime RAG guidance conflicts with the JSON schema, evidence-only rule, or non-product commerce exclusions, follow the stricter base instruction.",
    ragProfileText
  ].filter(Boolean).join("\n\n");
}

/** 분류 대상 OCR 근거 텍스트(이미지별, 전사 신뢰도 포함)를 user 메시지로 만듭니다. */
function createKeywordClassificationUserPrompt(request: KeywordClassificationRequest): string {
  const imageText = request.imageTexts
    .map((item, index) => {
      const confidenceLabel = item.confidence !== undefined
        ? ` (transcription confidence: ${item.confidence.toFixed(2)})`
        : "";
      return `Evidence ${index + 1}${confidenceLabel}: ${item.imageUrl}\n${item.text}`;
    })
    .join("\n\n");

  return [
    "Classify the PDP evidence below.",
    `Source: ${request.source}`,
    `Product name: ${request.productName ?? "unknown"}`,
    imageText
  ].filter(Boolean).join("\n\n");
}

/**
 * 런타임 RAG 프로필(분석 프롬프트 + 검색된 정책 문서)을 system 지시문 꼬리에
 * 붙일 텍스트로 만듭니다. 정책이 없으면 빈 문자열을 돌려 해당 블록을 생략합니다.
 */
function createRagProfileText(request: KeywordClassificationRequest): string {
  const documents = (request.ragDocuments ?? []).slice(0, 8);
  const documentText = documents
    .map((document, index) => [
      `RAG document ${index + 1}: ${document.name}`,
      truncate(document.content, 1800)
    ].join("\n"))
    .join("\n\n");
  const promptText = request.analysisPrompt?.trim();

  if (!promptText && !documentText) {
    return "";
  }

  return [
    "Runtime RAG profile. Treat these instructions as product extraction policy and classification reference.",
    "Each retrieved chunk may include Kind, Intents, and Field targets. Use those routing hints to resolve overlapping rules and to keep missing/unsupported fields out of public product facts.",
    promptText ? `Analysis prompt:\n${truncate(promptText, 2400)}` : undefined,
    documentText
  ].filter(Boolean).join("\n\n");
}

/** 프롬프트에 싣는 정책 문서·분석 프롬프트가 과도하게 길어지지 않도록 자릅니다. */
function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}\n[truncated]` : value;
}
