/**
 * Checked-in wire DTOs for the Python Agent API. The service intentionally
 * retains extensible diagnostics payloads, so nested diagnostic records stay
 * open while the stable console-facing fields are explicit.
 */
export interface OpenAgentDto {
  [key: string]: any;
}

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
  geoProduct: OpenAgentDto & {
    rag: { chunks: Array<{ id: string; kind: string; text: string }> };
  };
  generatedAt: string;
  ragProfile: string;
}

export interface ProductExtractionDiagnostics {
  source: string;
  sourceType: ProductExtractionResult["sourceType"];
  process: ProductExtractionStep[];
  evidence: OpenAgentDto[];
  warnings: Array<{ code: string; message: string }>;
  generatedAt: string;
  ragProfile: string;
  [key: string]: any;
}

export type PdpGeoLocale = "ko-KR" | "ja-JP" | "en-US" | "en-GB";
export type PdpGeoRagMode = "local-versioned-rag" | "managed-vector-store-rag";
export type PdpGeoGenerationStageId =
  | "input" | "normalize" | "rag-load" | "chunk" | "embed" | "retrieve" | "rerank" | "generate" | "validate" | "repair" | "quality-gate" | "artifact";

export interface PdpGeoGenerationStep {
  id: PdpGeoGenerationStageId;
  title: string;
  description: string;
  status: "pending" | "running" | "done" | "error";
  message?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface PdpGeoOcrSentenceDiagnostic {
  text: string;
  imageUrls?: string[];
  intents: string[];
  schemaFields: string[];
  geoUse: string;
}

/**
 * A safe, copy-free record for an output unit removed after final provenance
 * validation. The API never includes omitted copy, source text, URLs, or IDs
 * in this shape.
 */
export interface PdpGeoPublicCopyOmission {
  fieldPath: string;
  action: "sentenceOmitted" | "fieldOmitted" | "faqItemOmitted" | "howToStepOmitted";
  reason: "noEligibleEvidence" | "assertionFrameRejected" | "directSupportRejected" | "unresolvedBinding";
  count: number;
  sentenceIndex: number | null;
}

export interface PdpGeoDiagnostics extends OpenAgentDto {
  normalizedProduct: OpenAgentDto;
  ocrSentences: PdpGeoOcrSentenceDiagnostic[];
  recommendations: OpenAgentDto[];
  evidence: OpenAgentDto[];
  selectedRagChunks: Array<OpenAgentDto & { id: string; source: string; kind: string; text: string; score: number; title?: string; metadata?: Record<string, string | number | boolean> }>;
  ragUsage: Array<OpenAgentDto & {
    principle: string;
    enabled: boolean;
    confidence: number;
    productEvidenceCount: number;
    references: Array<OpenAgentDto & { source: string; title?: string; kind: string; excerpt: string; score?: number; usage: string; intents: string[]; fieldTargets: string[] }>;
  }>;
  terminology: OpenAgentDto;
  validationWarnings: string[];
  validationFindings?: OpenAgentDto[];
  validationRepairs?: Array<OpenAgentDto & { field: string; source: string; issue: string; action: string }>;
  publicCopyOmissions?: PdpGeoPublicCopyOmission[];
  ragMode: PdpGeoRagMode;
  generatedAt: string;
}

export interface PdpGeoGenerationResult {
  locale: PdpGeoLocale;
  market?: string;
  schemaMarkup: OpenAgentDto;
  content: OpenAgentDto;
  diagnostics: PdpGeoDiagnostics;
  generatedAt: string;
  ragProfile: string;
}

export interface CitationProbeResult extends OpenAgentDto {
  engineId: string;
  queries: Array<OpenAgentDto & {
    query: string;
    querySource: string;
    vanilla: { wordpos: number };
    generated: { wordpos: number };
    delta: { wordpos: number };
    sectionAttribution?: Array<{ sectionId: string; share: number; sentences?: string[] }>;
    imageAttribution?: Array<{ sectionId: string; share: number; sentences?: string[] }>;
  }>;
  mean: { vanilla: { wordpos: number }; generated: { wordpos: number }; delta: { wordpos: number } };
  gate: { pass: boolean };
  keypointCoverage?: { contradicted: number; supported: number; total: number };
  sectionAttribution?: Array<{ sectionId: string; share: number; sentences?: string[] }>;
  imageAttribution?: Array<{ sectionId: string; share: number; sentences?: string[] }>;
  warnings: string[];
}

export interface GeoQualityEvaluation {
  overallScore: number;
  dimensions: Array<{
    id: "geo" | "cep" | "eeat";
    label: string;
    score: number;
    criteria: string;
    summary: string;
    evidence: string[];
    improvements: string[];
  }>;
  validationDetails: string[];
  validationImprovements: string[];
}

export interface EasyImprovementItem {
  text: string;
  subItems?: string[];
}
