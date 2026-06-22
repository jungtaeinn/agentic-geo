import { generatePdpGeoArtifacts } from "./generate";
import { normalizeProductReviewKeywords } from "./keyword-normalizer";
import { normalizePdpProduct } from "./normalize";
import { readPdpGeoGeneratorRagProfile } from "./rag/profile";
import { createPdpGeoRagQuery, resolvePdpGeoRagSettings, retrievePdpGeoRagChunks } from "./rag/retrieval";
import { pdpGeoGeneratorRagManifest } from "./rag/manifest";
import { validateAndRepairPdpGeoArtifacts } from "./validate";
import {
  PdpGeoGenerationInputSchema,
  type PdpGeoDiagnostics,
  type PdpGeoGenerationInput,
  type PdpGeoGenerationRun,
  type PdpGeoGenerationStageId,
  type PdpGeoGenerationStep,
  type PdpGeoGeneratorOptions
} from "./types";

const pipelineSteps: Array<Pick<PdpGeoGenerationStep, "id" | "title" | "description">> = [
  {
    id: "input",
    title: "입력 검증",
    description: "임의 상품 JSON과 옵션을 검증"
  },
  {
    id: "normalize",
    title: "상품 신호 정규화",
    description: "REST/API/PDP JSON을 내부 ProductSignal로 변환"
  },
  {
    id: "rag-load",
    title: "RAG 프로필 로드",
    description: "schema.org, E-E-A-T, CEP, GEO, BestPractice, locale 용어집 로드"
  },
  {
    id: "chunk",
    title: "RAG chunk 구성",
    description: "버전 문서와 상품 컨텍스트를 검색 가능한 chunk로 준비"
  },
  {
    id: "embed",
    title: "임베딩 구성",
    description: "로컬 또는 managed vector store 임베딩 전략 적용"
  },
  {
    id: "retrieve",
    title: "RAG 검색",
    description: "상품/locale/schema 목표에 맞는 관련 문서 검색"
  },
  {
    id: "rerank",
    title: "리랭킹",
    description: "schema, locale, terminology, GEO 관련성을 기준으로 재정렬"
  },
  {
    id: "generate",
    title: "GEO 산출물 생성",
    description: "JSON-LD schema markup과 HTML content 생성"
  },
  {
    id: "validate",
    title: "문법 검증",
    description: "JSON-LD와 HTML 구조 검증"
  },
  {
    id: "repair",
    title: "방어 보정",
    description: "누락된 필수 필드와 안전하지 않은 HTML 보정"
  },
  {
    id: "artifact",
    title: "최종 아티팩트 생성",
    description: "복사 가능한 schemaMarkup과 content 결과 생성"
  }
];

/** Generates GEO-ready schema markup and PDP HTML content from arbitrary product JSON. */
export async function generatePdpGeo(
  input: PdpGeoGenerationInput,
  options: PdpGeoGeneratorOptions = {}
): Promise<PdpGeoGenerationRun> {
  const process = createPipelineTracker(options.onProgress);

  process.start("input", "입력 JSON과 GEO 생성 옵션을 검증합니다.");
  const parsed = PdpGeoGenerationInputSchema.parse(input) as PdpGeoGenerationInput;
  process.done("input", "입력 JSON을 표준 요청으로 검증했습니다.");

  process.start("normalize", "상품 JSON 구조를 자동 추론하고 fieldMapping을 적용합니다.");
  let normalized = normalizePdpProduct(parsed.product, {
    hints: parsed.hints,
    fieldMapping: parsed.fieldMapping,
    sourceUrl: parsed.source?.url
  });
  const keywordNormalization = await normalizeProductReviewKeywords(
    normalized.product,
    normalized.locale,
    normalized.market,
    options
  );
  normalized = {
    ...normalized,
    product: keywordNormalization.product,
    evidence: [
      ...normalized.evidence,
      ...keywordNormalization.evidence
    ]
  };
  process.done(
    "normalize",
    keywordNormalization.evidence.length > 0
      ? `${normalized.product.name} 상품 신호를 정규화하고 리뷰 키워드 오타 후보를 보정했습니다.`
      : `${normalized.product.name} 상품 신호를 정규화했습니다.`
  );

  process.start("rag-load", "패키지 RAG 프로필과 런타임 RAG 문서를 로드합니다.");
  const profile = await readPdpGeoGeneratorRagProfile();
  const ragSettings = resolvePdpGeoRagSettings({
    ...options.rag,
    ...parsed.rag,
    analysisPrompt: parsed.rag?.analysisPrompt ?? options.analysisPrompt ?? profile.analysisPrompt,
    documents: [
      ...profile.documents.map((document) => ({
        name: document.name,
        content: document.content,
        version: document.version
      })),
      ...(options.ragDocuments ?? []),
      ...(parsed.rag?.documents ?? [])
    ]
  });
  const ragDocuments = mergeRagDocuments([
    {
      name: pdpGeoGeneratorRagManifest.analysisPrompt,
      content: ragSettings.analysisPrompt ?? profile.analysisPrompt,
      version: "v1"
    },
    ...(ragSettings.documents ?? [])
  ]);
  process.done("rag-load", `${ragDocuments.length}개 RAG 문서를 로드했습니다.`);

  process.start("chunk", ragSettings.mode === "managed-vector-store-rag" ? "Managed vector store의 색인 chunk를 사용합니다." : "로컬 RAG 문서를 chunk로 분할합니다.");
  process.done("chunk", ragSettings.mode === "managed-vector-store-rag" ? "Managed vector store chunk 구성을 선택했습니다." : "로컬 RAG chunk 구성을 준비했습니다.");

  process.start("embed", ragSettings.mode === "managed-vector-store-rag" ? "Managed vector store 임베딩을 사용합니다." : "로컬 hash embedding을 구성합니다.");
  process.done("embed", ragSettings.mode === "managed-vector-store-rag" ? `${ragSettings.provider} 임베딩 검색 모드를 선택했습니다.` : "로컬 provider-neutral embedding을 구성했습니다.");

  process.start("retrieve", "상품, locale, schema target 기반 RAG 검색 쿼리를 생성합니다.");
  const query = createPdpGeoRagQuery(normalized.product, normalized.locale, normalized.market);
  const retrieved = await retrievePdpGeoRagChunks(
    {
      query,
      product: normalized.product,
      locale: normalized.locale,
      market: normalized.market,
      documents: ragDocuments,
      settings: ragSettings
    },
    {
      apiKey: options.apiKey,
      customRetriever: options.customRetriever
    }
  );
  process.done("retrieve", `${retrieved.length}개 RAG chunk를 검색했습니다.`);

  process.start("rerank", "검색된 chunk를 schema/locale/GEO 관련성 기준으로 정렬합니다.");
  const selectedRagChunks = retrieved.slice(0, ragSettings.maxChunks ?? 8);
  process.done("rerank", `${selectedRagChunks.length}개 chunk를 최종 컨텍스트로 선택했습니다.`);

  process.start("generate", "GEO 최적화 schema markup과 PDP content를 생성합니다.");
  const generated = generatePdpGeoArtifacts({
    product: normalized.product,
    locale: normalized.locale,
    market: normalized.market,
    sourceUrl: parsed.source?.url,
    hints: parsed.hints,
    ragChunks: selectedRagChunks,
    ragDocuments
  });
  process.done("generate", "Product, FAQPage, HowTo, BreadcrumbList, WebPage와 HTML 섹션을 생성했습니다.");

  process.start("validate", "JSON-LD와 HTML 문법을 검증합니다.");
  const repaired = validateAndRepairPdpGeoArtifacts({
    schemaMarkup: generated.schemaMarkup,
    content: generated.content,
    fallbackProductName: generated.content.sections.productName,
    fallbackDescription: generated.content.sections.description,
    locale: normalized.locale
  });
  process.done("validate", `${repaired.validationWarnings.length}개 검증 경고를 확인했습니다.`);

  process.start("repair", "검증 경고에 대한 안전 보정을 적용합니다.");
  process.done("repair", repaired.validationWarnings.length > 0 ? "방어 보정을 적용했습니다." : "추가 보정 없이 통과했습니다.");

  process.start("artifact", "최종 GEO 아티팩트를 직렬화합니다.");
  const generatedAt = new Date().toISOString();
  const diagnostics: PdpGeoDiagnostics = {
    normalizedProduct: normalized.product,
    ocrSentences: normalized.ocrSentences,
    recommendations: generated.recommendations,
    evidence: [
      ...normalized.evidence,
      ...generated.evidence,
      ...repaired.validationWarnings.map((warning) => ({
        field: "validation",
        source: "repair" as const,
        value: warning
      }))
    ],
    selectedRagChunks,
    terminology: generated.terminology,
    validationWarnings: repaired.validationWarnings,
    ragMode: ragSettings.mode,
    generatedAt
  };
  const result = {
    source: parsed.source,
    locale: normalized.locale,
    market: normalized.market,
    schemaMarkup: repaired.schemaMarkup,
    content: repaired.content,
    diagnostics,
    generatedAt,
    ragProfile: profile.profile
  };
  process.done("artifact", "최종 GEO schema/content 아티팩트를 생성했습니다.");

  return {
    result,
    diagnostics,
    process: process.snapshot()
  };
}

interface PdpGeoGenerationProcessTracker {
  start: (id: PdpGeoGenerationStageId, message?: string) => void;
  done: (id: PdpGeoGenerationStageId, message?: string) => void;
  snapshot: () => PdpGeoGenerationStep[];
}

function createPipelineTracker(onProgress?: PdpGeoGeneratorOptions["onProgress"]): PdpGeoGenerationProcessTracker {
  const steps = pipelineSteps.map((step): PdpGeoGenerationStep => ({
    ...step,
    status: "pending"
  }));

  function update(id: PdpGeoGenerationStageId, patch: Partial<PdpGeoGenerationStep>) {
    const index = steps.findIndex((step) => step.id === id);
    const current = steps[index];
    if (!current) {
      return;
    }

    const nextStep: PdpGeoGenerationStep = {
      ...current,
      ...patch
    };
    steps[index] = nextStep;
    onProgress?.({ ...nextStep });
  }

  return {
    start(id, message) {
      update(id, {
        status: "running",
        message,
        startedAt: new Date().toISOString()
      });
    },
    done(id, message) {
      update(id, {
        status: "done",
        message,
        completedAt: new Date().toISOString()
      });
    },
    snapshot() {
      return steps.map((step) => ({ ...step }));
    }
  };
}

function mergeRagDocuments(documents: Array<{ name: string; content: string; version?: string }>): Array<{ name: string; content: string; version?: string }> {
  const map = new Map<string, { name: string; content: string; version?: string }>();
  for (const document of documents) {
    if (!document.name || !document.content) {
      continue;
    }
    map.set(document.name, document);
  }
  return Array.from(map.values());
}
