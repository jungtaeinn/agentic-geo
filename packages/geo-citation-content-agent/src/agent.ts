import { createGeoCitationContentBrief } from "./core/content-brief";
import { createRedditVariantStrategy } from "./core/citation-strategy";
import { createGeoCitationPipelineTracker } from "./core/diagnostics";
import { runGeoCitationEvidencePipeline } from "./core/evidence-pipeline";
import { normalizeGeoCitationProduct } from "./core/normalize";
import {
  createDefaultTarget,
  validateAndRepairGeoCitationArtifact,
  validateGeoCitationInput
} from "./core/validate";
import { resolveGeoCitationDraftWriter } from "./llm/providers";
import { readGeoCitationRagProfile } from "./rag/profile";
import { createGeoCitationReasoning } from "./rag/reasoning";
import { generateRedditCitationArtifact } from "./surfaces/reddit/generate";
import { getSurfaceProfile } from "./surfaces/registry";
import type {
  GeoCitationContentInput,
  GeoCitationContentRun,
  GeoCitationDiagnostics,
  GeoCitationEvidenceDiagnostic,
  GeoCitationGeneratorOptions,
  GeoCitationRagDocument,
  GeoCitationRagSettings,
  GeoCitationRagUsageDiagnostic,
  GeoCitationRecommendation,
  GeoCitationRuntimeUsage
} from "./types";

export async function generateGeoCitationContent(
  input: GeoCitationContentInput,
  options: GeoCitationGeneratorOptions = {}
): Promise<GeoCitationContentRun> {
  const process = createGeoCitationPipelineTracker(options.onProgress);

  try {
    process.start("input", "입력 payload와 target surface를 검증합니다.");
    const parsed = validateGeoCitationInput(input);
    const target = createDefaultTarget(parsed.target);
    const surfaceProfile = getSurfaceProfile(target.surface);
    process.done("input", `${surfaceProfile.displayName} surface 요청을 확인했습니다.`);

    process.start("normalize", "상품 정보를 citation content signal로 정규화합니다.");
    const product = normalizeGeoCitationProduct(parsed.product, parsed.source);
    process.done("normalize", `${product.name} 상품 signal을 정규화했습니다.`);

    process.start("mandatory-rag-load", "필수 citation contract와 공통 GEO 정책 문서를 로드합니다.");
    const ragProfile = await readGeoCitationRagProfile();
    const ragSettings = mergeRagSettings(options.rag, parsed.rag);
    const runtimeRagDocuments = mergeRuntimeRagDocuments(options.ragDocuments, ragSettings.documents);
    const mandatoryRagDocuments = [
      ...ragProfile.mandatoryDocuments,
      ...runtimeRagDocuments
    ];
    process.done("mandatory-rag-load", `${mandatoryRagDocuments.length}개 mandatory/custom RAG 문서를 로드했습니다.`);

    process.start("surface-rag-load", "Reddit surface guideline과 post pattern을 로드합니다.");
    const surfaceRagDocuments = ragProfile.surfaceDocuments.reddit;
    process.done("surface-rag-load", `${surfaceRagDocuments.length}개 Reddit surface RAG 문서를 로드했습니다.`);

    process.start("evidence-normalize", "상품/리뷰/이미지/뉴스/논문/기존 GEO 결과를 evidence로 정규화합니다.");
    const evidencePipeline = runGeoCitationEvidencePipeline({
      product,
      evidence: parsed.evidence,
      source: parsed.source,
      strategy: parsed.strategy,
      rag: ragSettings
    });
    process.done("evidence-normalize", `${evidencePipeline.evidence.length}개 evidence item을 정규화했습니다.`);
    process.start("chunk", "Evidence를 RAG chunk로 분할합니다.");
    process.done("chunk", `${evidencePipeline.chunks.length}개 evidence chunk를 구성했습니다.`);
    process.start("retrieve", "상품/검색 의도 기반으로 evidence chunk를 검색합니다.");
    process.done("retrieve", `${evidencePipeline.selectedChunks.length}개 evidence chunk를 선택했습니다.`);
    process.start("rerank", "source type, freshness, lexical overlap 기준으로 chunk를 리랭킹합니다.");
    process.done("rerank", "Evidence chunk 정렬을 완료했습니다.");

    process.start("brief", "AI answer chunk와 Reddit 토론 흐름을 함께 담은 content brief를 만듭니다.");
    const variantStrategy = createRedditVariantStrategy({
      product,
      strategy: parsed.strategy,
      availableEvidenceTypes: [...new Set(evidencePipeline.evidence.map((item) => item.sourceType))]
    });
    const brief = createGeoCitationContentBrief({
      product,
      target,
      evidenceMap: evidencePipeline.evidenceMap,
      variantStrategy,
      strategy: parsed.strategy
    });
    const reasoning = createGeoCitationReasoning({
      product,
      angle: variantStrategy.angle,
      retrievedChunks: evidencePipeline.selectedChunks,
      brief
    });
    process.done("brief", `${reasoning.principles.length}개 생성 원칙과 ${brief.answerChunks.length}개 answer chunk를 준비했습니다.`);

    process.start("generate", "Reddit title/bodyMarkdown artifact를 생성합니다.");
    const writer = resolveGeoCitationDraftWriter(options);
    const generatedArtifact = await generateRedditCitationArtifact({
      product,
      target,
      brief,
      variantStrategy,
      mandatoryRagDocuments,
      surfaceRagDocuments,
      writer
    });
    process.done("generate", "Reddit artifact 초안을 생성했습니다.");

    process.start("validate", "Unsupported claim, Reddit channel risk, 홍보 톤을 검증합니다.");
    const validation = validateAndRepairGeoCitationArtifact({
      artifact: generatedArtifact,
      brief,
      product
    });
    process.done("validate", `${validation.unsupportedClaims.length + validation.channelWarnings.length + validation.validationWarnings.length}개 검증 신호를 기록했습니다.`);

    process.start("repair", "검증 결과에 따라 안전한 artifact로 보정합니다.");
    process.done("repair", "방어 보정을 완료했습니다.");

    process.start("artifact", "최종 Reddit artifact와 diagnostics를 반환합니다.");
    const generatedAt = new Date().toISOString();
    const evidenceDiagnostics = createEvidenceDiagnostics({
      productName: product.name,
      mandatoryRagDocuments,
      surfaceRagDocuments,
      evidenceItemsCount: evidencePipeline.evidence.length,
      selectedRagCount: evidencePipeline.selectedChunks.length,
      briefAnswerChunkCount: brief.answerChunks.length,
      validation
    });
    const recommendations = createRecommendations(validation);
    const ragUsage = createRagUsageDiagnostics(evidencePipeline.selectedChunks);
    const runtimeUsage = createRuntimeUsageDiagnostics(options, {
      mandatoryRagDocuments: mandatoryRagDocuments.length,
      surfaceRagDocuments: surfaceRagDocuments.length,
      evidenceItems: evidencePipeline.evidence.length,
      evidenceChunks: evidencePipeline.chunks.length,
      selectedRagChunks: evidencePipeline.selectedChunks.length,
      answerChunks: brief.answerChunks.length
    });
    const diagnostics: GeoCitationDiagnostics = {
      mandatoryRagDocuments: mandatoryRagDocuments.map((document) => document.name),
      surfaceRagDocuments: surfaceRagDocuments.map((document) => document.name),
      recommendations,
      evidence: evidenceDiagnostics,
      selectedRagChunks: evidencePipeline.selectedChunks,
      ragUsage,
      runtimeUsage,
      usedEvidence: brief.evidenceMap,
      unsupportedClaims: validation.unsupportedClaims,
      channelWarnings: validation.channelWarnings,
      validationWarnings: validation.validationWarnings,
      promotionalToneScore: validation.promotionalToneScore,
      geoCitationReadiness: validation.geoCitationReadiness,
      variantStrategy,
      normalizedProduct: product,
      generatedAt
    };
    const result = {
      artifact: validation.artifact,
      brief,
      strategy: {
        searchIntent: brief.searchIntent,
        citationAngles: brief.citationAngles,
        evidenceMap: brief.evidenceMap,
        eeatSignals: brief.eeatSignals,
        cepContexts: brief.cepContexts,
        variantStrategy
      },
      diagnostics
    };
    process.done("artifact", "최종 결과를 생성했습니다.");

    return {
      result,
      diagnostics,
      process: process.steps
    };
  } catch (error) {
    process.error("artifact", error instanceof Error ? error.message : "GEO citation content generation failed.");
    throw error;
  }
}

function createEvidenceDiagnostics(input: {
  productName: string;
  mandatoryRagDocuments: GeoCitationRagDocument[];
  surfaceRagDocuments: GeoCitationRagDocument[];
  evidenceItemsCount: number;
  selectedRagCount: number;
  briefAnswerChunkCount: number;
  validation: {
    unsupportedClaims: string[];
    channelWarnings: string[];
    validationWarnings: string[];
    geoCitationReadiness: { score: number; passed: boolean; keywordCoverage: { present: string[]; missing: string[] } };
  };
}): GeoCitationEvidenceDiagnostic[] {
  const diagnostics: GeoCitationEvidenceDiagnostic[] = [
    {
      field: "product.normalized",
      source: "input",
      value: `${input.productName} was normalized into a citation-content product signal.`
    },
    {
      field: "rag.mandatory",
      source: "rag",
      value: `Mandatory RAG applied: ${input.mandatoryRagDocuments.map((document) => document.name).join(", ")}`
    },
    {
      field: "rag.surface",
      source: "rag",
      value: `Reddit surface RAG applied: ${input.surfaceRagDocuments.map((document) => document.name).join(", ")}`
    },
    {
      field: "evidence.pipeline",
      source: "evidence",
      value: `${input.evidenceItemsCount} evidence item(s) normalized and ${input.selectedRagCount} chunk(s) selected for claim grounding.`
    },
    {
      field: "brief.answerChunks",
      source: "evidence",
      value: `${input.briefAnswerChunkCount} answer-ready chunk(s) prepared before Reddit rendering.`
    },
    {
      field: "readiness.geoCitation",
      source: "readiness",
      value: `GEO citation readiness ${input.validation.geoCitationReadiness.passed ? "passed" : "failed"} with score ${input.validation.geoCitationReadiness.score}. Present keywords: ${input.validation.geoCitationReadiness.keywordCoverage.present.join(", ") || "none"}. Missing keywords: ${input.validation.geoCitationReadiness.keywordCoverage.missing.join(", ") || "none"}.`
    }
  ];

  diagnostics.push(
    ...input.validation.unsupportedClaims.map((claim) => ({
      field: "validation.unsupportedClaims",
      source: "validation" as const,
      value: claim
    })),
    ...input.validation.channelWarnings.map((warning) => ({
      field: "validation.channel",
      source: "validation" as const,
      value: warning
    })),
    ...input.validation.validationWarnings.map((warning) => ({
      field: "validation.readiness",
      source: "readiness" as const,
      value: warning
    }))
  );

  return diagnostics;
}

function createRecommendations(validation: {
  unsupportedClaims: string[];
  channelWarnings: string[];
  validationWarnings: string[];
  geoCitationReadiness: { passed: boolean; warnings: string[] };
}): GeoCitationRecommendation[] {
  const recommendations: GeoCitationRecommendation[] = [];

  if (validation.unsupportedClaims.length > 0) {
    recommendations.push({
      field: "claims",
      message: "Downgrade or remove unsupported strong claims before posting.",
      reason: validation.unsupportedClaims.join(" / ")
    });
  }
  if (validation.channelWarnings.length > 0) {
    recommendations.push({
      field: "reddit.channel",
      message: "Review Reddit community-fit warnings before posting.",
      reason: validation.channelWarnings.join(" / ")
    });
  }
  if (!validation.geoCitationReadiness.passed) {
    recommendations.push({
      field: "geoCitationReadiness",
      message: "Improve the Reddit draft before treating it as citation-ready.",
      reason: validation.geoCitationReadiness.warnings.join(" / ") || "GEO citation readiness score did not pass."
    });
  }

  return recommendations;
}

function createRagUsageDiagnostics(selectedChunks: Array<{
  sourceType: GeoCitationRagUsageDiagnostic["sourceType"];
  title?: string;
  score: number;
  reason: string;
  text: string;
}>): GeoCitationRagUsageDiagnostic[] {
  return selectedChunks.map((chunk) => ({
    source: chunk.title ?? chunk.sourceType,
    sourceType: chunk.sourceType,
    score: chunk.score,
    usage: chunk.reason,
    excerpt: chunk.text.slice(0, 280)
  }));
}

function createRuntimeUsageDiagnostics(
  options: GeoCitationGeneratorOptions,
  counts: GeoCitationRuntimeUsage["counts"]
): GeoCitationRuntimeUsage {
  const provider = options.provider ?? "mock";
  const deployment = provider === "azure-openai" ? options.deployments?.reasoning ?? options.deployment : undefined;

  return {
    provider,
    service: provider === "azure-openai" ? "Azure API model deployment" : provider === "custom" ? "custom draft writer" : "mock draft writer",
    deployment,
    model: options.model,
    called: provider === "azure-openai" || Boolean(options.customDraftWriter),
    details: provider === "azure-openai"
      ? "Reddit title/bodyMarkdown generation used Azure OpenAI chat completions after mandatory/surface RAG and evidence retrieval."
      : options.customDraftWriter
        ? "Reddit title/bodyMarkdown generation used a custom draft writer after mandatory/surface RAG and evidence retrieval."
        : "Reddit title/bodyMarkdown generation used the local mock writer after mandatory/surface RAG and evidence retrieval.",
    counts
  };
}

function mergeRagSettings(...settings: Array<GeoCitationRagSettings | undefined>): GeoCitationRagSettings {
  return settings.reduce<GeoCitationRagSettings>((acc, item) => ({
    ...acc,
    ...item,
    documents: [
      ...(acc.documents ?? []),
      ...(item?.documents ?? [])
    ]
  }), {});
}

function mergeRuntimeRagDocuments(
  optionDocuments: GeoCitationRagDocument[] | undefined,
  inputDocuments: GeoCitationRagSettings["documents"] | undefined
): GeoCitationRagDocument[] {
  return [
    ...(optionDocuments ?? []),
    ...(inputDocuments ?? []).map((document): GeoCitationRagDocument => ({
      ...document,
      sourceRole: document.sourceRole ?? "custom",
      mandatory: true
    }))
  ];
}
