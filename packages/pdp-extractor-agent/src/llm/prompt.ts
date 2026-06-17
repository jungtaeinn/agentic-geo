import type { KeywordClassificationRequest } from "./types";

/** Creates the compact model instruction used for OCR keyword classification. */
export function createKeywordClassificationPrompt(request: KeywordClassificationRequest): string {
  const imageText = request.imageTexts
    .map((item, index) => `Evidence ${index + 1}: ${item.imageUrl}\n${item.text}`)
    .join("\n\n");
  const ragProfileText = createRagProfileText(request);

  return [
    "You classify product-detail-page OCR and long-scroll section text for a GEO product extraction agent.",
    "Return strict JSON with {\"keywords\":[{\"keyword\":\"\",\"category\":\"benefit|effect|ingredient|usage|faq|review|product|price|metric|unknown\",\"confidence\":0.0}],\"summary\":\"\"}.",
    "Do not invent product claims. Use only the provided evidence text.",
    "Treat hidden PDP accordion/tab text such as Benefits, Ingredients, How to Use, Directions, Clinical Results, and FAQ as first-class product evidence when it is present in the HTML.",
    "Use section headings as classification hints, but classify by the actual body text when the heading is generic or site-specific.",
    "Do not classify cart, purchase-layer, coupon, loyalty point, delivery, exchange, refund, return, escrow, or legal notice text as product benefit/effect/ingredient/usage evidence.",
    "For Korean PDPs, map 효능/피부 고민/상품 장점 to benefit only when the body describes skin/product value; map 효과/개선/결과 to effect; map 주요 성분/전성분/원료 to ingredient; map 사용법/사용 방법 to usage.",
    "Prefer concrete skincare evidence such as ingredients, clinical result wording, benefits, quantitative metrics, usage instructions, FAQ questions, price, and review signals.",
    "Keep claim terms close to the source wording so downstream RAG can audit them.",
    ragProfileText,
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
