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
export type PdpGeoProviderId = "mock" | "openai" | "gemini" | "azure-openai" | "aistudio" | "custom";

/** Schema graph targets supported by the generator. */
export type PdpGeoSchemaTarget = "WebPage" | "Product" | "FAQPage" | "HowTo" | "BreadcrumbList";

/** Page-node typing options; subtypes are emitted alongside WebPage. */
export type PdpGeoPageType = "ItemPage" | "CollectionPage" | "AboutPage" | "WebPage";

export type PdpGeoRagUpdateTarget =
  | "productDescription"
  | "webPageDescription"
  | "quickFacts"
  | "benefits"
  | "ingredients"
  | "howToUse"
  | "faq"
  | "schema"
  | "breadcrumbs"
  | "reviews";

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
  /**
   * Page-level typing of the emitted page node. PDPs default to "ItemPage"
   * (emitted as ["WebPage", "ItemPage"] for consumer compatibility);
   * category/listing pages use "CollectionPage", brand/about pages use
   * "AboutPage", and "WebPage" keeps the plain generic type.
   */
  pageType?: PdpGeoPageType;
  updateTargets?: PdpGeoRagUpdateTarget[];
  /**
   * Official brand entity URLs (brand site, Wikidata, verified social) emitted
   * as `Brand.sameAs` so the schema graph works as a connected entity page.
   */
  brandSameAs?: string[];
  /**
   * Site operator entity (P0). Emitted as a top-level `Organization` node
   * (`<origin>/#organization`) referenced by `Offer.seller` — only when the
   * source provides it. `sameAs` keeps only valid absolute URLs and an empty
   * array is never emitted (a bare [] is knowledge-graph noise).
   */
  organization?: {
    name: string;
    url: string;
    logoUrl?: string;
    sameAs?: string[];
  };
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
  dateModified?: string | string[];
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
  queryPlanning?: PdpGeoRagQueryPlanningSettings;
  fullDocumentHydration?: PdpGeoRagFullDocumentHydrationSettings;
  policyChecklist?: PdpGeoPolicyChecklistSettings;
}

export interface PdpGeoRagQueryPlanningSettings {
  enabled?: boolean;
  updateTargets?: PdpGeoRagUpdateTarget[];
  includeBaseQuery?: boolean;
  maxSubqueries?: number;
}

export interface PdpGeoPolicyChecklistSettings {
  enabled?: boolean;
  maxRules?: number;
  maxRuleChars?: number;
}

export interface PdpGeoRagFullDocumentHydrationSettings {
  enabled?: boolean;
  strategicOnly?: boolean;
  maxDocuments?: number;
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
    proofreading?: string;
  };
  apiVersion?: string;
  /** Sampling temperature forwarded to model calls. Omitted from requests when undefined (model default). */
  temperature?: number;
  embedding?: {
    provider?: "local" | "azure-openai" | "aistudio";
    apiKey?: string;
    endpoint?: string;
    deployment?: string;
    apiVersion?: string;
    model?: string;
  };
  reranker?: {
    provider?: "local-hybrid" | "cohere" | "azure-ai-search-semantic" | "aistudio-bedrock-cohere";
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
  /** Real embedding adapter for local-versioned RAG semantic scoring (multilingual recommended). */
  customEmbedder?: { embed(texts: string[]): Promise<number[][]> };
  /**
   * Cross-encoder style reranker applied once to the merged retrieval
   * candidates (all subqueries plus coverage backfill) before final chunk
   * selection. Implementations must return the same chunks with adjusted
   * scores/order and must preserve chunk metadata (coverage protection relies
   * on `metadata.queryPlanTarget`). Failures fall back to the deterministic
   * local-hybrid ordering.
   */
  customReranker?: { rerank(request: { query: string; chunks: PdpGeoRetrievedChunk[] }): Promise<PdpGeoRetrievedChunk[]> };
  productNormalization?: PdpGeoProductNormalizationSettings;
  customProductNormalizer?: PdpGeoProductNormalizer;
  keywordNormalization?: PdpGeoKeywordNormalizationSettings;
  customKeywordNormalizer?: PdpGeoKeywordNormalizer;
  contentPlanning?: PdpGeoContentPlanningSettings;
  customContentPlanner?: PdpGeoContentPlanner;
  copyRefinement?: PdpGeoCopyRefinementSettings;
  customCopyRefiner?: PdpGeoCopyRefiner;
  finalProofreading?: PdpGeoFinalProofreadingSettings;
  customFinalProofreader?: PdpGeoFinalProofreader;
  /**
   * Post-validation self-correction: evaluate the finished artifacts with the
   * shared GEO/CEP/E-E-A-T rubric and, when a dimension falls below its floor
   * or validation warnings remain, run one targeted corrective refinement
   * pass and keep the result only if it measurably improves.
   */
  qualityGate?: PdpGeoQualityGateSettings;
}

export interface PdpGeoQualityGateSettings {
  /** Defaults to true whenever a corrective model or custom refiner is configured. */
  enabled?: boolean;
  /** Per-dimension score floors. Defaults: GEO 90, CEP 95, E-E-A-T 90. */
  thresholds?: {
    geo?: number;
    cep?: number;
    eeat?: number;
  };
  /**
   * Optional LLM concept-embodiment judge (eval-agent `judgeConceptEmbodiment`).
   * When configured, the gate additionally assesses whether the GEO answer
   * coverage, CEP causal path, and E-E-A-T experience/expertise/authority/
   * trust CONCEPTS are actually embodied in the public content — the
   * deterministic rubric stays untouched, but a concept dimension below its
   * floor also triggers the corrective pass, and a corrected variant may be
   * adopted for a concept-score improvement alone (never with a
   * deterministic regression).
   */
  conceptJudge?: import("@agentic-geo/pdp-geo-eval-agent").GeoEvalEngineConfig;
}

export interface PdpGeoConceptAssessmentDiagnostics {
  overallScore: number;
  dimensions: Array<{
    id: "geo" | "cep" | "eeat";
    score: number;
    embodied: string[];
    missing: string[];
    improvements: string[];
  }>;
  summary: string;
}

export interface PdpGeoQualityGateScores {
  overall: number;
  geo: number;
  cep: number;
  eeat: number;
}

export interface PdpGeoQualityGateDiagnostics {
  enabled: boolean;
  thresholds: { geo: number; cep: number; eeat: number };
  initialScores?: PdpGeoQualityGateScores;
  initialWarningCount?: number;
  /** Gate conditions the initial artifacts failed; empty when the gate passed. */
  shortfalls: string[];
  /** Whether a corrective refinement pass was actually run. */
  attempted: boolean;
  /** Whether the corrected artifacts were adopted (false = rolled back or not attempted). */
  adopted: boolean;
  correctedScores?: PdpGeoQualityGateScores;
  correctedWarningCount?: number;
  /** LLM concept-embodiment assessment of the initial artifacts (opt-in). */
  conceptAssessment?: PdpGeoConceptAssessmentDiagnostics;
  /** LLM concept-embodiment assessment of the corrected artifacts, when a corrective pass ran. */
  correctedConceptAssessment?: PdpGeoConceptAssessmentDiagnostics;
  reason: string;
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

export interface PdpSemanticMetricClaim {
  label?: string;
  subject?: string;
  value?: string;
  unit?: string;
  metric?: string;
  direction?: string;
  timing?: string;
  baseline?: string;
  comparator?: string;
  period?: string;
  sample?: string;
  method?: string;
  institution?: string;
  evidenceGroup?: string;
  caveat?: string;
  sentence?: string;
  sourceText?: string;
  /** OCR image(s) this claim's sourceText was transcribed from. */
  imageUrls?: string[];
}

export interface PdpSemanticIngredientBenefitLink {
  ingredient?: string;
  benefit?: string;
  effect?: string;
  sentence?: string;
  sourceText?: string;
  /** OCR image(s) this link's sourceText was transcribed from. */
  imageUrls?: string[];
}

/** Source metadata retained for a research paper or editorial article cited by the PDP. */
export interface PdpSemanticCitation {
  type?: "research" | "article";
  title?: string;
  publisher?: string;
  author?: string;
  publishedAt?: string;
  url?: string;
  finding?: string;
  sourceText?: string;
  /** OCR image(s) this citation's sourceText was transcribed from. */
  imageUrls?: string[];
}

export interface PdpSemanticFacts {
  ingredients: string[];
  benefits: string[];
  effects: string[];
  skinTypes: string[];
  usageSteps: string[];
  /** Atomic, source-backed safety/certification tests classified by the normalizer. */
  safetyTests?: string[];
  metricClaims: PdpSemanticMetricClaim[];
  evidenceSentences: string[];
  ingredientBenefitLinks: PdpSemanticIngredientBenefitLink[];
  citations?: PdpSemanticCitation[];
}

/**
 * Canonical schema.org `ItemAvailability` enumeration member (V30.0,
 * https://schema.org/ItemAvailability). Values outside this list are invalid
 * and must be dropped rather than emitted.
 */
export type PdpAvailabilityToken =
  | "BackOrder"
  | "Discontinued"
  | "InStock"
  | "InStoreOnly"
  | "LimitedAvailability"
  | "MadeToOrder"
  | "OnlineOnly"
  | "OutOfStock"
  | "PreOrder"
  | "PreSale"
  | "Reserved"
  | "SoldOut";

/** Canonical schema.org `OfferItemCondition` enumeration member. */
export type PdpItemConditionToken =
  | "NewCondition"
  | "RefurbishedCondition"
  | "UsedCondition"
  | "DamagedCondition";

/**
 * Structure-preserving variant signal from the GEO-128 input contract.
 * Only source-backed fields are retained; commerce values are normalized
 * (GS1 check digit, ItemAvailability enum) or dropped at normalize time.
 */
export interface PdpProductVariantSignal {
  id?: string;
  sku?: string;
  gtin?: string;
  title?: string;
  options: string[];
  price?: string;
  currency?: string;
  availability?: PdpAvailabilityToken;
  url?: string;
  image?: string;
}

/**
 * Normalized product facts inferred from arbitrary product JSON.
 *
 * GEO-128: sku/gtin/availability/variants는 구조 보존 필드로 반영되어
 * JSON-LD에 매핑된다(Product.sku/gtin, Offer.availability =
 * "https://schema.org/<값>", 신뢰 가능한 variant가 2개 이상이면 variant별
 * offers 배열). tags/seoTitle/seoDescription 및 metafields의 구조 보존은
 * 여전히 보류 상태다(metafields→sourceTexts 주입 유지).
 */
export type PdpReturnPolicyCategoryToken =
  | "MerchantReturnFiniteReturnWindow"
  | "MerchantReturnUnlimitedWindow"
  | "MerchantReturnNotPermitted";
export type PdpReturnMethodToken = "ReturnByMail" | "ReturnInStore" | "ReturnAtKiosk";
export type PdpReturnFeesToken = "FreeReturn" | "ReturnFeesCustomerResponsibility" | "RestockingFees";

/**
 * Source-provided merchant return policy (P0 commerce trust layer). Emitted
 * as an `Offer.hasMerchantReturnPolicy` object only when the category and
 * country are mappable — Google requires a structured MerchantReturnPolicy
 * (string values are invalid) with `returnPolicyCountry`.
 */
export interface PdpReturnPolicySignal {
  category: PdpReturnPolicyCategoryToken;
  merchantReturnDays?: number;
  returnMethod?: PdpReturnMethodToken;
  returnFees?: PdpReturnFeesToken;
  applicableCountry: string;
  returnPolicyCountry?: string;
  url?: string;
}

/**
 * Source-provided shipping signal (P0 commerce trust layer). Emitted as
 * `Offer.shippingDetails`/`OfferShippingDetails` with QuantitativeValue day
 * ranges — free-text lead times ("1 - 6 Days") are invalid for merchant
 * listings.
 */
export interface PdpShippingSignal {
  destinationCountry: string;
  handlingDaysMin?: number;
  handlingDaysMax?: number;
  transitDaysMin?: number;
  transitDaysMax?: number;
  rate?: { amount: number; currency: string };
}

/** sourceTexts[i]와 인덱스 정렬된 OCR 유래 메타. 비-OCR 항목은 undefined. */
export interface PdpSourceTextMeta {
  imageUrls?: string[];
  /** 해당 문장을 만든 이미지 전사 confidence 최솟값(0-1). */
  ocrConfidence?: number;
}

export interface PdpProductSignal {
  name: string;
  originalName?: string;
  description?: string;
  brand?: string;
  category?: string;
  sku?: string;
  gtin?: string;
  availability?: PdpAvailabilityToken;
  itemCondition?: PdpItemConditionToken;
  priceValidUntil?: string;
  returnPolicy?: PdpReturnPolicySignal;
  shipping?: PdpShippingSignal;
  /**
   * Source-provided last-modified date for the PDP (ISO 8601). Emitted as
   * `WebPage.dateModified` only when the source supplies it — a freshness
   * timestamp is an AI-citation gatekeeper (What Gets Cited, SIGIR 2026), but
   * inventing one from generation time is forbidden by the schema policy.
   */
  dateModified?: string;
  variants?: PdpProductVariantSignal[];
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
  /** 정리된 sourceTexts 값 → OCR 유래 메타. 텍스트 키잉이라 배열 재필터에도 정합이 깨지지 않는다. */
  sourceTextMeta?: Record<string, PdpSourceTextMeta>;
  semanticFacts?: PdpSemanticFacts;
}

export type PdpGeoRagKind = "orchestration" | "field-contracts" | "schema" | "eeat" | "cep" | "best-practice" | "geo-research" | "evidence-cards" | "official-docs" | "locale" | "terminology" | "product" | "custom";
export type PdpGeoRagIntent = "faq" | "howTo" | "claims" | "customer" | "review" | "schema" | "locale" | "evidence" | "retrieval" | "general";
export type PdpGeoRagFieldTarget =
  | "WebPage.description"
  | "Product.description"
  | "Product.additionalProperty"
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

export interface PdpGeoHydratedRagDocument {
  source: string;
  version?: string;
  kind: PdpGeoRagKind;
  hydrationMode: "controlled-full-document";
  selectedChunkTitles: string[];
  content: string;
}

export type PdpGeoPolicyRuleSeverity = "critical" | "guidance";
export type PdpGeoPolicyRuleExtraction = "rules" | "narrative";

/** One atomic, deduplicated requirement compiled from a RAG policy document. */
export interface PdpGeoPolicyRule {
  id: string;
  document: string;
  version?: string;
  kind: PdpGeoRagKind;
  heading: string;
  text: string;
  intents: PdpGeoRagIntent[];
  fieldTargets: PdpGeoRagFieldTarget[];
  severity: PdpGeoPolicyRuleSeverity;
  extraction: PdpGeoPolicyRuleExtraction;
  priority: number;
}

export interface PdpGeoPolicyCoverageDocument {
  document: string;
  kind: PdpGeoRagKind;
  totalRules: number;
  injectedRules: number;
  criticalRules: number;
  injectedCriticalRules: number;
  narrativeRules: number;
}

/** Accounting of how many compiled policy rules actually reached the model prompt. */
export interface PdpGeoPolicyCoverage {
  mode: "compiled-policy-checklist";
  totalRules: number;
  injectedRules: number;
  criticalRules: number;
  injectedCriticalRules: number;
  criticalCoverageRatio: number;
  documents: PdpGeoPolicyCoverageDocument[];
  excludedRuleIds: string[];
}

export interface PdpGeoRagSubquery {
  id: string;
  target: PdpGeoRagUpdateTarget | "general";
  query: string;
  intents: PdpGeoRagIntent[];
  fieldTargets: PdpGeoRagFieldTarget[];
  reason: string;
}

export interface PdpGeoRagQueryPlan {
  mode: "single-query" | "agentic-subquery-planning";
  updateTargets: Array<PdpGeoRagUpdateTarget | "general">;
  queries: PdpGeoRagSubquery[];
}

export interface PdpGeoRetrieverRequest {
  query: string;
  /**
   * Generation intents / field targets of the active subquery (from
   * PdpGeoRagSubquery). When present, the local retriever boosts chunks whose
   * typed rag-index intents/fieldTargets align BEFORE the candidate cut, so
   * target-relevant guidance (e.g. schema docs for a schema subquery) cannot
   * be crowded out by lexically dominant brand/product chunks.
   */
  queryIntents?: PdpGeoRagIntent[];
  queryFieldTargets?: PdpGeoRagFieldTarget[];
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
  hydratedRagDocuments?: PdpGeoHydratedRagDocument[];
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

export interface PdpGeoProductNormalizationRequest {
  rawProduct: unknown;
  bootstrapProduct: PdpProductSignal;
  locale: PdpGeoLocale;
  market?: string;
  source?: PdpGeoSourceInfo;
  hints?: PdpGeoGenerationHints;
  fieldMapping?: PdpGeoFieldMapping;
  analysisPrompt?: string;
  ragDocuments: Array<{
    name: string;
    content: string;
    version?: string;
  }>;
}

export interface PdpGeoProductNormalizationResult {
  product?: Partial<PdpProductSignal>;
  locale?: PdpGeoLocale;
  market?: string;
  warnings?: string[];
  rawText?: string;
  usage?: PdpGeoTokenUsage;
}

export interface PdpGeoProductNormalizer {
  normalizeProduct(request: PdpGeoProductNormalizationRequest): Promise<PdpGeoProductNormalizationResult> | PdpGeoProductNormalizationResult;
}

export interface PdpGeoProductNormalizationSettings {
  enabled?: boolean;
  provider?: PdpGeoProviderId;
  apiKey?: string;
  model?: string;
  endpoint?: string;
  deployment?: string;
  apiVersion?: string;
  maxRagDocuments?: number;
  maxSourceCharacters?: number;
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

/** The semantic role of one source-backed atomic fact available to the planner. */
export type PdpGeoEvidenceRole =
  | "identity"
  | "description"
  | "benefit"
  | "effect"
  | "ingredient"
  | "audience"
  | "usage"
  | "metric"
  | "faq"
  | "review"
  | "commerce"
  | "source";

/**
 * A stable, atomic source fact. Public copy must cite these IDs instead of
 * relying on an untraceable flattened product string.
 */
export interface PdpGeoAtomicEvidence {
  id: string;
  role: PdpGeoEvidenceRole;
  text: string;
  sourcePath: string;
  locale: PdpGeoLocale;
  productScope: "product";
  confidence: number;
  /** 이 원자를 만든 OCR 원본 이미지들. 이미지 유래가 아닐 때 없음. */
  imageUrls?: string[];
  /** 이미지 전사 confidence 최솟값(0-1). 이미지 유래가 아닐 때 없음. */
  ocrConfidence?: number;
}

export interface PdpGeoPlannedField {
  include: boolean;
  text: string;
  intent: string;
  evidenceIds: string[];
  confidence: number;
  omitReason: string;
}

export interface PdpGeoPlannedFaqItem {
  include: boolean;
  question: string;
  answer: string;
  intent: string;
  cep: string;
  evidenceIds: string[];
  confidence: number;
  omitReason: string;
}

export interface PdpGeoPlannedHowToStep {
  position: number;
  name: string;
  text: string;
  evidenceIds: string[];
}

export interface PdpGeoPlannedHowTo {
  eligible: boolean;
  ordered: boolean;
  goal: string;
  steps: PdpGeoPlannedHowToStep[];
  evidenceIds: string[];
  confidence: number;
  omitReason: string;
}

export interface PdpGeoPlannedCep {
  situation: string;
  need: string;
  constraint: string;
  evidenceIds: string[];
  confidence: number;
}

/** Evidence-bound semantic plan used as the single source for public copy and schema eligibility. */
export interface PdpGeoContentPlan {
  mode: "model" | "conservative";
  locale: PdpGeoLocale;
  productDescription: PdpGeoPlannedField;
  webPageDescription: PdpGeoPlannedField;
  faq: PdpGeoPlannedFaqItem[];
  howTo: PdpGeoPlannedHowTo;
  cep: PdpGeoPlannedCep[];
  warnings: string[];
}

export interface PdpGeoContentPlanningRequest {
  product: PdpProductSignal;
  locale: PdpGeoLocale;
  market?: string;
  hints?: PdpGeoGenerationHints;
  evidenceLedger: PdpGeoAtomicEvidence[];
  ragChunks: PdpGeoRetrievedChunk[];
  /** Compact compiled policy constraints; guidance only, never product evidence. */
  policyRules?: PdpGeoPolicyRule[];
  /** First-pass plan supplied only for a model-backed evidence-entailment audit. */
  candidatePlan?: Omit<PdpGeoContentPlan, "mode">;
  planningFeedback?: Array<{
    field: string;
    reason: string;
  }>;
}

export interface PdpGeoContentPlanningResult {
  plan?: Omit<PdpGeoContentPlan, "mode">;
  warnings?: string[];
  rawText?: string;
  usage?: PdpGeoTokenUsage;
}

export interface PdpGeoContentPlanner {
  planContent(request: PdpGeoContentPlanningRequest): Promise<PdpGeoContentPlanningResult> | PdpGeoContentPlanningResult;
}

export interface PdpGeoContentPlanningSettings {
  enabled?: boolean;
  provider?: PdpGeoProviderId;
  apiKey?: string;
  model?: string;
  endpoint?: string;
  deployment?: string;
  apiVersion?: string;
  maxEvidenceItems?: number;
  maxRagChunks?: number;
}

export interface PdpGeoCopyRefinementRequest {
  product: PdpProductSignal;
  locale: PdpGeoLocale;
  market?: string;
  schemaMarkup: PdpGeoSchemaMarkup;
  content: PdpGeoContentArtifact;
  ragChunks: PdpGeoRetrievedChunk[];
  hydratedRagDocuments?: PdpGeoHydratedRagDocument[];
  reasoning?: PdpGeoReasoningResult;
  policyRules?: PdpGeoPolicyRule[];
  inferredSearchQueries?: PdpGeoInferredSearchQueryDiagnostic[];
  refinementFeedback?: PdpGeoCopyRefinementFeedback[];
}

export interface PdpGeoCopyRefinementFeedback {
  field: string;
  reason: string;
  rejectedText?: string;
  currentText?: string;
}

export interface PdpGeoCopyRefinementResult {
  schemaDescriptions?: {
    webPage?: string;
    product?: string;
  };
  schemaProperties?: Record<string, string>;
  faqAnswers?: Array<{
    sourceQuestion?: string;
    question?: string;
    answer?: string;
  }>;
  contentSections?: Partial<Pick<PdpGeoContentSections, "description" | "quickFacts" | "faq">>;
  ruleCompliance?: {
    violatedRuleIds: string[];
    notes: string[];
  };
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

export type PdpGeoFinalProofreadingIssueCode =
  | "awkward"
  | "grammar"
  | "duplicate-sentence"
  | "duplicate-word"
  | "punctuation";

export type PdpGeoFinalProofreadingFieldPath =
  | "Product.description"
  | "WebPage.description"
  | `FAQPage.mainEntity[${number}].name`
  | `FAQPage.mainEntity[${number}].acceptedAnswer.text`
  | `HowTo.step[${number}].text`;

export interface PdpGeoFinalProofreadingField {
  fieldPath: PdpGeoFinalProofreadingFieldPath;
  sourceHash: string;
  text: string;
  constraint: "fluency-only" | "punctuation-only";
  evidenceIds: string[];
  immutableTokens: string[];
  /**
   * 직전 시도에서 이 필드의 제안이 기각된 사유. 재시도 요청에만 실린다.
   * 첫 요청에는 없으며, 재시도는 필드당 한 번만 일어난다.
   */
  priorRejection?: string;
}

export interface PdpGeoFinalProofreadingRequest {
  locale: PdpGeoLocale;
  market?: string;
  productName: string;
  brand?: string;
  fields: PdpGeoFinalProofreadingField[];
  evidenceLedger: PdpGeoAtomicEvidence[];
}

export interface PdpGeoFinalProofreadingEdit {
  fieldPath: PdpGeoFinalProofreadingFieldPath;
  sourceHash: string;
  action: "keep" | "revise";
  revisedText: string;
  issueCodes: PdpGeoFinalProofreadingIssueCode[];
}

export interface PdpGeoFinalProofreadingResult {
  edits: PdpGeoFinalProofreadingEdit[];
  warnings: string[];
  rawText?: string;
  usage?: PdpGeoTokenUsage;
}

export interface PdpGeoFinalProofreader {
  proofread(request: PdpGeoFinalProofreadingRequest): Promise<PdpGeoFinalProofreadingResult> | PdpGeoFinalProofreadingResult;
}

export interface PdpGeoFinalProofreadingSettings {
  /** This final, additional model call is opt-in for library consumers. */
  enabled?: boolean;
  provider?: PdpGeoProviderId;
  apiKey?: string;
  model?: string;
  endpoint?: string;
  deployment?: string;
  apiVersion?: string;
  maxOutputTokens?: number;
}

export interface PdpGeoFinalProofreadingRejection {
  fieldPath?: PdpGeoFinalProofreadingFieldPath;
  reason: string;
  proposedText?: string;
}

export interface PdpGeoFinalProofreadingSkippedField {
  fieldPath: PdpGeoFinalProofreadingFieldPath;
  reason: string;
}

export interface PdpGeoFinalProofreadingAcceptedEdit {
  fieldPath: PdpGeoFinalProofreadingFieldPath;
  sourceHash: string;
  before: string;
  after: string;
  evidenceIds: string[];
  issueCodes: PdpGeoFinalProofreadingIssueCode[];
}

export interface PdpGeoPublicCopySentenceProvenance {
  text: string;
  sourceHash: string;
  evidenceIds: string[];
  /** 인용 atom들의 이미지 계보 합집합. OCR 유래 근거가 없으면 없음. */
  imageUrls?: string[];
}

export interface PdpGeoPublicCopyProvenance {
  fieldPath: PdpGeoFinalProofreadingFieldPath;
  text: string;
  sourceHash: string;
  origin: "model-plan" | "deterministic-renderer";
  evidenceIds: string[];
  sentences: PdpGeoPublicCopySentenceProvenance[];
  /** 인용 atom들의 이미지 계보 합집합. OCR 유래 근거가 없으면 없음. */
  imageUrls?: string[];
}

export interface PdpGeoFinalProofreadingDiagnostics {
  status: "skipped" | "kept" | "applied" | "rejected" | "failed";
  called: boolean;
  applied: boolean;
  acceptedFields: PdpGeoFinalProofreadingFieldPath[];
  acceptedEdits: PdpGeoFinalProofreadingAcceptedEdit[];
  rejectedEdits: PdpGeoFinalProofreadingRejection[];
  skippedFields: PdpGeoFinalProofreadingSkippedField[];
  warnings: string[];
  finalPublicCopyProvenance: PdpGeoPublicCopyProvenance[];
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
  /** Reserved for a future optional renderer. Currently always empty. */
  html: string;
  /** Internal structured copy used to compose and proofread schema fields. */
  sections: PdpGeoContentSections;
}

export interface PdpGeoRecommendation {
  field: "productName" | "description" | "quickFacts" | "benefits" | "ingredients" | "howToUse" | "faq" | "schema" | "terminology" | "offers.availability";
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
  source: "schema-validator" | "html-validator" | "sentence-qa" | "field-contract-validator" | "trust-field-validator";
  issue: string;
  action: string;
  before?: JsonValue;
  after?: JsonValue;
  evidence?: string[];
}

export interface PdpGeoValidationFinding {
  field: string;
  source: PdpGeoValidationRepair["source"];
  issue: string;
  suggestedAction: string;
  before?: JsonValue;
  suggestedAfter?: JsonValue;
  evidence?: string[];
  /**
   * How two runs decide this is the same finding.
   *
   * `"text"` (the default) means the finding is about specific text, so the
   * text is part of its identity — a different duplicated word is a different
   * finding. `"field-shape"` means the finding describes a property the
   * field's prose has, so it stays the same finding however that prose is
   * worded.
   *
   * The proofreading pass compares the findings before and after its edits and
   * reverts everything if it introduced any. A field-shape finding keyed by
   * text can never match across an edit to that field, so a defect that was
   * already there read as newly introduced: the pass reverted every edit it had
   * made and reported a reason that was not true.
   */
  identity?: "text" | "field-shape";
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

export type PdpGeoOcrSentenceIntent = "benefit" | "effect" | "ingredient" | "usage" | "review" | "metric";

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

export interface PdpGeoInferredSearchQueryDiagnostic {
  kind: "direct" | "indirect";
  question: string;
  keywords: string[];
  answer: string;
  source: "model-inferred-cep" | "review-derived-cep" | "product-fact" | "positive-review-usefeel";
  mentionsProductOrBrand: boolean;
}

export interface PdpGeoDiagnostics {
  normalizedProduct: PdpProductSignal;
  evidenceLedger?: PdpGeoAtomicEvidence[];
  contentPlan?: PdpGeoContentPlan;
  ocrSentences: PdpGeoOcrSentenceDiagnostic[];
  recommendations: PdpGeoRecommendation[];
  evidence: PdpGeoEvidence[];
  selectedRagChunks: PdpGeoRetrievedChunk[];
  hydratedRagDocuments?: PdpGeoHydratedRagDocument[];
  policyCoverage?: PdpGeoPolicyCoverage;
  reasoning?: PdpGeoReasoningResult;
  ragUsage: PdpGeoRagUsageDiagnostic[];
  ragQueryPlan?: PdpGeoRagQueryPlan;
  runtimeUsage?: PdpGeoRuntimeUsage;
  terminology: PdpGeoTerminologyDiagnostics;
  inferredSearchQueries?: PdpGeoInferredSearchQueryDiagnostic[];
  finalProofreading?: PdpGeoFinalProofreadingDiagnostics;
  finalPublicCopyProvenance?: PdpGeoPublicCopyProvenance[];
  validationWarnings: string[];
  validationFindings?: PdpGeoValidationFinding[];
  validationRepairs?: PdpGeoValidationRepair[];
  qualityGate?: PdpGeoQualityGateDiagnostics;
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
  | "quality-gate"
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
    schemaTargets: z.array(z.enum(["WebPage", "Product", "FAQPage", "HowTo", "BreadcrumbList"])).optional(),
    pageType: z.enum(["ItemPage", "CollectionPage", "AboutPage", "WebPage"]).optional(),
    updateTargets: z.array(z.enum(["productDescription", "webPageDescription", "quickFacts", "benefits", "ingredients", "howToUse", "faq", "schema", "breadcrumbs", "reviews"])).optional(),
    brandSameAs: z.array(z.string().url()).optional(),
    // P0: 운영 조직 엔티티. sameAs는 느슨하게 받고 발행 시 유효 URL만
    // 남긴다(fail-closed 필터링) — 입력 전체를 거부하지 않기 위함.
    organization: z.object({
      name: z.string(),
      url: z.string().url(),
      logoUrl: z.string().url().optional(),
      sameAs: z.array(z.string()).optional()
    }).optional()
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
    analysisPrompt: z.string().optional(),
    queryPlanning: z.object({
      enabled: z.boolean().optional(),
      updateTargets: z.array(z.enum(["productDescription", "webPageDescription", "quickFacts", "benefits", "ingredients", "howToUse", "faq", "schema", "breadcrumbs", "reviews"])).optional(),
      includeBaseQuery: z.boolean().optional(),
      maxSubqueries: z.number().int().positive().optional()
    }).optional(),
    fullDocumentHydration: z.object({
      enabled: z.boolean().optional(),
      strategicOnly: z.boolean().optional(),
      maxDocuments: z.number().int().positive().optional()
    }).optional()
  }).optional()
});
