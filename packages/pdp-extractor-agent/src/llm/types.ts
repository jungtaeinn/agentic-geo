import type { ClassifiedKeyword, ClassifiedSentenceInsight } from "../types";

/** Provider IDs supported by the first extractor agent. */
export type LlmProviderId = "mock" | "openai" | "gemini" | "azure-openai";

/** Runtime credentials and endpoint settings for model-backed extraction. */
export interface LlmProviderConfig {
  provider: LlmProviderId;
  apiKey?: string;
  model?: string;
  endpoint?: string;
  deployment?: string;
  apiVersion?: string;
}

/** OCR/vision text classification request passed to provider adapters. */
export interface KeywordClassificationRequest {
  source: string;
  productName?: string;
  analysisPrompt?: string;
  ragDocuments?: Array<{
    name: string;
    content: string;
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
}

/** Common interface for model-backed or mock keyword classifiers. */
export interface KeywordClassifier {
  classifyKeywords(request: KeywordClassificationRequest): Promise<KeywordClassificationResponse>;
  extractImageTexts?(request: ImageTextExtractionRequest): Promise<ImageTextExtractionResponse>;
}
