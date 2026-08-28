import type { EvalEvidenceItem } from "../types";
export {
  buildKeypointJudgePrompt,
  buildClaimExtractionPrompt,
  buildCitationSupportPrompt
} from "../prompts/citation-utility";
import {
  buildKeypointJudgePrompt,
  buildClaimExtractionPrompt,
  buildCitationSupportPrompt
} from "../prompts/citation-utility";
import { completeWithProvider, type GeoEvalEngineConfig } from "./engine";

/**
 * GEU-style utility guardrails ported from AutoGEO `geu_score.py` and adapted
 * to this package's evidence contract.
 *
 * AutoGEO needed hand-annotated key points per query; here the generation
 * pipeline already emits `diagnostics.evidenceLedger`, so the ledger itself
 * is the keypoint list. Two judge protocols are provided:
 *
 * 1. Keypoint coverage — does the generated public copy keep each ledger
 *    entry Supported (KPR) and, critically, contradict none of them (KPC)?
 *    A cosmetics-domain release gate: visibility gains must never ride on
 *    semantic distortion of the evidence.
 * 2. Citation quality — when the simulated engine cites our PDP, are its
 *    claims actually supported by the PDP text? Claim-level precision uses
 *    the max support across cited sources (AutoGEO parity) so multi-source
 *    sentences are not under-scored; recall is the cited-claim ratio.
 *
 * Prompt builders, parsers, and scorers are pure and unit-tested. Only the
 * `judge*` orchestrators call the LLM (through the shared eval-tier provider
 * adapter). Every judgment requires a justification so failed items are
 * debuggable in reports.
 */

export type KeypointLabel = "Supported" | "Omitted" | "Contradicted";

export interface KeypointJudgment {
  label: KeypointLabel;
  justification: string;
}

export interface KeypointCoverageScore {
  /** Keypoint recall: Supported / total. Higher is better. */
  kpr: number;
  /** Keypoint contradiction rate: Contradicted / total. Must stay at 0. */
  kpc: number;
  supported: number;
  omitted: number;
  contradicted: number;
  total: number;
  /** Evidence ids judged Contradicted, with justifications, for reports. */
  contradictions: Array<{ evidenceId: string; justification: string }>;
}

export interface ExtractedClaim {
  claimId: number;
  claim: string;
  sourceIndices: number[];
}

export type CitationSupportLevel = "full_support" | "partial_support" | "no_support";

export interface CitationSupportJudgment {
  support: CitationSupportLevel;
  justification: string;
}

export interface CitationQualityScore {
  /** Mean over cited claims of the max support level across their cited sources. */
  precision: number | null;
  /** Cited claims / total claims. */
  recall: number | null;
  citedClaims: number;
  totalClaims: number;
  /** Claims whose best support was below full_support, for reports. */
  weakClaims: Array<{ claim: string; bestSupport: CitationSupportLevel; justification: string }>;
}

export const CITATION_SUPPORT_VALUES: Record<CitationSupportLevel, number> = {
  no_support: 0,
  partial_support: 0.5,
  full_support: 1
};

// ---------------------------------------------------------------------------
// Parsers (pure, strict)
// ---------------------------------------------------------------------------

/** Parses the keypoint judge response; throws when any expected id is missing or malformed. */
export function parseKeypointJudgments(raw: string, expectedIds: string[]): Record<string, KeypointJudgment> {
  const parsed = parseJsonObject(raw);
  const judgments: Record<string, KeypointJudgment> = {};

  for (const id of expectedIds) {
    const entry = parsed[id];
    if (!entry || typeof entry !== "object") {
      throw new Error(`Keypoint judge response is missing evidence id "${id}".`);
    }
    const { label, justification } = entry as { label?: unknown; justification?: unknown };
    if (label !== "Supported" && label !== "Omitted" && label !== "Contradicted") {
      throw new Error(`Keypoint judge returned an invalid label for "${id}": ${String(label)}`);
    }
    if (typeof justification !== "string" || !justification.trim()) {
      throw new Error(`Keypoint judge returned no justification for "${id}".`);
    }
    judgments[id] = { label, justification: justification.trim() };
  }
  return judgments;
}

export function parseExtractedClaims(raw: string): ExtractedClaim[] {
  const parsed = parseJsonObject(raw);
  const claims = parsed.claims;
  if (!Array.isArray(claims)) {
    throw new Error("Claim extraction response has no \"claims\" array.");
  }
  return claims.map((entry, index) => {
    const record = entry as { claimId?: unknown; claim?: unknown; sourceIndices?: unknown };
    if (typeof record.claim !== "string" || !record.claim.trim()) {
      throw new Error(`Extracted claim ${index + 1} has no text.`);
    }
    const sourceIndices = Array.isArray(record.sourceIndices)
      ? record.sourceIndices.filter((value): value is number => Number.isInteger(value))
      : [];
    return {
      claimId: Number.isInteger(record.claimId) ? record.claimId as number : index + 1,
      claim: record.claim.trim(),
      sourceIndices
    };
  });
}

export function parseCitationSupport(raw: string): CitationSupportJudgment {
  const parsed = parseJsonObject(raw);
  const { support, justification } = parsed as { support?: unknown; justification?: unknown };
  if (support !== "full_support" && support !== "partial_support" && support !== "no_support") {
    throw new Error(`Citation support judge returned an invalid level: ${String(support)}`);
  }
  if (typeof justification !== "string" || !justification.trim()) {
    throw new Error("Citation support judge returned no justification.");
  }
  return { support, justification: justification.trim() };
}

// ---------------------------------------------------------------------------
// Scorers (pure)
// ---------------------------------------------------------------------------

export function scoreKeypointCoverage(judgments: Record<string, KeypointJudgment>): KeypointCoverageScore {
  const entries = Object.entries(judgments);
  const total = entries.length;
  let supported = 0;
  let omitted = 0;
  let contradicted = 0;
  const contradictions: KeypointCoverageScore["contradictions"] = [];

  for (const [evidenceId, judgment] of entries) {
    if (judgment.label === "Supported") {
      supported += 1;
    } else if (judgment.label === "Contradicted") {
      contradicted += 1;
      contradictions.push({ evidenceId, justification: judgment.justification });
    } else {
      omitted += 1;
    }
  }

  return {
    kpr: total > 0 ? supported / total : 0,
    kpc: total > 0 ? contradicted / total : 0,
    supported,
    omitted,
    contradicted,
    total,
    contradictions
  };
}

/**
 * AutoGEO-parity citation quality: precision is the mean over cited claims of
 * the MAX support across each claim's cited sources; recall is the fraction
 * of claims that carry any citation. Returns nulls when no claims exist.
 */
export function scoreCitationQuality(
  claims: ExtractedClaim[],
  supportsByClaim: Map<number, CitationSupportJudgment[]>
): CitationQualityScore {
  const totalClaims = claims.length;
  if (totalClaims === 0) {
    return { precision: null, recall: null, citedClaims: 0, totalClaims: 0, weakClaims: [] };
  }

  const citedClaims = claims.filter((claim) => claim.sourceIndices.length > 0);
  const recall = citedClaims.length / totalClaims;
  const weakClaims: CitationQualityScore["weakClaims"] = [];
  const precisionScores: number[] = [];

  for (const claim of citedClaims) {
    const supports = supportsByClaim.get(claim.claimId) ?? [];
    if (supports.length === 0) {
      // Every cited index missed the source list (hallucinated citation).
      // That is a failed citation, not missing data — score it as no_support
      // so precision cannot resolve to null and bypass the utility gate.
      precisionScores.push(CITATION_SUPPORT_VALUES.no_support);
      weakClaims.push({
        claim: claim.claim,
        bestSupport: "no_support",
        justification: "All cited source indices are out of range (hallucinated citation)."
      });
      continue;
    }
    const best = supports.reduce((bestSoFar, current) => (
      CITATION_SUPPORT_VALUES[current.support] > CITATION_SUPPORT_VALUES[bestSoFar.support] ? current : bestSoFar
    ));
    precisionScores.push(CITATION_SUPPORT_VALUES[best.support]);
    if (best.support !== "full_support") {
      weakClaims.push({ claim: claim.claim, bestSupport: best.support, justification: best.justification });
    }
  }

  return {
    precision: precisionScores.length > 0
      ? precisionScores.reduce((sum, value) => sum + value, 0) / precisionScores.length
      : citedClaims.length === 0 ? 0 : null,
    recall,
    citedClaims: citedClaims.length,
    totalClaims,
    weakClaims
  };
}

// ---------------------------------------------------------------------------
// Combined acceptance gate
// ---------------------------------------------------------------------------

export interface UtilityGateInput {
  /** Generated-minus-vanilla wordpos share delta. Undefined skips the check. */
  visibilityDelta?: number;
  keypointCoverage?: KeypointCoverageScore;
  citationQuality?: CitationQualityScore;
}

export interface UtilityGateThresholds {
  /** Visibility must improve by at least this much (default 0: no regression). */
  minVisibilityDelta: number;
  /** Contradiction rate ceiling (default 0: any contradiction fails). */
  maxKpc: number;
  /** Keypoint retention floor (AutoGEO cold-start filter used 0.8). */
  minKpr: number;
  /** Claim-level citation precision floor. */
  minCitationPrecision: number;
}

export const DEFAULT_UTILITY_GATE_THRESHOLDS: UtilityGateThresholds = {
  minVisibilityDelta: 0,
  maxKpc: 0,
  minKpr: 0.8,
  minCitationPrecision: 0.7
};

/**
 * Gate thresholds for judging PDP PUBLIC COPY against the full evidence
 * ledger. Public copy is a curated summary, so omitting ledger items is by
 * design — KPR stays reported but never fails the gate (minKpr 0). The
 * failure mode that matters here is contradiction (KPC), which stays at 0.
 * AutoGEO's 0.8 KPR floor applies to engine ANSWERS, not to source copy.
 */
export const PDP_COPY_UTILITY_GATE_THRESHOLDS: UtilityGateThresholds = {
  ...DEFAULT_UTILITY_GATE_THRESHOLDS,
  minKpr: 0
};

export interface UtilityGateResult {
  pass: boolean;
  failures: string[];
  skippedChecks: string[];
}

/**
 * AutoGEO-style combined acceptance: visibility up AND utility intact. A
 * check with no input is skipped (and reported), never silently passed as ok.
 */
export function evaluateUtilityGate(
  input: UtilityGateInput,
  thresholds: UtilityGateThresholds = DEFAULT_UTILITY_GATE_THRESHOLDS
): UtilityGateResult {
  const failures: string[] = [];
  const skippedChecks: string[] = [];

  if (input.visibilityDelta === undefined) {
    skippedChecks.push("visibilityDelta");
  } else if (input.visibilityDelta < thresholds.minVisibilityDelta) {
    failures.push(`visibility delta ${round(input.visibilityDelta)} is below ${thresholds.minVisibilityDelta}`);
  }

  if (!input.keypointCoverage) {
    skippedChecks.push("keypointCoverage");
  } else {
    if (input.keypointCoverage.kpc > thresholds.maxKpc) {
      failures.push(`KPC ${round(input.keypointCoverage.kpc)} exceeds ${thresholds.maxKpc} (${input.keypointCoverage.contradicted} contradicted evidence item(s))`);
    }
    if (input.keypointCoverage.kpr < thresholds.minKpr) {
      failures.push(`KPR ${round(input.keypointCoverage.kpr)} is below ${thresholds.minKpr}`);
    }
  }

  if (!input.citationQuality || input.citationQuality.precision === null) {
    skippedChecks.push("citationQuality");
  } else if (input.citationQuality.precision < thresholds.minCitationPrecision) {
    failures.push(`citation precision ${round(input.citationQuality.precision)} is below ${thresholds.minCitationPrecision}`);
  }

  return { pass: failures.length === 0, failures, skippedChecks };
}

// ---------------------------------------------------------------------------
// LLM orchestrators (eval tier only)
// ---------------------------------------------------------------------------

const JUDGE_MAX_RETRIES = 3;

/** Judges keypoint coverage of `publicText` against the evidence ledger. */
export async function judgeKeypointCoverage(
  config: GeoEvalEngineConfig,
  evidence: EvalEvidenceItem[],
  publicText: string
): Promise<{ score: KeypointCoverageScore; judgments: Record<string, KeypointJudgment> }> {
  if (evidence.length === 0) {
    throw new Error("judgeKeypointCoverage requires a non-empty evidence ledger.");
  }
  const prompt = buildKeypointJudgePrompt(evidence, publicText);
  const expectedIds = evidence.map((item) => item.id);
  const judgments = await callJudgeWithRetries(
    () => completeWithProvider(config, prompt.system, prompt.user),
    (raw) => parseKeypointJudgments(raw, expectedIds)
  );
  return { score: scoreKeypointCoverage(judgments), judgments };
}

/** Extracts claims from an engine answer and checks each cited source's support. */
export async function judgeCitationQuality(
  config: GeoEvalEngineConfig,
  answer: string,
  documents: string[]
): Promise<CitationQualityScore> {
  const extractionPrompt = buildClaimExtractionPrompt(answer);
  const claims = await callJudgeWithRetries(
    () => completeWithProvider(config, extractionPrompt.system, extractionPrompt.user),
    parseExtractedClaims
  );

  const supportsByClaim = new Map<number, CitationSupportJudgment[]>();
  for (const claim of claims) {
    if (claim.sourceIndices.length === 0) {
      continue;
    }
    const supports: CitationSupportJudgment[] = [];
    for (const sourceIndex of claim.sourceIndices) {
      const document = documents[sourceIndex];
      if (document === undefined) {
        continue;
      }
      const supportPrompt = buildCitationSupportPrompt(claim.claim, document);
      supports.push(await callJudgeWithRetries(
        () => completeWithProvider(config, supportPrompt.system, supportPrompt.user),
        parseCitationSupport
      ));
    }
    supportsByClaim.set(claim.claimId, supports);
  }

  return scoreCitationQuality(claims, supportsByClaim);
}

async function callJudgeWithRetries<T>(request: () => Promise<string>, parse: (raw: string) => T): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < JUDGE_MAX_RETRIES; attempt += 1) {
    try {
      return parse(await request());
    } catch (error) {
      lastError = error;
      if (attempt < JUDGE_MAX_RETRIES - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
      }
    }
  }
  throw new Error(`Judge call failed after ${JUDGE_MAX_RETRIES} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("Judge response contains no JSON object.");
  }
  const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Judge response is not a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
