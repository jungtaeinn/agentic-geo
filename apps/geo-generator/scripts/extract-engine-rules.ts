import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { generatePdpGeo } from "@agentic-geo/pdp-geo-generator-agent";
import {
  argValue,
  buildGeneratedSourceText,
  buildVanillaSourceText,
  completeWithProvider,
  geoEvalEngineId,
  resolveEngineConfigFromEnv,
  type GeoEvalProvider
} from "@agentic-geo/pdp-geo-eval-agent";
import {
  evalProducts,
  geoEvalGoldens,
  type EvalProductId,
  type GeoEvalGoldenResult
} from "@agentic-geo/pdp-geo-eval-agent/benchmark";

/**
 * Engine-preference rule extraction pipeline (AutoGEO `extract_rules.py`
 * ported to this package's observation loop).
 *
 * Input: a `pnpm geo:benchmark -- --json` result file. Goldens whose paired
 * wordpos delta exceeds the threshold become preference pairs — the more-cited
 * PDP variant is the winner, the less-cited one the loser. For each pair the
 * pipeline asks an LLM WHY the engine preferred the winner (explainer), mines
 * atomic reusable rules from that explanation (extractor), consolidates them
 * (hierarchical merge), and strips query-specific phrasing (independence
 * filter).
 *
 * Output: a DRAFT rule document in the evidence-card format under
 * `apps/geo-generator/scripts/rule-drafts/`. It is intentionally NOT written into `src/rag/` —
 * observed rules enter the corpus only after human review, with rag-index
 * metadata, in a commit that attaches before/after geo:benchmark evidence.
 *
 * Resume: each pair's explanation+rules is checkpointed as an individual JSON
 * file; re-runs skip completed pairs (AutoGEO checkpoint pattern).
 *
 * Usage:
 *   pnpm geo:benchmark -- --provider azure-openai --json > /tmp/geo-eval.json
 *   pnpm geo:extract-rules -- --provider azure-openai --results /tmp/geo-eval.json
 *   # options: --threshold 0.05  --out scripts/rule-drafts/<date>  --engine-label gemini-sim
 *
 * Caveat: winner/loser texts are re-derived from the current fixtures and the
 * current generation pipeline. Run extraction close to the eval run so the
 * regenerated texts match what the engine actually scored.
 */

interface PreferencePair {
  goldenId: string;
  productId: EvalProductId;
  query: string;
  winnerText: string;
  loserText: string;
  winnerVariant: "generated" | "vanilla";
  wordposDelta: number;
}

interface PairExtraction {
  goldenId: string;
  winnerVariant: "generated" | "vanilla";
  wordposDelta: number;
  explanation: string;
  rules: string[];
}

const args = process.argv.slice(2);
const provider = (argValue(args, "--provider") ?? process.env.GEO_EVAL_PROVIDER ?? "") as GeoEvalProvider | "";
const resultsPath = argValue(args, "--results");
const threshold = Number.parseFloat(argValue(args, "--threshold") ?? "0.05");
const engineLabel = argValue(args, "--engine-label");
const MERGE_CHUNK_CHAR_BUDGET = 24000;

if (!provider || !resultsPath) {
  console.error("Usage: pnpm geo:extract-rules -- --provider <openai|gemini|azure-openai|aistudio> --results <geo-eval-json> [--threshold 0.05] [--out <dir>]");
  process.exit(1);
}

const config = resolveEngineConfigFromEnv(provider, args, 0.2);
const outDir = argValue(args, "--out")
  ?? join("scripts/rule-drafts", new Date().toISOString().slice(0, 10));

// ---------------------------------------------------------------------------
// Prompts (AutoGEO explainer / extractor / merger / filter, PDP-adapted)
// ---------------------------------------------------------------------------

const EXPLAINER_SYSTEM = "You are an expert AI analyst studying how generative search engines choose which product documents to cite.";

function buildExplainerPrompt(pair: PreferencePair): string {
  return `[Task]
Two product documents competed as sources for a generative engine answering a customer's question. Both were available alongside identical competitor documents; the engine cited the winning document substantially more (citation share difference: ${pair.wordposDelta.toFixed(3)}).

Explain in detail why the engine likely preferred the winning document. Consider factors such as:
- Directness: does it answer the customer's question head-on?
- Completeness: does it cover the aspects the question implies?
- Relevance: is the content on-topic without navigational or promotional noise?
- Structure: do headings/lists/atomic paragraphs make information easy to extract?
- Accuracy and specificity: precise names, quantities, and concrete usage details?
- Evidence presentation: are claims scoped, attributed, and verifiable?
- Conciseness: necessary information without filler?

[Customer Question]
${pair.query}

[Document A]
${pair.winnerText}

[Document B]
${pair.loserText}

[Winning Document]: Document A

[Your Explanation]
Explain the strengths of the winning document and the weaknesses of the other in relation to the customer's question.`;
}

const EXTRACTOR_SYSTEM = "You extract general, reusable content rules. Respond only with a JSON array of strings.";

function buildExtractorPrompt(explanation: string): string {
  return `[Instruction]
Based on the following explanation about why one product document was cited more by a generative engine, extract a set of general, reusable rules that define a high-quality product source document.

Rules must be objective, deterministic principles about how to PRESENT truthful product information (structure, specificity, evidence scoping, phrasing). NEVER extract a rule that would require inventing claims, metrics, or credentials that the product data does not contain.

Examples:
["The document should state the product's primary benefit in the first sentence."]
["The document should present usage steps as an ordered list.", "The document should scope clinical results with test conditions and duration."]

Return the list as a JSON array of strings. Do not use markdown fences. If no clear rules can be extracted, return [].

[Explanation]
${explanation}`;
}

const MERGER_SYSTEM = "You are an expert in information retrieval content quality. Respond only with a JSON array of strings.";

function buildMergerPrompt(rules: string[]): string {
  const rulesText = rules.map((rule) => `- ${rule}`).join("\n");
  return `[Task]
Consolidate the given list of rules into a set of core principles. Merge semantically similar rules, eliminate duplicates, and rephrase for clarity.

[Criteria for a Good Merged Rule]
1. Atomic: expresses a single, distinct idea.
2. Actionable: provides a clear, evaluatable instruction.
3. Unambiguous: uses simple, direct language.

[Example of what to avoid (over-merging)]
- Original: ["The text needs to be factual.", "The text should provide multiple viewpoints."]
- Bad merge: ["The text must be factual and provide multiple viewpoints."] (two distinct ideas — keep them separate)

Return the merged list as a single, valid JSON array of strings. No markdown fences, no explanations.

[Original Rules]
${rulesText}

[Merged Rules JSON]`;
}

const FILTER_SYSTEM = "You are a technical writer creating context-independent documentation. Respond only with the requested JSON object.";

function buildFilterPrompt(rule: string): string {
  return `[Task]
Analyze the following rule. Remove any part that makes it dependent on a specific customer "query" or "question" — at generation time the future queries are unknown, so only general principles are useful.

- If the rule contains a general principle AND a query reference, keep only the general principle.
- If the entire rule is ONLY about handling a query (e.g. "Directly answer the customer's question."), return an empty string.

Return a single JSON object: {"modifiedRule": "<string>"}

[Input Rule]
"${rule}"

[Output JSON]`;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  await mkdir(join(outDir, "pairs"), { recursive: true });

  const evalOutput = JSON.parse(await readFile(resultsPath as string, "utf8")) as {
    engineId?: string;
    scores?: GeoEvalGoldenResult[];
  };
  if (!Array.isArray(evalOutput.scores)) {
    console.error(`No scores found in ${resultsPath}. Expected the output of \`pnpm geo:benchmark -- --json\`.`);
    process.exit(1);
  }

  const pairs = await collectPreferencePairs(evalOutput.scores, threshold);
  console.error(`Found ${pairs.length} preference pair(s) with |Δwordpos| >= ${threshold} (from ${evalOutput.scores.length} goldens).`);
  if (pairs.length === 0) {
    console.error("Nothing to extract. Lower --threshold or run geo:benchmark on more goldens.");
    return;
  }

  // Stage 1: per-pair explanation + rule extraction (checkpointed).
  const extractions: PairExtraction[] = [];
  for (const pair of pairs) {
    const checkpointPath = join(outDir, "pairs", `${pair.goldenId}.json`);
    if (existsSync(checkpointPath)) {
      extractions.push(JSON.parse(await readFile(checkpointPath, "utf8")) as PairExtraction);
      console.error(`  [skip] ${pair.goldenId} (checkpoint exists)`);
      continue;
    }

    console.error(`  [explain] ${pair.goldenId} (winner=${pair.winnerVariant}, Δwordpos=${pair.wordposDelta})`);
    const explanation = await completeWithProvider(config, EXPLAINER_SYSTEM, buildExplainerPrompt(pair));
    const rulesRaw = await completeWithProvider(config, EXTRACTOR_SYSTEM, buildExtractorPrompt(explanation));
    const rules = parseJsonStringArray(rulesRaw);

    const extraction: PairExtraction = {
      goldenId: pair.goldenId,
      winnerVariant: pair.winnerVariant,
      wordposDelta: pair.wordposDelta,
      explanation,
      rules
    };
    await writeFile(checkpointPath, `${JSON.stringify(extraction, null, 2)}\n`, "utf8");
    extractions.push(extraction);
  }

  // Stage 2: hierarchical merge.
  const uniqueRules = [...new Set(extractions.flatMap((extraction) => extraction.rules))].sort();
  console.error(`Merging ${uniqueRules.length} unique rule candidate(s)…`);
  const mergedRules = await hierarchicalMerge(uniqueRules);

  // Stage 3: query-independence filter.
  console.error(`Filtering ${mergedRules.length} merged rule(s) for query independence…`);
  const filteredRules: string[] = [];
  for (const rule of mergedRules) {
    const response = await completeWithProvider(config, FILTER_SYSTEM, buildFilterPrompt(rule));
    const modified = parseModifiedRule(response);
    if (modified) {
      filteredRules.push(modified);
    }
  }
  const finalRules = [...new Set(filteredRules)].sort();

  // Output.
  await writeFile(join(outDir, "merged-rules.json"), `${JSON.stringify({
    engineId: evalOutput.engineId,
    extractionModel: geoEvalEngineId(config),
    threshold,
    pairCount: pairs.length,
    extractedRuleCount: uniqueRules.length,
    mergedRules,
    filteredRules: finalRules
  }, null, 2)}\n`, "utf8");

  const draftPath = join(outDir, "engine-preference-rules_draft.md");
  await writeFile(draftPath, buildDraftDocument(finalRules, extractions, evalOutput.engineId), "utf8");

  console.error(`\nDone. ${finalRules.length} filtered rule(s).`);
  console.error(`  - ${join(outDir, "merged-rules.json")}`);
  console.error(`  - ${draftPath}`);
  console.error("\nNEXT STEP (human review required): review the draft, remove anything that");
  console.error("encourages unevidenced claims, then move approved rules into a versioned");
  console.error("src/rag/ document with rag-index metadata and attach before/after geo:benchmark");
  console.error("deltas to the same commit. Never commit the draft directly.");
}

async function collectPreferencePairs(scores: GeoEvalGoldenResult[], minDelta: number): Promise<PreferencePair[]> {
  const generatedTextByProduct = new Map<EvalProductId, string>();
  const pairs: PreferencePair[] = [];

  for (const score of scores) {
    if (Math.abs(score.delta.wordpos) < minDelta) {
      continue;
    }
    const golden = geoEvalGoldens.find((candidate) => candidate.id === score.goldenId);
    if (!golden) {
      console.error(`  [warn] golden ${score.goldenId} not found in current goldens; skipping.`);
      continue;
    }
    if (!generatedTextByProduct.has(golden.productId)) {
      const run = await generatePdpGeo({
        product: evalProducts[golden.productId],
        hints: {
          locale: golden.locale,
          market: golden.market,
          brand: evalProducts[golden.productId].brand,
          category: evalProducts[golden.productId].category
        }
      });
      generatedTextByProduct.set(golden.productId, buildGeneratedSourceText(run.result.content.sections));
    }
    const generatedText = generatedTextByProduct.get(golden.productId) as string;
    const vanillaText = buildVanillaSourceText(evalProducts[golden.productId]);
    const generatedWon = score.delta.wordpos > 0;

    pairs.push({
      goldenId: score.goldenId,
      productId: golden.productId,
      query: golden.query,
      winnerText: generatedWon ? generatedText : vanillaText,
      loserText: generatedWon ? vanillaText : generatedText,
      winnerVariant: generatedWon ? "generated" : "vanilla",
      wordposDelta: score.delta.wordpos
    });
  }
  return pairs;
}

async function hierarchicalMerge(rules: string[]): Promise<string[]> {
  if (rules.length === 0) {
    return [];
  }
  let current = rules;
  while (totalChars(current) > MERGE_CHUNK_CHAR_BUDGET) {
    const chunks = chunkByCharBudget(current, MERGE_CHUNK_CHAR_BUDGET);
    console.error(`  merge level: ${current.length} rules -> ${chunks.length} chunks`);
    const next: string[] = [];
    for (const chunk of chunks) {
      next.push(...parseJsonStringArray(await completeWithProvider(config, MERGER_SYSTEM, buildMergerPrompt(chunk))));
    }
    current = [...new Set(next)].sort();
  }
  const finalMerged = parseJsonStringArray(await completeWithProvider(config, MERGER_SYSTEM, buildMergerPrompt(current)));
  return finalMerged.length > 0 ? [...new Set(finalMerged)].sort() : current;
}

function totalChars(rules: string[]): number {
  return rules.reduce((sum, rule) => sum + rule.length, 0);
}

function chunkByCharBudget(rules: string[], budget: number): string[][] {
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let chunkChars = 0;
  for (const rule of rules) {
    if (chunkChars + rule.length > budget && chunk.length > 0) {
      chunks.push(chunk);
      chunk = [];
      chunkChars = 0;
    }
    chunk.push(rule);
    chunkChars += rule.length;
  }
  if (chunk.length > 0) {
    chunks.push(chunk);
  }
  return chunks;
}

function parseJsonStringArray(raw: string): string[] {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    console.error(`  [warn] no JSON array in response (preview: ${text.slice(0, 120)}…); skipping.`);
    return [];
  }
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
  } catch (error) {
    console.error(`  [warn] failed to parse rule array: ${error instanceof Error ? error.message : String(error)}; skipping.`);
    return [];
  }
}

function parseModifiedRule(raw: string): string | undefined {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { modifiedRule?: unknown };
    return typeof parsed.modifiedRule === "string" && parsed.modifiedRule.trim() ? parsed.modifiedRule.trim() : undefined;
  } catch {
    return undefined;
  }
}

function buildDraftDocument(rules: string[], pairExtractions: PairExtraction[], engineId: string | undefined): string {
  const today = new Date().toISOString().slice(0, 10);
  const label = engineLabel ?? engineId ?? "unknown-engine";
  const pairLines = pairExtractions
    .map((extraction) => `  - ${extraction.goldenId}: winner=${extraction.winnerVariant}, Δwordpos=${extraction.wordposDelta}, rules=${extraction.rules.length}`)
    .join("\n");
  const ruleLines = rules.map((rule) => `- ${rule}`).join("\n");

  return `# Engine Preference Rules (DRAFT — human review required)

> Status: **draft / not reviewed**. Do NOT load this file into the generation
> RAG corpus. After review, move approved rules into a versioned
> \`src/rag/engine-preference-rules_v1.md\` with rag-index metadata
> (kind/intents/fieldTargets/ruleExtraction), and attach the before/after
> \`pnpm geo:benchmark\` deltas to the same commit.

- Source: observed citation preferences of \`${label}\` (simulated engine)
- Checked: ${today}
- Method: AutoGEO-style preference-pair mining (explainer → extractor → merge → query-independence filter)
- Preference pairs (|Δwordpos| >= ${threshold}):
${pairLines}
- Extraction model: ${geoEvalEngineId(config)}
- Do-not-use: any rule that requires adding claims, metrics, certifications, or review content without product evidence — the evidence contract always wins over citation-visibility tactics.

## Observed rules (filtered)

${ruleLines}
`;
}

await main();
