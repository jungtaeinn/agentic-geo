import { z } from "zod";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/** Locales supported by the first PDP GEO generator. */
export type PdpGeoLocale = "ko-KR" | "ja-JP" | "en-US" | "en-GB";

/** RAG retrieval modes. Local mode is provider-neutral; managed mode can use OpenAI or a custom adapter. */
export type PdpGeoRagMode = "local-versioned-rag" | "managed-vector-store-rag";

/** Provider IDs kept intentionally broad so non-OpenAI vector stores can be added later. */
export type PdpGeoRagProvider = "local" | "openai" | "custom";

/** Embedding provider IDs for local or managed retrieval implementations. */
export type PdpGeoEmbeddingProvider = "local" | "openai" | "custom";

/** Reranker IDs used by the retrieval stage. */
export type PdpGeoRerankerProvider = "local-hybrid" | "openai-file-search" | "custom";

/** Model provider IDs accepted by optional model-backed refinement hooks. */
export type PdpGeoProviderId = "mock" | "openai" | "gemini" | "azure-openai" | "custom";

/** Schema graph targets supported by the generator. */
export type PdpGeoSchemaTarget = "WebPage" | "Product" | "FAQPage" | "HowTo" | "BreadcrumbList";

/** Source metadata for diagnostics and schema ID generation. */
export interface PdpGeoSourceInfo {
  type?: "pdp-extractor" | "rest-api" | "manual-json" | "unknown";
  url?: string;
  apiName?: string;
}

/** Locale, market, and content strategy hints that can override automatic inference. */
export interface PdpGeoGenerationHints {
  locale?: PdpGeoLocale;
  market?: "KR" | "JP" | "US" | "GB" | string;
  brand?: string;
  category?: string;
  targetAudience?: string;
  tone?: string;
  schemaTargets?: PdpGeoSchemaTarget[];
}

/** Optional mapping from internal signal names to arbitrary REST JSON paths. */
export interface PdpGeoFieldMapping {
  name?: string | string[];
  description?: string | string[];
  brand?: string | string[];
  category?: string | string[];
  price?: string | string[];
  currency?: string | string[];
  images?: string | string[];
  options?: string | string[];
  benefits?: string | string[];
  effects?: string | string[];
  ingredients?: string | string[];
  usage?: string | string[];
  faq?: string | string[];
  reviews?: string | string[];
  rating?: string | string[];
  reviewCount?: string | string[];
  breadcrumbs?: string | string[];
}

/** RAG runtime settings. */
export interface PdpGeoRagSettings {
  mode?: PdpGeoRagMode;
  provider?: PdpGeoRagProvider;
  embeddingProvider?: PdpGeoEmbeddingProvider;
  embeddingModel?: string;
  rerankerProvider?: PdpGeoRerankerProvider;
  vectorStoreId?: string;
  maxChunks?: number;
  scoreThreshold?: number;
  rewriteQuery?: boolean;
  managedSearchEndpoint?: string;
  resolveUrls?: boolean;
  maxResolvedUrlDocuments?: number;
  urlFetchTimeoutMs?: number;
  allowedUrlDomains?: string[];
  documents?: Array<{
    name: string;
    content: string;
    version?: string;
  }>;
  analysisPrompt?: string;
}

/** User-facing request shape accepted by the GEO generation pipeline. */
export interface PdpGeoGenerationInput {
  product: unknown;
  source?: PdpGeoSourceInfo;
  hints?: PdpGeoGenerationHints;
  fieldMapping?: PdpGeoFieldMapping;
  rag?: PdpGeoRagSettings;
}

/** Runtime options passed by apps or REST handlers. */
export interface PdpGeoGeneratorOptions {
  provider?: PdpGeoProviderId;
  apiKey?: string;
  model?: string;
  endpoint?: string;
  deployment?: string;
  deployments?: {
    ocr?: string;
    reasoning?: string;
    embedding?: string;
  };
  apiVersion?: string;
  embedding?: {
    provider?: "local" | "azure-openai";
    apiKey?: string;
    endpoint?: string;
    deployment?: string;
    apiVersion?: string;
    model?: string;
  };
  reranker?: {
    provider?: "local-hybrid" | "cohere" | "azure-ai-search-semantic";
    apiKey?: string;
    endpoint?: string;
    model?: string;
    indexName?: string;
    semanticConfiguration?: string;
    queryLanguage?: string;
  };
  analysisPrompt?: string;
  ragDocuments?: Array<{
    name: string;
    content: string;
    version?: string;
  }>;
  rag?: PdpGeoRagSettings;
  onProgress?: (step: PdpGeoGenerationStep) => void;
  customRetriever?: PdpGeoRetriever;
  customReasoner?: PdpGeoReasoner;
  customUrlResolver?: PdpGeoRagUrlResolver;
  keywordNormalization?: PdpGeoKeywordNormalizationSettings;
  customKeywordNormalizer?: PdpGeoKeywordNormalizer;
  copyRefinement?: PdpGeoCopyRefinementSettings;
  customCopyRefiner?: PdpGeoCopyRefiner;
}

export interface PdpGeoFaqItem {
  question: string;
  answer: string;
}

export interface PdpGeoReviewItem {
  body: string;
  author?: string;
  rating?: number;
  datePublished?: string;
}

export interface PdpGeoBreadcrumbItem {
  name: string;
  url?: string;
}

/** Normalized product facts inferred from arbitrary product JSON. */
export interface PdpProductSignal {
  name: string;
  originalName?: string;
  description?: string;
  brand?: string;
  category?: string;
  price?: {
    raw: string;
    amount?: number;
    currency?: string;
  };
  images: string[];
  options: string[];
  benefits: string[];
  effects: string[];
  ingredients: string[];
  usage: string[];
  metrics: string[];
  faq: PdpGeoFaqItem[];
  reviews: {
    rating?: number;
    reviewCount?: number;
    items: PdpGeoReviewItem[];
    keywords: string[];
  };
  breadcrumbs: PdpGeoBreadcrumbItem[];
  sourceTexts: string[];
}

export type PdpGeoRagKind = "schema" | "eeat" | "cep" | "best-practice" | "geo-research" | "official-docs" | "locale" | "terminology" | "product" | "custom";
export type PdpGeoRagIntent = "faq" | "howTo" | "claims" | "customer" | "review" | "schema" | "locale" | "evidence" | "retrieval" | "general";
export type PdpGeoRagFieldTarget =
  | "WebPage.description"
  | "Product.description"
  | "Product.additionalProperty"
  | "Product.positiveNotes"
  | "FAQPage.mainEntity"
  | "HowTo.step"
  | "BreadcrumbList"
  | "PDP.content"
  | "diagnostics"
  | "retrieval";

export interface PdpGeoRagChunk {
  id: string;
  source: string;
  title?: string;
  text: string;
  kind: PdpGeoRagKind;
  intents?: PdpGeoRagIntent[];
  fieldTargets?: PdpGeoRagFieldTarget[];
  metadata: Record<string, string | number | boolean>;
  score?: number;
}

export interface PdpGeoRetrievedChunk extends PdpGeoRagChunk {
  score: number;
}

export interface PdpGeoRetrieverRequest {
  query: string;
  product: PdpProductSignal;
  locale: PdpGeoLocale;
  market?: string;
  documents: Array<{
    name: string;
    content: string;
    version?: string;
  }>;
  settings: Required<Pick<PdpGeoRagSettings, "mode" | "provider" | "embeddingProvider" | "rerankerProvider">> & PdpGeoRagSettings;
}

export interface PdpGeoRetriever {
  retrieve(request: PdpGeoRetrieverRequest): Promise<PdpGeoRetrievedChunk[]>;
}

export interface PdpGeoRagUrlResolverRequest {
  url: string;
  sourceDocumentName: string;
  sourceDocumentVersion?: string;
}

export interface PdpGeoRagUrlResolvedDocument {
  url: string;
  title?: string;
  content: string;
  contentType?: string;
}

export interface PdpGeoRagUrlResolver {
  resolve(request: PdpGeoRagUrlResolverRequest): Promise<PdpGeoRagUrlResolvedDocument | undefined>;
}

export type PdpGeoReasoningPrinciple =
  | "answer-ready FAQ"
  | "stepwise HowTo"
  | "evidence-backed claims"
  | "target customer context"
  | "review-intent FAQ";

export interface PdpGeoReasoningDecision {
  principle: PdpGeoReasoningPrinciple;
  enabled: boolean;
  confidence: number;
  ragSources: string[];
  productEvidence: string[];
  rationale: string;
}

export interface PdpGeoReasoningResult {
  mode: "explicit-rag-product-reasoning";
  queryIntents: string[];
  selectedSources: string[];
  productEvidence: {
    benefits: string[];
    effects: string[];
    ingredients: string[];
    usage: string[];
    reviews: string[];
    faq: string[];
    sourceBackedClaims: string[];
  };
  decisions: PdpGeoReasoningDecision[];
  principles: PdpGeoReasoningPrinciple[];
}

export interface PdpGeoReasonerRequest {
  product: PdpProductSignal;
  locale: PdpGeoLocale;
  market?: string;
  ragChunks: PdpGeoRetrievedChunk[];
}

export interface PdpGeoReasoner {
  reason(request: PdpGeoReasonerRequest): Promise<PdpGeoReasoningResult> | PdpGeoReasoningResult;
}

export interface PdpGeoRagUsageReference {
  source: string;
  title?: string;
  kind: PdpGeoRagKind;
  intents: PdpGeoRagIntent[];
  fieldTargets: PdpGeoRagFieldTarget[];
  score: number;
  usage: string;
  excerpt: string;
}

export interface PdpGeoRagUsageDiagnostic {
  principle: PdpGeoReasoningPrinciple;
  enabled: boolean;
  confidence: number;
  rationale: string;
  ragSources: string[];
  productEvidenceCount: number;
  references: PdpGeoRagUsageReference[];
}

export interface PdpGeoKeywordNormalizationRequest {
  productName: string;
  locale: PdpGeoLocale;
  market?: string;
  reviewKeywords: string[];
  reviewBodies: string[];
  benefits: string[];
  effects: string[];
  sourceTexts: string[];
}

export interface PdpGeoKeywordCorrection {
  original: string;
  normalized: string;
  confidence: number;
  reason?: string;
}

export interface PdpGeoKeywordNormalizationResult {
  corrections: PdpGeoKeywordCorrection[];
  warnings?: string[];
  rawText?: string;
  usage?: PdpGeoTokenUsage;
}

export interface PdpGeoKeywordNormalizer {
  normalizeKeywords(request: PdpGeoKeywordNormalizationRequest): Promise<PdpGeoKeywordNormalizationResult>;
}

export interface PdpGeoKeywordNormalizationSettings {
  enabled?: boolean;
  provider?: PdpGeoProviderId;
  apiKey?: string;
  model?: string;
  endpoint?: string;
  deployment?: string;
  apiVersion?: string;
  confidenceThreshold?: number;
  maxKeywords?: number;
}

export interface PdpGeoCopyRefinementRequest {
  product: PdpProductSignal;
  locale: PdpGeoLocale;
  market?: string;
  schemaMarkup: PdpGeoSchemaMarkup;
  content: PdpGeoContentArtifact;
  ragChunks: PdpGeoRetrievedChunk[];
  reasoning?: PdpGeoReasoningResult;
}

export interface PdpGeoCopyRefinementResult {
  schemaDescriptions?: {
    webPage?: string;
    product?: string;
  };
  contentSections?: Partial<Pick<PdpGeoContentSections, "description">>;
  warnings?: string[];
  rawText?: string;
  usage?: PdpGeoTokenUsage;
}

export interface PdpGeoCopyRefiner {
  refineCopy(request: PdpGeoCopyRefinementRequest): Promise<PdpGeoCopyRefinementResult> | PdpGeoCopyRefinementResult;
}

export interface PdpGeoCopyRefinementSettings {
  enabled?: boolean;
  provider?: PdpGeoProviderId;
  apiKey?: string;
  model?: string;
  endpoint?: string;
  deployment?: string;
  apiVersion?: string;
}

export interface PdpGeoContentSections {
  productName: string;
  description: string;
  quickFacts: string;
  benefits: string;
  ingredients: string;
  howToUse: string;
  faq: string;
}

export interface PdpGeoSchemaMarkup {
  jsonLd: JsonObject;
  scriptTag: string;
}

export interface PdpGeoContentArtifact {
  html: string;
  sections: PdpGeoContentSections;
}

export interface PdpGeoRecommendation {
  field: "productName" | "description" | "quickFacts" | "benefits" | "ingredients" | "howToUse" | "faq" | "schema" | "terminology";
  message: string;
  reason: string;
}

export interface PdpGeoEvidence {
  field: string;
  source: "input" | "fieldMapping" | "rag" | "terminology" | "schema-validator" | "html-validator" | "repair" | "llm";
  value: string;
}

export interface PdpGeoValidationRepair {
  field: string;
  source: "schema-validator" | "html-validator" | "sentence-qa";
  issue: string;
  action: string;
  before?: JsonValue;
  after?: JsonValue;
  evidence?: string[];
}

export interface PdpGeoTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface PdpGeoRuntimePipelineStep {
  stage: "chunking" | "embedding" | "retrieval" | "reranking" | "ocr" | "final";
  label: string;
  provider?: string;
  service?: string;
  model?: string;
  deployment?: string;
  mode?: string;
  called: boolean;
  tokenUsage?: PdpGeoTokenUsage;
  details?: string;
}

export interface PdpGeoRuntimeUsage {
  steps: PdpGeoRuntimePipelineStep[];
  tokenTotals: PdpGeoTokenUsage;
  tokenNote?: string;
}

export type PdpGeoOcrSentenceIntent = "benefit" | "effect" | "ingredient" | "usage" | "review";

export interface PdpGeoOcrSentenceDiagnostic {
  text: string;
  imageUrls?: string[];
  intents: PdpGeoOcrSentenceIntent[];
  schemaFields: string[];
  geoUse: string;
}

export interface PdpGeoTerminologyDiagnostics {
  locale: PdpGeoLocale;
  market?: string;
  appliedTerms: Array<{
    concept: string;
    term: string;
    field: string;
  }>;
  avoidedTerms: Array<{
    concept: string;
    term: string;
    replacement?: string;
  }>;
  suggestions: string[];
}

export interface PdpGeoDiagnostics {
  normalizedProduct: PdpProductSignal;
  ocrSentences: PdpGeoOcrSentenceDiagnostic[];
  recommendations: PdpGeoRecommendation[];
  evidence: PdpGeoEvidence[];
  selectedRagChunks: PdpGeoRetrievedChunk[];
  reasoning?: PdpGeoReasoningResult;
  ragUsage: PdpGeoRagUsageDiagnostic[];
  runtimeUsage?: PdpGeoRuntimeUsage;
  terminology: PdpGeoTerminologyDiagnostics;
  validationWarnings: string[];
  validationRepairs?: PdpGeoValidationRepair[];
  ragMode: PdpGeoRagMode;
  generatedAt: string;
}

export interface PdpGeoGenerationResult {
  source?: PdpGeoSourceInfo;
  locale: PdpGeoLocale;
  market?: string;
  schemaMarkup: PdpGeoSchemaMarkup;
  content: PdpGeoContentArtifact;
  diagnostics: PdpGeoDiagnostics;
  generatedAt: string;
  ragProfile: string;
}

export type PdpGeoGenerationStageId =
  | "input"
  | "normalize"
  | "rag-load"
  | "chunk"
  | "embed"
  | "retrieve"
  | "rerank"
  | "generate"
  | "validate"
  | "repair"
  | "artifact";

export interface PdpGeoGenerationStep {
  id: PdpGeoGenerationStageId;
  title: string;
  description: string;
  status: "pending" | "running" | "done" | "error";
  message?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface PdpGeoGenerationRun {
  result: PdpGeoGenerationResult;
  diagnostics: PdpGeoDiagnostics;
  process: PdpGeoGenerationStep[];
}

export const PdpGeoGenerationInputSchema = z.object({
  product: z.unknown(),
  source: z.object({
    type: z.enum(["pdp-extractor", "rest-api", "manual-json", "unknown"]).optional(),
    url: z.string().optional(),
    apiName: z.string().optional()
  }).optional(),
  hints: z.object({
    locale: z.enum(["ko-KR", "ja-JP", "en-US", "en-GB"]).optional(),
    market: z.string().optional(),
    brand: z.string().optional(),
    category: z.string().optional(),
    targetAudience: z.string().optional(),
    tone: z.string().optional(),
    schemaTargets: z.array(z.enum(["WebPage", "Product", "FAQPage", "HowTo", "BreadcrumbList"])).optional()
  }).optional(),
  fieldMapping: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
  rag: z.object({
    mode: z.enum(["local-versioned-rag", "managed-vector-store-rag"]).optional(),
    provider: z.enum(["local", "openai", "custom"]).optional(),
    embeddingProvider: z.enum(["local", "openai", "custom"]).optional(),
    embeddingModel: z.string().optional(),
    rerankerProvider: z.enum(["local-hybrid", "openai-file-search", "custom"]).optional(),
    vectorStoreId: z.string().optional(),
    maxChunks: z.number().int().positive().optional(),
    scoreThreshold: z.number().min(0).max(1).optional(),
    rewriteQuery: z.boolean().optional(),
    managedSearchEndpoint: z.string().optional(),
    resolveUrls: z.boolean().optional(),
    maxResolvedUrlDocuments: z.number().int().positive().optional(),
    urlFetchTimeoutMs: z.number().int().positive().optional(),
    allowedUrlDomains: z.array(z.string()).optional(),
    documents: z.array(z.object({
      name: z.string(),
      content: z.string(),
      version: z.string().optional()
    })).optional(),
    analysisPrompt: z.string().optional()
  }).optional()
});
