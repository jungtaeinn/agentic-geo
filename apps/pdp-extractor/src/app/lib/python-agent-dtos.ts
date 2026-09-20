/** Checked-in browser DTOs for the Python Agent API. */
export type ProductExtractionStageId = "input" | "fetch" | "extract" | "ocr" | "review" | "rag" | "json";

export interface ProductExtractionStepMetrics {
  ocrImageCandidateCount?: number;
  reviewItemCount?: number;
  ragChunkCount?: number;
}

export interface ProductExtractionStep {
  id: ProductExtractionStageId;
  title: string;
  description: string;
  status: "pending" | "running" | "done" | "error";
  message?: string;
  metrics?: ProductExtractionStepMetrics;
  startedAt?: string;
  completedAt?: string;
}

export interface ProductExtractionResult {
  source: string;
  sourceType: "url" | "restApi" | "mock";
  geoProduct: {
    name: string;
    images: string[];
    reviews: { keywords: string[] };
    ocr: { textBlocks: string[] };
    contentAnalysis: { sections: unknown[] };
    rag: { chunks: Array<{ id: string; kind: "product" | "review" | "faq" | "ocr" | "source"; text: string }> };
    [key: string]: unknown;
  };
  generatedAt: string;
  ragProfile: string;
}

export interface ProductExtractionDiagnostics {
  source: string;
  sourceType: ProductExtractionResult["sourceType"];
  process: ProductExtractionStep[];
  evidence: Array<{ field: string; source: string; value: string }>;
  warnings: Array<{ code: string; message: string }>;
  generatedAt: string;
  ragProfile: string;
}
