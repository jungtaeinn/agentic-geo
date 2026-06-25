import type { AiTokenUsage, ClassifiedKeyword, ClassifiedSentenceInsight } from "../types";

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
  /** Sampling temperature. Omitted from the request when undefined so models that only accept their default value (e.g. gpt-5.5) are not rejected. */
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
  }>;
}

/** Structured keyword output expected from every provider adapter. */
export interface KeywordClassificationResponse {
  keywords: ClassifiedKeyword[];
  sentenceInsights?: ClassifiedSentenceInsight[];
  summary: string;
  rawText?: string;
  usage?: AiTokenUsage;
}

/** Vision OCR request passed to providers that can read image URLs directly. */
export interface ImageTextExtractionRequest {
  source: string;
  productName?: string;
  imageUrls: string[];
}

/** Text extracted from product images before semantic classification. */
export interface ImageTextExtractionResponse {
  images: Array<{
    imageUrl: string;
    text: string;
  }>;
  rawText?: string;
  usage?: AiTokenUsage;
}

/** Common interface for model-backed or mock keyword classifiers. */
export interface KeywordClassifier {
  classifyKeywords(request: KeywordClassificationRequest): Promise<KeywordClassificationResponse>;
  extractImageTexts?(request: ImageTextExtractionRequest): Promise<ImageTextExtractionResponse>;
}
