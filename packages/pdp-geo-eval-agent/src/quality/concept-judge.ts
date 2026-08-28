import type { EvalUiLanguage, GeoQualityEvalInput } from "../types";
export { buildConceptEmbodimentPrompt } from "../prompts/concept-embodiment";
import { buildConceptEmbodimentPrompt } from "../prompts/concept-embodiment";
import { completeWithProvider, type GeoEvalEngineConfig } from "../citation/engine";
import type { GeoQualityDimensionId } from "./evaluate";

/**
 * LLM-based CONCEPT EMBODIMENT judge — a separate, opt-in assessment layered
 * on top of the deterministic quality rubric (`evaluate.ts`). It never
 * touches the rubric's scores; it answers a different question: not "is the
 * schema well-formed and safely worded" (the rubric), but "did the GEO/CEP/
 * E-E-A-T CONCEPTS actually make it into the public copy, in substance".
 *
 * The three concepts are judged by FUNCTION, not by keyword presence — the
 * criteria below describe what each concept does for a reader/engine, and
 * the model must judge whether the copy performs that function. Fairness is
 * enforced structurally: the prompt is given the same source-signal
 * booleans/counts the generator itself reads (`normalizedProduct`), with an
 * explicit instruction never to penalize the absence of a signal the source
 * never had, and never to suggest inventing content beyond the source.
 */

const CONCEPT_DIMENSION_IDS: GeoQualityDimensionId[] = ["geo", "cep", "eeat"];

export interface ConceptEmbodimentDimension {
  id: GeoQualityDimensionId;
  score: number;
  /** Concept elements that ARE embodied in the copy, with a quote/paraphrase of where. */
  embodied: string[];
  /** Concept elements backed by an available source signal but not embodied in the copy. */
  missing: string[];
  /** Actionable instructions to restructure/surface EXISTING content — never to add new facts. */
  improvements: string[];
}

export interface ConceptEmbodimentAssessment {
  /** Rounded mean of the three dimension scores — computed here, not trusted from the model. */
  overallScore: number;
  dimensions: ConceptEmbodimentDimension[];
  summary: string;
}

// ---------------------------------------------------------------------------
// Parser (pure, strict)
// ---------------------------------------------------------------------------

export function parseConceptEmbodimentResponse(raw: string): ConceptEmbodimentAssessment {
  const parsed = parseJsonObject(raw);
  const dimensionsRaw = parsed.dimensions;
  if (!dimensionsRaw || typeof dimensionsRaw !== "object" || Array.isArray(dimensionsRaw)) {
    throw new Error("Concept embodiment response has no \"dimensions\" object.");
  }
  const dimensionsRecord = dimensionsRaw as Record<string, unknown>;
  const dimensions = CONCEPT_DIMENSION_IDS.map((id) => parseConceptDimension(id, dimensionsRecord[id]));

  const summary = parsed.summary;
  if (typeof summary !== "string" || !summary.trim()) {
    throw new Error("Concept embodiment response has no \"summary\" text.");
  }

  return {
    overallScore: Math.round(dimensions.reduce((sum, dimension) => sum + dimension.score, 0) / dimensions.length),
    dimensions,
    summary: summary.trim()
  };
}

// ---------------------------------------------------------------------------
// Orchestrator (eval tier only)
// ---------------------------------------------------------------------------

/**
 * Judges concept embodiment for one PDP. `complete` defaults to the shared
 * eval-tier provider adapter and is injectable for tests — mirrors the
 * pattern used by `judgeKeypointCoverage` in `../citation/utility.ts`.
 */
export async function judgeConceptEmbodiment(
  input: GeoQualityEvalInput,
  config: GeoEvalEngineConfig,
  language: EvalUiLanguage,
  complete: (config: GeoEvalEngineConfig, system: string, user: string) => Promise<string> = completeWithProvider
): Promise<ConceptEmbodimentAssessment> {
  const prompt = buildConceptEmbodimentPrompt(input, language);
  const raw = await complete(config, prompt.system, prompt.user);
  return parseConceptEmbodimentResponse(raw);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseConceptDimension(id: GeoQualityDimensionId, raw: unknown): ConceptEmbodimentDimension {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Concept embodiment response is missing the "${id}" dimension.`);
  }
  const record = raw as Record<string, unknown>;
  const score = record.score;
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 100) {
    throw new Error(`Concept embodiment response has an out-of-range score for "${id}": ${String(score)}`);
  }
  return {
    id,
    score: Math.round(score),
    embodied: parseStringArray(record.embodied, id, "embodied"),
    missing: parseStringArray(record.missing, id, "missing"),
    improvements: parseStringArray(record.improvements, id, "improvements")
  };
}

function parseStringArray(value: unknown, id: string, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Concept embodiment response has a non-array "${field}" for "${id}".`);
  }
  return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("Concept embodiment judge response contains no JSON object.");
  }
  const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Concept embodiment judge response is not a JSON object.");
  }
  return parsed as Record<string, unknown>;
}
