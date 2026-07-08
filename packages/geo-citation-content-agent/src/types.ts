export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type GeoCitationSurface = "reddit" | "youtube" | "blog";
export type SupportedGeoCitationSurface = "reddit";
export type GeoCitationLocale = "ko-KR" | "ja-JP" | "en-US" | "en-GB";
export type GeoCitationProviderId = "mock" | "azure-openai" | "custom";

/** Azure deployment names mapped to generation roles. */
export interface GeoCitationAzureRoleDeployments {
  reasoning?: string;
}

export type GeoCitationEvidenceSourceType =
  | "product"
  | "review"
  | "image"
  | "news"
  | "paper"
  | "existing-geo"
  | "custom";

export type GeoCitationContentAngle =
  | "claim-check"
  | "comparison"
  | "use-case-fit"
  | "review-pattern"
  | "skeptical-research"
  | "buyer-question";

export type GeoCitationToneProfile =
  | "curious-neutral"
  | "skeptical-but-fair"
  | "practical-research"
  | "community-question";

export type GeoCitationGenerationMode = "single-best" | "multi-candidate";
export type GeoCitationVariantDiversity = "low" | "medium" | "high";

export interface GeoCitationSourceInfo {
  type?: "pdp-extractor" | "pdp-geo-generator" | "rest-api" | "manual-json" | "unknown";
  url?: string;
  apiName?: string;
  observedAt?: string;
}

export interface GeoCitationEvidenceInput {
  id?: string;
  sourceType?: GeoCitationEvidenceSourceType;
  title?: string;
  text?: string;
  url?: string;
  author?: string;
  rating?: number;
  publishedAt?: string;
  observedAt?: string;
  metadata?: JsonObject;
}

export interface GeoCitationEvidenceBuckets {
  reviews?: unknown[];
  images?: unknown[];
  newsArticles?: unknown[];
  researchPapers?: unknown[];
  existingGeoArtifacts?: unknown[];
  custom?: unknown[];
}

export interface GeoCitationTargetSettings {
  surface: GeoCitationSurface;
  locale?: GeoCitationLocale;
  market?: string;
  audience?: string;
  communityOrChannelHint?: string;
}

export interface GeoCitationVariantSettings {
  count?: number;
  diversity?: GeoCitationVariantDiversity;
  avoidNearDuplicate?: boolean;
  seed?: string;
}

export interface GeoCitationStrategySettings {
  searchQueries?: string[];
  citationGoals?: string[];
  contentAngle?: GeoCitationContentAngle;
  avoidPromotionalTone?: boolean;
  variants?: GeoCitationVariantSettings;
  generationMode?: GeoCitationGenerationMode;
}

export type GeoCitationRagMode = "local-versioned-rag" | "managed-vector-store-rag";

export interface GeoCitationRagSettings {
  mode?: GeoCitationRagMode;
  maxChunks?: number;
  scoreThreshold?: number;
  documents?: Array<{
    name: string;
    content: string;
    version?: string;
    sourceRole?: GeoCitationRagSourceRole;
  }>;
  analysisPrompt?: string;
}

export interface GeoCitationContentInput {
  product: unknown;
  source?: GeoCitationSourceInfo;
  evidence?: GeoCitationEvidenceBuckets;
  target?: GeoCitationTargetSettings;
  strategy?: GeoCitationStrategySettings;
  rag?: GeoCitationRagSettings;
}

export interface GeoCitationGeneratorOptions {
  provider?: GeoCitationProviderId;
  apiKey?: string;
  model?: string;
  endpoint?: string;
  deployment?: string;
  deployments?: GeoCitationAzureRoleDeployments;
  apiVersion?: string;
  temperature?: number;
  rag?: GeoCitationRagSettings;
  ragDocuments?: GeoCitationRagDocument[];
  customDraftWriter?: GeoCitationDraftWriter;
  onProgress?: (step: GeoCitationGenerationStep) => void;
}

export interface GeoCitationNormalizedProduct {
  name: string;
  description?: string;
  brand?: string;
  category?: string;
  benefits: string[];
  effects: string[];
  ingredients: string[];
  usage: string[];
  images: string[];
  reviewKeywords: string[];
  sourceTexts: string[];
  observedAt?: string;
}

export interface GeoCitationNormalizedEvidence {
  id: string;
  sourceType: GeoCitationEvidenceSourceType;
  title?: string;
  text: string;
  url?: string;
  author?: string;
  rating?: number;
  publishedAt?: string;
  observedAt?: string;
  freshness?: "recent" | "dated" | "unknown";
  metadata?: JsonObject;
}

export interface GeoCitationEvidenceChunk {
  id: string;
  evidenceId: string;
  sourceType: GeoCitationEvidenceSourceType;
  title?: string;
  text: string;
  url?: string;
  publishedAt?: string;
  observedAt?: string;
  keywords: string[];
}

export interface GeoCitationRetrievedChunk extends GeoCitationEvidenceChunk {
  score: number;
  reason: string;
}

export interface GeoCitationEvidenceReference {
  id: string;
  sourceType: GeoCitationEvidenceSourceType;
  title?: string;
  text: string;
  url?: string;
  rating?: number;
  publishedAt?: string;
  observedAt?: string;
}

/** A short verbatim excerpt safe to quote directly in public copy. */
export interface GeoCitationQuotableEvidence {
  evidenceId: string;
  sourceType: GeoCitationEvidenceSourceType;
  quote: string;
  attribution: string;
}

export interface GeoCitationClaimWithEvidence {
  claim: string;
  evidenceRefs: string[];
  confidence: "high" | "medium" | "low";
  caveat?: string;
}

export interface GeoCitationAnswerChunk {
  question: string;
  answer: string;
  evidenceRefs: string[];
  caveat?: string;
}

export interface GeoCitationContentBrief {
  productSummary: string;
  freshnessStatement: string;
  searchIntent: string[];
  citationAngles: string[];
  eeatSignals: string[];
  cepContexts: string[];
  evidenceBackedClaims: GeoCitationClaimWithEvidence[];
  answerChunks: GeoCitationAnswerChunk[];
  caveats: string[];
  comparisonPoints: string[];
  audienceContexts: string[];
  evidenceMap: GeoCitationEvidenceReference[];
  quotableEvidence: GeoCitationQuotableEvidence[];
  statisticsHighlights: string[];
}

export interface RedditCitationArtifact {
  surface: "reddit";
  title: string;
  bodyMarkdown: string;
  flairSuggestion?: string;
  subredditFitNotes: string[];
  disclosureNote?: string;
  commentSeeds: string[];
}

export type GeoCitationArtifact = RedditCitationArtifact;

export interface GeoCitationContentStrategy {
  searchIntent: string[];
  citationAngles: string[];
  evidenceMap: GeoCitationEvidenceReference[];
  eeatSignals: string[];
  cepContexts: string[];
  variantStrategy: RedditContentVariantStrategy;
}

export interface RedditContentVariantStrategy {
  variantId: string;
  angle: GeoCitationContentAngle;
  titlePattern:
    | "is-it-worth-it"
    | "who-is-this-for"
    | "claim-vs-reality"
    | "comparison-question"
    | "what-i-found";
  evidenceFocus: GeoCitationEvidenceSourceType[];
  toneProfile: GeoCitationToneProfile;
  communityQuestion: string;
  flairSuggestion: string;
}

export interface GeoCitationReadinessCheck {
  id:
    | "answer-ready-title"
    | "short-version-chunks"
    | "tldr-position"
    | "claim-evidence-language"
    | "quotation-or-statistic"
    | "source-type-separation"
    | "caveat-limitation"
    | "comparison-context"
    | "community-question"
    | "anti-promo"
    | "freshness-signal";
  label: string;
  passed: boolean;
  weight: number;
  message: string;
}

export interface GeoCitationKeywordCoverage {
  required: string[];
  present: string[];
  missing: string[];
  coverageRatio: number;
}

export interface GeoCitationReadinessReport {
  passed: boolean;
  score: number;
  checks: GeoCitationReadinessCheck[];
  keywordCoverage: GeoCitationKeywordCoverage;
  structureSignals: string[];
  warnings: string[];
}

export type GeoCitationDiagnosticSource =
  | "input"
  | "rag"
  | "evidence"
  | "llm"
  | "validation"
  | "repair"
  | "readiness";

export interface GeoCitationEvidenceDiagnostic {
  field: string;
  source: GeoCitationDiagnosticSource;
  value: string;
}

export interface GeoCitationRecommendation {
  field: string;
  message: string;
  reason: string;
}

export interface GeoCitationRagUsageDiagnostic {
  source: string;
  sourceType: GeoCitationEvidenceSourceType;
  score: number;
  usage: string;
  excerpt: string;
}

export interface GeoCitationRuntimeUsage {
  provider: GeoCitationProviderId;
  service: string;
  deployment?: string;
  model?: string;
  called: boolean;
  details: string;
  counts: {
    mandatoryRagDocuments: number;
    surfaceRagDocuments: number;
    evidenceItems: number;
    evidenceChunks: number;
    selectedRagChunks: number;
    answerChunks: number;
  };
}

export interface GeoCitationDiagnostics {
  mandatoryRagDocuments: string[];
  surfaceRagDocuments: string[];
  recommendations: GeoCitationRecommendation[];
  evidence: GeoCitationEvidenceDiagnostic[];
  selectedRagChunks: GeoCitationRetrievedChunk[];
  ragUsage: GeoCitationRagUsageDiagnostic[];
  runtimeUsage: GeoCitationRuntimeUsage;
  usedEvidence: GeoCitationEvidenceReference[];
  unsupportedClaims: string[];
  channelWarnings: string[];
  validationWarnings: string[];
  promotionalToneScore: number;
  geoCitationReadiness: GeoCitationReadinessReport;
  variantStrategy: RedditContentVariantStrategy;
  normalizedProduct: GeoCitationNormalizedProduct;
  generatedAt: string;
}

export interface GeoCitationGenerationResult {
  artifact: GeoCitationArtifact;
  brief: GeoCitationContentBrief;
  strategy: GeoCitationContentStrategy;
  diagnostics: GeoCitationDiagnostics;
}

export interface GeoCitationContentRun {
  result: GeoCitationGenerationResult;
  diagnostics: GeoCitationDiagnostics;
  process: GeoCitationGenerationStep[];
}

export type GeoCitationGenerationStageId =
  | "input"
  | "normalize"
  | "mandatory-rag-load"
  | "surface-rag-load"
  | "evidence-normalize"
  | "chunk"
  | "retrieve"
  | "rerank"
  | "brief"
  | "generate"
  | "validate"
  | "repair"
  | "artifact";

export interface GeoCitationGenerationStep {
  id: GeoCitationGenerationStageId;
  title: string;
  description: string;
  status: "pending" | "running" | "done" | "error";
  message?: string;
  startedAt?: string;
  completedAt?: string;
}

export type GeoCitationRagSourceRole = "mandatory-policy" | "surface-guideline" | "evidence" | "custom";

export interface GeoCitationRagDocument {
  name: string;
  content: string;
  version?: string;
  sourceRole?: GeoCitationRagSourceRole;
  surface?: GeoCitationSurface;
  mandatory?: boolean;
}

export interface GeoCitationDraftWriterRequest {
  product: GeoCitationNormalizedProduct;
  target: Required<GeoCitationTargetSettings>;
  brief: GeoCitationContentBrief;
  variantStrategy: RedditContentVariantStrategy;
  mandatoryRagDocuments: GeoCitationRagDocument[];
  surfaceRagDocuments: GeoCitationRagDocument[];
  prompt: string;
}

export interface GeoCitationDraftWriterResult {
  artifact: RedditCitationArtifact;
}

export interface GeoCitationDraftWriter {
  writeRedditArtifact(request: GeoCitationDraftWriterRequest): Promise<GeoCitationDraftWriterResult>;
}
