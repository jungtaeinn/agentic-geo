import { ensurePdpGeoFaqPlanCoverage, generatePdpGeoArtifacts } from "./generate";
import { refinePdpGeoCopy } from "./copy-refiner";
import { createPdpGeoPublicCopyProvenance, finalProofreadPdpGeoArtifacts } from "./final-proofreader";
import { createPdpGeoEvidenceLedger, planPdpGeoContent } from "./content-planner";
import { normalizeProductReviewKeywords } from "./keyword-normalizer";
import { normalizePdpProduct } from "./normalize";
import { normalizePdpProductWithAgent } from "./product-normalizer";
import { compilePdpGeoPolicyChecklist } from "./rag/policy-compiler";
import { readPdpGeoGeneratorRagProfile } from "./rag/profile";
import { createPdpGeoReasoning } from "./rag/reasoning";
import { createPdpGeoRagQueryPlan, resolvePdpGeoRagSettings, retrievePdpGeoRagChunks } from "./rag/retrieval";
import { pdpGeoGeneratorRagManifest } from "./rag/manifest";
import { validatePdpGeoArtifacts } from "./validate";
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
    title: "GEO 산출물 생성 및 최종 교정",
    description: "JSON-LD 생성 후 선택적으로 별도 fluency-only proofreading 모델 호출"
  },
  {
    id: "validate",
    title: "문법 검증",
    description: "JSON-LD 구조와 공개 문구 검증"
  },
  {
    id: "repair",
    title: "검증 결과 기록",
    description: "자동 수정 없이 validation findings를 diagnostics에 기록"
  },
  {
    id: "artifact",
    title: "최종 아티팩트 생성",
    description: "복사 가능한 schemaMarkup과 content 결과 생성"
  }
];

/** Generates GEO-ready schema markup from arbitrary product JSON. */
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
  const profileDocuments = profile.documents.map((document) => ({
    name: document.name,
    content: document.content,
    version: document.version
  }));
  let normalized = normalizePdpProduct(parsed.product, {
    hints: parsed.hints,
    fieldMapping: parsed.fieldMapping,
    sourceUrl: parsed.source?.url
  });
  const productNormalizationRagDocuments = mergeRagDocuments(scopeBrandRagDocuments([
    ...profileDocuments,
    ...(options.ragDocuments ?? []),
    ...(parsed.rag?.documents ?? [])
  ], normalized.product, parsed.hints));
  if (shouldReportProductNormalizationCall(options)) {
    process.start("normalize", `${runtimeProviderLabel(options.productNormalization?.provider ?? options.provider)} product signal normalization 모델을 호출합니다.`);
  }
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
    // Locale and explicit market are request control-plane values. A model may
    // classify source languages, but it must not silently change the target
    // language/market selected by the caller or deterministic bootstrap.
    locale: parsed.hints?.locale ?? normalized.locale,
    market: parsed.hints?.market ?? productNormalization.market ?? normalized.market,
    evidence: [
      ...normalized.evidence,
      ...productNormalization.evidence
    ]
  };
  if (shouldReportKeywordNormalizationCall(options)) {
    process.start("normalize", `${runtimeProviderLabel(options.keywordNormalization?.provider ?? options.provider)} review keyword normalization 모델을 호출합니다.`);
  }
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
    documents: scopeBrandRagDocuments([
      ...profileDocuments,
      ...(options.ragDocuments ?? []),
      ...(parsed.rag?.documents ?? [])
    ], normalized.product, parsed.hints)
  });
  const ragDocuments = mergeRagDocuments([
    {
      name: pdpGeoGeneratorRagManifest.analysisPrompt,
      content: ragSettings.analysisPrompt ?? profile.analysisPrompt,
      version: "v1"
    },
    ...(ragSettings.documents ?? [])
  ]);
  const policyChecklist = compilePdpGeoPolicyChecklist(ragDocuments, ragSettings.policyChecklist);
  process.done(
    "rag-load",
    `${ragDocuments.length}개 RAG 문서를 로드하고 ${policyChecklist.coverage.totalRules}개 정책 규칙을 컴파일했습니다 (프롬프트 주입 ${policyChecklist.coverage.injectedRules}개, critical ${policyChecklist.coverage.injectedCriticalRules}/${policyChecklist.coverage.criticalRules}개).`
  );

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
  const brandIdentityCoverageChunks = await retrieveBrandIdentityCoverageRagChunks({
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
  const retrieved = markBrandIdentityCoverageRagChunks(mergeRetrievedRagChunks([
    ...primaryRetrieved,
    ...strategicCoverageChunks,
    ...brandIdentityCoverageChunks
  ]), normalized.product);
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
  const evidenceLedger = createPdpGeoEvidenceLedger(normalized.product, normalized.locale);
  if (shouldReportContentPlanningCall(options)) {
    process.start("generate", `${runtimeProviderLabel(options.contentPlanning?.provider ?? options.provider)} evidence-bound content/schema planning 모델을 호출합니다.`);
  }
  const contentPlanning = await planPdpGeoContent({
    product: normalized.product,
    locale: normalized.locale,
    market: normalized.market,
    hints: parsed.hints,
    evidenceLedger,
    ragChunks: selectedRagChunks,
    policyRules: policyChecklist.injectedRules
  }, options);
  const plannedFaqCountBeforeCoverage = contentPlanning.plan.faq.filter((item) => item.include).length;
  contentPlanning.plan = ensurePdpGeoFaqPlanCoverage({
    plan: contentPlanning.plan,
    product: normalized.product,
    locale: normalized.locale,
    market: normalized.market,
    ragChunks: selectedRagChunks,
    reasoning,
    evidenceLedger
  });
  const plannedFaqCountAfterCoverage = contentPlanning.plan.faq.filter((item) => item.include).length;
  if (plannedFaqCountAfterCoverage > plannedFaqCountBeforeCoverage) {
    contentPlanning.evidence.push({
      field: "content.plan.faq",
      source: "rag",
      value: `Completed source-backed FAQ coverage from ${plannedFaqCountBeforeCoverage} to ${plannedFaqCountAfterCoverage} item(s), ordered as target customer, composition and benefits, then additional applicable product questions.`
    });
  }
  let generated = generatePdpGeoArtifacts({
    product: normalized.product,
    locale: normalized.locale,
    market: normalized.market,
    sourceUrl: parsed.source?.url,
    hints: parsed.hints,
    ragChunks: selectedRagChunks,
    ragDocuments,
    reasoning,
    contentPlan: contentPlanning.plan
  });
  const renderedPublicCopyProvenance = createPdpGeoPublicCopyProvenance({
    schemaMarkup: generated.schemaMarkup,
    contentPlan: contentPlanning.plan,
    evidenceLedger
  });
  const plannedDescriptionsApplied = contentPlanning.plan.productDescription.include
    && contentPlanning.plan.webPageDescription.include;
  const shouldRunCopyRefinement = !contentPlanning.applied
    || !plannedDescriptionsApplied
    || options.copyRefinement?.enabled === true;
  if (shouldRunCopyRefinement && shouldReportCopyRefinementCall(options)) {
    process.start("generate", `${runtimeProviderLabel(options.copyRefinement?.provider ?? options.provider)} final reasoning/copy refinement 모델을 호출합니다.`);
  }
  const copyRefinement = shouldRunCopyRefinement
    ? await refinePdpGeoCopy(
      {
        product: normalized.product,
        locale: normalized.locale,
        market: normalized.market,
        schemaMarkup: generated.schemaMarkup,
        content: generated.content,
        ragChunks: selectedRagChunks,
        hydratedRagDocuments,
        reasoning,
        policyRules: policyChecklist.injectedRules,
        inferredSearchQueries: generated.inferredSearchQueries
      },
      options
    )
    : {
        schemaMarkup: generated.schemaMarkup,
        content: generated.content,
        evidence: [],
        warnings: [],
        called: false,
        applied: false,
        rejections: []
      };
  generated = {
    ...generated,
    schemaMarkup: copyRefinement.schemaMarkup,
    content: copyRefinement.content,
    evidence: [
      ...generated.evidence,
      ...contentPlanning.evidence,
      ...copyRefinement.evidence
    ]
  };
  if (shouldReportFinalProofreadingCall(options)) {
    process.start("generate", `${runtimeProviderLabel(options.finalProofreading?.provider ?? options.provider)} final fluency-only proofreading 모델을 호출합니다.`);
  }
  const finalProofreading = await finalProofreadPdpGeoArtifacts({
    product: normalized.product,
    locale: normalized.locale,
    market: normalized.market,
    schemaMarkup: generated.schemaMarkup,
    content: generated.content,
    evidenceLedger,
    contentPlan: contentPlanning.plan,
    publicCopyProvenance: renderedPublicCopyProvenance
  }, options);
  generated = {
    ...generated,
    schemaMarkup: finalProofreading.schemaMarkup,
    content: finalProofreading.content,
    evidence: [...generated.evidence, ...finalProofreading.evidence]
  };
  process.done(
    "generate",
    finalProofreading.diagnostics.applied
      ? `근거와 구조를 잠근 상태에서 ${finalProofreading.diagnostics.acceptedFields.length}개 필드의 최종 문장 교정을 적용했습니다.`
      : contentPlanning.applied
      ? "근거 ID 기반 Schema Plan으로 적합한 Product, WebPage, FAQ, HowTo를 생성했습니다."
      : copyRefinement.applied
        ? "보수적 스키마 적합성 판단 후 Gen AI 문장 refinement를 적용했습니다."
        : "보수적 스키마 적합성 판단으로 근거가 확인된 산출물을 생성했습니다."
  );

  process.start("validate", "최종 교정 이후 JSON-LD와 공개 문구를 읽기 전용으로 검증합니다.");
  const validated = validatePdpGeoArtifacts({
    schemaMarkup: generated.schemaMarkup,
    content: generated.content,
    fallbackProductName: generated.content.sections.productName,
    fallbackDescription: generated.content.sections.description,
    locale: normalized.locale
  });
  process.done("validate", createValidationStepMessage(validated.validationWarnings, validated.validationFindings));

  process.start("repair", "검증기는 문장을 수정하지 않고 진단만 기록합니다.");
  process.done("repair", "자동 보정을 적용하지 않았습니다. 최종 교정 산출물을 그대로 보존했습니다.");

  process.start("artifact", "최종 GEO 아티팩트를 직렬화합니다.");
  const generatedAt = new Date().toISOString();
  const ragUsage = createRagUsageDiagnostics(selectedRagChunks, reasoning);
  const runtimeUsage = createGeneratorRuntimeUsage(options, ragSettings, {
    productNormalizationUsage: productNormalization.usage,
    productNormalizationCalled: productNormalization.called,
    keywordNormalizationUsage: keywordNormalization.usage,
    contentPlanningUsage: contentPlanning.usage,
    contentPlanningCalled: contentPlanning.called,
    copyRefinementUsage: copyRefinement.usage,
    copyRefinementCalled: copyRefinement.called,
    finalProofreadingUsage: finalProofreading.usage,
    finalProofreadingCalled: finalProofreading.diagnostics.called,
    retrievedCount: retrieved.length,
    selectedRagCount: selectedRagChunks.length,
    ragDocumentCount: ragDocuments.length
  });
  const diagnostics: PdpGeoDiagnostics = {
    normalizedProduct: normalized.product,
    evidenceLedger,
    contentPlan: contentPlanning.plan,
    ocrSentences: normalized.ocrSentences,
    recommendations: generated.recommendations,
    evidence: [
      ...normalized.evidence,
      ...generated.evidence,
      ...validated.validationWarnings.map((warning) => ({
        field: "validation",
        source: "schema-validator" as const,
        value: warning
      }))
    ],
    selectedRagChunks,
    hydratedRagDocuments,
    policyCoverage: policyChecklist.coverage,
    reasoning,
    ragQueryPlan: queryPlan,
    ragUsage,
    runtimeUsage,
    terminology: generated.terminology,
    inferredSearchQueries: generated.inferredSearchQueries,
    finalProofreading: finalProofreading.diagnostics,
    finalPublicCopyProvenance: finalProofreading.finalPublicCopyProvenance,
    validationWarnings: validated.validationWarnings,
    validationFindings: validated.validationFindings,
    validationRepairs: [],
    ragMode: ragSettings.mode,
    generatedAt
  };
  const result = {
    source: parsed.source,
    locale: normalized.locale,
    market: normalized.market,
    schemaMarkup: generated.schemaMarkup,
    content: generated.content,
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
const coverageRagKindOrder: PdpGeoRetrievedChunk["kind"][] = [
  // Reserve the cross-cutting reasoning spine first. With the default budget
  // every family still fits; under a smaller budget GEO/EEAT/CEP must not be
  // displaced by whichever operational document happened to score first.
  "geo-research",
  "eeat",
  "cep",
  "schema",
  "best-practice",
  "locale",
  "terminology",
  "official-docs"
];

const strategicCoverageDocuments = [
  {
    kind: "schema",
    document: pdpGeoGeneratorRagManifest.documents.schemaOrgProduct,
    query: "Schema.org Product FAQPage HowTo WebPage BreadcrumbList compatibility, field requirements, JSON-LD graph constraints, and structured data validation.",
    reason: "Ensure schema.org field compatibility is present when strategy chunks rank higher."
  },
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
  },
  {
    kind: "official-docs",
    document: pdpGeoGeneratorRagManifest.documents.officialAiSearchPlatformDocs,
    query: "Official AI search platform guidance for retrieval, hybrid search, reranking, embeddings, grounding, structured data eligibility, and helpful product content.",
    reason: "Ensure official provider/search guidance is present when local policy chunks rank higher."
  },
  {
    kind: "best-practice",
    document: pdpGeoGeneratorRagManifest.documents.bestPractice,
    query: "PDP GEO best practice for customer-facing sentence tone, vocabulary, cadence, natural evidence transitions, field evidence contracts, Product and WebPage description separation, FAQ, HowTo, and schema alignment.",
    reason: "Ensure the active BestPractice public-copy voice and field-contract guidance are present when strategy chunks rank higher."
  },
  {
    kind: "locale",
    document: pdpGeoGeneratorRagManifest.documents.localeExpressionGuidelines,
    query: "Locale expression guidance for natural market wording, public copy quality, terminology preservation, and unsupported wording avoidance.",
    reason: "Ensure locale expression guidance is present when strategy chunks rank higher."
  },
  {
    kind: "terminology",
    document: pdpGeoGeneratorRagManifest.documents.localeTerminologyMap,
    query: "Locale terminology map for benefit, ingredient, product type, and market-natural public wording.",
    reason: "Ensure terminology mapping is present when strategy chunks rank higher."
  }
] as const;

function resolveStrategicCoverageDocument(
  entry: (typeof strategicCoverageDocuments)[number],
  documents: Array<{ name: string; content: string; version?: string }>
): { name: string; content: string; version?: string } | undefined {
  const exactDocument = documents.find((candidate) => normalizeRagPath(candidate.name) === entry.document);
  if (exactDocument) {
    return exactDocument;
  }
  if (entry.document !== pdpGeoGeneratorRagManifest.documents.bestPractice) {
    const replacementDocuments = brandScopedReplacementDocumentNames(entry.document);
    return documents.find((candidate) => replacementDocuments.includes(normalizeRagPath(candidate.name)));
  }
  return documents.find((candidate) => brandScopedReplacementDocumentNames(entry.document).includes(normalizeRagPath(candidate.name)));
}

function brandScopedReplacementDocumentNames(defaultDocumentName: string): string[] {
  if (defaultDocumentName === pdpGeoGeneratorRagManifest.documents.bestPractice) {
    return Object.values(pdpGeoGeneratorRagManifest.brandBestPractices);
  }
  if (defaultDocumentName === pdpGeoGeneratorRagManifest.documents.localeExpressionGuidelines) {
    return Object.values(pdpGeoGeneratorRagManifest.brandLocaleExpressionGuidelines);
  }
  if (defaultDocumentName === pdpGeoGeneratorRagManifest.documents.localeTerminologyMap) {
    return Object.values(pdpGeoGeneratorRagManifest.brandLocaleTerminologyMaps);
  }
  return [];
}

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
    const document = resolveStrategicCoverageDocument(entry, input.documents);
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
      kind: entry.kind,
      metadata: {
        ...chunk.metadata,
        queryPlanTarget: "strategicCoverage",
        queryPlanReason: entry.reason
      }
    }));
  }));

  return chunks.flat();
}

async function retrieveBrandIdentityCoverageRagChunks(input: {
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
  const documentName = inferBrandIdentityDocument(input.product);
  if (!documentName || input.existingChunks.some((chunk) => chunk.source === documentName)) {
    return [];
  }

  const document = input.documents.find((candidate) => candidate.name === documentName);
  if (!document) {
    return [];
  }

  const retrieved = await retrievePdpGeoRagChunks(
    {
      query: [
        "Target brand identity for PDP GEO generation: brand image, tone, vocabulary, mood, personality, customer entry points, and claim-safety boundaries. Use official articles, patents, or research papers from this document only as brand-level context, not product evidence.",
        `Product: ${input.product.name}.`,
        input.product.brand ? `Brand: ${input.product.brand}.` : undefined,
        input.product.category ? `Category: ${input.product.category}.` : undefined,
        input.product.benefits.length > 0 ? `Benefits: ${input.product.benefits.slice(0, 4).join(", ")}.` : undefined,
        input.product.ingredients.length > 0 ? `Ingredients: ${input.product.ingredients.slice(0, 4).join(", ")}.` : undefined,
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
      queryPlanTarget: "brandIdentityCoverage",
      queryPlanReason: "Ensure the matched target-brand identity document is available to generation without adding other brand identity documents."
    },
    score: Math.max(chunk.score, 0.93)
  }));
}

function markBrandIdentityCoverageRagChunks(
  chunks: PdpGeoRetrievedChunk[],
  product: PdpProductSignal
): PdpGeoRetrievedChunk[] {
  const documentName = inferBrandIdentityDocument(product);
  if (!documentName) {
    return chunks;
  }

  return chunks.map((chunk) => {
    if (chunk.source !== documentName) {
      return chunk;
    }
    return {
      ...chunk,
      metadata: {
        ...chunk.metadata,
        queryPlanTarget: "brandIdentityCoverage",
        queryPlanReason: chunk.metadata.queryPlanReason ?? "Ensure the matched target-brand identity document is available to generation without adding other brand identity documents."
      },
      score: Math.max(chunk.score, 0.93)
    };
  });
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
  const sorted = chunks.slice().sort((a, b) => b.score - a.score);
  const selected: PdpGeoRetrievedChunk[] = [];
  const selectedKeys = new Set<string>();
  const protectedChunks = selectProtectedRagCoverageChunks(sorted);
  const effectiveLimit = limit + protectedChunks.length;

  for (const chunk of protectedChunks) {
    selected.push(chunk);
    selectedKeys.add(ragChunkKey(chunk));
  }

  for (const kind of coverageRagKindOrder) {
    if (selected.length >= effectiveLimit) {
      break;
    }
    const candidate = sorted.find((chunk) => chunk.kind === kind && !selectedKeys.has(ragChunkKey(chunk)));
    if (!candidate) {
      continue;
    }
    selected.push(candidate);
    selectedKeys.add(ragChunkKey(candidate));
  }

  while (selected.length < effectiveLimit) {
    const candidate = selectNextDiverseRagChunk(sorted, selected, selectedKeys);
    if (!candidate) {
      break;
    }
    selected.push(candidate);
    selectedKeys.add(ragChunkKey(candidate));
  }

  return selected.sort((a, b) => b.score - a.score);
}

function selectProtectedRagCoverageChunks(chunks: PdpGeoRetrievedChunk[]): PdpGeoRetrievedChunk[] {
  const selected: PdpGeoRetrievedChunk[] = [];
  const selectedSources = new Set<string>();

  for (const chunk of chunks) {
    if (chunk.metadata.queryPlanTarget !== "brandIdentityCoverage" || selectedSources.has(chunk.source)) {
      continue;
    }
    selected.push(chunk);
    selectedSources.add(chunk.source);
  }

  return selected;
}

function selectNextDiverseRagChunk(
  candidates: PdpGeoRetrievedChunk[],
  selected: PdpGeoRetrievedChunk[],
  selectedKeys: Set<string>
): PdpGeoRetrievedChunk | undefined {
  let best: PdpGeoRetrievedChunk | undefined;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const candidate of candidates) {
    if (selectedKeys.has(ragChunkKey(candidate))) {
      continue;
    }
    const diversityScore = candidate.score - chunkRedundancyPenalty(candidate, selected);
    if (!best || diversityScore > bestScore) {
      best = candidate;
      bestScore = diversityScore;
    }
  }

  return best;
}

function chunkRedundancyPenalty(candidate: PdpGeoRetrievedChunk, selected: PdpGeoRetrievedChunk[]): number {
  return selected.reduce((penalty, chunk) => {
    const sameSourcePenalty = chunk.source === candidate.source ? 0.06 : 0;
    const sameKindPenalty = chunk.kind === candidate.kind ? 0.04 : 0;
    const sameFieldPenalty = overlapRatio(readChunkFieldTargets(candidate), readChunkFieldTargets(chunk)) * 0.06;
    const sameIntentPenalty = overlapRatio(readChunkIntents(candidate), readChunkIntents(chunk)) * 0.04;

    return penalty + sameSourcePenalty + sameKindPenalty + sameFieldPenalty + sameIntentPenalty;
  }, 0);
}

function overlapRatio(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  const rightSet = new Set(right);
  const overlap = left.filter((item) => rightSet.has(item)).length;
  return overlap / Math.sqrt(left.length * right.length);
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
    contentPlanningUsage?: PdpGeoTokenUsage;
    contentPlanningCalled?: boolean;
    copyRefinementUsage?: PdpGeoTokenUsage;
    copyRefinementCalled?: boolean;
    finalProofreadingUsage?: PdpGeoTokenUsage;
    finalProofreadingCalled?: boolean;
    retrievedCount: number;
    selectedRagCount: number;
    ragDocumentCount: number;
  }
): PdpGeoRuntimeUsage {
  const provider = runtimeProviderLabel(options.provider);
  const finalSettings = context.copyRefinementCalled
    ? options.copyRefinement
    : context.contentPlanningCalled
      ? options.contentPlanning
      : context.keywordNormalizationUsage
        ? options.keywordNormalization
        : context.productNormalizationCalled
          ? options.productNormalization
          : undefined;
  const finalProviderId = finalSettings?.provider ?? options.provider;
  const finalProvider = runtimeProviderLabel(finalProviderId);
  const finalModel = finalSettings?.model ?? options.model;
  const finalDeployment = finalSettings?.deployment ?? options.deployments?.reasoning ?? options.deployment;
  const embeddingProvider = options.embedding?.provider ?? ragSettings.embeddingProvider;
  const rerankerProvider = options.reranker?.provider ?? ragSettings.rerankerProvider;
  const finalTokenUsage = mergeTokenUsages([
    context.productNormalizationUsage,
    context.keywordNormalizationUsage,
    context.contentPlanningUsage,
    context.copyRefinementUsage
  ].filter((usage): usage is PdpGeoTokenUsage => Boolean(usage)));
  const finalDetails = [
    context.productNormalizationCalled ? "Model-backed product signal normalization was called before keyword normalization." : undefined,
    context.keywordNormalizationUsage ? "Model-backed keyword normalization was called during product normalization." : undefined,
    context.contentPlanningCalled ? "Evidence-bound content/schema planning was called before artifact rendering." : undefined,
    context.copyRefinementCalled ? "Model-backed copy refinement was called after deterministic schema/content generation." : undefined
  ].filter(Boolean).join(" ");
  const proofreadingSettings = options.finalProofreading;
  const proofreadingProviderId = proofreadingSettings?.provider ?? options.provider;
  const proofreadingProvider = runtimeProviderLabel(proofreadingProviderId);
  const proofreadingModel = proofreadingSettings?.model ?? options.model;
  const proofreadingDeployment = proofreadingSettings?.deployment
    ?? options.deployments?.proofreading
    ?? options.deployments?.reasoning
    ?? options.deployment;
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
      service: embeddingProvider === "azure-openai"
        ? "Azure API embedding deployment"
        : embeddingProvider === "aistudio" ? "AI Studio embedding deployment" : `${embeddingProvider} embedding`,
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
      service: rerankerProvider === "azure-ai-search-semantic"
        ? "Azure AI Search semantic ranker"
        : rerankerProvider === "aistudio-bedrock-cohere"
          ? "AI Studio Bedrock Cohere Rerank"
          : rerankerProvider === "cohere" ? "Cohere Rerank" : `${rerankerProvider} ordering`,
      model: options.reranker?.provider === "cohere" || options.reranker?.provider === "aistudio-bedrock-cohere" ? options.reranker.model : undefined,
      called: ragSettings.mode === "managed-vector-store-rag" && ragSettings.rerankerProvider !== "local-hybrid",
      details: ragSettings.mode === "managed-vector-store-rag"
        ? "Generator RAG reranking follows the configured managed retriever/reranker."
        : "Local-versioned mode applies contextual hybrid reranking, RRF-style lexical/semantic fusion metadata, and coverage-aware chunk selection before strategic GEO/CEP/E-E-A-T reasoning."
    },
    {
      stage: "ocr",
      label: "OCR/structure extraction",
      provider,
      service: deploymentServiceLabel(options.provider) ?? provider,
      model: usesDeployments(options.provider) ? undefined : options.model,
      deployment: usesDeployments(options.provider) ? options.deployments?.ocr ?? options.deployment : undefined,
      called: false,
      details: "Generator consumes OCR evidence from the extractor result; it does not run image OCR itself."
    },
    {
      stage: "final",
      label: "Final classification/reasoning",
      provider: finalProvider,
      service: deploymentServiceLabel(finalProviderId) ?? finalProvider,
      model: usesDeployments(finalProviderId) ? undefined : finalModel,
      deployment: usesDeployments(finalProviderId) ? finalDeployment : undefined,
      called: Boolean(context.productNormalizationCalled || context.keywordNormalizationUsage || context.contentPlanningCalled || context.copyRefinementCalled),
      tokenUsage: finalTokenUsage,
      details: finalDetails || "Schema/content reasoning is deterministic in the current generator path; no final model usage metadata was returned."
    },
    {
      stage: "final",
      label: "Final proofreading",
      provider: proofreadingProvider,
      service: deploymentServiceLabel(proofreadingProviderId) ?? proofreadingProvider,
      model: usesDeployments(proofreadingProviderId) ? undefined : proofreadingModel,
      deployment: usesDeployments(proofreadingProviderId) ? proofreadingDeployment : undefined,
      called: Boolean(context.finalProofreadingCalled),
      tokenUsage: context.finalProofreadingUsage,
      details: context.finalProofreadingCalled
        ? "A separate fluency-only model call reviewed the finalized public-copy fields; deterministic invariant gates accepted or rejected each proposed edit."
        : "Final proofreading is disabled or no eligible public-copy fields were available."
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
  if (provider === "aistudio") {
    return "external-agent";
  }
  return provider ?? "mock";
}

/** Providers that address models by deployment/model id over a shared endpoint (Azure-style contract). */
function usesDeployments(provider: PdpGeoGeneratorOptions["provider"]): boolean {
  return provider === "azure-openai" || provider === "aistudio";
}

/** Service label for deployment-based providers; undefined for non-deployment providers. */
function deploymentServiceLabel(provider: PdpGeoGeneratorOptions["provider"]): string | undefined {
  if (provider === "azure-openai") {
    return "Azure API model deployment";
  }
  if (provider === "aistudio") {
    return "AI Studio model deployment";
  }
  return undefined;
}

function shouldReportProductNormalizationCall(options: PdpGeoGeneratorOptions): boolean {
  if (options.customProductNormalizer) {
    return true;
  }
  const settings = options.productNormalization;
  const provider = settings?.provider ?? options.provider ?? "mock";
  return Boolean(settings?.enabled && provider !== "mock" && provider !== "custom");
}

function shouldReportKeywordNormalizationCall(options: PdpGeoGeneratorOptions): boolean {
  if (options.customKeywordNormalizer) {
    return true;
  }
  const settings = options.keywordNormalization;
  const provider = settings?.provider ?? options.provider ?? "mock";
  return Boolean(settings?.enabled && provider !== "mock" && provider !== "custom");
}

function shouldReportCopyRefinementCall(options: PdpGeoGeneratorOptions): boolean {
  if (options.customCopyRefiner) {
    return true;
  }
  const settings = options.copyRefinement;
  const provider = settings?.provider ?? options.provider ?? "mock";
  const explicitEnabled = settings?.enabled;
  return Boolean((explicitEnabled ?? (provider !== "mock" && provider !== "custom" && Boolean(settings?.apiKey ?? options.apiKey)))
    && provider !== "mock"
    && provider !== "custom");
}

function shouldReportFinalProofreadingCall(options: PdpGeoGeneratorOptions): boolean {
  if (options.finalProofreading?.enabled === false) return false;
  if (options.customFinalProofreader) return true;
  const settings = options.finalProofreading;
  if (!settings) return false;
  const provider = settings.provider ?? options.provider ?? "mock";
  const enabled = settings.enabled ?? (
    provider !== "mock"
    && provider !== "custom"
    && Boolean(settings.apiKey ?? options.apiKey)
  );
  return Boolean(enabled && provider !== "mock" && provider !== "custom");
}

function shouldReportContentPlanningCall(options: PdpGeoGeneratorOptions): boolean {
  if (options.contentPlanning?.enabled === false) {
    return false;
  }
  if (options.customContentPlanner) {
    return true;
  }
  const settings = options.contentPlanning;
  const provider = settings?.provider ?? options.provider ?? "mock";
  const enabled = settings?.enabled ?? (provider !== "mock" && provider !== "custom" && Boolean(settings?.apiKey ?? options.apiKey));
  return Boolean(enabled && provider !== "mock" && provider !== "custom");
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
    "stepwise HowTo": "HowTo 원문 단계의 적합성·보존 근거",
    "evidence-backed claims": "효능/성분 주장 근거와 과장 방지 기준",
    "target customer context": "고객 맥락과 PDP 설명 문장 구성 근거",
    "review-intent FAQ": "긍정/중립 리뷰 언어를 FAQ 사용감 의도로 재구성하는 근거"
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

type BrandRagSlug = keyof typeof pdpGeoGeneratorRagManifest.brandIdentities;

interface BrandRagScope {
  slug?: BrandRagSlug;
  identityDocument?: string;
  bestPracticeDocument?: string;
  localeExpressionGuidelinesDocument?: string;
  localeTerminologyMapDocument?: string;
}

function scopeBrandRagDocuments(
  documents: Array<{ name: string; content: string; version?: string }>,
  product: PdpProductSignal,
  hints?: { brand?: string }
): Array<{ name: string; content: string; version?: string }> {
  const scope = inferBrandRagScope(product, hints);
  const defaultReplacements = new Map<string, string | undefined>([
    [pdpGeoGeneratorRagManifest.documents.bestPractice, scope.bestPracticeDocument],
    [pdpGeoGeneratorRagManifest.documents.localeExpressionGuidelines, scope.localeExpressionGuidelinesDocument],
    [pdpGeoGeneratorRagManifest.documents.localeTerminologyMap, scope.localeTerminologyMapDocument]
  ]);
  const documentNames = new Set(documents.map((document) => normalizeRagPath(document.name)));

  return documents.filter((document) => {
    const name = normalizeRagPath(document.name);
    if (isBrandScopedDocument(name)) {
      return Boolean(scope.slug && brandScopedDocumentSlug(name) === scope.slug);
    }
    const replacementDocument = defaultReplacements.get(name);
    if (replacementDocument && documentNames.has(replacementDocument)) {
      return false;
    }
    return true;
  });
}

function inferBrandIdentityDocument(product: PdpProductSignal, hints?: { brand?: string }): string | undefined {
  return inferBrandRagScope(product, hints).identityDocument;
}

function inferBrandRagScope(product: PdpProductSignal, hints?: { brand?: string }): BrandRagScope {
  const signal = normalizeBrandIdentitySignal([
    hints?.brand,
    product.brand,
    product.name
  ].filter(Boolean).join(" "));

  const slug = inferBrandRagSlug(signal);
  if (!slug) {
    return {};
  }

  return {
    slug,
    identityDocument: pdpGeoGeneratorRagManifest.brandIdentities[slug],
    bestPracticeDocument: pdpGeoGeneratorRagManifest.brandBestPractices[slug],
    localeExpressionGuidelinesDocument: pdpGeoGeneratorRagManifest.brandLocaleExpressionGuidelines[slug],
    localeTerminologyMapDocument: pdpGeoGeneratorRagManifest.brandLocaleTerminologyMaps[slug]
  };
}

function inferBrandRagSlug(signal: string): BrandRagSlug | undefined {
  if (/(sulwhasoo|설화수)/.test(signal)) {
    return "sulwhasoo";
  }
  if (/(aestura|에스트라|아에스트라)/.test(signal)) {
    return "aestura";
  }
  return undefined;
}

function isBrandScopedDocument(name: string): boolean {
  return normalizeRagPath(name).startsWith("brands/");
}

function brandScopedDocumentSlug(name: string): string | undefined {
  return normalizeRagPath(name).match(/^brands\/([^/]+)\//)?.[1];
}

function normalizeRagPath(name: string): string {
  return name.replace(/\\/g, "/");
}

function normalizeBrandIdentitySignal(value: string): string {
  return value.toLowerCase().normalize("NFKC").replace(/\s+/g, "");
}
