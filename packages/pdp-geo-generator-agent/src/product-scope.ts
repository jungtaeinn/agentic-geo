import type { PdpProductSignal } from "./types";

type SegmentKind = "current" | "foreign" | "orphan";
type CandidateSource = "capitalized" | "action-target" | "family-context";

interface ProductScope {
  productPhrases: string[][];
  nameTokens: string[];
  categoryTokens: string[];
  formTokens: string[];
  primaryFormToken?: string;
  familyTokens: string[];
  ingredientTokens: string[];
}

interface ProductCandidate {
  source: CandidateSource;
  raw: string;
  tokens: string[];
}

const genericStopTokens = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "its",
  "of",
  "on",
  "onto",
  "or",
  "our",
  "the",
  "this",
  "to",
  "with",
  "your",
  "product",
  "item",
  "set",
  "mini",
  "full",
  "size",
  "ml",
  "oz",
  "apply",
  "dispense",
  "lather",
  "layer",
  "massage",
  "mist",
  "pat",
  "pump",
  "rub",
  "scoop",
  "smooth",
  "spray",
  "spread",
  "take",
  "use",
  "using",
  "warm"
]);

const routineOnlyTokens = new Set([
  "amount",
  "appropriate",
  "before",
  "clean",
  "damp",
  "dry",
  "evenly",
  "face",
  "gently",
  "hands",
  "layer",
  "morning",
  "night",
  "palms",
  "pea",
  "routine",
  "skin",
  "small",
  "step",
  "thin",
  "twice",
  "until",
  "water",
  "wet"
]);

const actionTargetPattern =
  /\b(?:apply|dispense|take|pump|scoop|spray|mist|spread|massage|lather|rub|warm|layer|pat|smooth)\s+([^.;\n]{2,120})/giu;
const currentProductActionPattern =
  /\b(?:apply|dispense|use|using|take|pump|scoop|spray|mist|spread|massage|lather|rub|warm|layer|pat|smooth|rinse|사용|도포|바르|덜어|펴\s*바르|마사지|흡수|塗布|なじませ)\b/iu;

export function filterCurrentProductUsageInstructions(product: PdpProductSignal): PdpProductSignal {
  if (product.usage.length === 0) {
    return product;
  }

  const scope = createProductScope(product);
  if (scope.nameTokens.length === 0 && scope.categoryTokens.length === 0) {
    return product;
  }

  const usage: string[] = [];
  let lastContext: SegmentKind | undefined;

  for (const instruction of product.usage) {
    const segments = splitUsageSegments(instruction);
    const keptSegments: string[] = [];
    let droppedSegment = false;

    for (const segment of segments) {
      const kind = classifyUsageSegment(segment, scope);
      if (kind === "foreign") {
        lastContext = "foreign";
        droppedSegment = true;
        continue;
      }

      if (kind === "current") {
        keptSegments.push(cleanUsageSegment(segment));
        lastContext = "current";
        continue;
      }

      if (lastContext === "foreign") {
        droppedSegment = true;
        continue;
      }

      if (lastContext === "current" || keptSegments.length > 0 || usage.length === 0) {
        keptSegments.push(cleanUsageSegment(segment));
        lastContext = lastContext ?? "orphan";
      }
    }

    const scopedInstruction = !droppedSegment && segments.length === 1 && keptSegments.length === 1
      ? instruction.trim()
      : joinUsageSegments(keptSegments);
    if (scopedInstruction) {
      usage.push(scopedInstruction);
    }
  }

  const scopedUsage = uniqueStrings(usage);
  const scopedProduct = {
    ...product,
    benefits: filterForeignOnlySignals(product.benefits, scope),
    effects: filterForeignOnlySignals(product.effects, scope),
    metrics: filterForeignOnlySignals(product.metrics, scope),
    sourceTexts: filterForeignOnlySignals(product.sourceTexts, scope),
    usage: scopedUsage
  };

  if (
    scopedProduct.usage.length === product.usage.length
    && scopedProduct.usage.every((value, index) => value === product.usage[index])
    && scopedProduct.benefits.length === product.benefits.length
    && scopedProduct.effects.length === product.effects.length
    && scopedProduct.metrics.length === product.metrics.length
    && scopedProduct.sourceTexts.length === product.sourceTexts.length
  ) {
    return product;
  }

  return scopedProduct;
}

export function isConflictingProductUsageInstruction(value: string, product: PdpProductSignal): boolean {
  const scope = createProductScope(product);
  if (scope.nameTokens.length === 0 && scope.categoryTokens.length === 0) {
    return false;
  }

  return splitUsageSegments(value).some((segment) => classifyUsageSegment(segment, scope) === "foreign");
}

function createProductScope(product: PdpProductSignal): ProductScope {
  const nameTokens = uniqueStrings(significantTokens([
    ...tokenize(product.name),
    ...tokenize(product.originalName ?? "")
  ]));
  const categoryTokens = uniqueStrings(significantTokens(tokenize(product.category ?? "")));
  const formTokens = categoryTokens.length > 0
    ? categoryTokens
    : nameTokens.length > 1
      ? [nameTokens[nameTokens.length - 1]].filter((value): value is string => Boolean(value))
      : nameTokens;
  const primaryFormToken = formTokens[formTokens.length - 1];
  const familyTokens = uniqueStrings(nameTokens.filter((token) => !containsMatchingToken(formTokens, token))).slice(0, 4);
  const productPhrases = uniqueTokenPhrases([
    tokenize(product.name),
    tokenize(product.originalName ?? ""),
    tokenize(product.category ?? "")
  ].map(significantTokens).filter((tokens) => tokens.length > 0));
  const ingredientTokens = uniqueStrings(product.ingredients.flatMap((value) => significantTokens(tokenize(value))));

  return {
    productPhrases,
    nameTokens,
    categoryTokens,
    formTokens,
    primaryFormToken,
    familyTokens,
    ingredientTokens
  };
}

function classifyUsageSegment(segment: string, scope: ProductScope): SegmentKind {
  const currentAnchor = hasCurrentProductAnchor(segment, scope);
  const hasForeignReference = hasForeignProductReference(segment, scope);

  if (currentAnchor) {
    return "current";
  }
  if (hasForeignReference) {
    return "foreign";
  }
  return "orphan";
}

function filterForeignOnlySignals(values: string[], scope: ProductScope): string[] {
  return values.filter((value) => !isForeignOnlySignal(value, scope));
}

function isForeignOnlySignal(value: string, scope: ProductScope): boolean {
  const segments = splitUsageSegments(value);
  if (segments.length === 0) {
    return false;
  }

  let hasForeign = false;
  let hasCurrent = false;

  for (const segment of segments) {
    const kind = classifyUsageSegment(segment, scope);
    hasForeign = hasForeign || hasForeignProductReference(segment, scope, true);
    hasCurrent = hasCurrent || kind === "current";
  }

  return hasForeign && !hasCurrent;
}

function hasForeignProductReference(segment: string, scope: ProductScope, actionableOnly = false): boolean {
  return extractProductCandidates(segment, scope).some((candidate) => {
    if (actionableOnly && candidate.source === "capitalized") {
      return false;
    }
    return isDifferentProductCandidate(candidate, scope);
  });
}

function hasCurrentProductAnchor(segment: string, scope: ProductScope): boolean {
  const tokens = significantTokens(tokenize(segment));
  if (tokens.length === 0) {
    return false;
  }

  if (scope.productPhrases.some((phrase) => phrase.length > 0 && containsTokenSequence(tokens, phrase))) {
    return true;
  }
  if (scope.primaryFormToken && containsMatchingToken(tokens, scope.primaryFormToken) && currentProductActionPattern.test(segment)) {
    return true;
  }
  if (scope.categoryTokens.length > 0 && tokenOverlapCount(tokens, scope.categoryTokens) === scope.categoryTokens.length) {
    return true;
  }

  return scope.nameTokens.length > 0 && tokenOverlapCount(tokens, scope.nameTokens) >= Math.min(3, scope.nameTokens.length);
}

function extractProductCandidates(segment: string, scope: ProductScope): ProductCandidate[] {
  return uniqueCandidates([
    ...extractCapitalizedCandidates(segment),
    ...extractActionTargetCandidates(segment),
    ...extractFamilyContextCandidates(segment, scope)
  ]);
}

function extractCapitalizedCandidates(segment: string): ProductCandidate[] {
  const candidates: ProductCandidate[] = [];
  const patterns = [
    /\b(?:[A-Z][A-Z0-9'&-]{2,}\s+){1,}[A-Z][A-Z0-9'&-]{2,}\b/g,
    /\b(?:[A-Z][a-z0-9'&-]{2,}\s+){1,}[A-Z][a-z0-9'&-]{2,}\b/g
  ];

  for (const pattern of patterns) {
    for (const match of segment.matchAll(pattern)) {
      const raw = trimCandidatePhrase(match[0]);
      const tokens = candidateTokens(raw);
      if (tokens.length >= 2) {
        candidates.push({ source: "capitalized", raw, tokens });
      }
    }
  }

  return candidates;
}

function extractActionTargetCandidates(segment: string): ProductCandidate[] {
  const candidates: ProductCandidate[] = [];

  for (const match of segment.matchAll(actionTargetPattern)) {
    const target = match[1];
    if (!target) {
      continue;
    }

    const raw = trimCandidatePhrase(target);
    const tokens = candidateTokens(raw);
    if (tokens.length > 0) {
      candidates.push({ source: "action-target", raw, tokens });
    }
  }

  return candidates;
}

function extractFamilyContextCandidates(segment: string, scope: ProductScope): ProductCandidate[] {
  if (scope.familyTokens.length === 0) {
    return [];
  }

  const tokens = significantTokens(tokenize(segment));
  const candidates: ProductCandidate[] = [];

  tokens.forEach((token, index) => {
    if (!containsMatchingToken(scope.familyTokens, token)) {
      return;
    }

    const window = tokens.slice(index, Math.min(index + 4, tokens.length));
    if (window.length >= 2) {
      candidates.push({
        source: "family-context",
        raw: window.join(" "),
        tokens: window
      });
    }
  });

  return candidates;
}

function isDifferentProductCandidate(candidate: ProductCandidate, scope: ProductScope): boolean {
  if (isCurrentProductCandidate(candidate.tokens, scope) || isIngredientCandidate(candidate.tokens, scope)) {
    return false;
  }

  if (candidate.source === "family-context") {
    return tokenOverlapCount(candidate.tokens, scope.familyTokens) > 0 && !candidateContainsPrimaryForm(candidate.tokens, scope);
  }

  if (candidate.source === "capitalized") {
    return candidate.tokens.length >= 2 && !isRoutineOnlyCandidate(candidate.tokens);
  }

  if (isRoutineOnlyCandidate(candidate.tokens)) {
    return false;
  }

  return candidate.tokens.length >= 2 && looksLikeNamedTarget(candidate.raw);
}

function isCurrentProductCandidate(tokens: string[], scope: ProductScope): boolean {
  if (tokens.length === 0) {
    return false;
  }

  if (scope.productPhrases.some((phrase) => phrase.length > 0 && containsTokenSequence(tokens, phrase))) {
    return true;
  }

  if (candidateContainsPrimaryForm(tokens, scope)) {
    if (scope.familyTokens.length === 0) {
      return true;
    }
    return tokenOverlapCount(tokens, scope.familyTokens) > 0 || tokenOverlapCount(tokens, scope.categoryTokens) > 0;
  }

  if (!scope.primaryFormToken && tokenOverlapCount(tokens, scope.nameTokens) >= Math.min(2, scope.nameTokens.length)) {
    return true;
  }

  return false;
}

function candidateContainsPrimaryForm(tokens: string[], scope: ProductScope): boolean {
  return Boolean(scope.primaryFormToken && containsMatchingToken(tokens, scope.primaryFormToken));
}

function isIngredientCandidate(tokens: string[], scope: ProductScope): boolean {
  if (tokens.length < 2 || scope.ingredientTokens.length === 0) {
    return false;
  }

  return tokenOverlapCount(tokens, scope.ingredientTokens) >= Math.min(tokens.length, 3);
}

function isRoutineOnlyCandidate(tokens: string[]): boolean {
  return tokens.every((token) => routineOnlyTokens.has(token) || genericStopTokens.has(token) || /^\d+$/.test(token));
}

function looksLikeNamedTarget(value: string): boolean {
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length < 2) {
    return false;
  }

  return words.some((word) => /^[A-Z][\p{L}\p{N}'&-]+$/u.test(word));
}

function splitUsageSegments(value: string): string[] {
  return value
    .replace(/\s+(?=Step\s+\d+\b)/gi, "\n")
    .replace(/\s*;\s*/g, "\n")
    .replace(/,\s*then\b/gi, "\nThen")
    .replace(/\bthen\b/gi, "\nThen")
    .replace(/\.\s+/g, "\n")
    .split(/\n+/)
    .map(cleanUsageSegment)
    .filter((segment) => segment.length > 0);
}

function cleanUsageSegment(value: string): string {
  return value
    .replace(/^\s*(?:how\s*to\s*use|directions?|usage|사용\s*방법|사용법|使い方|使用方法)\s*:?\s*/i, "")
    .replace(/^\s*Step\s+\d+\s*[:.-]?\s*/i, "")
    .replace(/^\s*\d+\.\s*/, "")
    .replace(/\s+/g, " ")
    .replace(/\s+\./g, ".")
    .trim()
    .replace(/[.;,\s]+$/g, "")
    .trim();
}

function joinUsageSegments(segments: string[]): string {
  const cleaned = uniqueStrings(segments.map(cleanUsageSegment).filter(Boolean));
  if (cleaned.length === 0) {
    return "";
  }
  return cleaned.join(". ");
}

function trimCandidatePhrase(value: string): string {
  const beforeConnector = value
    .replace(/\b(?:to|onto|on|into|with|after|before|until|for|from|then|and)\b[\s\S]*$/iu, "")
    .trim();
  const afterOf = beforeConnector.match(/\bof\s+(.+)$/iu)?.[1] ?? beforeConnector;

  return afterOf
    .replace(/^\s*(?:a|an|the|your|this|one|two|three|four|five|\d+(?:-\d+)?|dime-sized|pea-sized|small|generous|appropriate|amount|pumps?|drops?|scoops?)\s+/iu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function candidateTokens(value: string): string[] {
  return significantTokens(tokenize(value)).filter((token) => !routineOnlyTokens.has(token));
}

function significantTokens(tokens: string[]): string[] {
  return tokens.filter((token) => token.length > 1 && !genericStopTokens.has(token));
}

function tokenize(value: string): string[] {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’']/g, "")
    .match(/[\p{L}\p{N}]+/gu) ?? [];
}

function containsTokenSequence(tokens: string[], phraseTokens: string[]): boolean {
  if (phraseTokens.length === 0 || phraseTokens.length > tokens.length) {
    return false;
  }

  for (let index = 0; index <= tokens.length - phraseTokens.length; index += 1) {
    const matches = phraseTokens.every((phraseToken, offset) => {
      const token = tokens[index + offset];
      return Boolean(token && tokensMatch(token, phraseToken));
    });
    if (matches) {
      return true;
    }
  }

  return false;
}

function tokenOverlapCount(left: string[], right: string[]): number {
  const matched = new Set<number>();

  for (const token of left) {
    const index = right.findIndex((candidate, candidateIndex) => !matched.has(candidateIndex) && tokensMatch(candidate, token));
    if (index >= 0) {
      matched.add(index);
    }
  }

  return matched.size;
}

function containsMatchingToken(tokens: string[], token: string): boolean {
  return tokens.some((candidate) => tokensMatch(candidate, token));
}

function tokensMatch(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  if (Math.min(left.length, right.length) < 5 || Math.abs(left.length - right.length) > 1) {
    return false;
  }

  return hasEditDistanceWithinOne(left, right);
}

function hasEditDistanceWithinOne(left: string, right: string): boolean {
  let leftIndex = 0;
  let rightIndex = 0;
  let edits = 0;

  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }

    edits += 1;
    if (edits > 1) {
      return false;
    }

    if (left.length > right.length) {
      leftIndex += 1;
    } else if (right.length > left.length) {
      rightIndex += 1;
    } else {
      leftIndex += 1;
      rightIndex += 1;
    }
  }

  return edits + (left.length - leftIndex) + (right.length - rightIndex) <= 1;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function uniqueTokenPhrases(values: string[][]): string[][] {
  const seen = new Set<string>();
  const result: string[][] = [];

  for (const value of values) {
    const key = value.join(" ");
    if (key && !seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }

  return result;
}

function uniqueCandidates(values: ProductCandidate[]): ProductCandidate[] {
  const seen = new Set<string>();
  const result: ProductCandidate[] = [];

  for (const value of values) {
    const key = `${value.source}:${value.tokens.join(" ")}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }

  return result;
}
