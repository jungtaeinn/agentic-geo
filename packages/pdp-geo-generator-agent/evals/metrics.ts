import type { EvalTarget, ExpectedChunkAnchor, RagEvalGolden } from "./goldens";

/**
 * Deterministic RAGChecker-style metrics (arXiv:2408.08067) adapted to this
 * repository's constraints (C2: no LLM in CI scoring).
 *
 * - claimRecall: fraction of expected evidence anchors present in the top-K
 *   retrieved chunks. Retrieval-module recall against the corpus' own routing
 *   contract.
 * - contextPrecision: fraction of retrieved chunks that are on-target for the
 *   golden (expected anchor match, target-intent overlap, or always-relevant
 *   orchestration policy). Duplicated and off-intent chunks lower this score.
 * - classification: binary top-K selection quality over the retrieved
 *   candidate pool. A candidate is predicted positive when selected into the
 *   final context and actual positive when it is on-target by the same rule as
 *   contextPrecision. This yields a conventional TP/FP/FN/TN confusion matrix
 *   plus precision, recall, and accuracy.
 * - noiseChunkRate: fraction of retrieved chunks that are heading-only or
 *   near-empty (< 60 visible chars). Direct measure for roadmap item 3.
 * - faithfulness: generation-tier check, scored only when generated text is
 *   provided (expectedClaims present, forbiddenClaims absent).
 */

export interface ScoredChunk {
  id?: string;
  source: string;
  title?: string;
  headingPath?: string;
  kind?: string;
  intents: string[];
  text: string;
}

export interface ChunkClassificationMetrics {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number;
  recall: number;
  accuracy: number;
}

export interface GoldenRetrievalScore {
  goldenId: string;
  target: EvalTarget;
  claimRecall: number;
  contextPrecision: number;
  classification: ChunkClassificationMetrics;
  noiseChunkRate: number;
  matchedAnchors: string[];
  missedAnchors: string[];
  retrievedCount: number;
  /** Documents behind the selected chunks — what actually reached the prompt. */
  selectedSources: string[];
}

export interface AggregateScores {
  goldens: number;
  claimRecall: number;
  contextPrecision: number;
  classification: ChunkClassificationMetrics;
  noiseChunkRate: number;
  byTarget: Record<string, {
    goldens: number;
    claimRecall: number;
    contextPrecision: number;
    classification: ChunkClassificationMetrics;
  }>;
}

const TARGET_INTENTS: Record<EvalTarget, string[]> = {
  faq: ["faq", "customer", "review"],
  howToUse: ["howTo"],
  productDescription: ["claims", "customer", "evidence", "review", "general"],
  webPageDescription: ["general", "customer", "claims", "schema"],
  schema: ["schema", "evidence", "claims"]
};

/** Policy/orchestration context is considered relevant for every target. */
const ALWAYS_RELEVANT_KINDS = new Set(["orchestration"]);

const NOISE_TEXT_THRESHOLD = 60;

export function anchorLabel(anchor: ExpectedChunkAnchor): string {
  return anchor.heading ? `${anchor.document} # ${anchor.heading}` : anchor.document;
}

export function chunkMatchesAnchor(chunk: ScoredChunk, anchor: ExpectedChunkAnchor): boolean {
  const source = normalize(chunk.source);
  if (!source.endsWith(normalize(anchor.document))) {
    return false;
  }
  if (!anchor.heading) {
    return true;
  }
  const haystack = `${chunk.title ?? ""} ${chunk.headingPath ?? ""}`.toLowerCase();
  return haystack.includes(anchor.heading.toLowerCase());
}

export function isNoiseChunk(chunk: ScoredChunk): boolean {
  const body = chunk.text.replace(/^#+\s.*$/gm, "").replace(/\s+/g, " ").trim();
  return body.length < NOISE_TEXT_THRESHOLD;
}

/** Returns the deterministic binary relevance label used by context precision and classification metrics. */
export function isTargetRelevantChunk(golden: RagEvalGolden, chunk: ScoredChunk): boolean {
  const targetIntents = new Set(TARGET_INTENTS[golden.target]);
  return golden.expectedChunks.some((anchor) => chunkMatchesAnchor(chunk, anchor))
    || chunk.intents.some((intent) => targetIntents.has(intent))
    || (chunk.kind !== undefined && ALWAYS_RELEVANT_KINDS.has(chunk.kind));
}

export function scoreRetrieval(
  golden: RagEvalGolden,
  chunks: ScoredChunk[],
  candidatePool: ScoredChunk[] = chunks
): GoldenRetrievalScore {
  const matchedAnchors: string[] = [];
  const missedAnchors: string[] = [];

  for (const anchor of golden.expectedChunks) {
    if (chunks.some((chunk) => chunkMatchesAnchor(chunk, anchor))) {
      matchedAnchors.push(anchorLabel(anchor));
    } else {
      missedAnchors.push(anchorLabel(anchor));
    }
  }

  const onTargetCount = chunks.filter((chunk) => isTargetRelevantChunk(golden, chunk)).length;

  const noiseCount = chunks.filter(isNoiseChunk).length;
  const classification = scoreChunkClassification(golden, chunks, candidatePool);

  return {
    goldenId: golden.id,
    target: golden.target,
    claimRecall: golden.expectedChunks.length === 0 ? 1 : matchedAnchors.length / golden.expectedChunks.length,
    contextPrecision: chunks.length === 0 ? 0 : onTargetCount / chunks.length,
    classification,
    noiseChunkRate: chunks.length === 0 ? 0 : noiseCount / chunks.length,
    matchedAnchors,
    missedAnchors,
    retrievedCount: chunks.length,
    selectedSources: Array.from(new Set(chunks.map((chunk) => chunk.source)))
  };
}

export interface FaithfulnessScore {
  goldenId: string;
  supportedClaims: string[];
  missingClaims: string[];
  forbiddenHits: string[];
  faithfulness: number;
}

/** Generation-tier scorer. `generatedText` is the concatenated public output for the golden's target. */
export function scoreFaithfulness(golden: RagEvalGolden, generatedText: string): FaithfulnessScore {
  const haystack = generatedText.toLowerCase();
  const supportedClaims = golden.expectedClaims.filter((claim) => haystack.includes(claim.toLowerCase()));
  const missingClaims = golden.expectedClaims.filter((claim) => !haystack.includes(claim.toLowerCase()));
  const forbiddenHits = golden.forbiddenClaims.filter((claim) => haystack.includes(claim.toLowerCase()));
  const claimScore = golden.expectedClaims.length === 0 ? 1 : supportedClaims.length / golden.expectedClaims.length;

  return {
    goldenId: golden.id,
    supportedClaims,
    missingClaims,
    forbiddenHits,
    faithfulness: forbiddenHits.length > 0 ? 0 : claimScore
  };
}

export function aggregateScores(scores: GoldenRetrievalScore[]): AggregateScores {
  const byTarget: AggregateScores["byTarget"] = {};
  const classification = emptyClassificationMetrics();

  for (const score of scores) {
    const bucket = byTarget[score.target] ?? {
      goldens: 0,
      claimRecall: 0,
      contextPrecision: 0,
      classification: emptyClassificationMetrics()
    };
    bucket.goldens += 1;
    bucket.claimRecall += score.claimRecall;
    bucket.contextPrecision += score.contextPrecision;
    addConfusionCounts(bucket.classification, score.classification);
    addConfusionCounts(classification, score.classification);
    byTarget[score.target] = bucket;
  }
  for (const bucket of Object.values(byTarget)) {
    bucket.claimRecall = round(bucket.claimRecall / bucket.goldens);
    bucket.contextPrecision = round(bucket.contextPrecision / bucket.goldens);
    bucket.classification = finalizeClassificationMetrics(bucket.classification);
  }

  return {
    goldens: scores.length,
    claimRecall: round(mean(scores.map((score) => score.claimRecall))),
    contextPrecision: round(mean(scores.map((score) => score.contextPrecision))),
    classification: finalizeClassificationMetrics(classification),
    noiseChunkRate: round(mean(scores.map((score) => score.noiseChunkRate))),
    byTarget
  };
}

function scoreChunkClassification(
  golden: RagEvalGolden,
  selectedChunks: ScoredChunk[],
  candidatePool: ScoredChunk[]
): ChunkClassificationMetrics {
  const selectedKeys = new Set(selectedChunks.map(classificationChunkKey));
  const candidates = new Map<string, ScoredChunk>();

  for (const chunk of [...candidatePool, ...selectedChunks]) {
    candidates.set(classificationChunkKey(chunk), chunk);
  }

  const counts = emptyClassificationMetrics();
  for (const [key, chunk] of candidates) {
    const predictedPositive = selectedKeys.has(key);
    const actualPositive = isTargetRelevantChunk(golden, chunk);

    if (predictedPositive && actualPositive) {
      counts.tp += 1;
    } else if (predictedPositive) {
      counts.fp += 1;
    } else if (actualPositive) {
      counts.fn += 1;
    } else {
      counts.tn += 1;
    }
  }

  return finalizeClassificationMetrics(counts, false);
}

function emptyClassificationMetrics(): ChunkClassificationMetrics {
  return { tp: 0, fp: 0, fn: 0, tn: 0, precision: 0, recall: 0, accuracy: 0 };
}

function addConfusionCounts(target: ChunkClassificationMetrics, source: ChunkClassificationMetrics): void {
  target.tp += source.tp;
  target.fp += source.fp;
  target.fn += source.fn;
  target.tn += source.tn;
}

function finalizeClassificationMetrics(
  counts: ChunkClassificationMetrics,
  shouldRound = true
): ChunkClassificationMetrics {
  const total = counts.tp + counts.fp + counts.fn + counts.tn;
  const precision = divide(counts.tp, counts.tp + counts.fp);
  const recall = divide(counts.tp, counts.tp + counts.fn);
  const accuracy = divide(counts.tp + counts.tn, total);
  const normalizeMetric = shouldRound ? round : (value: number) => value;

  return {
    tp: counts.tp,
    fp: counts.fp,
    fn: counts.fn,
    tn: counts.tn,
    precision: normalizeMetric(precision),
    recall: normalizeMetric(recall),
    accuracy: normalizeMetric(accuracy)
  };
}

function classificationChunkKey(chunk: ScoredChunk): string {
  return chunk.id ?? [chunk.source, chunk.title ?? "", chunk.headingPath ?? "", chunk.text].join("\u0000");
}

function divide(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function normalize(name: string): string {
  return name.replace(/\\/g, "/").toLowerCase();
}
