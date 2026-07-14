import { z } from "zod";

/** Supported source types for the product extractor agent. */
export const ProductExtractionInputSchema = z.object({
  sourceType: z.enum(["url", "restApi"]),
  source: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
  aiProvider: z.enum(["mock", "openai", "gemini", "azure-openai", "aistudio"]).default("mock").optional()
});

/** User-facing request shape accepted by the extraction pipeline. */
export type ProductExtractionInput = z.infer<typeof ProductExtractionInputSchema>;

/** Product details normalized from meta tags, JSON-LD, DOM text, OCR, and API responses. */
export interface ProductProfile {
  name: string;
  brand?: string;
  price?: string;
  currency?: string;
  description?: string;
  images: string[];
  options: string[];
  benefits: string[];
  effects: string[];
  ingredients: string[];
  usage: string[];
  metrics: string[];
  faq: FaqItem[];
  contentSections: ProductContentSection[];
}

/** Optional model/custom-agent request for source-backed product profile normalization. */
export interface ProductExtractorProductNormalizationRequest {
  source: string;
  sourceType: ProductExtractionInput["sourceType"] | "mock";
  rawSource: unknown;
  bootstrapProduct: ProductProfile;
  analysisPrompt?: string;
  ragDocuments?: Array<{
    name: string;
    content: string;
    version?: string;
  }>;
}

/** Model/custom-agent response for product profile normalization. */
export interface ProductExtractorProductNormalizationResult {
  product?: Partial<ProductProfile>;
  warnings?: string[];
  rawText?: string;
  usage?: AiTokenUsage;
}

export interface ProductExtractorProductNormalizer {
  normalizeProductProfile(request: ProductExtractorProductNormalizationRequest): Promise<ProductExtractorProductNormalizationResult> | ProductExtractorProductNormalizationResult;
}

export interface ProductExtractorProductNormalizationSettings {
  enabled?: boolean;
  provider?: ProductExtractionInput["aiProvider"];
  apiKey?: string;
  model?: string;
  endpoint?: string;
  deployment?: string;
  apiVersion?: string;
  maxRagDocuments?: number;
  maxSourceCharacters?: number;
}

/** Product content category inferred from HTML sections, tabs, accordions, and review cards. */
export type ProductContentCategory =
  | "benefit"
  | "effect"
  | "ingredient"
  | "usage"
  | "faq"
  | "review"
  | "rating"
  | "metric"
  | "unknown";

/** Product-related HTML content normalized for downstream GEO analysis. */
export interface ProductContentSection {
  title: string;
  category: ProductContentCategory;
  text: string;
  bullets: string[];
}

/** Question and answer content found on a product detail page. */
export interface FaqItem {
  question: string;
  answer: string;
}

/** Review summary and representative keywords extracted from page or API data. */
export interface ReviewSummary {
  rating?: number;
  reviewCount?: number;
  items: ReviewItem[];
  keywords: ClassifiedKeyword[];
}

/** Individual review signal used as RAG evidence. */
export interface ReviewItem {
  body: string;
  author?: string;
  rating?: number;
  datePublished?: string;
}

/** Keyword bucket generated from DOM text, review content, OCR text, or model output. */
export interface ClassifiedKeyword {
  keyword: string;
  category: KeywordCategory;
  confidence: number;
  source: "dom" | "jsonLd" | "review" | "ocr" | "llm" | "mock";
}

/** Sentence-level OCR evidence semantically interpreted from visual copy and classified with related keywords. */
export interface ClassifiedSentenceInsight {
  text: string;
  category: KeywordCategory;
  keywords: string[];
  confidence: number;
  source: "ocr" | "llm" | "mock";
  semanticFacts?: Partial<GeoSemanticFacts>;
}

/** Public sentence-level OCR insight retained without model confidence for downstream schema/content generation. */
export interface GeoSentenceInsight {
  imageUrl?: string;
  text: string;
  category: KeywordCategory;
  keywords: string[];
  semanticFacts?: Partial<GeoSemanticFacts>;
}

export interface GeoSemanticMetricClaim {
  label?: string;
  subject?: string;
  value?: string;
  unit?: string;
  metric?: string;
  direction?: string;
  timing?: string;
  period?: string;
  sample?: string;
  method?: string;
  caveat?: string;
  sentence?: string;
  sourceText?: string;
}

export interface GeoSemanticIngredientBenefitLink {
  ingredient?: string;
  benefit?: string;
  effect?: string;
  sentence?: string;
  sourceText?: string;
}

export interface GeoSemanticCitation {
  type?: "research" | "article";
  title?: string;
  publisher?: string;
  author?: string;
  publishedAt?: string;
  url?: string;
  finding?: string;
  sourceText?: string;
}

export interface GeoSemanticFacts {
  ingredients: string[];
  benefits: string[];
  effects: string[];
  skinTypes: string[];
  usageSteps: string[];
  metricClaims: GeoSemanticMetricClaim[];
  evidenceSentences: string[];
  ingredientBenefitLinks: GeoSemanticIngredientBenefitLink[];
  citations?: GeoSemanticCitation[];
}

/** Keyword categories used by GEO downstream agents. */
export type KeywordCategory =
  | "product"
  | "price"
  | "benefit"
  | "effect"
  | "ingredient"
  | "usage"
  | "faq"
  | "review"
  | "metric"
  | "trend"
  | "unknown";

/** Public GEO keyword groups without model confidence or audit source fields. */
export interface GeoKeywordGroups {
  product: string[];
  price: string[];
  benefit: string[];
  effect: string[];
  ingredient: string[];
  usage: string[];
  faq: string[];
  review: string[];
  metric: string[];
  trend: string[];
  unknown: string[];
}

/** Image-level OCR/vision output retained for auditability. */
export interface OcrExtraction {
  imagesScanned: number;
  extractedTexts: OcrTextEvidence[];
}

/** OCR evidence tied to an image URL and classified keywords. */
export interface OcrTextEvidence {
  imageUrl: string;
  text: string;
  keywords: ClassifiedKeyword[];
  sentenceInsights: ClassifiedSentenceInsight[];
  confidence: number;
}

/** RAG chunk generated from extracted product, review, FAQ, OCR, or source evidence. */
export interface RagChunk {
  id: string;
  kind: "product" | "review" | "faq" | "ocr" | "source";
  text: string;
  metadata: Record<string, string | number | boolean>;
}

/** Public RAG chunk shape exposed as GEO product raw data. */
export interface GeoRagChunk {
  id: string;
  kind: RagChunk["kind"];
  text: string;
}

/** Provider token usage when a model API returns usage metadata. */
export interface AiTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** Runtime model/search step audit shown in diagnostics. */
export interface RuntimePipelineStep {
  stage: "ocr" | "embedding" | "retrieval" | "reranking" | "final";
  label: string;
  provider?: string;
  service?: string;
  model?: string;
  deployment?: string;
  mode?: string;
  called: boolean;
  tokenUsage?: AiTokenUsage;
  details?: string;
}

export interface RuntimePipelineUsage {
  steps: RuntimePipelineStep[];
  tokenTotals: AiTokenUsage;
  tokenNote?: string;
}

export interface ProductExtractorRagUsageReference {
  sourceDocument: string;
  chunkId?: string;
  kind?: string;
  intents: string[];
  fieldTargets: string[];
  score?: number;
  usage: string;
  excerpt: string;
}

export interface ProductExtractorRagUsageDiagnostic {
  principle: string;
  references: ProductExtractorRagUsageReference[];
}

/** Product-centered raw data prepared for downstream GEO schema/content agents. */
export interface GeoProductRawData {
  name: string;
  brand?: string;
  price?: {
    raw: string;
    amount?: number;
    currency?: string;
  };
  description?: string;
  images: string[];
  options: string[];
  benefits: string[];
  effects: string[];
  ingredients: string[];
  usage: string[];
  metrics: string[];
  faq: FaqItem[];
  reviews: {
    rating?: number;
    reviewCount?: number;
    items: ReviewItem[];
    keywords: string[];
  };
  sourceExtraction: {
    html: {
      description?: string;
      sections: ProductContentSection[];
      faq: FaqItem[];
    };
    ocr: {
      imageTexts: Array<{
        imageUrl: string;
        text: string;
      }>;
      textBlocks: string[];
      sentenceInsights: GeoSentenceInsight[];
      semanticFacts?: GeoSemanticFacts;
    };
  };
  aiAnalysis: {
    keywords: GeoKeywordGroups;
    categorizedSections: ProductContentSection[];
    summary?: string;
    semanticFacts?: GeoSemanticFacts;
  };
  semanticFacts?: GeoSemanticFacts;
  categorizedProductInfo: {
    benefits: string[];
    effects: string[];
    ingredients: string[];
    usage: string[];
    metrics: string[];
    faq: FaqItem[];
  };
  customerReviewAnalysis: {
    rating?: number;
    reviewCount?: number;
    items: ReviewItem[];
    keywords: string[];
    reviewSignals: string[];
    ratingSummary?: string;
  };
  contentAnalysis: {
    sections: ProductContentSection[];
    reviewSignals: string[];
    ratingSummary?: string;
  };
  ocr: {
    textBlocks: string[];
    keywords: GeoKeywordGroups;
    sentenceInsights: GeoSentenceInsight[];
  };
  rag: {
    chunks: GeoRagChunk[];
  };
}

/** Stable pipeline stage ids shared by the package, REST adapter, and UI progress panel. */
export type ProductExtractionStageId = "input" | "fetch" | "extract" | "ocr" | "review" | "rag" | "json";

/** Runtime trace emitted while the extractor normalizes, collects, extracts, chunks, and serializes data. */
export interface ProductExtractionStep {
  id: ProductExtractionStageId;
  title: string;
  description: string;
  status: "pending" | "running" | "done" | "error";
  message?: string;
  startedAt?: string;
  completedAt?: string;
}

/** Evidence item that tells downstream validators where a field came from. */
export interface ExtractionEvidence {
  field: string;
  source: "meta" | "jsonLd" | "dom" | "url" | "review" | "ocr" | "api" | "mock" | "llm";
  value: string;
}

/** Non-fatal issue produced while extracting a product source. */
export interface AgentWarning {
  code: string;
  message: string;
}

/** Clean JSON payload returned as the product extractor's final artifact. */
export interface ProductExtractionResult {
  source: string;
  sourceType: ProductExtractionInput["sourceType"] | "mock";
  geoProduct: GeoProductRawData;
  generatedAt: string;
  ragProfile: string;
}

/** Per-image OCR pipeline outcome kept for QA review and re-run feedback. */
export interface OcrTargetDiagnostic {
  imageUrl: string;
  /** Whether the tall-image pre-pass split this target into vertical slices. */
  sliced: boolean;
  sliceCount?: number;
  status: "extracted" | "empty" | "failed";
  /** Total transcription length collected for this image (all slices combined). */
  textLength: number;
  /** Lowest model-reported transcription confidence across this image's slices. */
  confidence?: number;
  textPreview?: string;
  /** Human-readable review points, e.g. low confidence or extraction failure. */
  issues: string[];
}

/** OCR text that was collected but excluded somewhere in the pipeline, with the reason. */
export interface OcrDroppedTextDiagnostic {
  imageUrl: string;
  reason: string;
  textPreview: string;
}

/**
 * End-to-end OCR pipeline trace: which images were read, how their texts were
 * combined, how classification behaved, and how much of the OCR evidence made
 * it into the public result. Designed so a reviewer can locate weak spots and
 * feed this block back into a follow-up improvement run.
 */
export interface OcrDiagnostics {
  provider: string;
  /** Product-detail images selected for vision OCR. */
  targetsConsidered: number;
  /** Actual image inputs sent to the model after tall-image slicing. */
  inputsSent: number;
  targets: OcrTargetDiagnostic[];
  combination: {
    /** Candidates entering the merge stage (vision texts + attribute texts, post noise filter). */
    candidatesIn: number;
    /** Exact/contained duplicates absorbed into a longer candidate. */
    duplicatesAbsorbed: number;
    /** Boundary-overlap joins performed (sliced images, srcset variants). */
    overlapJoins: number;
    /** Candidates dropped before merging as non-product evidence. */
    droppedCandidates: OcrDroppedTextDiagnostic[];
    /** Final merged evidence candidates passed to classification. */
    candidatesOut: number;
  };
  classification: {
    batches: number;
    failedBatches: number;
    providerKeywords: number;
    sentenceInsights: number;
    confidence: number;
  };
  utilization: {
    /** OCR evidence texts that survived into the public geoProduct output. */
    textBlocksInResult: number;
    /** Keywords attached to OCR evidence texts. */
    keywordsAttached: number;
    sentenceInsightsByCategory: Record<string, number>;
    ragChunksFromOcr: number;
    /** Extracted texts excluded from the public output, with reasons. */
    unusedTexts: OcrDroppedTextDiagnostic[];
  };
  /** Aggregated review points across all stages, ordered by severity. */
  issues: string[];
}

/** Runtime diagnostics kept outside of the final product artifact. */
export interface ProductExtractionDiagnostics {
  source: string;
  sourceType: ProductExtractionResult["sourceType"];
  process: ProductExtractionStep[];
  evidence: ExtractionEvidence[];
  warnings: AgentWarning[];
  runtimeUsage?: RuntimePipelineUsage;
  ragUsage?: ProductExtractorRagUsageDiagnostic[];
  ocr?: OcrDiagnostics;
  generatedAt: string;
  ragProfile: string;
}

/** Full agent run shape used by apps that need both artifact and diagnostics. */
export interface ProductExtractionRun {
  result: ProductExtractionResult;
  diagnostics: ProductExtractionDiagnostics;
}
