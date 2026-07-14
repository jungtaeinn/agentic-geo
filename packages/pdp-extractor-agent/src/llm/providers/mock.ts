import type {
  KeywordClassificationRequest,
  KeywordClassificationResponse,
  KeywordClassifier
} from "../types";
import type { ClassifiedKeyword, ClassifiedSentenceInsight, GeoSemanticFacts, KeywordCategory } from "../../types";

const categoryRules: Array<[KeywordCategory, RegExp]> = [
  ["ingredient", /ginseng|panax|niacinamide|retinol|peptide|hyaluronic|ceramide|vitamin|collagen|ingredient|성분|원료|진세노믹스|인삼|펩타이드|레티놀|나이아신아마이드/i],
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
    const sentenceInsights = request.imageTexts.flatMap((item) => classifySentences(item.text));
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
    metricClaims: unique(insights.filter((item) => item.category === "metric" || /\d+(?:\.\d+)?\s*%/.test(item.text)).map((item) => item.text)).slice(0, 10).map((sentence) => ({
      sentence,
      sourceText: sentence
    })),
    evidenceSentences: unique(insights.map((item) => item.text)).slice(0, 16),
    citations: [],
    ingredientBenefitLinks: unique(insights.filter((item) => item.category === "ingredient" && /(support|help|improve|care|효능|효과|개선|케어|장벽|보습|수분)/i.test(item.text)).map((item) => item.text)).slice(0, 8).map((sentence) => ({
      sentence,
      sourceText: sentence
    }))
  };
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

function splitEvidenceSentences(text: string): string[] {
  const lines = text
    .replace(/\[[^\]]+\]\s*/g, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((item) => item.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean);
  const parts = reconstructOcrSemanticUnits(lines).flatMap(segmentSemanticUnit);

  return Array.from(new Set(parts.map((item) => item.replace(/\s+/g, " ").trim()).filter((item) => !isLikelyStandaloneOcrHeading(item))))
    .filter((item) => item.split(/\s+/).length >= 3 || /[가-힣ぁ-んァ-ン]/.test(item))
    .slice(0, 8);
}

function reconstructOcrSemanticUnits(lines: string[]): string[] {
  const units: string[] = [];
  let current = "";

  for (const line of lines) {
    if (isLikelyStandaloneOcrHeading(line)) {
      if (current) {
        units.push(current);
        current = "";
      }
      continue;
    }

    if (!current) {
      current = line;
      continue;
    }

    if (startsNewOcrSemanticUnit(current, line)) {
      units.push(current);
      current = line;
    } else {
      current = joinOcrContinuation(current, line);
    }
  }

  if (current) {
    units.push(current);
  }

  return Array.from(new Set(units.map((item) => item.trim()).filter((item) => item.length >= 12)));
}

function startsNewOcrSemanticUnit(current: string, next: string): boolean {
  if (/^(?:ingredients?|전성분|全成分)\s*:/i.test(next)) {
    return true;
  }
  if (/^(?:ingredients?|전성분|全成分)\s*:/i.test(current)) {
    return false;
  }
  if (shouldContinueOcrLine(current, next)) {
    return false;
  }
  return /[.!?。！？]$/.test(current) && /^[A-Z가-힣ぁ-んァ-ン0-9]/.test(next);
}

function shouldContinueOcrLine(current: string, next: string): boolean {
  const words = current.split(/\s+/);
  const tail = words.at(-1) ?? "";
  const twoWordTail = words.slice(-2).join(" ");
  const head = next.split(/\s+/)[0] ?? "";

  return current.endsWith("-")
    || /^[a-z]/.test(head)
    || /(?:,|:|;|\(|\[|with|and|or|of|for|to|that|which|by|from|in|on|as|is|are|was|were|into|using|including|combines?|contains?|supports?|helps?|working|enhances?)$/i.test(tail)
    || /(?:a|an|the|a potent|5 other)$/i.test(twoWordTail)
    || /^(?:and|or|with|that|which|while|working|helping|to|for|of|in|by|as|from|into|plus|including|containing)\b/i.test(next)
    || (!/[.!?。！？]$/.test(current) && !isLikelyStandaloneOcrHeading(next));
}

function joinOcrContinuation(current: string, next: string): string {
  return current.endsWith("-") ? `${current.slice(0, -1)}${next}` : `${current} ${next}`;
}

function segmentSemanticUnit(value: string): string[] {
  const parts = value
    .split(/(?<=[.!?。！？])\s+(?=[A-Z0-9"“‘'가-힣ぁ-んァ-ン])/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 12);
  return parts.length > 0 ? parts : [value];
}

function isLikelyStandaloneOcrHeading(value: string): boolean {
  const text = value.trim();
  const words = text.split(/\s+/);

  if (/^(?:ingredients?|전성분|全成分)\s*:/i.test(text) || words.length > 8 || /[.!?。！？]/.test(text)) {
    return false;
  }
  if (/\b(?:is|are|was|were|has|have|combines?|contains?|supports?|helps?|enhances?|improves?|diminish(?:es|ed)?)\b/i.test(text)) {
    return false;
  }

  return /[A-Z가-힣]/.test(text) && /(effect|ingredient|benefit|formula|peptide|ginseng|효능|효과|성분|원료)/i.test(text);
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
