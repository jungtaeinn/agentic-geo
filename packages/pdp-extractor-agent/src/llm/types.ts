import type { AiTokenUsage, ClassifiedKeyword, ClassifiedSentenceInsight, GeoSemanticFacts } from "../types";

/** Provider IDs supported by the first extractor agent. */
export type LlmProviderId = "mock" | "openai" | "gemini" | "azure-openai" | "aistudio";

/** Azure deployment names mapped to pipeline roles. */
export interface AzureRoleDeployments {
  ocr?: string;
  reasoning?: string;
  embedding?: string;
}

/** Optional embedding runtime used by RAG retrieval. */
export interface EmbeddingRuntimeConfig {
  provider?: "local" | "azure-openai" | "aistudio";
  apiKey?: string;
  endpoint?: string;
  deployment?: string;
  apiVersion?: string;
  model?: string;
}

/** Optional reranker runtime used after initial retrieval. */
export interface RerankerRuntimeConfig {
  provider?: "local-hybrid" | "cohere" | "azure-ai-search-semantic" | "aistudio-bedrock-cohere";
  apiKey?: string;
  endpoint?: string;
  model?: string;
  indexName?: string;
  semanticConfiguration?: string;
  queryLanguage?: string;
}

/** Runtime credentials and endpoint settings for model-backed extraction. */
export interface LlmProviderConfig {
  provider: LlmProviderId;
  apiKey?: string;
  model?: string;
  endpoint?: string;
  deployment?: string;
  deployments?: AzureRoleDeployments;
  apiVersion?: string;
  /** Sampling temperature. Omitted from the request when undefined so models that only accept their default value are not rejected. */
  temperature?: number;
  embedding?: EmbeddingRuntimeConfig;
  reranker?: RerankerRuntimeConfig;
}

/** OCR/vision text classification request passed to provider adapters. */
export interface KeywordClassificationRequest {
  source: string;
  productName?: string;
  analysisPrompt?: string;
  ragDocuments?: Array<{
    name: string;
    content: string;
    score?: number;
    sourceDocument?: string;
    chunkId?: string;
  }>;
  imageTexts: Array<{
    imageUrl: string;
    text: string;
    /** 0-1 legibility confidence reported by the vision OCR transcription pass. */
    confidence?: number;
  }>;
}

/** Structured keyword output expected from every provider adapter. */
export interface KeywordClassificationResponse {
  keywords: ClassifiedKeyword[];
  sentenceInsights?: ClassifiedSentenceInsight[];
  semanticFacts?: Partial<GeoSemanticFacts>;
  summary: string;
  rawText?: string;
  usage?: AiTokenUsage;
}

/**
 * 한 줄의 레이아웃 기능. 의미가 아니라 레이아웃에서의 역할이다.
 *
 * 계약이 담는 것은 "본 것"이고 뜻은 파이프라인이 정한다. 그래서 이 다섯 값은
 * 어떤 상품·어떤 절이 와도 같은 뜻으로 성립한다 — 제목, 본문, 라벨(축 눈금·
 * 범례·캡션·규격), 값(측정 수치·배지), 각주.
 */
export type OcrLayoutLineRole = "title" | "body" | "label" | "value" | "footnote";

export interface OcrLayoutLine {
  text: string;
  role: OcrLayoutLineRole;
  /** 값 라인이 자기 눈금/캡션과 짝지어 인쇄됐을 때의 그 라벨. */
  pairedLabel?: string;
}

/**
 * 레이아웃이 시각적으로 함께 묶어 둔 텍스트 하나. 제목 있는 절, 나란한 패널,
 * 차트, 제품컷, 각주가 모두 여기에 해당한다 — 템플릿을 가정하지 않는다.
 *
 * 중첩 대신 `parentId`로 평면을 유지한다. strict JSON 스키마에서 재귀 `$ref`
 * 지원이 프로바이더마다 갈리기 때문이다.
 */
export interface OcrLayoutGroup {
  /** 이미지(=슬라이스) 안에서 유일한 짧은 id. */
  id: string;
  /** 감싸는 그룹의 id. 최상위면 없음. */
  parentId?: string;
  /** 레이아웃이 따로 세운 이 그룹의 제목. */
  title?: string;
  /** 레이아웃이 실제로 인쇄한 번호. 모델이 스스로 붙인 번호가 아니다. */
  ordinal?: number;
  /** 각주·고지 그룹이 한정하는 대상 그룹의 id. */
  annotates?: string;
  lines: OcrLayoutLine[];
}

/** Vision OCR request passed to providers that can read image URLs directly. */
export interface ImageTextExtractionRequest {
  source: string;
  productName?: string;
  imageUrls: string[];
  /**
   * Optional prepared inputs (e.g. tall-image slices). displayUrl labels the
   * image in prompts and result mapping; inputUrl is what the model reads and
   * may be a base64 data URL. When present it takes precedence over imageUrls.
   */
  imageInputs?: Array<{
    displayUrl: string;
    inputUrl: string;
  }>;
}

/** Text extracted from product images before semantic classification. */
export interface ImageTextExtractionResponse {
  images: Array<{
    imageUrl: string;
    text: string;
    /** Model-reported 0-1 legibility/completeness confidence for this transcription. */
    confidence?: number;
    /**
     * 이 이미지에서 눈에 보이는 레이아웃 관계. 프로바이더가 보고하지 않으면
     * 없으며, 그때는 소비 측이 전사 줄 목록에서 관계를 복원한다.
     */
    groups?: OcrLayoutGroup[];
  }>;
  rawText?: string;
  usage?: AiTokenUsage;
}

/** Common interface for model-backed or mock keyword classifiers. */
export interface KeywordClassifier {
  classifyKeywords(request: KeywordClassificationRequest): Promise<KeywordClassificationResponse>;
  extractImageTexts?(request: ImageTextExtractionRequest): Promise<ImageTextExtractionResponse>;
}
