import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AggregateScores } from "../evals/metrics";
import { runRagEval } from "../evals/runner";

/**
 * Runs the deterministic RAG retrieval benchmark.
 *
 * Usage:
 *   pnpm rag:eval              # human-readable report + baseline comparison
 *   pnpm rag:eval -- --json    # machine-readable JSON (for agents/CI tooling)
 *   pnpm rag:eval -- --write   # additionally update evals/baseline.json
 *
 * Update the baseline only when a change is INTENDED to move retrieval quality
 * (corpus edits, retrieval changes). tests/rag-eval.test.ts gates regressions
 * against the committed baseline. See evals/README.md for the agent workflow.
 */

const shouldWrite = process.argv.includes("--write");
const asJson = process.argv.includes("--json");
const baselinePath = join(dirname(fileURLToPath(import.meta.url)), "../evals/baseline.json");

interface BaselineFile {
  generatedAt: string;
  aggregates: AggregateScores;
}

const baseline = await readFile(baselinePath, "utf8")
  .then((raw) => JSON.parse(raw) as BaselineFile)
  .catch(() => undefined);

const result = await runRagEval();

if (result.unresolvableAnchors.length > 0) {
  if (asJson) {
    console.log(JSON.stringify({ status: "error", unresolvableAnchors: result.unresolvableAnchors }, null, 2));
  } else {
    console.error("Unresolvable golden anchors (fix goldens.ts):");
    for (const anchor of result.unresolvableAnchors) {
      console.error(`  - ${anchor}`);
    }
  }
  process.exit(1);
}

const delta = baseline
  ? {
    claimRecall: round(result.aggregates.claimRecall - baseline.aggregates.claimRecall),
    contextPrecision: round(result.aggregates.contextPrecision - baseline.aggregates.contextPrecision),
    classification: baseline.aggregates.classification
      ? {
        precision: round(result.aggregates.classification.precision - baseline.aggregates.classification.precision),
        recall: round(result.aggregates.classification.recall - baseline.aggregates.classification.recall),
        accuracy: round(result.aggregates.classification.accuracy - baseline.aggregates.classification.accuracy)
      }
      : undefined,
    noiseChunkRate: round(result.aggregates.noiseChunkRate - baseline.aggregates.noiseChunkRate),
    byTarget: Object.fromEntries(Object.entries(result.aggregates.byTarget).map(([target, bucket]) => [
      target,
      {
        claimRecall: round(bucket.claimRecall - (baseline.aggregates.byTarget[target]?.claimRecall ?? 0)),
        contextPrecision: round(bucket.contextPrecision - (baseline.aggregates.byTarget[target]?.contextPrecision ?? 0)),
        classification: baseline.aggregates.byTarget[target]?.classification
          ? {
            precision: round(bucket.classification.precision - baseline.aggregates.byTarget[target].classification.precision),
            recall: round(bucket.classification.recall - baseline.aggregates.byTarget[target].classification.recall),
            accuracy: round(bucket.classification.accuracy - baseline.aggregates.byTarget[target].classification.accuracy)
          }
          : undefined
      }
    ]))
  }
  : undefined;

if (asJson) {
  console.log(JSON.stringify({
    status: "ok",
    generatedAt: new Date().toISOString().slice(0, 10),
    aggregates: result.aggregates,
    baseline: baseline?.aggregates,
    baselineGeneratedAt: baseline?.generatedAt,
    deltaVsBaseline: delta,
    scores: result.scores
  }, null, 2));
} else {
  console.log("Per-golden scores:");
  for (const score of result.scores) {
    const flag = score.claimRecall < 1 ? " *" : "";
    const classification = score.classification;
    console.log(
      `  ${score.goldenId.padEnd(18)} target=${score.target.padEnd(18)} claimR=${score.claimRecall.toFixed(2)} clsP=${classification.precision.toFixed(2)} clsR=${classification.recall.toFixed(2)} acc=${classification.accuracy.toFixed(2)} cm=${classification.tp}/${classification.fp}/${classification.fn}/${classification.tn} noise=${score.noiseChunkRate.toFixed(2)} selected=${score.retrievedCount}${flag}`
    );
    for (const missed of score.missedAnchors) {
      console.log(`      missed: ${missed}`);
    }
  }

  console.log("\nAggregates:");
  console.log(`  goldens           ${result.aggregates.goldens}`);
  console.log(`  claim recall      ${result.aggregates.claimRecall}${formatDelta(delta?.claimRecall)}`);
  console.log(`  context precision ${result.aggregates.contextPrecision}${formatDelta(delta?.contextPrecision)}`);
  console.log(`  class precision   ${result.aggregates.classification.precision}${formatDelta(delta?.classification?.precision)}`);
  console.log(`  class recall      ${result.aggregates.classification.recall}${formatDelta(delta?.classification?.recall)}`);
  console.log(`  class accuracy    ${result.aggregates.classification.accuracy}${formatDelta(delta?.classification?.accuracy)}`);
  console.log(`  confusion matrix  TP=${result.aggregates.classification.tp} FP=${result.aggregates.classification.fp} FN=${result.aggregates.classification.fn} TN=${result.aggregates.classification.tn}`);
  console.log(`  noise chunk rate  ${result.aggregates.noiseChunkRate}${formatDelta(delta?.noiseChunkRate)}`);
  console.log("  by target:");
  for (const [target, bucket] of Object.entries(result.aggregates.byTarget)) {
    console.log(
      `    ${target.padEnd(20)} claimR=${bucket.claimRecall}${formatDelta(delta?.byTarget[target]?.claimRecall)} clsP=${bucket.classification.precision}${formatDelta(delta?.byTarget[target]?.classification?.precision)} clsR=${bucket.classification.recall}${formatDelta(delta?.byTarget[target]?.classification?.recall)} acc=${bucket.classification.accuracy}${formatDelta(delta?.byTarget[target]?.classification?.accuracy)} (n=${bucket.goldens})`
    );
  }
  if (baseline) {
    console.log(`\nBaseline: evals/baseline.json (generated ${baseline.generatedAt}); deltas shown in parentheses.`);
  } else {
    console.log("\nNo committed baseline found. Run with --write to create one.");
  }
}

if (shouldWrite) {
  await writeFile(baselinePath, `${JSON.stringify({
    generatedAt: new Date().toISOString().slice(0, 10),
    aggregates: result.aggregates
  }, null, 2)}\n`, "utf8");
  if (!asJson) {
    console.log(`Baseline written to ${baselinePath}`);
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function formatDelta(value: number | undefined): string {
  if (value === undefined) {
    return "";
  }
  const sign = value > 0 ? "+" : "";
  return ` (${sign}${value} vs baseline)`;
}
