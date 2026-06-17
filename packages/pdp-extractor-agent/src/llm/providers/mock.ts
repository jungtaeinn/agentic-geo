import type {
  KeywordClassificationRequest,
  KeywordClassificationResponse,
  KeywordClassifier
} from "../types";
import type { ClassifiedKeyword, KeywordCategory } from "../../types";

const categoryRules: Array<[KeywordCategory, RegExp]> = [
  ["ingredient", /ginseng|panax|niacinamide|retinol|peptide|hyaluronic|ceramide|vitamin|collagen|ingredient|성분|원료|진세노믹스|인삼|펩타이드|레티놀|나이아신아마이드/i],
  ["benefit", /hydration|moisture|moisturizing|soothing|brightening|firming|anti-aging|radiance|elasticity|resilience|barrier|보습|수분|진정|미백|탄력|광채|장벽|영양|고밀도|자생력|피부/i],
  ["effect", /effect|improve|improvement|reduce|diminish|care|wrinkle|wrinkles|fine|lines|firmness|texture|lift|효과|개선|완화|케어|주름|피부결/i],
  ["usage", /use|apply|morning|night|ritual|pump|face|neck|사용|도포|아침|저녁|루틴|펌프|주의/i],
  ["faq", /\?|faq|question|answer|what|how|can|자주|질문|답변/i],
  ["review", /review|rating|customer|stars|agreed|showed|리뷰|평점|고객|만족/i],
  ["metric", /\b\d+(?:\.\d+)?\s?%|\b\d+(?:\.\d+)?\s?(?:ml|mL|oz|fl\.?\s?oz|weeks?|days?|hours?|stars?|점|개|명|회|주|일|시간|퍼센트)\b/i],
  ["price", /₩|원|\$|price|sale|discount|가격|할인/i]
];

/** Deterministic classifier used in tests and GitHub Pages mock mode. */
export class MockKeywordClassifier implements KeywordClassifier {
  async classifyKeywords(request: KeywordClassificationRequest): Promise<KeywordClassificationResponse> {
    const keywords = request.imageTexts.flatMap((item) => classifyText(item.text));

    return {
      keywords,
      summary: keywords.length > 0 ? "Mock OCR keyword classification completed." : "No OCR keywords found."
    };
  }
}

function classifyText(text: string): ClassifiedKeyword[] {
  const terms = Array.from(new Set(text.split(/[\s,./|·()[\]{}<>:;!]+/).map((term) => term.trim()).filter(Boolean)))
    .filter((term) => term.length >= 2)
    .slice(0, 18);

  return terms.map((keyword) => ({
    keyword,
    category: categoryRules.find(([, pattern]) => pattern.test(keyword))?.[0] ?? "unknown",
    confidence: 0.72,
    source: "ocr"
  }));
}
