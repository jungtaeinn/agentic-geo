import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ragEvalGoldens } from "../evals/goldens";
import { scoreRetrieval, type AggregateScores, type ScoredChunk } from "../evals/metrics";
import { runRagEval, type RagEvalRunResult } from "../evals/runner";

/**
 * Deterministic RAG retrieval benchmark gate (roadmap item 1,
 * docs/rag-inference-maximization-paper-analysis_2026-07-31.md §5).
 *
 * Compares current retrieval quality against the committed baseline
 * (evals/baseline.json). Corpus or retrieval changes that regress claim
 * recall / context precision / chunk classification metrics beyond EPSILON
 * fail CI. Intentional improvements should update the baseline via
 * `pnpm rag:eval -- --write` in the same commit.
 */

const EPSILON = 0.03;

/**
 * Per-target contextPrecision floor gate (safety net ahead of the Phase 2 RAG
 * corpus canonicalization work). Wider than EPSILON on purpose: this is a
 * floor against silent precision collapse on any single target, not a tight
 * regression band.
 */
const CONTEXT_PRECISION_FLOOR_EPSILON = 0.05;

interface BaselineFile {
  generatedAt: string;
  aggregates: AggregateScores;
}

async function loadBaseline(): Promise<BaselineFile> {
  const baselinePath = join(dirname(fileURLToPath(import.meta.url)), "../evals/baseline.json");
  return JSON.parse(await readFile(baselinePath, "utf8")) as BaselineFile;
}

let cachedRun: Promise<RagEvalRunResult> | undefined;

function runOnce(): Promise<RagEvalRunResult> {
  cachedRun ??= runRagEval();
  return cachedRun;
}

describe("rag retrieval benchmark", () => {
  it("covers both brands, all five targets, and both locales", () => {
    const targets = new Set(ragEvalGoldens.map((golden) => golden.target));
    const locales = new Set(ragEvalGoldens.map((golden) => golden.locale));
    const products = new Set(ragEvalGoldens.map((golden) => golden.productId));

    expect(ragEvalGoldens.length).toBeGreaterThanOrEqual(20);
    expect(targets).toEqual(new Set(["faq", "howToUse", "productDescription", "webPageDescription", "schema"]));
    expect(locales).toEqual(new Set(["en-US", "ko-KR"]));
    expect(products.size).toBe(4);
  });

  it("has no unresolvable golden anchors (typo guard)", async () => {
    const result = await runOnce();
    expect(result.unresolvableAnchors).toEqual([]);
  });

  it("computes chunk-selection precision, recall, and accuracy from TP/FP/FN/TN", () => {
    const golden = ragEvalGoldens[0];
    expect(golden).toBeDefined();

    const relevantSelected: ScoredChunk = {
      id: "tp",
      source: "eeat_v1.md",
      title: "Experience",
      intents: [],
      text: "Relevant expected-anchor content"
    };
    const irrelevantSelected: ScoredChunk = {
      id: "fp",
      source: "unrelated.md",
      intents: [],
      text: "Unrelated selected content"
    };
    const relevantNotSelected: ScoredChunk = {
      id: "fn",
      source: "faq-guidance.md",
      intents: ["faq"],
      text: "Relevant candidate omitted from the final context"
    };
    const irrelevantNotSelected: ScoredChunk = {
      id: "tn",
      source: "other.md",
      intents: [],
      text: "Unrelated candidate correctly omitted"
    };

    const score = scoreRetrieval(
      golden!,
      [relevantSelected, irrelevantSelected],
      [relevantSelected, irrelevantSelected, relevantNotSelected, irrelevantNotSelected]
    );

    expect(score.classification).toEqual({
      tp: 1,
      fp: 1,
      fn: 1,
      tn: 1,
      precision: 0.5,
      recall: 0.5,
      accuracy: 0.5
    });
  });

  it("does not regress aggregate retrieval quality against the committed baseline", async () => {
    const [result, baseline] = await Promise.all([runOnce(), loadBaseline()]);

    expect(result.aggregates.goldens).toBe(baseline.aggregates.goldens);
    expect(result.aggregates.claimRecall).toBeGreaterThanOrEqual(baseline.aggregates.claimRecall - EPSILON);
    expect(result.aggregates.contextPrecision).toBeGreaterThanOrEqual(baseline.aggregates.contextPrecision - EPSILON);
    expect(result.aggregates.classification.precision).toBeGreaterThanOrEqual(baseline.aggregates.classification.precision - EPSILON);
    expect(result.aggregates.classification.recall).toBeGreaterThanOrEqual(baseline.aggregates.classification.recall - EPSILON);
    expect(result.aggregates.classification.accuracy).toBeGreaterThanOrEqual(baseline.aggregates.classification.accuracy - EPSILON);
    expect(result.aggregates.noiseChunkRate).toBeLessThanOrEqual(baseline.aggregates.noiseChunkRate + EPSILON);
  });

  it("does not regress per-target claim recall or context precision against the committed baseline", async () => {
    const [result, baseline] = await Promise.all([runOnce(), loadBaseline()]);

    for (const [target, baselineBucket] of Object.entries(baseline.aggregates.byTarget)) {
      const currentBucket = result.aggregates.byTarget[target];
      expect(currentBucket, `missing target bucket: ${target}`).toBeDefined();
      expect(
        currentBucket?.claimRecall ?? 0,
        `claim recall regression on target "${target}" (baseline ${baselineBucket.claimRecall})`
      ).toBeGreaterThanOrEqual(baselineBucket.claimRecall - EPSILON);
      expect(
        currentBucket?.contextPrecision ?? 0,
        `context precision floor breach on target "${target}" (baseline ${baselineBucket.contextPrecision})`
      ).toBeGreaterThanOrEqual(baselineBucket.contextPrecision - CONTEXT_PRECISION_FLOOR_EPSILON);
      expect(
        currentBucket?.classification.precision ?? 0,
        `classification precision regression on target "${target}" (baseline ${baselineBucket.classification.precision})`
      ).toBeGreaterThanOrEqual(baselineBucket.classification.precision - EPSILON);
      expect(
        currentBucket?.classification.recall ?? 0,
        `classification recall regression on target "${target}" (baseline ${baselineBucket.classification.recall})`
      ).toBeGreaterThanOrEqual(baselineBucket.classification.recall - EPSILON);
      expect(
        currentBucket?.classification.accuracy ?? 0,
        `classification accuracy regression on target "${target}" (baseline ${baselineBucket.classification.accuracy})`
      ).toBeGreaterThanOrEqual(baselineBucket.classification.accuracy - EPSILON);
    }
  });
});
