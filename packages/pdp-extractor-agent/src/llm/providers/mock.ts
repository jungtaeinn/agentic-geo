import type {
  KeywordClassificationRequest,
  KeywordClassificationResponse,
  KeywordClassifier
} from "../types";
import type { ClassifiedKeyword, ClassifiedSentenceInsight, GeoSemanticFacts, KeywordCategory } from "../../types";
import { parseOcrBlockSections, segmentItemSentences } from "../../ocr-block-structure";

const categoryRules: Array<[KeywordCategory, RegExp]> = [
  ["ingredient", /ginseng|panax|niacinamide|retinol|peptide|hyaluronic|ceramide|vitamin|collagen|ingredient|성분|원료|보태니컴플렉스|인삼|펩타이드|레티놀|나이아신아마이드/i],
  ["benefit", /hydration|moisture|moisturizing|soothing|brightening|firming|anti-aging|radiance|elasticity|resilience|barrier|보습|수분|진정|미백|탄력|광채|장벽|영양|고밀도|자생력|피부/i],
  ["effect", /effect|improve|improvement|enhance|enhances|reduce|diminish|care|wrinkle|wrinkles|fine|lines|firmness|firmer|elasticity|resilience|texture|lift|효과|개선|완화|케어|주름|피부결/i],
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
    const sentenceInsights = request.imageTexts.flatMap((item, index) =>
      classifySentences(item.text).map((insight) => ({ ...insight, evidenceIndex: index + 1 }))
    );
    const semanticFacts = semanticFactsFromInsights(sentenceInsights);

    return {
      keywords,
      sentenceInsights,
      semanticFacts,
      summary: keywords.length > 0 ? "Mock OCR keyword classification completed." : "No OCR keywords found."
    };
  }
}

function semanticFactsFromInsights(insights: ClassifiedSentenceInsight[]): GeoSemanticFacts {
  return {
    ingredients: unique(insights.filter((item) => item.category === "ingredient").flatMap((item) => item.keywords.length > 0 ? item.keywords : [item.text])).slice(0, 12),
    benefits: unique(insights.filter((item) => item.category === "benefit").map((item) => item.text)).slice(0, 12),
    effects: unique(insights.filter((item) => item.category === "effect").map((item) => item.text)).slice(0, 12),
    skinTypes: unique(insights.flatMap((item) => extractSkinTypePhrases(item.text))).slice(0, 8),
    usageSteps: unique(insights.filter((item) => item.category === "usage").map((item) => item.text)).slice(0, 8),
    metricClaims: dedupeByText(insights.filter((item) => item.category === "metric" || /\d+(?:\.\d+)?\s*%/.test(item.text))).slice(0, 10).map((insight) => ({
      sentence: insight.text,
      sourceText: insight.text,
      ...(insight.evidenceIndex !== undefined ? { evidenceIndex: insight.evidenceIndex } : {})
    })),
    evidenceSentences: unique(insights.map((item) => item.text)).slice(0, 16),
    citations: [],
    ingredientBenefitLinks: dedupeByText(insights.filter((item) => item.category === "ingredient" && /(support|help|improve|care|효능|효과|개선|케어|장벽|보습|수분)/i.test(item.text))).slice(0, 8).map((insight) => ({
      sentence: insight.text,
      sourceText: insight.text,
      ...(insight.evidenceIndex !== undefined ? { evidenceIndex: insight.evidenceIndex } : {})
    }))
  };
}

/** text 기준 첫 인사이트만 남기는 dedupe 헬퍼 — evidenceIndex를 보존하기 위해 원본 인사이트 객체를 유지한다. */
function dedupeByText(items: ClassifiedSentenceInsight[]): ClassifiedSentenceInsight[] {
  const seen = new Set<string>();
  return items.filter((item) => (seen.has(item.text) ? false : (seen.add(item.text), true)));
}

function extractSkinTypePhrases(value: string): string[] {
  return [
    /dry\s+(?:or\s+sensitive\s+)?skin/i.test(value) ? value.match(/dry\s+(?:or\s+sensitive\s+)?skin/i)?.[0] : undefined,
    /sensitive\s+skin/i.test(value) ? "sensitive skin" : undefined,
    /건조\s*피부(?:\s*또는\s*민감\s*피부)?/.test(value) ? value.match(/건조\s*피부(?:\s*또는\s*민감\s*피부)?/)?.[0]?.replace(/\s+/g, " ") : undefined,
    /민감\s*피부/.test(value) ? "민감 피부" : undefined
  ].filter((item): item is string => Boolean(item));
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

function classifySentences(text: string): ClassifiedSentenceInsight[] {
  return splitEvidenceSentences(text).flatMap((sentence): ClassifiedSentenceInsight[] => {
    const keywords = classifyText(sentence).filter((keyword) => keyword.category !== "unknown");
    const category = dominantCategory(keywords);

    if (!category || category === "unknown") {
      return [];
    }

    return [{
      text: sentence,
      category,
      keywords: Array.from(new Set(keywords.map((keyword) => keyword.keyword))).slice(0, 8),
      confidence: 0.72,
      source: "mock"
    }];
  }).slice(0, 18);
}

/**
 * 근거 문장 분해. 절 관계 복원은 공용 파서(ocr-block-structure)가 단독으로
 * 책임진다 — 같은 규칙을 목업에 한 벌 더 두면 한쪽만 갱신되어 목업이 실제
 * 파이프라인과 다른 구조를 내놓는다(실제로 그렇게 갈라져 있었다).
 */
function splitEvidenceSentences(text: string): string[] {
  const items = parseOcrBlockSections(text.replace(/\[[^\]]+\]\s*/g, ""))
    .flatMap((section) => section.items.flatMap((item) => segmentItemSentences(item.text)));

  return Array.from(new Set(items.map((item) => item.replace(/\s+/g, " ").trim())))
    .filter((item) => item.length >= 6)
    .filter((item) => item.split(/\s+/).length >= 3 || /[가-힣ぁ-んァ-ン]/.test(item))
    .slice(0, 8);
}

function dominantCategory(keywords: ClassifiedKeyword[]): KeywordCategory | undefined {
  const ranked = new Map<KeywordCategory, number>();

  for (const keyword of keywords) {
    ranked.set(keyword.category, (ranked.get(keyword.category) ?? 0) + keyword.confidence);
  }

  return [...ranked.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}
