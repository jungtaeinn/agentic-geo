import { Body, Controller, HttpCode, NotFoundException, Post } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  propagateAttributes,
  startActiveObservation,
  startObservation,
  type LangfuseGenerationAttributes,
} from "@langfuse/tracing";
import type { PdpGeoContentSections, PdpGeoRuntimeUsage } from "@agentic-geo/pdp-geo-generator-agent/types";
import { TestGenerationDto } from "./dto/test-generation.dto";
import { GenerationService, type GeneratedArtifact } from "./generation.service";
import { flushLangfuse } from "../observability/langfuse";

export interface TestGenerationResponse
  extends Omit<GeneratedArtifact, "diagnostics" | "contentSections"> {
  geoGenerationId: string;
  validationWarnings: string[];
  runtimeUsage?: PdpGeoRuntimeUsage;
  /** `includeDiagnostics=true`일 때만 — 품질 루브릭(evaluateGeoQuality)의 입력. */
  diagnostics?: Record<string, unknown>;
  /** `includeDiagnostics=true`일 때만 — 개선 프롬프트가 "현재 콘텐츠"로 요구하는 입력. */
  contentSections?: PdpGeoContentSections;
}

/**
 * 로컬 전용 동기 생성 엔드포인트. 큐·DB를 우회해 생성기를 직접 호출하고 결과를 즉시 반환하며,
 * 실행 내역을 Langfuse 트레이스로 남긴다(키 미설정 시 트레이싱은 no-op).
 * GEO_TEST_SYNC_ENDPOINT=true 인 환경에서만 존재를 드러낸다 — 꺼진 환경에서는 404.
 */
@Controller("internal/v1/geo/test-generations")
export class GeoTestController {
  constructor(private readonly generation: GenerationService) {}

  @Post()
  @HttpCode(200)
  async generate(@Body() dto: TestGenerationDto): Promise<TestGenerationResponse> {
    if (!/^true$/i.test(process.env.GEO_TEST_SYNC_ENDPOINT ?? "")) {
      throw new NotFoundException();
    }
    const geoGenerationId = randomUUID();
    try {
      return await propagateAttributes({ sessionId: geoGenerationId, tags: ["geo-test-sync"] }, () =>
        startActiveObservation("geo-test-generation", async (span) => {
          span.update({
            input: { locale: dto.locale, product: dto.product },
            metadata: { geoGenerationId },
          });
          let artifact: GeneratedArtifact;
          try {
            artifact = await this.generation.generate({
              geoGenerationId,
              locale: dto.locale,
              product: dto.product,
              brandSameAs: dto.brandSameAs,
            });
          } catch (error) {
            span.update({
              level: "ERROR",
              statusMessage: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
          const runtimeUsage = extractRuntimeUsage(artifact);
          recordModelCalls(runtimeUsage);
          const response = toResponse(geoGenerationId, artifact, runtimeUsage);
          // 트레이스 output에는 opt-in 페이로드를 뺀 기본 응답만 남긴다 — diagnostics는 선택 RAG
          // 청크와 근거 원장까지 담겨 수 MB에 이를 수 있어 트레이스를 압도한다.
          // 기본 응답만으로도 생성 결과(jsonLd/scriptTag/hash)는 그대로 재현된다.
          span.update({ output: response });
          return dto.includeDiagnostics
            ? { ...response, diagnostics: artifact.diagnostics, contentSections: artifact.contentSections }
            : response;
        }),
      );
    } finally {
      await flushLangfuse();
    }
  }
}

/**
 * 기본 응답에는 대용량 diagnostics 전체 대신 runtimeUsage와 validationWarnings만 싣는다.
 * 필드를 흩뿌리지 않고 하나씩 옮기는 이유: opt-in 페이로드(diagnostics/contentSections)가
 * 아티팩트에 새 필드가 늘 때마다 기본 응답으로 새어 들어가는 것을 막기 위해서다.
 */
function toResponse(
  geoGenerationId: string,
  artifact: GeneratedArtifact,
  runtimeUsage: PdpGeoRuntimeUsage | undefined,
): TestGenerationResponse {
  const warnings = (artifact.diagnostics as { validationWarnings?: string[] }).validationWarnings ?? [];
  return {
    geoGenerationId,
    resultStatus: artifact.resultStatus,
    jsonLd: artifact.jsonLd,
    scriptTag: artifact.scriptTag,
    schemaTypes: artifact.schemaTypes,
    resultHash: artifact.resultHash,
    ragProfile: artifact.ragProfile,
    generatedAt: artifact.generatedAt,
    validationWarnings: warnings,
    runtimeUsage,
  };
}

function extractRuntimeUsage(artifact: GeneratedArtifact): PdpGeoRuntimeUsage | undefined {
  return (artifact.diagnostics as { runtimeUsage?: PdpGeoRuntimeUsage }).runtimeUsage;
}

/** 생성기가 사후 보고한 스텝별 모델 호출을 활성 트레이스의 자식 generation 관측으로 기록한다. */
function recordModelCalls(usage: PdpGeoRuntimeUsage | undefined): void {
  for (const step of usage?.steps ?? []) {
    if (!step.called) continue;
    const usageDetails: Record<string, number> = {};
    if (step.tokenUsage?.inputTokens !== undefined) usageDetails.input = step.tokenUsage.inputTokens;
    if (step.tokenUsage?.outputTokens !== undefined) usageDetails.output = step.tokenUsage.outputTokens;
    if (step.tokenUsage?.totalTokens !== undefined) usageDetails.total = step.tokenUsage.totalTokens;
    const attributes: LangfuseGenerationAttributes = {
      model: step.model ?? step.deployment,
      metadata: {
        stage: step.stage,
        provider: step.provider,
        service: step.service,
        mode: step.mode,
        details: step.details,
      },
      ...(Object.keys(usageDetails).length > 0 ? { usageDetails } : {}),
    };
    const observation =
      step.stage === "embedding"
        ? startObservation(step.label, attributes, { asType: "embedding" })
        : startObservation(step.label, attributes, { asType: "generation" });
    observation.end();
  }
}
