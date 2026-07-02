import type {
  GeoCitationEvidenceChunk,
  GeoCitationNormalizedProduct,
  GeoCitationRagSettings,
  GeoCitationRetrievedChunk,
  GeoCitationStrategySettings
} from "../types";

export function retrieveGeoCitationEvidenceChunks(input: {
  product: GeoCitationNormalizedProduct;
  chunks: GeoCitationEvidenceChunk[];
  strategy?: GeoCitationStrategySettings;
  settings?: GeoCitationRagSettings;
}): GeoCitationRetrievedChunk[] {
  const maxChunks = input.settings?.maxChunks ?? 8;
  const scoreThreshold = input.settings?.scoreThreshold ?? 0.06;
  const queryTerms = createQueryTerms(input.product, input.strategy);

  return input.chunks
    .map((chunk) => {
      const score = scoreEvidenceChunk(chunk, queryTerms);

      return {
        ...chunk,
        score,
        reason: createScoreReason(chunk, queryTerms, score)
      };
    })
    .filter((chunk) => chunk.score >= scoreThreshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxChunks);
}

function createQueryTerms(product: GeoCitationNormalizedProduct, strategy?: GeoCitationStrategySettings): string[] {
  return unique([
    product.name,
    product.brand,
    product.category,
    product.description,
    ...product.benefits,
    ...product.effects,
    ...product.ingredients,
    ...product.reviewKeywords,
    ...(strategy?.searchQueries ?? []),
    ...(strategy?.citationGoals ?? [])
  ].flatMap((value) => tokenize(value)));
}

function scoreEvidenceChunk(chunk: GeoCitationEvidenceChunk, queryTerms: string[]): number {
  const chunkTerms = new Set(tokenize(`${chunk.title ?? ""} ${chunk.text} ${chunk.keywords.join(" ")}`));
  const overlap = queryTerms.filter((term) => chunkTerms.has(term)).length;
  const sourceBoost = sourceTypeBoost(chunk.sourceType);
  const recencyBoost = chunk.observedAt || chunk.publishedAt ? 0.06 : 0;
  const exactNameBoost = queryTerms.some((term) => term.length > 5 && chunk.text.toLowerCase().includes(term)) ? 0.05 : 0;

  return Math.min(1, overlap / Math.max(queryTerms.length, 1) + sourceBoost + recencyBoost + exactNameBoost);
}

function sourceTypeBoost(sourceType: GeoCitationEvidenceChunk["sourceType"]): number {
  switch (sourceType) {
    case "paper":
      return 0.16;
    case "news":
      return 0.12;
    case "review":
      return 0.1;
    case "existing-geo":
      return 0.09;
    case "image":
      return 0.08;
    case "product":
      return 0.07;
    case "custom":
    default:
      return 0.04;
  }
}

function createScoreReason(chunk: GeoCitationEvidenceChunk, queryTerms: string[], score: number): string {
  const chunkTerms = new Set(tokenize(`${chunk.title ?? ""} ${chunk.text} ${chunk.keywords.join(" ")}`));
  const matches = queryTerms.filter((term) => chunkTerms.has(term)).slice(0, 5);

  return matches.length > 0
    ? `${chunk.sourceType} evidence matched ${matches.join(", ")} with score ${score.toFixed(2)}`
    : `${chunk.sourceType} evidence selected by source quality and freshness with score ${score.toFixed(2)}`;
}

function tokenize(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }

  return value
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
