import { generatePdpGeoArtifacts } from "./generate";
import { refinePdpGeoCopy } from "./copy-refiner";
import { normalizeProductReviewKeywords } from "./keyword-normalizer";
import { normalizePdpProduct } from "./normalize";
import { readPdpGeoGeneratorRagProfile } from "./rag/profile";
import { createPdpGeoReasoning } from "./rag/reasoning";
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
  type PdpGeoGeneratorOptions,
  type PdpGeoRagFieldTarget,
  type PdpGeoRagIntent,
  type PdpGeoRagUsageDiagnostic,
  type PdpGeoRuntimePipelineStep,
  type PdpGeoRuntimeUsage,
  type PdpGeoTokenUsage,
  type PdpGeoReasoningPrinciple,
  type PdpGeoReasoningResult,
  type PdpGeoRetrievedChunk
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
      customRetriever: options.customRetriever,
      urlResolver: options.customUrlResolver
    }
  );
  process.done("retrieve", `${retrieved.length}개 RAG chunk를 검색했습니다.`);

  process.start("rerank", "검색된 chunk를 schema/locale/GEO 관련성 기준으로 정렬합니다.");
  const selectedRagChunks = retrieved.slice(0, ragSettings.maxChunks ?? 8);
  const reasoningRequest = {
    product: normalized.product,
    locale: normalized.locale,
    market: normalized.market,
    ragChunks: selectedRagChunks
  };
  const reasoning = await (options.customReasoner?.reason(reasoningRequest) ?? createPdpGeoReasoning(reasoningRequest));
  process.done("rerank", `${selectedRagChunks.length}개 chunk를 최종 컨텍스트로 선택하고 ${reasoning.principles.length}개 RAG+상품근거 판단을 구성했습니다.`);

  process.start("generate", "GEO 최적화 schema markup과 PDP content를 생성합니다.");
  let generated = generatePdpGeoArtifacts({
    product: normalized.product,
    locale: normalized.locale,
    market: normalized.market,
    sourceUrl: parsed.source?.url,
    hints: parsed.hints,
    ragChunks: selectedRagChunks,
    ragDocuments,
    reasoning
  });
  const copyRefinement = await refinePdpGeoCopy(
    {
      product: normalized.product,
      locale: normalized.locale,
      market: normalized.market,
      schemaMarkup: generated.schemaMarkup,
      content: generated.content,
      ragChunks: selectedRagChunks,
      reasoning
    },
    options
  );
  generated = {
    ...generated,
    schemaMarkup: copyRefinement.schemaMarkup,
    content: copyRefinement.content,
    evidence: [
      ...generated.evidence,
      ...copyRefinement.evidence
    ]
  };
  process.done(
    "generate",
    copyRefinement.applied
      ? "Product, FAQPage, HowTo, BreadcrumbList, WebPage와 HTML 섹션을 생성하고 Gen AI 문장 refinement를 적용했습니다."
      : "Product, FAQPage, HowTo, BreadcrumbList, WebPage와 HTML 섹션을 생성했습니다."
  );

  process.start("validate", "JSON-LD와 HTML 문법을 검증합니다.");
  const repaired = validateAndRepairPdpGeoArtifacts({
    schemaMarkup: generated.schemaMarkup,
    content: generated.content,
    fallbackProductName: generated.content.sections.productName,
    fallbackDescription: generated.content.sections.description,
    locale: normalized.locale
  });
  process.done("validate", createValidationStepMessage(repaired.validationWarnings, repaired.validationRepairs));

  process.start("repair", "검증 경고에 대한 안전 보정을 적용합니다.");
  process.done("repair", createRepairStepMessage(repaired.validationRepairs));

  process.start("artifact", "최종 GEO 아티팩트를 직렬화합니다.");
  const generatedAt = new Date().toISOString();
  const ragUsage = createRagUsageDiagnostics(selectedRagChunks, reasoning);
  const runtimeUsage = createGeneratorRuntimeUsage(options, ragSettings, {
    keywordNormalizationUsage: keywordNormalization.usage,
    copyRefinementUsage: copyRefinement.usage,
    copyRefinementCalled: copyRefinement.called,
    retrievedCount: retrieved.length,
    selectedRagCount: selectedRagChunks.length,
    ragDocumentCount: ragDocuments.length
  });
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
    reasoning,
    ragUsage,
    runtimeUsage,
    terminology: generated.terminology,
    validationWarnings: repaired.validationWarnings,
    validationRepairs: repaired.validationRepairs,
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

function createValidationStepMessage(warnings: string[], repairs: Array<{ field: string; issue: string }>): string {
  if (warnings.length === 0) {
    return "검증 경고 없이 통과했습니다.";
  }
  const firstRepair = repairs[0];
  if (firstRepair) {
    return `${warnings.length}개 검증 경고를 확인했습니다. 첫 문제: ${firstRepair.field} - ${firstRepair.issue}`;
  }
  return `${warnings.length}개 검증 경고를 확인했습니다. ${warnings.slice(0, 2).join(" / ")}`;
}

function createRepairStepMessage(repairs: Array<{ field: string; action: string }>): string {
  if (repairs.length === 0) {
    return "추가 보정 없이 통과했습니다.";
  }
  const firstRepair = repairs[0];
  if (!firstRepair) {
    return `${repairs.length}개 보정을 적용했습니다.`;
  }
  return `${repairs.length}개 보정을 적용했습니다. 첫 보정: ${firstRepair.field} - ${firstRepair.action}`;
}

function createGeneratorRuntimeUsage(
  options: PdpGeoGeneratorOptions,
  ragSettings: ReturnType<typeof resolvePdpGeoRagSettings>,
  context: {
    keywordNormalizationUsage?: PdpGeoTokenUsage;
    copyRefinementUsage?: PdpGeoTokenUsage;
    copyRefinementCalled?: boolean;
    retrievedCount: number;
    selectedRagCount: number;
    ragDocumentCount: number;
  }
): PdpGeoRuntimeUsage {
  const provider = runtimeProviderLabel(options.provider);
  const finalDeployment = options.deployments?.reasoning ?? options.deployment;
  const embeddingProvider = options.embedding?.provider ?? ragSettings.embeddingProvider;
  const rerankerProvider = options.reranker?.provider ?? ragSettings.rerankerProvider;
  const finalTokenUsage = mergeTokenUsages([
    context.keywordNormalizationUsage,
    context.copyRefinementUsage
  ].filter((usage): usage is PdpGeoTokenUsage => Boolean(usage)));
  const finalDetails = [
    context.keywordNormalizationUsage ? "Model-backed keyword normalization was called during product normalization." : undefined,
    context.copyRefinementCalled ? "Model-backed copy refinement was called after deterministic schema/content generation." : undefined
  ].filter(Boolean).join(" ");
  const steps: PdpGeoRuntimePipelineStep[] = [
    {
      stage: "chunking",
      label: "Chunking",
      provider: "deterministic",
      service: "section-aware deterministic chunking",
      called: true,
      details: `${context.ragDocumentCount} RAG documents prepared as section-aware chunks. No model is used.`
    },
    {
      stage: "embedding",
      label: "Embedding",
      provider: embeddingProvider === "azure-openai" ? "azure-api" : embeddingProvider,
      service: embeddingProvider === "azure-openai" ? "Azure API embedding deployment" : `${embeddingProvider} embedding`,
      model: options.embedding?.model ?? ragSettings.embeddingModel,
      deployment: options.embedding?.deployment ?? options.deployments?.embedding,
      called: ragSettings.mode === "managed-vector-store-rag",
      details: ragSettings.mode === "managed-vector-store-rag"
        ? "Managed/vector retrieval mode is configured."
        : "Generator local-versioned RAG currently uses deterministic local scoring unless a managed retriever is configured."
    },
    {
      stage: "retrieval",
      label: "Retrieval",
      provider: ragSettings.provider,
      service: ragSettings.mode === "managed-vector-store-rag" ? `${ragSettings.provider} managed vector search` : "local-versioned RAG hybrid search",
      mode: ragSettings.mode,
      called: true,
      details: `${context.retrievedCount} chunks retrieved before ${context.selectedRagCount} chunks were selected for generation.`
    },
    {
      stage: "reranking",
      label: "Reranking",
      provider: rerankerProvider,
      service: rerankerProvider === "azure-ai-search-semantic" ? "Azure AI Search semantic ranker" : rerankerProvider === "cohere" ? "Cohere Rerank" : `${rerankerProvider} ordering`,
      model: options.reranker?.provider === "cohere" ? options.reranker.model : undefined,
      called: ragSettings.mode === "managed-vector-store-rag" && ragSettings.rerankerProvider !== "local-hybrid",
      details: "Generator RAG reranking follows the configured RAG retriever/reranker. Local-versioned mode defaults to deterministic score ordering."
    },
    {
      stage: "ocr",
      label: "OCR/structure extraction",
      provider,
      service: options.provider === "azure-openai" ? "Azure API model deployment" : provider,
      model: options.provider === "azure-openai" ? undefined : options.model,
      deployment: options.provider === "azure-openai" ? options.deployments?.ocr ?? options.deployment : undefined,
      called: false,
      details: "Generator consumes OCR evidence from the extractor result; it does not run image OCR itself."
    },
    {
      stage: "final",
      label: "Final classification/reasoning",
      provider,
      service: options.provider === "azure-openai" ? "Azure API model deployment" : provider,
      model: options.provider === "azure-openai" ? undefined : options.model,
      deployment: options.provider === "azure-openai" ? finalDeployment : undefined,
      called: Boolean(context.keywordNormalizationUsage || context.copyRefinementCalled),
      tokenUsage: finalTokenUsage,
      details: finalDetails || "Schema/content reasoning is deterministic in the current generator path; no final model usage metadata was returned."
    }
  ];
  const tokenTotals = mergeTokenUsages(steps.map((step) => step.tokenUsage).filter((usage): usage is PdpGeoTokenUsage => Boolean(usage)));
  const calledModelWithoutTokenUsage = steps.some((step) => step.called && (step.stage === "final" || step.stage === "ocr") && !step.tokenUsage);

  return {
    steps,
    tokenTotals: tokenTotals ?? {},
    tokenNote: tokenTotals
      ? "Token counts are summed from provider usage metadata returned by model APIs."
      : calledModelWithoutTokenUsage
        ? "A model-backed generator step was called, but the provider did not return token usage metadata."
      : "No generator model call returned token usage; deterministic chunking/retrieval/reranking stages do not consume LLM tokens."
  };
}

function mergeTokenUsages(usages: PdpGeoTokenUsage[]): PdpGeoTokenUsage | undefined {
  const merged = usages.reduce<PdpGeoTokenUsage>((total, usage) => ({
    inputTokens: sumOptional(total.inputTokens, usage.inputTokens),
    outputTokens: sumOptional(total.outputTokens, usage.outputTokens),
    totalTokens: sumOptional(total.totalTokens, usage.totalTokens)
  }), {});
  return merged.inputTokens !== undefined || merged.outputTokens !== undefined || merged.totalTokens !== undefined ? merged : undefined;
}

function sumOptional(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined && right === undefined) {
    return undefined;
  }
  return (left ?? 0) + (right ?? 0);
}

function runtimeProviderLabel(provider: PdpGeoGeneratorOptions["provider"]): string {
  if (provider === "azure-openai") {
    return "azure-api";
  }
  return provider ?? "mock";
}

function createRagUsageDiagnostics(
  chunks: PdpGeoRetrievedChunk[],
  reasoning: PdpGeoReasoningResult
): PdpGeoRagUsageDiagnostic[] {
  const chunkByReasoningSource = new Map<string, PdpGeoRetrievedChunk>();

  for (const chunk of chunks) {
    const keys = [
      formatRagSource(chunk),
      chunk.source,
      chunk.title ? `${chunk.source}#${chunk.title}` : undefined
    ].filter((value): value is string => Boolean(value));

    for (const key of keys) {
      if (!chunkByReasoningSource.has(key)) {
        chunkByReasoningSource.set(key, chunk);
      }
    }
  }

  return reasoning.decisions
    .map((decision): PdpGeoRagUsageDiagnostic => {
      const references = decision.ragSources
        .map((source) => chunkByReasoningSource.get(source))
        .filter((chunk): chunk is PdpGeoRetrievedChunk => Boolean(chunk))
        .map((chunk) => {
          const fieldTargets = readChunkFieldTargets(chunk);
          return {
            source: chunk.source,
            title: chunk.title,
            kind: chunk.kind,
            intents: readChunkIntents(chunk),
            fieldTargets,
            score: chunk.score,
            usage: describeRagUsage(decision.principle, fieldTargets),
            excerpt: compactRagExcerpt(chunk.text)
          };
        });

      return {
        principle: decision.principle,
        enabled: decision.enabled,
        confidence: decision.confidence,
        rationale: decision.rationale,
        ragSources: decision.ragSources,
        productEvidenceCount: decision.productEvidence.length,
        references
      };
    })
    .filter((item) => item.enabled || item.references.length > 0);
}

function describeRagUsage(principle: PdpGeoReasoningPrinciple, fieldTargets: PdpGeoRagFieldTarget[]): string {
  const base = {
    "answer-ready FAQ": "FAQ 질문/답변 구성 근거",
    "stepwise HowTo": "HowTo 단계와 사용 루틴 구성 근거",
    "evidence-backed claims": "효능/성분 주장 근거와 과장 방지 기준",
    "target customer context": "고객 맥락과 PDP 설명 문장 구성 근거",
    "review-intent FAQ": "리뷰 언어를 FAQ/고객 질문으로 변환하는 근거"
  } satisfies Record<PdpGeoReasoningPrinciple, string>;
  const targetSummary = fieldTargets.length > 0 ? ` · 대상: ${fieldTargets.slice(0, 4).join(", ")}` : "";
  return `${base[principle]}${targetSummary}`;
}

function readChunkIntents(chunk: PdpGeoRetrievedChunk): PdpGeoRagIntent[] {
  const values = chunk.intents?.length ? chunk.intents : parseMetadataList(chunk.metadata.sectionIntents);
  return values.filter(isPdpGeoRagIntent);
}

function readChunkFieldTargets(chunk: PdpGeoRetrievedChunk): PdpGeoRagFieldTarget[] {
  const values = chunk.fieldTargets?.length ? chunk.fieldTargets : parseMetadataList(chunk.metadata.fieldTargets);
  return values.filter(isPdpGeoRagFieldTarget);
}

function parseMetadataList(value: string | number | boolean | undefined): string[] {
  return typeof value === "string" ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

function formatRagSource(chunk: Pick<PdpGeoRetrievedChunk, "source" | "title">): string {
  return chunk.title ? `${chunk.source}#${chunk.title}` : chunk.source;
}

function compactRagExcerpt(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 260 ? `${compact.slice(0, 257)}...` : compact;
}

function isPdpGeoRagIntent(value: string): value is PdpGeoRagIntent {
  return ["faq", "howTo", "claims", "customer", "review", "schema", "locale", "evidence", "retrieval", "general"].includes(value);
}

function isPdpGeoRagFieldTarget(value: string): value is PdpGeoRagFieldTarget {
  return [
    "WebPage.description",
    "Product.description",
    "Product.additionalProperty",
    "Product.positiveNotes",
    "FAQPage.mainEntity",
    "HowTo.step",
    "BreadcrumbList",
    "PDP.content",
    "diagnostics",
    "retrieval"
  ].includes(value);
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
