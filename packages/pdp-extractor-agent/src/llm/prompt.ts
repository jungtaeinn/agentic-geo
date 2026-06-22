import type { KeywordClassificationRequest } from "./types";

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
    "Return strict JSON with {\"keywords\":[{\"keyword\":\"\",\"category\":\"benefit|effect|ingredient|usage|faq|review|product|price|metric|unknown\",\"confidence\":0.0}],\"sentenceInsights\":[{\"text\":\"\",\"category\":\"benefit|effect|ingredient|usage|faq|review|product|price|metric|unknown\",\"keywords\":[\"\"],\"confidence\":0.0,\"source\":\"llm\"}],\"summary\":\"\"}.",
    "Do not invent product claims. Use only the provided user evidence text for product facts.",
    "For sentenceInsights, preserve complete source sentences or compact source-backed clauses that can improve downstream description, benefit/effect, ingredient, usage, or schema markup fields.",
    "Before creating sentenceInsights, reconstruct wrapped OCR lines into semantic sentences or paragraphs: join adjacent lines when the next line continues the same clause, noun phrase, ingredient explanation, clinical-result row, or usage instruction. Do not split only because the OCR text has a line break, missing period, or visual column wrap.",
    "Use grammar and meaning to decide boundaries: keep headings separate from body copy, join broken phrases such as ingredient names or explanatory clauses, and split only when a new claim, new label, list item, FAQ item, or full ingredients label begins.",
    "When a visual sentence connects an ingredient/technology to a benefit or effect, keep the full sentence and classify it by the strongest downstream field while listing related ingredient/effect keywords.",
    "Treat hidden PDP accordion/tab text such as Benefits, Ingredients, How to Use, Directions, Clinical Results, and FAQ as first-class product evidence when it is present in the user evidence.",
    "Use section headings as classification hints, but classify by the actual body text when the heading is generic or site-specific.",
    "Do not classify cart, purchase-layer, coupon, loyalty point, delivery, exchange, refund, return, escrow, or legal notice text as product benefit/effect/ingredient/usage evidence.",
    "For Korean PDPs, map 효능/피부 고민/상품 장점 to benefit only when the body describes skin/product value; map 효과/개선/결과 to effect; map 주요 성분/전성분/원료 to ingredient; map 사용법/사용 방법 to usage.",
    "Prefer concrete skincare evidence such as ingredients, clinical result wording, benefits, quantitative metrics, usage instructions, FAQ questions, price, and review signals.",
    "Keep claim terms and sentenceInsights close to the source wording so downstream RAG can audit them.",
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
    promptText ? `Analysis prompt:\n${truncate(promptText, 2400)}` : undefined,
    documentText
  ].filter(Boolean).join("\n\n");
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}\n[truncated]` : value;
}
