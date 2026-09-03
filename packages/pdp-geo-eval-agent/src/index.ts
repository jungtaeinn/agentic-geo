/**
 * Public surface of the PDP GEO evaluation agent.
 *
 * Everything here consumes structural input contracts (`./types`) — this
 * package never imports the extractor or generator packages. Apps connect
 * the agents: extractor output -> generator -> this evaluator.
 */

// NOTE: this root surface must stay client-bundle safe (no node:* imports).
// The benchmark runner uses node:fs/crypto and is exported via "./benchmark".
export * from "./types";

// Citation-visibility metrics (deterministic, no LLM)
export {
  attributeCitationsToSections,
  extractCitationSentences,
  scoreCitationVisibility,
  scoreImpressionShares,
  zNormalizeScores,
  type AttributableSection,
  type CitationSectionAttribution,
  type CitationSentence,
  type CitationVisibilityScore,
  type ImpressionShares
} from "./citation/metrics";

// Image-derived attributable sections (deterministic, no LLM)
export {
  buildImageAttributableSections,
  type ImageProvenanceEntry,
  type ImageProvenanceSentence
} from "./citation/image-sections";

// Simulated generative engine (LLM adapters)
export {
  buildCitationAnswerPrompt,
  CITATION_ANSWER_INSTRUCTIONS,
  completeWithProvider,
  generateEngineAnswer,
  geoEvalEngineId,
  type GeoEvalEngineAnswer,
  type GeoEvalEngineConfig,
  type GeoEvalProvider
} from "./citation/engine";

// GEU-style utility guardrails
export {
  DEFAULT_UTILITY_GATE_THRESHOLDS,
  evaluateUtilityGate,
  judgeCitationQuality,
  judgeKeypointCoverage,
  parseCitationSupport,
  parseExtractedClaims,
  parseKeypointJudgments,
  PDP_COPY_UTILITY_GATE_THRESHOLDS,
  scoreCitationQuality,
  scoreKeypointCoverage,
  type CitationQualityScore,
  type CitationSupportJudgment,
  type CitationSupportLevel,
  type ExtractedClaim,
  type KeypointCoverageScore,
  type KeypointJudgment,
  type KeypointLabel,
  type UtilityGateInput,
  type UtilityGateResult,
  type UtilityGateThresholds
} from "./citation/utility";

// Inline citation probe (paired vanilla-vs-generated diagnostic)
export {
  buildGeneratedSourceText,
  buildProbeDistractors,
  CITATION_PROBE_INTERPRETATION,
  deriveProbeQueries,
  GEO_EVAL_TARGET_SLOT,
  runCitationProbe,
  type CitationProbeContext,
  type CitationProbeOptions,
  type CitationProbeQuery,
  type CitationProbeQueryResult,
  type CitationProbeQuerySource,
  type CitationProbeResult,
  type CitationProbeShare
} from "./citation/probe";

export { buildVanillaSourceText } from "./citation/source-text";
export { argValue, resolveEngineConfigFromEnv } from "./citation/cli";

// Quality rubric (GEO / CEP / E-E-A-T)
export {
  evaluateGeoQuality,
  formatGeoQualityEvaluationText,
  type GeoQualityDimension,
  type GeoQualityDimensionId,
  type GeoQualityEvaluation
} from "./quality/evaluate";
export { getGeoQualityCopy, type GeoQualityCopy } from "./quality/copy";
export { containsSerializedMetadata, findSerializedMetadataArtifact } from "./contracts/serialized-metadata";

// Concept-embodiment judge (LLM, opt-in — separate from the deterministic rubric above)
export {
  buildConceptEmbodimentPrompt,
  judgeConceptEmbodiment,
  parseConceptEmbodimentResponse,
  type ConceptEmbodimentAssessment,
  type ConceptEmbodimentDimension
} from "./quality/concept-judge";

// Evaluation-suite presentation helpers
export {
  buildEasyImprovementSummary,
  buildProbeNarrativeWhy,
  buildProbeSafetyNotes,
  formatImageSectionId,
  formatPctDelta,
  formatQuerySourceBreakdown,
  formatSectionAttribution,
  getEvaluationSuiteCopy,
  probeQueryOutcome,
  shareToPct,
  truncateQuote,
  type EasyImprovementItem,
  type EvaluationSuiteCopy
} from "./quality/suite";

// LLM improvement prompts
export {
  formatContentSectionsForPrompt,
  formatProbeLlmPrompt,
  formatQualityLlmPrompt,
  type ProbePromptContext,
  type QualityPromptContext
} from "./prompts/improvement";
