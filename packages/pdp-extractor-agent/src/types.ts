import type { OcrLayoutGroup, OcrLayoutLineRole } from "./llm/types";
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
/**
 * 소스 JSON-LD/페이로드에서 관측된 반품 정책 원시값. 느슨한 문자열로
 * 전달하고 downstream generator가 fail-closed 정규화한다.
 */
export interface ExtractedMerchantReturnPolicy {
  category?: string;
  merchantReturnDays?: number;
  returnMethod?: string;
  returnFees?: string;
  applicableCountry?: string;
  returnPolicyCountry?: string;
  url?: string;
}

export interface ProductProfile {
  name: string;
  brand?: string;
  price?: string;
  currency?: string;
  availability?: string;
  itemCondition?: string;
  priceValidUntil?: string;
  returnPolicy?: ExtractedMerchantReturnPolicy;
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
  evidenceIndex?: number;
  imageUrls?: string[];
  attribution?: "declared" | "fuzzy" | "local";
  /**
   * 역할이 원문의 절 제목에서 선언된 경우의 출처. 관계가 역할을 정했다는
   * 뜻이므로, 뒤따르는 어휘 기반 재검증을 건너뛴다.
   */
  roleSource?: "section-heading";
}

/** Public sentence-level OCR insight retained without model confidence for downstream schema/content generation. */
export interface GeoSentenceInsight {
  imageUrl?: string;
  text: string;
  category: KeywordCategory;
  keywords: string[];
  semanticFacts?: Partial<GeoSemanticFacts>;
  imageUrls?: string[];
}

export interface GeoSemanticMetricClaim {
  label?: string;
  subject?: string;
  value?: string;
  unit?: string;
  metric?: string;
  direction?: string;
  timing?: string;
  /**
   * 견준 대상. 상대 수치("자사 알칼리 폼 대비 +84.3%")는 이 값이 없으면
   * 무엇에 견준 값인지 알 수 없어 인용할 수 없다. 생성기는 이미 이 슬롯을
   * 읽고 있었고, 추출기 쪽에만 자리가 없어 보고할 수 없었다.
   */
  comparator?: string;
  /** 비교의 기준선(대조군·무도포 등)을 원문이 따로 밝힌 경우. */
  baseline?: string;
  period?: string;
  sample?: string;
  method?: string;
  caveat?: string;
  sentence?: string;
  sourceText?: string;
  /** 분류 배치 내 상대값(원시 선언 감사용). 이미지 추적에는 imageUrls를 사용할 것 — 멀티 배치 런에서 evidenceIndex는 배치마다 1부터 다시 매겨진다. */
  evidenceIndex?: number;
  imageUrls?: string[];
}

export interface GeoSemanticIngredientBenefitLink {
  ingredient?: string;
  benefit?: string;
  effect?: string;
  sentence?: string;
  sourceText?: string;
  /** 분류 배치 내 상대값(원시 선언 감사용). 이미지 추적에는 imageUrls를 사용할 것 — 멀티 배치 런에서 evidenceIndex는 배치마다 1부터 다시 매겨진다. */
  evidenceIndex?: number;
  imageUrls?: string[];
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
  /** 분류 배치 내 상대값(원시 선언 감사용). 이미지 추적에는 imageUrls를 사용할 것 — 멀티 배치 런에서 evidenceIndex는 배치마다 1부터 다시 매겨진다. */
  evidenceIndex?: number;
  imageUrls?: string[];
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
  imageUrls?: string[];
  /**
   * 전사와 함께 보고된 레이아웃 관계(내부 감사·소비용). 프로바이더가 보고하지
   * 않으면 없다. 공개 `geoProduct`로는 내보내지 않는다 — 관계의 결과는 문장
   * 인사이트와 semanticFacts로 전달되고, 원시 구조를 소비하는 다운스트림은
   * 아직 없다.
   */
  groups?: OcrLayoutGroup[];
}

/** 레이아웃 관계가 왜 폐기됐는지. */
export type OcrLayoutDiscardReason =
  /** 라인의 과반이 전사에 없어 이 전사의 구조가 아니라고 판정됐다. */
  | "quorum"
  /** 슬라이스 중 일부만 구조를 보고해 관계를 반만 세울 수 있었다. */
  | "slice-partial"
  /** 오버랩 지문 일치에 실패해 경계의 줄 소유권을 알 수 없었다. */
  | "overlap-unmatched";

export interface OcrLayoutDiagnostics {
  /** 프로바이더가 보고한 그룹 수(검증 전). */
  groupsReported: number;
  /** 검증을 통과해 실제로 소비된 그룹 수. */
  groupsKept: number;
  /** 채택된 그룹의 라인 역할 분포. */
  lineRoles: Record<OcrLayoutLineRole, number>;
  /** 슬라이스 경계에서 이어 붙인 그룹 수. */
  sliceStitches: number;
  /** 구조를 폐기한 이미지와 그 사유. */
  structureDiscarded: Array<{ imageUrl: string; reason: OcrLayoutDiscardReason }>;
  /**
   * 이어붙이지 못한 슬라이스 경계. 왜 어긋났는지는 그때의 두 판독을 봐야
   * 알 수 있으므로(토큰이 빠졌는가, 줄이 다르게 끊겼는가) 경계 양쪽을 남긴다.
   */
  unmatchedBoundaries?: Array<{ imageUrl: string; sliceIndex: number; tailPreview: string; headPreview: string }>;
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
  /** 소스가 제공한 재고 상태(예: OutOfStock). 추측 발행 금지 — 관측값만. */
  availability?: string;
  itemCondition?: string;
  priceValidUntil?: string;
  returnPolicy?: ExtractedMerchantReturnPolicy;
  description?: string;
  /**
   * Source-provided page/product last-modified date (ISO 8601-like), taken
   * from page metadata or the source payload. Never the extraction time —
   * downstream schema generation emits it as WebPage.dateModified only when
   * the source supplied it.
   */
  dateModified?: string;
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
        imageUrls?: string[];
        confidence?: number;
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

/** 이미지 목록만으로 OCR+관계해석을 수행하는 공개 진입점의 요청. */
export interface ImageOcrEvidenceRequest {
  /** 라벨링·진단에 쓰는 소스 식별자(페이지 URL 등). */
  source: string;
  productName?: string;
  /** OCR 대상 이미지 URL 목록(http/https만 허용, 그 외는 경고 후 제외). */
  imageUrls: string[];
}

/** GeoProductRawData.sourceExtraction.ocr와 동일 형태의 관계 보존 OCR 블록. */
export interface ImageOcrEvidenceResult {
  ocr: {
    imageTexts: Array<{ imageUrl: string; text: string; imageUrls?: string[]; confidence?: number }>;
    textBlocks: string[];
    sentenceInsights: GeoSentenceInsight[];
    semanticFacts?: GeoSemanticFacts;
  };
  keywords: GeoKeywordGroups;
  diagnostics: {
    ocr?: OcrDiagnostics;
    warnings: AgentWarning[];
    runtimeUsage?: RuntimePipelineUsage;
  };
  generatedAt: string;
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
  /**
   * 전사와 함께 보고된 레이아웃 관계의 채택·폐기 기록. 프로바이더가 구조를
   * 전혀 보고하지 않은 런에서는 없다.
   *
   * 프로바이더가 슬라이스마다 구조를 성실히 내는지, 경계 스티칭이 실제로
   * 붙는지는 실측으로만 알 수 있다. 이 블록이 그 판단 근거다.
   */
  layout?: OcrLayoutDiagnostics;
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
  relations?: OcrRelationDiagnostics;
}

/** 문장 하나가 어떤 이미지에서 왔고 어떤 방식으로 귀속됐는지의 감사 레코드. */
export interface OcrRelationSentenceDiagnostic {
  text: string;
  category: KeywordCategory;
  imageUrls: string[];
  /** declared: 모델이 evidenceIndex로 선언 / fuzzy: 텍스트 매칭 폴백 / local: 로컬 휴리스틱 */
  attribution: "declared" | "fuzzy" | "local";
}

/** OCR 문장→이미지 관계 구성 결과의 감사 기록. attributionCounts와 semanticFactLinks는 전수 집계이고, sentences는 최대 120개 표본 목록이다(후보×인사이트 부착 단위로 집계). */
export interface OcrRelationDiagnostics {
  /** 표본 목록(최대 120개). 전수 수치는 attributionCounts를 볼 것. */
  sentences: OcrRelationSentenceDiagnostic[];
  attributionCounts: { declared: number; fuzzy: number; local: number };
  semanticFactLinks: {
    metricClaims: { total: number; withImage: number };
    ingredientBenefitLinks: { total: number; withImage: number };
    citations: { total: number; withImage: number };
  };
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
