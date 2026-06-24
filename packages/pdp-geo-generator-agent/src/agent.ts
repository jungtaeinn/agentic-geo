import { generatePdpGeoArtifacts } from "./generate";
import { refinePdpGeoCopy } from "./copy-refiner";
import { normalizeProductReviewKeywords } from "./keyword-normalizer";
import { normalizePdpProduct } from "./normalize";
import { normalizePdpProductWithAgent } from "./product-normalizer";
import { readPdpGeoGeneratorRagProfile } from "./rag/profile";
import { createPdpGeoReasoning } from "./rag/reasoning";
import { createPdpGeoRagQueryPlan, resolvePdpGeoRagSettings, retrievePdpGeoRagChunks } from "./rag/retrieval";
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
  type PdpGeoHydratedRagDocument,
  type PdpGeoLocale,
  type PdpGeoRagFieldTarget,
  type PdpGeoRagIntent,
  type PdpGeoRagUsageDiagnostic,
  type PdpGeoRuntimePipelineStep,
  type PdpGeoRuntimeUsage,
  type PdpGeoTokenUsage,
  type PdpGeoReasoningPrinciple,
  type PdpGeoReasoningResult,
  type PdpGeoRetrievedChunk,
  type PdpProductSignal
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
  const profile = await readPdpGeoGeneratorRagProfile();
  let normalized = normalizePdpProduct(parsed.product, {
    hints: parsed.hints,
    fieldMapping: parsed.fieldMapping,
    sourceUrl: parsed.source?.url
  });
  const productNormalizationRagDocuments = mergeRagDocuments([
    ...profile.documents.map((document) => ({
      name: document.name,
      content: document.content,
      version: document.version
    })),
    ...(options.ragDocuments ?? []),
    ...(parsed.rag?.documents ?? [])
  ]);
  const productNormalization = await normalizePdpProductWithAgent(
    {
      rawProduct: parsed.product,
      bootstrapProduct: normalized.product,
      locale: normalized.locale,
      market: normalized.market,
      source: parsed.source,
      hints: parsed.hints,
      fieldMapping: parsed.fieldMapping,
      analysisPrompt: parsed.rag?.analysisPrompt ?? options.analysisPrompt ?? profile.analysisPrompt,
      ragDocuments: productNormalizationRagDocuments
    },
    options
  );
  normalized = {
    ...normalized,
    product: productNormalization.product,
    locale: productNormalization.locale,
    market: productNormalization.market,
    evidence: [
      ...normalized.evidence,
      ...productNormalization.evidence
    ]
  };
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
    createNormalizeStepMessage(normalized.product.name, productNormalization, keywordNormalization.evidence.length > 0)
  );

  process.start("rag-load", "패키지 RAG 프로필과 런타임 RAG 문서를 로드합니다.");
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

  process.start("retrieve", "상품, locale, schema target 기반 RAG query plan을 생성합니다.");
  const queryPlan = createPdpGeoRagQueryPlan(
    normalized.product,
    normalized.locale,
    normalized.market,
    ragSettings,
    parsed.hints?.updateTargets
  );
  const primaryRetrieved = mergeRetrievedRagChunks((await Promise.all(queryPlan.queries.map((subquery) =>
    retrievePdpGeoRagChunks(
      {
        query: subquery.query,
        product: normalized.product,
        locale: normalized.locale,
        market: normalized.market,
        documents: ragDocuments,
        settings: createRetrievalCandidateSettings(ragSettings)
      },
      {
        apiKey: options.apiKey,
        customRetriever: options.customRetriever,
        urlResolver: options.customUrlResolver
      }
    ).then((chunks) => chunks.map((chunk) => ({
      ...chunk,
      metadata: {
        ...chunk.metadata,
        queryPlanTarget: subquery.target,
        queryPlanReason: subquery.reason
      },
      score: boostChunkForSubquery(chunk, subquery.fieldTargets, subquery.intents)
    })))
  ))).flat());
  const preliminarySelectedRagChunks = selectFinalRagChunks(primaryRetrieved, ragSettings.maxChunks ?? 8);
  const strategicCoverageChunks = await retrieveStrategicCoverageRagChunks({
    existingChunks: preliminarySelectedRagChunks,
    product: normalized.product,
    locale: normalized.locale,
    market: normalized.market,
    documents: ragDocuments,
    settings: ragSettings,
    apiKey: options.apiKey,
    customRetriever: options.customRetriever,
    urlResolver: options.customUrlResolver
  });
  const retrieved = mergeRetrievedRagChunks([
    ...primaryRetrieved,
    ...strategicCoverageChunks
  ]);
  process.done(
    "retrieve",
    queryPlan.mode === "agentic-subquery-planning"
      ? `${queryPlan.queries.length}개 subquery로 ${retrieved.length}개 RAG chunk를 검색했습니다.`
      : `${retrieved.length}개 RAG chunk를 검색했습니다.`
  );

  process.start("rerank", "검색된 chunk를 schema/locale/GEO 관련성 기준으로 정렬합니다.");
  const selectedRagChunks = selectFinalRagChunks(retrieved, ragSettings.maxChunks ?? 8);
  const hydratedRagDocuments = hydrateSelectedRagDocuments(selectedRagChunks, ragDocuments, ragSettings);
  const reasoningRequest = {
    product: normalized.product,
    locale: normalized.locale,
    market: normalized.market,
    ragChunks: selectedRagChunks,
    hydratedRagDocuments
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
      hydratedRagDocuments,
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
    productNormalizationUsage: productNormalization.usage,
    productNormalizationCalled: productNormalization.called,
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
    hydratedRagDocuments,
    reasoning,
    ragQueryPlan: queryPlan,
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

function mergeRetrievedRagChunks(chunks: PdpGeoRetrievedChunk[]): PdpGeoRetrievedChunk[] {
  const merged = new Map<string, PdpGeoRetrievedChunk>();
  for (const chunk of chunks) {
    const key = `${chunk.source}:${chunk.title ?? ""}:${chunk.id}`;
    const current = merged.get(key);
    if (!current || chunk.score > current.score) {
      merged.set(key, chunk);
    }
  }
  return Array.from(merged.values()).sort((a, b) => b.score - a.score);
}

const strategicRagKinds = new Set(["geo-research", "cep", "eeat"]);

const strategicCoverageDocuments = [
  {
    kind: "geo-research",
    document: pdpGeoGeneratorRagManifest.documents.geoResearch,
    query: "GEO research guidance for answer-ready product facts, schema/content alignment, retrieval and query planning, FAQ and HowTo answerability.",
    reason: "Ensure GEO research strategy is present when general retrieval ranks operational chunks higher."
  },
  {
    kind: "cep",
    document: pdpGeoGeneratorRagManifest.documents.cep,
    query: "Category Entry Point guidance for customer needs, routine moments, review questions, FAQ updates, HowToUse updates, and PDP field mapping.",
    reason: "Ensure CEP customer-entry strategy is present when general retrieval ranks operational chunks higher."
  },
  {
    kind: "eeat",
    document: pdpGeoGeneratorRagManifest.documents.eeat,
    query: "E-E-A-T trust-first claim safety, evidence hierarchy, customer experience, expertise, authoritativeness, and partial update query planning.",
    reason: "Ensure E-E-A-T claim-safety strategy is present when general retrieval ranks operational chunks higher."
  }
] as const;

function createRetrievalCandidateSettings<T extends { maxChunks?: number }>(settings: T): T {
  return {
    ...settings,
    maxChunks: Math.max(settings.maxChunks ?? 8, 24)
  };
}

async function retrieveStrategicCoverageRagChunks(input: {
  existingChunks: PdpGeoRetrievedChunk[];
  product: PdpProductSignal;
  locale: PdpGeoLocale;
  market?: string;
  documents: Array<{ name: string; content: string; version?: string }>;
  settings: ReturnType<typeof resolvePdpGeoRagSettings>;
  apiKey?: PdpGeoGeneratorOptions["apiKey"];
  customRetriever?: PdpGeoGeneratorOptions["customRetriever"];
  urlResolver?: PdpGeoGeneratorOptions["customUrlResolver"];
}): Promise<PdpGeoRetrievedChunk[]> {
  const missingDocuments = strategicCoverageDocuments.filter((entry) =>
    !input.existingChunks.some((chunk) => chunk.kind === entry.kind)
  );
  if (missingDocuments.length === 0) {
    return [];
  }

  const chunks = await Promise.all(missingDocuments.map(async (entry) => {
    const document = input.documents.find((candidate) => candidate.name === entry.document);
    if (!document) {
      return [];
    }
    const retrieved = await retrievePdpGeoRagChunks(
      {
        query: [
          entry.query,
          `Product: ${input.product.name}.`,
          input.product.category ? `Category: ${input.product.category}.` : undefined,
          input.product.benefits.length > 0 ? `Benefits: ${input.product.benefits.slice(0, 4).join(", ")}.` : undefined,
          input.product.ingredients.length > 0 ? `Ingredients: ${input.product.ingredients.slice(0, 4).join(", ")}.` : undefined,
          input.product.usage.length > 0 ? `Usage: ${input.product.usage.slice(0, 2).join(" ")}` : undefined,
          input.product.reviews.keywords.length > 0 ? `Review keywords: ${input.product.reviews.keywords.slice(0, 4).join(", ")}.` : undefined
        ].filter(Boolean).join(" "),
        product: input.product,
        locale: input.locale,
        market: input.market,
        documents: [document],
        settings: {
          ...input.settings,
          maxChunks: 3,
          scoreThreshold: 0
        }
      },
      {
        apiKey: input.apiKey,
        customRetriever: input.customRetriever,
        urlResolver: input.urlResolver
      }
    );
    return retrieved.map((chunk) => ({
      ...chunk,
      metadata: {
        ...chunk.metadata,
        queryPlanTarget: "strategicCoverage",
        queryPlanReason: entry.reason
      }
    }));
  }));

  return chunks.flat();
}

function hydrateSelectedRagDocuments(
  selectedChunks: PdpGeoRetrievedChunk[],
  documents: Array<{ name: string; content: string; version?: string }>,
  settings: ReturnType<typeof resolvePdpGeoRagSettings>
): PdpGeoHydratedRagDocument[] {
  const hydration = settings.fullDocumentHydration;
  if (hydration?.enabled === false) {
    return [];
  }

  const strategicOnly = hydration?.strategicOnly ?? true;
  const maxDocuments = hydration?.maxDocuments ?? 3;
  const candidateChunks = selectedChunks.filter((chunk) => !strategicOnly || strategicRagKinds.has(chunk.kind));
  const sourceToChunks = new Map<string, PdpGeoRetrievedChunk[]>();

  for (const chunk of candidateChunks) {
    const group = sourceToChunks.get(chunk.source) ?? [];
    group.push(chunk);
    sourceToChunks.set(chunk.source, group);
  }

  const hydrated: PdpGeoHydratedRagDocument[] = [];
  for (const [source, chunks] of sourceToChunks) {
    const document = documents.find((candidate) => candidate.name === source);
    const firstChunk = chunks[0];
    if (!document || !firstChunk) {
      continue;
    }
    hydrated.push({
      source,
      version: document.version,
      kind: firstChunk.kind,
      hydrationMode: "controlled-full-document",
      selectedChunkTitles: uniqueStrings(chunks.map((chunk) => chunk.title).filter((title): title is string => Boolean(title))),
      content: document.content
    });
    if (hydrated.length >= maxDocuments) {
      break;
    }
  }

  return hydrated;
}

function selectFinalRagChunks(chunks: PdpGeoRetrievedChunk[], maxChunks: number): PdpGeoRetrievedChunk[] {
  const limit = Math.max(1, maxChunks);
  const selected = chunks.slice(0, limit);
  const selectedKeys = new Set(selected.map(ragChunkKey));

  for (const kind of strategicRagKinds) {
    if (selected.some((chunk) => chunk.kind === kind)) {
      continue;
    }
    const candidate = chunks.find((chunk) => chunk.kind === kind && !selectedKeys.has(ragChunkKey(chunk)));
    if (!candidate) {
      continue;
    }
    if (selected.length < limit) {
      selected.push(candidate);
      selectedKeys.add(ragChunkKey(candidate));
      continue;
    }
    const replacementIndex = findStrategicCoverageReplacementIndex(selected, kind);
    const replacement = selected[replacementIndex];
    if (replacement) {
      selectedKeys.delete(ragChunkKey(replacement));
      selected[replacementIndex] = candidate;
      selectedKeys.add(ragChunkKey(candidate));
    }
  }

  return selected.sort((a, b) => b.score - a.score);
}

function findStrategicCoverageReplacementIndex(chunks: PdpGeoRetrievedChunk[], missingKind: string): number {
  const kindCounts = chunks.reduce((counts, chunk) => {
    counts.set(chunk.kind, (counts.get(chunk.kind) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());
  let replacementIndex = -1;
  let replacementScore = Number.POSITIVE_INFINITY;
  for (const [index, chunk] of chunks.entries()) {
    if (strategicRagKinds.has(chunk.kind)) {
      continue;
    }
    if (chunk.score < replacementScore) {
      replacementIndex = index;
      replacementScore = chunk.score;
    }
  }
  if (replacementIndex >= 0) {
    return replacementIndex;
  }

  replacementScore = Number.POSITIVE_INFINITY;
  for (const [index, chunk] of chunks.entries()) {
    if (chunk.kind === missingKind || (kindCounts.get(chunk.kind) ?? 0) <= 1) {
      continue;
    }
    if (chunk.score < replacementScore) {
      replacementIndex = index;
      replacementScore = chunk.score;
    }
  }
  return replacementIndex;
}

function ragChunkKey(chunk: PdpGeoRetrievedChunk): string {
  return `${chunk.source}:${chunk.title ?? ""}:${chunk.id}`;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function boostChunkForSubquery(
  chunk: PdpGeoRetrievedChunk,
  fieldTargets: PdpGeoRagFieldTarget[],
  intents: PdpGeoRagIntent[]
): number {
  const chunkTargets = new Set([...(chunk.fieldTargets ?? []), ...parseMetadataList(chunk.metadata.fieldTargets)].filter(isPdpGeoRagFieldTarget));
  const chunkIntents = new Set([...(chunk.intents ?? []), ...parseMetadataList(chunk.metadata.sectionIntents)].filter(isPdpGeoRagIntent));
  const fieldMatch = fieldTargets.some((fieldTarget) => chunkTargets.has(fieldTarget));
  const intentMatch = intents.some((intent) => chunkIntents.has(intent));
  return Math.min(1, chunk.score + (fieldMatch ? 0.08 : 0) + (intentMatch ? 0.04 : 0));
}

function createNormalizeStepMessage(
  productName: string,
  productNormalization: { called: boolean; applied: boolean },
  keywordNormalizationApplied: boolean
): string {
  const actions = [
    productNormalization.applied
      ? "상품 신호를 에이전트 정규화로 보강"
      : productNormalization.called
        ? "상품 신호 에이전트 정규화를 검토"
        : "상품 신호를 부트스트랩 정규화",
    keywordNormalizationApplied ? "리뷰 키워드 오타 후보를 보정" : undefined
  ].filter(Boolean);

  return `${productName} ${actions.join("하고 ")}했습니다.`;
}

function createGeneratorRuntimeUsage(
  options: PdpGeoGeneratorOptions,
  ragSettings: ReturnType<typeof resolvePdpGeoRagSettings>,
  context: {
    productNormalizationUsage?: PdpGeoTokenUsage;
    productNormalizationCalled?: boolean;
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
    context.productNormalizationUsage,
    context.keywordNormalizationUsage,
    context.copyRefinementUsage
  ].filter((usage): usage is PdpGeoTokenUsage => Boolean(usage)));
  const finalDetails = [
    context.productNormalizationCalled ? "Model-backed product signal normalization was called before keyword normalization." : undefined,
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
        : "Generator local-versioned RAG uses local contextual hybrid vectors and lexical signals unless a managed retriever is configured."
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
      details: ragSettings.mode === "managed-vector-store-rag"
        ? "Generator RAG reranking follows the configured managed retriever/reranker."
        : "Local-versioned mode applies contextual hybrid reranking metadata before strategic GEO/CEP/E-E-A-T coverage selection."
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
      called: Boolean(context.productNormalizationCalled || context.keywordNormalizationUsage || context.copyRefinementCalled),
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
