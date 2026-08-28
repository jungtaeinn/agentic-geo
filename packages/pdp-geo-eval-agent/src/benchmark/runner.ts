import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalEvidenceItem } from "../types";
import { evalProducts, type EvalProductId } from "./fixtures";
import { geoEvalDistractors } from "./distractors";
import { buildVanillaSourceText } from "../citation/source-text";
import { generateEngineAnswer, geoEvalEngineId, type GeoEvalEngineConfig } from "../citation/engine";
import { GEO_EVAL_TARGET_SLOT } from "../citation/probe";
import { geoEvalGoldens, type GeoEvalGolden } from "./goldens";
import { scoreCitationVisibility, type CitationVisibilityScore } from "../citation/metrics";
import {
  evaluateUtilityGate,
  judgeCitationQuality,
  judgeKeypointCoverage,
  PDP_COPY_UTILITY_GATE_THRESHOLDS,
  type CitationQualityScore,
  type KeypointCoverageScore,
  type UtilityGateResult
} from "../citation/utility";

/**
 * Counterfactual citation-visibility runner (AutoGEO evaluation protocol).
 *
 * For every golden query the same 5-source set is answered twice by the
 * simulated engine: once with the vanilla PDP text in the target slot and
 * once with the generated PDP text. Distractors, query, slot, and engine are
 * identical between the two runs, so the share-of-voice delta is attributable
 * to the generated content alone.
 *
 * Engine answers and judge verdicts are cached on disk keyed by a content
 * hash (engine id + query + sources), so interrupted runs resume without
 * re-paying for completed calls and re-runs are free until an input changes.
 */

export interface GeoEvalRunOptions {
  /** Simulated generative engine (answer generation). */
  engine: GeoEvalEngineConfig;
  /**
   * Pre-generated PDP artifacts per fixture product. This package never runs
   * the generator (no inter-package dependency); the wiring script in the app
   * generates artifacts and injects them here.
   */
  artifacts: Partial<Record<EvalProductId, GeneratedProductArtifact>>;
  /** Judge model for utility metrics; defaults to `engine`. */
  judge?: GeoEvalEngineConfig;
  /** Also run keypoint-coverage + citation-quality judges (extra LLM calls). */
  includeUtility?: boolean;
  /** Restrict to specific golden ids. */
  goldenIds?: string[];
  /** Answer/judgment cache directory. Defaults to `.benchmark-cache` at this package's root. */
  cacheDir?: string;
  /** Read cached answers when true (default). Writes always happen. */
  useCache?: boolean;
  onProgress?: (message: string) => void;
}

export interface GeoEvalVariantScore {
  wordpos: number;
  word: number;
  pos: number;
  citedSentenceCount: number;
  sentenceCount: number;
  hallucinatedCitations: number[];
  cachedAnswer: boolean;
}

export interface GeoEvalGoldenResult {
  goldenId: string;
  productId: EvalProductId;
  locale: string;
  cepFocus: string;
  query: string;
  vanilla: GeoEvalVariantScore;
  generated: GeoEvalVariantScore;
  delta: { wordpos: number; word: number; pos: number };
  utility?: {
    keypointCoverage?: KeypointCoverageScore;
    citationQuality?: CitationQualityScore;
  };
  gate: UtilityGateResult;
}

export interface GeoEvalShareAggregate {
  wordpos: number;
  word: number;
  pos: number;
}

export interface GeoEvalAggregates {
  goldens: number;
  engineId: string;
  vanilla: GeoEvalShareAggregate;
  generated: GeoEvalShareAggregate;
  delta: GeoEvalShareAggregate;
  byLocale: Record<string, { goldens: number; vanilla: GeoEvalShareAggregate; generated: GeoEvalShareAggregate; delta: GeoEvalShareAggregate }>;
  byCepFocus: Record<string, { goldens: number; delta: GeoEvalShareAggregate }>;
  gate: { evaluated: number; passed: number };
  utility?: {
    meanKpr: number | null;
    meanKpc: number | null;
    meanCitationPrecision: number | null;
    meanCitationRecall: number | null;
  };
}

export interface GeoEvalRunResult {
  engineId: string;
  scores: GeoEvalGoldenResult[];
  aggregates: GeoEvalAggregates;
}

export interface GeneratedProductArtifact {
  publicText: string;
  evidenceLedger: EvalEvidenceItem[];
}

const defaultCacheDir = join(dirname(fileURLToPath(import.meta.url)), "../../.benchmark-cache");

export async function runGeoBenchmark(options: GeoEvalRunOptions): Promise<GeoEvalRunResult> {
  const goldens = options.goldenIds && options.goldenIds.length > 0
    ? geoEvalGoldens.filter((golden) => options.goldenIds?.includes(golden.id))
    : geoEvalGoldens;
  if (goldens.length === 0) {
    throw new Error("No goldens matched the requested ids.");
  }

  const cacheDir = options.cacheDir ?? defaultCacheDir;
  const useCache = options.useCache ?? true;
  const judgeConfig = options.judge ?? options.engine;
  const engineId = geoEvalEngineId(options.engine);
  const progress = options.onProgress ?? (() => {});

  await mkdir(cacheDir, { recursive: true });

  const generatedByProduct = new Map<EvalProductId, GeneratedProductArtifact>();
  for (const productId of new Set(goldens.map((golden) => golden.productId))) {
    const artifact = options.artifacts[productId];
    if (!artifact) {
      throw new Error(`Missing injected artifact for product "${productId}". The app wiring script must generate and pass it.`);
    }
    generatedByProduct.set(productId, artifact);
  }

  const scores: GeoEvalGoldenResult[] = [];
  for (const golden of goldens) {
    progress(`scoring ${golden.id} (${golden.query})`);
    scores.push(await scoreGolden(golden, generatedByProduct.get(golden.productId) as GeneratedProductArtifact, {
      engine: options.engine,
      judge: judgeConfig,
      includeUtility: options.includeUtility ?? false,
      cacheDir,
      useCache
    }));
  }

  return { engineId, scores, aggregates: aggregateGeoScores(scores, engineId) };
}

/** Builds the 5-source set with the target document in the fixed slot. */
export function buildSourceSet(productId: EvalProductId, targetText: string): string[] {
  const distractors = geoEvalDistractors[productId];
  const sources = [...distractors];
  sources.splice(GEO_EVAL_TARGET_SLOT, 0, targetText);
  return sources;
}

interface GoldenScoringContext {
  engine: GeoEvalEngineConfig;
  judge: GeoEvalEngineConfig;
  includeUtility: boolean;
  cacheDir: string;
  useCache: boolean;
}

async function scoreGolden(
  golden: GeoEvalGolden,
  artifact: GeneratedProductArtifact,
  context: GoldenScoringContext
): Promise<GeoEvalGoldenResult> {
  const product = evalProducts[golden.productId];
  const vanillaSources = buildSourceSet(golden.productId, buildVanillaSourceText(product));
  const generatedSources = buildSourceSet(golden.productId, artifact.publicText);

  const [vanillaAnswer, generatedAnswer] = await Promise.all([
    cachedEngineAnswer(context, golden.query, vanillaSources),
    cachedEngineAnswer(context, golden.query, generatedSources)
  ]);

  const vanillaScore = scoreCitationVisibility(vanillaAnswer.answer, vanillaSources.length, GEO_EVAL_TARGET_SLOT);
  const generatedScore = scoreCitationVisibility(generatedAnswer.answer, generatedSources.length, GEO_EVAL_TARGET_SLOT);
  const delta = {
    wordpos: generatedScore.wordpos - vanillaScore.wordpos,
    word: generatedScore.word - vanillaScore.word,
    pos: generatedScore.pos - vanillaScore.pos
  };

  let utility: GeoEvalGoldenResult["utility"];
  if (context.includeUtility) {
    utility = {};
    if (artifact.evidenceLedger.length > 0) {
      const coverage = await cachedJudgeCall(
        context,
        "keypoint",
        { publicText: artifact.publicText, evidenceIds: artifact.evidenceLedger.map((item) => item.id) },
        async () => (await judgeKeypointCoverage(context.judge, artifact.evidenceLedger, artifact.publicText)).score
      );
      utility.keypointCoverage = coverage;
    }
    utility.citationQuality = await cachedJudgeCall(
      context,
      "citation-quality",
      { answer: generatedAnswer.answer, sources: generatedSources },
      () => judgeCitationQuality(context.judge, generatedAnswer.answer, generatedSources)
    );
  }

  // Keypoint coverage judges the generated PDP copy against the full ledger,
  // so the omission-tolerant PDP-copy thresholds apply (see utility.ts).
  const gate = evaluateUtilityGate({
    visibilityDelta: delta.wordpos,
    keypointCoverage: utility?.keypointCoverage,
    citationQuality: utility?.citationQuality
  }, PDP_COPY_UTILITY_GATE_THRESHOLDS);

  return {
    goldenId: golden.id,
    productId: golden.productId,
    locale: golden.locale,
    cepFocus: golden.cepFocus,
    query: golden.query,
    vanilla: toVariantScore(vanillaScore, vanillaAnswer.cached),
    generated: toVariantScore(generatedScore, generatedAnswer.cached),
    delta,
    utility,
    gate
  };
}

function toVariantScore(score: CitationVisibilityScore, cachedAnswer: boolean): GeoEvalVariantScore {
  return {
    wordpos: round(score.wordpos),
    word: round(score.word),
    pos: round(score.pos),
    citedSentenceCount: score.shares.citedSentenceCount,
    sentenceCount: score.shares.sentenceCount,
    hallucinatedCitations: score.shares.hallucinatedCitations,
    cachedAnswer
  };
}

// ---------------------------------------------------------------------------
// Disk cache (incremental resume, AutoGEO checkpoint pattern)
// ---------------------------------------------------------------------------

async function cachedEngineAnswer(
  context: GoldenScoringContext,
  query: string,
  sources: string[]
): Promise<{ answer: string; cached: boolean }> {
  const key = cacheKey("answer", { engineId: geoEvalEngineId(context.engine), query, sources });
  const cached = context.useCache ? await readCacheEntry<{ answer: string }>(context.cacheDir, key) : undefined;
  if (cached?.answer) {
    return { answer: cached.answer, cached: true };
  }
  const { answer } = await generateEngineAnswer(context.engine, query, sources);
  await writeCacheEntry(context.cacheDir, key, { answer, engineId: geoEvalEngineId(context.engine), query });
  return { answer, cached: false };
}

async function cachedJudgeCall<T>(
  context: GoldenScoringContext,
  kind: string,
  keyPayload: unknown,
  run: () => Promise<T>
): Promise<T> {
  const key = cacheKey(kind, { judgeId: geoEvalEngineId(context.judge), payload: keyPayload });
  const cached = context.useCache ? await readCacheEntry<{ value: T }>(context.cacheDir, key) : undefined;
  if (cached && "value" in cached) {
    return cached.value;
  }
  const value = await run();
  await writeCacheEntry(context.cacheDir, key, { value, judgeId: geoEvalEngineId(context.judge), kind });
  return value;
}

function cacheKey(kind: string, payload: unknown): string {
  const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 32);
  return `${kind}-${hash}`;
}

async function readCacheEntry<T>(cacheDir: string, key: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(join(cacheDir, `${key}.json`), "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function writeCacheEntry(cacheDir: string, key: string, value: unknown): Promise<void> {
  await writeFile(join(cacheDir, `${key}.json`), `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export function aggregateGeoScores(scores: GeoEvalGoldenResult[], engineId: string): GeoEvalAggregates {
  const byLocale: GeoEvalAggregates["byLocale"] = {};
  const byCepFocus: GeoEvalAggregates["byCepFocus"] = {};

  for (const score of scores) {
    const localeBucket = byLocale[score.locale] ?? {
      goldens: 0,
      vanilla: { wordpos: 0, word: 0, pos: 0 },
      generated: { wordpos: 0, word: 0, pos: 0 },
      delta: { wordpos: 0, word: 0, pos: 0 }
    };
    localeBucket.goldens += 1;
    addShares(localeBucket.vanilla, score.vanilla);
    addShares(localeBucket.generated, score.generated);
    addShares(localeBucket.delta, score.delta);
    byLocale[score.locale] = localeBucket;

    const focusBucket = byCepFocus[score.cepFocus] ?? { goldens: 0, delta: { wordpos: 0, word: 0, pos: 0 } };
    focusBucket.goldens += 1;
    addShares(focusBucket.delta, score.delta);
    byCepFocus[score.cepFocus] = focusBucket;
  }

  for (const bucket of Object.values(byLocale)) {
    finalizeShares(bucket.vanilla, bucket.goldens);
    finalizeShares(bucket.generated, bucket.goldens);
    finalizeShares(bucket.delta, bucket.goldens);
  }
  for (const bucket of Object.values(byCepFocus)) {
    finalizeShares(bucket.delta, bucket.goldens);
  }

  const kprs = scores.map((score) => score.utility?.keypointCoverage?.kpr).filter(isNumber);
  const kpcs = scores.map((score) => score.utility?.keypointCoverage?.kpc).filter(isNumber);
  const precisions = scores.map((score) => score.utility?.citationQuality?.precision).filter(isNumber);
  const recalls = scores.map((score) => score.utility?.citationQuality?.recall).filter(isNumber);
  const hasUtility = kprs.length > 0 || precisions.length > 0;

  return {
    goldens: scores.length,
    engineId,
    vanilla: meanShares(scores.map((score) => score.vanilla)),
    generated: meanShares(scores.map((score) => score.generated)),
    delta: meanShares(scores.map((score) => score.delta)),
    byLocale,
    byCepFocus,
    gate: {
      evaluated: scores.length,
      passed: scores.filter((score) => score.gate.pass).length
    },
    utility: hasUtility
      ? {
        meanKpr: mean(kprs),
        meanKpc: mean(kpcs),
        meanCitationPrecision: mean(precisions),
        meanCitationRecall: mean(recalls)
      }
      : undefined
  };
}

function addShares(target: GeoEvalShareAggregate, source: GeoEvalShareAggregate): void {
  target.wordpos += source.wordpos;
  target.word += source.word;
  target.pos += source.pos;
}

function finalizeShares(target: GeoEvalShareAggregate, count: number): void {
  target.wordpos = round(target.wordpos / count);
  target.word = round(target.word / count);
  target.pos = round(target.pos / count);
}

function meanShares(shares: GeoEvalShareAggregate[]): GeoEvalShareAggregate {
  const sum = { wordpos: 0, word: 0, pos: 0 };
  for (const share of shares) {
    addShares(sum, share);
  }
  finalizeShares(sum, Math.max(1, shares.length));
  return sum;
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function isNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
