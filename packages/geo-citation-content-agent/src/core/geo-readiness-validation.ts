import type {
  GeoCitationContentBrief,
  GeoCitationNormalizedProduct,
  GeoCitationReadinessCheck,
  GeoCitationReadinessReport,
  RedditCitationArtifact
} from "../types";

const promoPattern = /\b(buy now|shop now|limited offer|link in bio|affiliate link)\b|지금\s*구매|바로\s*구매|링크를\s*확인/i;
const caveatPattern = /\b(caveat|careful|skeptical|limitation|uncertain|directional|not definitive|not a guarantee|not guarantee|not guaranteed|do not prove|does not prove|not proof|before trusting)\b|주의|한계|조심|불확실|단정|검증/i;
const evidencePattern = /\b(evidence|supported|verify|source|claim|review|paper|news|study|signal)\b|근거|검증|리뷰|논문|뉴스|출처/i;
const comparisonPattern = /\b(compare|comparison|alternative|against|versus|vs|worth comparing)\b|비교|대안|대체/i;
const reviewPattern = /\b(review|user signal|user signals|reviewer|reviewers)\b|리뷰|후기/i;
const strongerSourcePattern = /\b(paper|news|study|stronger source|stronger sources|external reference)\b|논문|뉴스|연구|외부\s*근거/i;
const freshnessPattern = /\b(as of|available as of|recent|fresh|observed|published|202\d|20\d{2}-\d{2}-\d{2})\b|최근|기준|게시|확인/i;

export function evaluateGeoCitationReadiness(input: {
  artifact: RedditCitationArtifact;
  brief: GeoCitationContentBrief;
  product: GeoCitationNormalizedProduct;
}): GeoCitationReadinessReport {
  const text = `${input.artifact.title}\n${input.artifact.bodyMarkdown}`;
  const normalizedText = normalizeText(text);
  const bulletCount = countBullets(input.artifact.bodyMarkdown);
  const requiredKeywords = createRequiredKeywords(input.product, input.brief);
  const present = requiredKeywords.filter((keyword) => keywordIsPresent(keyword, normalizedText));
  const missing = requiredKeywords.filter((keyword) => !present.includes(keyword));
  const keywordCoverageRatio = requiredKeywords.length > 0 ? present.length / requiredKeywords.length : 1;
  const checks: GeoCitationReadinessCheck[] = [
    {
      id: "answer-ready-title",
      label: "Answer-ready title",
      passed: (/[?？]/.test(input.artifact.title) || /\b(looked|noticed|compared|who would|is .+ worth)\b/i.test(input.artifact.title)) && mentionsPrimaryEntity(input.artifact.title, input.product),
      weight: 1,
      message: "Title should be a question, comparison, or research observation that includes the product or category entity."
    },
    {
      id: "short-version-chunks",
      label: "Chunkable short version",
      passed: /short version|tl;dr|요약/i.test(input.artifact.bodyMarkdown) && bulletCount >= 2,
      weight: 1,
      message: "Body should include a compact summary section with at least two bullet-style answer chunks."
    },
    {
      id: "tldr-position",
      label: "TL;DR near the top",
      passed: tldrNearTop(input.artifact.bodyMarkdown),
      weight: 0.6,
      message: "The TL;DR/short-version block should appear within the first part of the body so readers and answer engines can extract it without scrolling."
    },
    {
      id: "claim-evidence-language",
      label: "Claim/evidence language",
      passed: evidencePattern.test(text),
      weight: 1,
      message: "Body should use explicit supported/evidence/verify/review/source language so answer engines can identify grounded claims."
    },
    {
      id: "quotation-or-statistic",
      label: "Direct quotation or statistic",
      passed: quotationOrStatisticPasses(input.artifact.bodyMarkdown, input.brief),
      weight: 0.7,
      message: "When quotable evidence or source-backed statistics are available, the body should include a verbatim quote or a concrete number — both improve citation visibility."
    },
    {
      id: "source-type-separation",
      label: "Source type separation",
      passed: sourceSeparationPasses(text, input.brief),
      weight: 0.9,
      message: "Body should distinguish product claims, reviews, and stronger sources such as papers or news when those sources are available."
    },
    {
      id: "caveat-limitation",
      label: "Caveat or limitation",
      passed: caveatPattern.test(text),
      weight: 1,
      message: "Body should include caveats, limitations, or careful language near strong claims."
    },
    {
      id: "comparison-context",
      label: "Comparison context",
      passed: comparisonPattern.test(text) || input.brief.comparisonPoints.length > 0 && /worth comparing|비교/i.test(text),
      weight: 0.85,
      message: "Body should include comparison or alternative context instead of only describing the product."
    },
    {
      id: "community-question",
      label: "Open community question",
      passed: input.artifact.bodyMarkdown.trim().endsWith("?") || input.artifact.commentSeeds.some((seed) => /[?？]$/.test(seed.trim())),
      weight: 0.75,
      message: "Reddit artifact should invite community correction, comparison, or firsthand perspective."
    },
    {
      id: "anti-promo",
      label: "Anti-promo safety",
      passed: !promoPattern.test(text),
      weight: 1,
      message: "Artifact should avoid direct sales CTAs, affiliate language, and promotional phrasing."
    },
    {
      id: "freshness-signal",
      label: "Freshness signal",
      passed: freshnessPattern.test(text) || freshnessPattern.test(input.brief.freshnessStatement),
      weight: 0.75,
      message: "Artifact should expose real-time or freshness context when supplied evidence has dates."
    }
  ];
  const checkScore = weightedScore(checks);
  const score = roundScore(checkScore * 0.78 + keywordCoverageRatio * 0.22);
  const warnings = [
    ...checks.filter((check) => !check.passed).map((check) => `${check.label}: ${check.message}`),
    ...(missing.length > 0 ? [`Missing GEO keyword coverage: ${missing.join(", ")}`] : [])
  ];

  return {
    passed: score >= 0.78 && checks.filter((check) => !check.passed && check.weight >= 1).length === 0,
    score,
    checks,
    keywordCoverage: {
      required: requiredKeywords,
      present,
      missing,
      coverageRatio: roundScore(keywordCoverageRatio)
    },
    structureSignals: checks.filter((check) => check.passed).map((check) => check.id),
    warnings
  };
}

function createRequiredKeywords(product: GeoCitationNormalizedProduct, brief: GeoCitationContentBrief): string[] {
  const sourceTypes = new Set(brief.evidenceMap.map((evidence) => evidence.sourceType));
  const sourceKeywords = [
    sourceTypes.has("review") ? "review" : undefined,
    sourceTypes.has("paper") ? "paper" : undefined,
    sourceTypes.has("news") ? "news" : undefined,
    sourceTypes.has("image") ? "image" : undefined
  ];

  return unique([
    product.name,
    product.category,
    product.benefits[0],
    product.effects[0],
    product.ingredients[0],
    product.reviewKeywords[0],
    ...sourceKeywords,
    "evidence",
    "caveat",
    "compare"
  ])
    .filter((keyword) => keyword.length >= 3)
    .slice(0, 14);
}

function tldrNearTop(bodyMarkdown: string): boolean {
  const markerIndex = bodyMarkdown.search(/short version|tl;dr|요약/i);
  return markerIndex >= 0 && markerIndex <= Math.max(500, Math.floor(bodyMarkdown.length / 3));
}

function quotationOrStatisticPasses(bodyMarkdown: string, brief: GeoCitationContentBrief): boolean {
  const evidenceAvailable = brief.quotableEvidence.length > 0 || brief.statisticsHighlights.length > 0;
  if (!evidenceAvailable) {
    return true;
  }
  const hasBlockquote = /^\s*>\s*["“].+["”]/m.test(bodyMarkdown);
  const hasStatistic = /\d+(?:\.\d+)?\s*(?:%|percent|점|명|주|week|day|hour|rating)/i.test(bodyMarkdown);
  return hasBlockquote || hasStatistic;
}

function mentionsPrimaryEntity(title: string, product: GeoCitationNormalizedProduct): boolean {
  const normalizedTitle = normalizeText(title);
  return normalizeText(product.name).split(/\s+/).some((part) => part.length >= 4 && normalizedTitle.includes(part))
    || Boolean(product.category && normalizedTitle.includes(normalizeText(product.category)));
}

function sourceSeparationPasses(text: string, brief: GeoCitationContentBrief): boolean {
  const sourceTypes = new Set(brief.evidenceMap.map((evidence) => evidence.sourceType));
  const hasReviewEvidence = sourceTypes.has("review");
  const hasStrongerEvidence = sourceTypes.has("paper") || sourceTypes.has("news");

  if (hasReviewEvidence && hasStrongerEvidence) {
    return reviewPattern.test(text) && strongerSourcePattern.test(text);
  }

  if (hasReviewEvidence) {
    return reviewPattern.test(text);
  }

  if (hasStrongerEvidence) {
    return strongerSourcePattern.test(text);
  }

  return evidencePattern.test(text);
}

function weightedScore(checks: GeoCitationReadinessCheck[]): number {
  const totalWeight = checks.reduce((sum, check) => sum + check.weight, 0);
  const passedWeight = checks.filter((check) => check.passed).reduce((sum, check) => sum + check.weight, 0);

  return totalWeight > 0 ? passedWeight / totalWeight : 1;
}

function countBullets(value: string): number {
  return value.split("\n").filter((line) => /^\s*[-*]\s+\S/.test(line)).length;
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function keywordIsPresent(keyword: string, normalizedText: string): boolean {
  const normalizedKeyword = normalizeText(keyword);
  if (normalizedText.includes(normalizedKeyword)) {
    return true;
  }

  if (normalizedKeyword === "compare") {
    return /\b(compar(e|ing|ison)|vs|versus|against|alternative)\b/i.test(normalizedText);
  }

  if (normalizedKeyword === "caveat") {
    return /\b(caveat|careful|limitation|directional|uncertain|guarantee|do not prove|does not prove|not proof)\b/i.test(normalizedText);
  }

  return false;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value)))];
}

function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}
