import { z } from "zod";

/** Supported source types for the product extractor agent. */
export const ProductExtractionInputSchema = z.object({
  sourceType: z.enum(["url", "restApi"]),
  source: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
  aiProvider: z.enum(["mock", "openai", "gemini", "azure-openai"]).default("mock").optional()
});

/** User-facing request shape accepted by the extraction pipeline. */
export type ProductExtractionInput = z.infer<typeof ProductExtractionInputSchema>;

/** Product details normalized from meta tags, JSON-LD, DOM text, OCR, and API responses. */
export interface ProductProfile {
  name: string;
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

/** Sentence-level OCR evidence reconstructed from visual copy and classified with related keywords. */
export interface ClassifiedSentenceInsight {
  text: string;
  category: KeywordCategory;
  keywords: string[];
  confidence: number;
  source: "ocr" | "llm" | "mock";
}

/** Public sentence-level OCR insight retained without model confidence for downstream schema/content generation. */
export interface GeoSentenceInsight {
  imageUrl?: string;
  text: string;
  category: KeywordCategory;
  keywords: string[];
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
    };
  };
  aiAnalysis: {
    keywords: GeoKeywordGroups;
    categorizedSections: ProductContentSection[];
    summary?: string;
  };
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

/** Runtime diagnostics kept outside of the final product artifact. */
export interface ProductExtractionDiagnostics {
  source: string;
  sourceType: ProductExtractionResult["sourceType"];
  process: ProductExtractionStep[];
  evidence: ExtractionEvidence[];
  warnings: AgentWarning[];
  runtimeUsage?: RuntimePipelineUsage;
  ragUsage?: ProductExtractorRagUsageDiagnostic[];
  generatedAt: string;
  ragProfile: string;
}

/** Full agent run shape used by apps that need both artifact and diagnostics. */
export interface ProductExtractionRun {
  result: ProductExtractionResult;
  diagnostics: ProductExtractionDiagnostics;
}
