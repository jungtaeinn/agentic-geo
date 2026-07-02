import type { GeoCitationNormalizedProduct, RedditCitationArtifact } from "../../types";

const MAX_TITLE_LENGTH = 120;
const MAX_PUBLIC_SENTENCE_LENGTH = 220;

const internalEvidenceRefPattern = /\b(?:product|extractor|review|paper|news|image|existing-geo|custom|rag)[\w.-]*:[\w:.-]+\b/gi;
const evidenceRefsLabelPattern = /\s*Evidence refs?:\s*[^.\n]+\.?/gi;
const diagnosticCountPattern = /\bThe selected evidence set includes [^.]+\.?\s*/gi;
const internalAudiencePatterns = [
  /상품을\s*비교하고\s*근거를\s*확인하려는\s*Reddit\s*사용자/gi,
  /Reddit users comparing products and evidence/gi,
  /people comparing product claims and real-world evidence/gi
];

const benefitKeywordLabels: Array<[RegExp, string]> = [
  [/\bfine lines?\b|\bwrinkles?\b|주름/i, "fine lines and wrinkles"],
  [/\bfirm(?:ness)?\b|\belasticity\b|\bresilience\b|탄력/i, "firmness and resilience"],
  [/\bhydrat(?:e|ion|ing)\b|\bmoistur/i, "hydration"],
  [/\bskin barrier\b|\bbarrier\b/i, "skin barrier support"],
  [/\bretinol\b/i, "retinol-based routines"],
  [/\bginseng\b|인삼/i, "ginseng-based skincare"],
  [/\bbright(?:en|ening)\b|\bradiance\b|톤/i, "radiance"],
  [/\bsooth(?:e|ing)\b|\bsensitive\b|진정/i, "sensitive-skin routines"]
];

export function createPublicRedditTitle(product: GeoCitationNormalizedProduct, pattern?: "question" | "thoughts"): string {
  const focus = createRedditTitleFocus(product);
  const title = pattern === "thoughts"
    ? `Thoughts on ${product.name} for ${focus}?`
    : `Is ${product.name} worth considering for ${focus}?`;

  return clampTitle(title, product.name, focus);
}

export function createRedditTitleFocus(product: GeoCitationNormalizedProduct): string {
  const searchableText = [
    ...product.benefits,
    ...product.effects,
    product.description,
    ...product.ingredients,
    product.category
  ].filter((value): value is string => Boolean(value)).join(" ");
  const keywordLabel = benefitKeywordLabels.find(([pattern]) => pattern.test(searchableText))?.[1];

  if (keywordLabel) {
    return keywordLabel;
  }

  const candidate = [
    ...product.benefits,
    ...product.effects,
    product.category,
    product.description
  ].find((value) => value && stripNoisyProductCopy(value).length > 0);

  return trimPublicPhrase(candidate ?? product.category ?? "this use case", 56) || "this use case";
}

export function createNaturalRedditAudience(product: GeoCitationNormalizedProduct): string {
  const category = normalizeShortLabel(product.category) || "product";
  return `people comparing ${category} options around ${createRedditTitleFocus(product)}`;
}

export function summarizeRedditIngredients(ingredients: string[]): string | undefined {
  const source = ingredients.join(" ");
  const labels = [
    [/\bretinol\b/i, "retinol"],
    [/\bniacinamide\b/i, "niacinamide"],
    [/\bceramide/i, "ceramides"],
    [/\bhyaluronic acid\b|\bsodium hyaluronate\b/i, "hyaluronic acid"],
    [/\bpeptide/i, "peptides"],
    [/\bginseng\b|인삼/i, "ginseng-derived actives"],
    [/\bpanthenol\b/i, "panthenol"]
  ].flatMap(([pattern, label]) => pattern instanceof RegExp && pattern.test(source) ? [label as string] : []);
  const uniqueLabels = [...new Set(labels)];

  if (uniqueLabels.length > 0) {
    return uniqueLabels.slice(0, 3).join(", ");
  }

  const cleanedIngredients = ingredients
    .map((ingredient) => trimPublicPhrase(ingredient, 42))
    .filter(Boolean);

  return cleanedIngredients.length > 0 ? cleanedIngredients.slice(0, 3).join(", ") : undefined;
}

export function sanitizePublicRedditText(text: string, product: GeoCitationNormalizedProduct): string {
  const audience = createNaturalRedditAudience(product);
  let sanitized = normalizeMarkdownText(text)
    .replace(evidenceRefsLabelPattern, "")
    .replace(internalEvidenceRefPattern, "")
    .replace(diagnosticCountPattern, "I would treat the available evidence as directional rather than definitive. ");

  internalAudiencePatterns.forEach((pattern) => {
    sanitized = sanitized.replace(pattern, audience);
  });

  sanitized = sanitized
    .replace(/\bCaveat:\s*/gi, "")
    .replace(/\bINGREDIENTS?:[\s\S]*?(?=(?:\n|$))/gi, "the full ingredient list")
    .replace(/\bFORMULATED WITHOUT:[^\n]+/gi, "")
    .replace(/\b(WATER\s*\/\s*AQUA\s*\/\s*EAU|BUTYLENE GLYCOL|PHENOXYETHANOL|SODIUM HYALURONATE CROSSPOLYMER)[^\n]*/gi, "the full ingredient list");

  sanitized = rewriteOverlongPublicLines(sanitized, product);
  sanitized = removeDuplicateSentences(sanitized);
  sanitized = removeDuplicateLines(sanitized);
  sanitized = removeEmptyMarkdownSections(sanitized);

  return normalizePublicPunctuation(collapseMarkdownWhitespace(sanitized)).trim();
}

export function sanitizeRedditArtifactForPublicCopy(input: {
  artifact: RedditCitationArtifact;
  product: GeoCitationNormalizedProduct;
}): { artifact: RedditCitationArtifact; warnings: string[] } {
  const warnings: string[] = [];
  const originalTitle = input.artifact.title;
  const originalBody = input.artifact.bodyMarkdown;
  let title = normalizeWhitespace(originalTitle)
    .replace(evidenceRefsLabelPattern, "")
    .replace(internalEvidenceRefPattern, "")
    .replace(/\s+\?/g, "?");

  if (shouldRewriteTitle(title, input.product)) {
    title = createPublicRedditTitle(input.product);
  } else {
    title = clampTitle(title, input.product.name, createRedditTitleFocus(input.product));
  }

  const bodyMarkdown = ensureCommunityQuestion(
    sanitizePublicRedditText(originalBody, input.product),
    input.artifact.commentSeeds[0]
  );

  if (title !== originalTitle) {
    warnings.push("Reddit title was repaired so it can be pasted as public Reddit copy.");
  }
  if (bodyMarkdown !== originalBody) {
    warnings.push("Reddit body was repaired to remove internal diagnostics, evidence IDs, repeated caveats, or raw ingredient dumps.");
  }

  return {
    artifact: {
      ...input.artifact,
      title,
      bodyMarkdown
    },
    warnings
  };
}

export function trimPublicSentence(text: string, maxLength = MAX_PUBLIC_SENTENCE_LENGTH): string {
  return trimPublicPhrase(stripNoisyProductCopy(text), maxLength);
}

function shouldRewriteTitle(title: string, product: GeoCitationNormalizedProduct): boolean {
  const sentenceCount = (title.match(/[.!?]/g) ?? []).length;

  return title.length > MAX_TITLE_LENGTH
    || sentenceCount > 1
    || /Formulated with|This powerhouse|melts into skin|INGREDIENTS?|FORMULATED WITHOUT|Evidence refs?|상품을\s*비교/i.test(title)
    || !title.toLowerCase().includes(product.name.toLowerCase());
}

function clampTitle(title: string, productName: string, focus: string): string {
  if (title.length <= MAX_TITLE_LENGTH) {
    return title;
  }

  const shorter = `Thoughts on ${productName} for ${focus}?`;
  if (shorter.length <= MAX_TITLE_LENGTH) {
    return shorter;
  }

  const compactName = trimPublicPhrase(productName, 70);
  const compactFocus = trimPublicPhrase(focus, 32);
  return `Thoughts on ${compactName} for ${compactFocus}?`;
}

function rewriteOverlongPublicLines(text: string, product: GeoCitationNormalizedProduct): string {
  const ingredientSummary = summarizeRedditIngredients(product.ingredients);

  return text.split("\n").map((line) => {
    const normalizedLine = normalizeWhitespace(line);

    if (/^-\s*Check whether alternatives use similar ingredients/i.test(normalizedLine) || (normalizedLine.length > 420 && /ingredients?|actives?|retinol|ginseng/i.test(normalizedLine))) {
      return ingredientSummary
        ? `- Compare the key actives (${ingredientSummary}) against alternatives instead of relying on similar claim wording alone.`
        : "- Compare the key actives against alternatives instead of relying on similar claim wording alone.";
    }

    if (normalizedLine.length > 520) {
      const prefix = normalizedLine.startsWith("- ") ? "- " : "";
      return `${prefix}${trimPublicPhrase(normalizedLine.replace(/^-\s*/, ""), 300)}`;
    }

    return line;
  }).join("\n");
}

function ensureCommunityQuestion(bodyMarkdown: string, fallbackQuestion: string | undefined): string {
  if (bodyMarkdown.trim().endsWith("?")) {
    return bodyMarkdown;
  }

  const question = fallbackQuestion?.trim() || "What would you want to verify before comparing this with similar options?";
  return `${bodyMarkdown.trim()}\n\nQuestion for people who have looked at similar products: ${question.endsWith("?") ? question : `${question}?`}`;
}

function removeDuplicateLines(text: string): string {
  const seen = new Set<string>();

  return text.split("\n").filter((line) => {
    const key = line.replace(/^[-#\s]+/, "").toLowerCase().trim();
    if (!key || key.length < 28 || !isDedupableCaveatSentence(key)) {
      return true;
    }
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  }).join("\n");
}

function removeDuplicateSentences(text: string): string {
  const seen = new Set<string>();

  return text.split("\n").map((line) => {
    const sentences = line.match(/[^.!?]+[.!?]+|[^.!?]+$/g);
    if (!sentences) {
      return line;
    }

    return sentences.filter((sentence) => {
      const key = normalizeWhitespace(sentence).replace(/^[-#\s]+/, "").toLowerCase();
      if (key.length < 36 || !isDedupableCaveatSentence(key)) {
        return true;
      }
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    }).join(" ").replace(/\s+([,.!?])/g, "$1").trim();
  }).join("\n");
}

function isDedupableCaveatSentence(sentenceKey: string): boolean {
  return /review patterns|marketing claims|do not prove|directional|not definitive|not a guarantee|careful|caveat|limitation|unsupported/.test(sentenceKey);
}

function stripNoisyProductCopy(text: string): string {
  return normalizeWhitespace(text)
    .replace(/\bINGREDIENTS?:[\s\S]*$/i, "")
    .replace(/\bFORMULATED WITHOUT:[\s\S]*$/i, "")
    .replace(/\bFormulated with\b/gi, "")
    .replace(/\bThis powerhouse\b/gi, "This")
    .replace(/\bmelts into skin on contact\b/gi, "")
    .replace(/\bdelivering essential nutrients\b/gi, "")
    .replace(/\s+[,.;]/g, ".")
    .replace(/\s+/g, " ")
    .trim();
}

function removeEmptyMarkdownSections(text: string): string {
  const lines = text.split("\n");
  const output: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^##\s+/.test(line)) {
      const nextContentIndex = lines.findIndex((candidate, candidateIndex) =>
        candidateIndex > index && candidate.trim().length > 0
      );
      const nextContent = nextContentIndex >= 0 ? lines[nextContentIndex] : "";
      if (!nextContent || /^##\s+/.test(nextContent)) {
        continue;
      }
    }
    output.push(line);
  }

  return output.join("\n");
}

function normalizePublicPunctuation(text: string): string {
  return text
    .replace(/\.\?/g, "?")
    .replace(/([.!?])\1+/g, "$1")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/:\s*\./g, ":")
    .replace(/\bT(\d{2}:\d{2}:\d{2})\.\s+(\d{3}Z)\b/g, "T$1.$2");
}

function trimPublicPhrase(text: string, maxLength: number): string {
  const firstSegment = stripNoisyProductCopy(text)
    .split(/\.\s+|;\s+|\s+while\s+|,\s+while\s+/i)[0] ?? "";
  const cleaned = firstSegment
    .trim()
    .replace(/[.]+$/, "");

  if (cleaned.length <= maxLength) {
    return cleaned;
  }

  const truncated = cleaned.slice(0, maxLength + 1);
  const lastSpace = truncated.lastIndexOf(" ");
  return `${truncated.slice(0, lastSpace > 24 ? lastSpace : maxLength).trim()}...`;
}

function normalizeShortLabel(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return trimPublicPhrase(value, 36).toLowerCase();
}

function normalizeMarkdownText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim();
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function collapseMarkdownWhitespace(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ");
}
