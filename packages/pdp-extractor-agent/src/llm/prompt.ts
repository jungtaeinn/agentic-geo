import type { ImageTextExtractionRequest, KeywordClassificationRequest } from "./types";

/**
 * Shared vision OCR transcription prompt. Transcription is intentionally kept
 * separate from semantic classification: the OCR pass only copies visible text
 * faithfully, and the later classification pass interprets it. Mixing the two
 * in one call measurably increases omissions and hallucinated claims.
 */
export function createImageOcrPrompt(request: ImageTextExtractionRequest): string {
  return [
    "Transcribe visible text from product detail page images for a GEO product extraction pipeline.",
    "Return strict JSON only: {\"images\":[{\"index\":1,\"imageUrl\":\"\",\"text\":\"\",\"confidence\":0.0}]}",
    "index is the 1-based image number exactly as labeled below. imageUrl is the labeled URL for that image. Never swap text between images.",
    "Transcribe every piece of readable text faithfully in natural reading order (top to bottom, left to right; finish one column before the next).",
    "Do not summarize, rewrite, translate, or infer claims. Keep the original language: Korean text stays Korean.",
    "Never complete text that is cut off, truncated, or hidden. Transcribe only what is actually visible; if a word is partially legible, transcribe the legible part only.",
    "Preserve visible line order, percentages, numeric values, units, footnote markers, row/column labels, and short headings as plain text lines.",
    "For tables, ingredient charts, clinical result images, and comparison blocks, keep each row's label and value together on one line.",
    "If an image has no readable product text, return an empty string for that image.",
    "Set confidence between 0 and 1 for each image: how legible and complete the transcription is (small, blurry, or partially cropped text lowers it).",
    `Source: ${request.source}`,
    `Product name: ${request.productName ?? "unknown"}`,
    ...request.imageUrls.map((imageUrl, index) => `Image ${index + 1}: ${imageUrl}`)
  ].join("\n");
}

export interface KeywordClassificationPromptParts {
  system: string;
  user: string;
}

/** Creates separated system/user prompts used for OCR keyword classification. */
export function createKeywordClassificationPromptParts(request: KeywordClassificationRequest): KeywordClassificationPromptParts {
  return {
    system: createKeywordClassificationSystemPrompt(request),
    user: createKeywordClassificationUserPrompt(request)
  };
}

/** Creates a compact single prompt for tests and providers without system prompt support. */
export function createKeywordClassificationPrompt(request: KeywordClassificationRequest): string {
  const prompt = createKeywordClassificationPromptParts(request);

  return [
    "System instructions:",
    prompt.system,
    "User evidence:",
    prompt.user
  ].join("\n\n");
}

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
    "Populate semanticFacts as the primary downstream contract: ingredients are ingredient or technology names, benefits/effects are consumer-facing care outcomes, skinTypes are recommended or explicitly targeted skin types, usageSteps are actionable directions only, metricClaims are measurable results with label/value/sample/period/method/caveat when present, ingredientBenefitLinks connect ingredients or technologies to outcomes only when the source states the relationship, and citations preserve explicitly cited research/article title, publisher, author, date, URL, finding, and original source text without inventing missing metadata.",
    "Use semanticFacts to express meaning, not exact visual layout. Do not hard-code product-specific terms or infer missing values. Leave arrays empty when evidence is absent.",
    "Classify before/after-use measurement rows, clinical timelines, and result tables as metric or effect, not usage. Classify usage only when the text gives an instruction such as apply, use, dispense, morning/night routine, 사용법, 사용 방법, 바르다, 도포, or 흡수.",
    "Keep claim terms and sentenceInsights source-backed so downstream RAG can audit them.",
    "The runtime RAG profile is extraction policy and classification reference, not product evidence. It can guide category decisions but must not create product facts.",
    "If runtime RAG guidance conflicts with the JSON schema, evidence-only rule, or non-product commerce exclusions, follow the stricter base instruction.",
    ragProfileText
  ].filter(Boolean).join("\n\n");
}

function createKeywordClassificationUserPrompt(request: KeywordClassificationRequest): string {
  const imageText = request.imageTexts
    .map((item, index) => `Evidence ${index + 1}: ${item.imageUrl}\n${item.text}`)
    .join("\n\n");

  return [
    "Classify the PDP evidence below.",
    `Source: ${request.source}`,
    `Product name: ${request.productName ?? "unknown"}`,
    imageText
  ].filter(Boolean).join("\n\n");
}

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

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}\n[truncated]` : value;
}
