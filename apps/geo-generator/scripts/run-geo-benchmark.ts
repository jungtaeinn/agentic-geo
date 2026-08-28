import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePdpGeo } from "@agentic-geo/pdp-geo-generator-agent";
import {
  argValue as readArg,
  buildGeneratedSourceText,
  resolveEngineConfigFromEnv,
  type GeoEvalProvider
} from "@agentic-geo/pdp-geo-eval-agent";
import {
  evalProducts,
  runGeoBenchmark,
  type EvalProductId,
  type GeneratedProductArtifact,
  type GeoEvalAggregates
} from "@agentic-geo/pdp-geo-eval-agent/benchmark";

/**
 * Citation-visibility benchmark CLI (opt-in paid tier — NOT part of CI).
 *
 * App-level wiring script: generates PDP artifacts with the generator package
 * and injects them into the eval package's benchmark runner. The two packages
 * stay dependency-free of each other — this script is the connection point.
 *
 * Usage (from apps/geo-generator):
 *   pnpm geo:benchmark -- --provider azure-openai       # human-readable paired report
 *   pnpm geo:benchmark -- --provider gemini --json           # machine-readable JSON
 *   pnpm geo:benchmark -- --provider openai --utility        # + KPR/KPC + citation-quality judges
 *   pnpm geo:benchmark -- --provider openai --write          # additionally update geo-benchmark-baseline.json
 *   pnpm geo:benchmark -- --provider openai --golden ACT-NEED,ACM-ROUTINE
 *   pnpm geo:benchmark -- --provider openai --no-cache       # ignore cached engine answers
 *
 * Provider credentials come from the environment:
 *   openai        OPENAI_API_KEY + (--model | OPENAI_MODEL)
 *   gemini        GEMINI_API_KEY + (--model | GEMINI_MODEL)
 *   azure-openai  AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT + (--deployment | AZURE_OPENAI_DEPLOYMENT) [+ AZURE_OPENAI_API_VERSION]
 *   aistudio      AISTUDIO_API_KEY + AISTUDIO_ENDPOINT + (--deployment | AISTUDIO_DEPLOYMENT) [+ AISTUDIO_API_VERSION]
 *
 * The engine answers are non-deterministic; judge scores are LLM-based. Use
 * paired deltas (generated vs vanilla on identical sources) as the signal and
 * update the baseline only for intentional improvements — the baseline lives
 * at `scripts/geo-benchmark-baseline.json` (written via --write; see
 * packages/pdp-geo-eval-agent/README.md for the update discipline).
 */

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const shouldWrite = args.includes("--write");
const includeUtility = args.includes("--utility");
const useCache = !args.includes("--no-cache");
const provider = (readArg(args, "--provider") ?? process.env.GEO_EVAL_PROVIDER ?? "") as GeoEvalProvider | "";
const goldenIds = readArg(args, "--golden")?.split(",").map((id) => id.trim()).filter(Boolean);

const baselinePath = join(dirname(fileURLToPath(import.meta.url)), "geo-benchmark-baseline.json");

interface GeoBaselineFile {
  generatedAt: string;
  engineId: string;
  aggregates: GeoEvalAggregates;
}

if (!provider) {
  console.error("Missing --provider (openai | gemini | azure-openai | aistudio). See packages/pdp-geo-eval-agent.");
  process.exit(1);
}

const engine = resolveEngineConfigFromEnv(provider, args);

const baseline = await readFile(baselinePath, "utf8")
  .then((raw) => JSON.parse(raw) as GeoBaselineFile)
  .catch(() => undefined);

// Generate PDP artifacts for every fixture product (deterministic mock path
// unless generator provider env vars are configured), then inject them.
const artifacts: Partial<Record<EvalProductId, GeneratedProductArtifact>> = {};
for (const [productId, product] of Object.entries(evalProducts)) {
  if (!asJson) {
    console.error(`  … generating PDP artifact for ${productId}`);
  }
  const locale = productId.startsWith("examplederma") ? "ko-KR" as const : "en-US" as const;
  const run = await generatePdpGeo({
    product,
    hints: { locale, market: locale === "ko-KR" ? "KR" : "US", brand: product.brand, category: product.category }
  });
  artifacts[productId as EvalProductId] = {
    publicText: buildGeneratedSourceText(run.result.content.sections),
    evidenceLedger: run.diagnostics.evidenceLedger ?? []
  };
}

const result = await runGeoBenchmark({
  engine,
  artifacts,
  includeUtility,
  goldenIds,
  useCache,
  onProgress: asJson ? undefined : (message) => console.error(`  … ${message}`)
});

const delta = baseline && baseline.engineId === result.engineId
  ? {
    deltaWordpos: round(result.aggregates.delta.wordpos - baseline.aggregates.delta.wordpos),
    generatedWordpos: round(result.aggregates.generated.wordpos - baseline.aggregates.generated.wordpos)
  }
  : undefined;

if (asJson) {
  console.log(JSON.stringify({
    status: "ok",
    engineId: result.engineId,
    aggregates: result.aggregates,
    baseline: baseline?.aggregates,
    baselineEngineId: baseline?.engineId,
    baselineGeneratedAt: baseline?.generatedAt,
    deltaVsBaseline: delta,
    scores: result.scores
  }, null, 2));
} else {
  printHumanReport();
}

if (shouldWrite) {
  await writeFile(baselinePath, `${JSON.stringify({
    generatedAt: new Date().toISOString().slice(0, 10),
    engineId: result.engineId,
    aggregates: result.aggregates
  } satisfies GeoBaselineFile, null, 2)}\n`, "utf8");
  if (!asJson) {
    console.log(`\nBaseline written to ${baselinePath}`);
  }
}

function printHumanReport(): void {
  console.log(`Engine: ${result.engineId}\n`);
  console.log("Per-golden citation share (wordpos, vanilla → generated):");
  for (const score of result.scores) {
    const gateFlag = score.gate.pass ? "" : "  GATE FAIL";
    const cacheFlag = score.vanilla.cachedAnswer && score.generated.cachedAnswer ? " (cached)" : "";
    console.log(
      `  ${score.goldenId.padEnd(14)} ${score.cepFocus.padEnd(10)} ${formatShare(score.vanilla.wordpos)} → ${formatShare(score.generated.wordpos)}  Δ=${formatDeltaValue(score.delta.wordpos)}${cacheFlag}${gateFlag}`
    );
    if (!score.gate.pass) {
      for (const failure of score.gate.failures) {
        console.log(`      fail: ${failure}`);
      }
    }
    const hallucinated = [...new Set([...score.vanilla.hallucinatedCitations, ...score.generated.hallucinatedCitations])];
    if (hallucinated.length > 0) {
      console.log(`      hallucinated citations ignored: [${hallucinated.join(", ")}]`);
    }
  }

  console.log("\nAggregates (mean share-of-voice across goldens):");
  console.log(`  vanilla    wordpos=${result.aggregates.vanilla.wordpos} word=${result.aggregates.vanilla.word} pos=${result.aggregates.vanilla.pos}`);
  console.log(`  generated  wordpos=${result.aggregates.generated.wordpos} word=${result.aggregates.generated.word} pos=${result.aggregates.generated.pos}`);
  console.log(`  delta      wordpos=${formatDeltaValue(result.aggregates.delta.wordpos)} word=${formatDeltaValue(result.aggregates.delta.word)} pos=${formatDeltaValue(result.aggregates.delta.pos)}`);
  console.log(`  gate       ${result.aggregates.gate.passed}/${result.aggregates.gate.evaluated} passed`);

  if (result.aggregates.utility) {
    const utility = result.aggregates.utility;
    console.log(`  utility    KPR=${utility.meanKpr ?? "-"} KPC=${utility.meanKpc ?? "-"} citationP=${utility.meanCitationPrecision ?? "-"} citationR=${utility.meanCitationRecall ?? "-"}`);
  }

  console.log("  by locale:");
  for (const [locale, bucket] of Object.entries(result.aggregates.byLocale)) {
    console.log(`    ${locale.padEnd(8)} Δwordpos=${formatDeltaValue(bucket.delta.wordpos)} (vanilla ${bucket.vanilla.wordpos} → generated ${bucket.generated.wordpos}, n=${bucket.goldens})`);
  }
  console.log("  by CEP focus:");
  for (const [focus, bucket] of Object.entries(result.aggregates.byCepFocus)) {
    console.log(`    ${focus.padEnd(10)} Δwordpos=${formatDeltaValue(bucket.delta.wordpos)} (n=${bucket.goldens})`);
  }

  if (baseline) {
    if (baseline.engineId === result.engineId && delta) {
      console.log(`\nBaseline: geo-benchmark-baseline.json (${baseline.generatedAt}, ${baseline.engineId})`);
      console.log(`  Δ(delta.wordpos) vs baseline: ${formatDeltaValue(delta.deltaWordpos)}`);
      console.log(`  Δ(generated.wordpos) vs baseline: ${formatDeltaValue(delta.generatedWordpos)}`);
    } else {
      console.log(`\nBaseline exists for a different engine (${baseline.engineId}); no comparison shown.`);
    }
  } else {
    console.log("\nNo committed baseline found. Run with --write to create one.");
  }
}

function formatShare(value: number): string {
  return value.toFixed(3);
}

function formatDeltaValue(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(3)}`;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
