import { generatePdpGeo } from "./agent";
import { pdpGeoGeneratorRagManifest } from "./rag/manifest";
import type {
  PdpGeoDiagnostics,
  PdpGeoGenerationInput,
  PdpGeoGenerationStageId,
  PdpGeoGenerationStep,
  PdpGeoGeneratorOptions
} from "./types";

/** REST request contract for calling the PDP GEO generator agent from another service. */
export interface PdpGeoGeneratorRestRequest extends Omit<PdpGeoGenerationInput, "product"> {
  product?: unknown;
  products?: unknown[];
  llm?: Partial<Pick<PdpGeoGeneratorRestConfig, "provider" | "apiKey" | "model" | "endpoint" | "deployment" | "deployments" | "apiVersion" | "embedding" | "reranker" | "copyRefinement">>;
  keywordNormalization?: PdpGeoGeneratorRestConfig["keywordNormalization"];
  copyRefinement?: PdpGeoGeneratorRestConfig["copyRefinement"];
}

export interface PdpGeoGeneratorRestFailure {
  index: number;
  error: string;
}

/** Runtime config used by REST adapters without leaking provider details into UI code. */
export interface PdpGeoGeneratorRestConfig extends PdpGeoGeneratorOptions {}

/** Creates a Web API compatible REST handler for this package-local agent. */
export function createPdpGeoGeneratorRestHandler(config: PdpGeoGeneratorRestConfig = {}) {
  return async function pdpGeoGeneratorRestHandler(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed. Use POST." }, 405);
    }

    try {
      const body = await request.json() as PdpGeoGeneratorRestRequest;
      const products = Array.isArray(body.products) ? body.products : body.product !== undefined ? [body.product] : [];
      const runtimeConfig: PdpGeoGeneratorRestConfig = {
        ...config,
        ...body.llm,
        rag: {
          ...config.rag,
          ...body.rag
        },
        keywordNormalization: config.keywordNormalization || body.keywordNormalization
          ? {
              ...config.keywordNormalization,
              ...body.keywordNormalization
            }
          : undefined,
        copyRefinement: config.copyRefinement || body.copyRefinement || body.llm?.copyRefinement
          ? {
              ...config.copyRefinement,
              ...body.llm?.copyRefinement,
              ...body.copyRefinement
            }
          : undefined
      };

      if (products.length === 0) {
        return jsonResponse({ error: "At least one product JSON payload is required." }, 400);
      }

      const runs = await Promise.all(products.map(async (product, index) => {
        try {
          return {
            status: "fulfilled" as const,
            run: await generatePdpGeo(
              {
                product,
                source: body.source,
                hints: body.hints,
                fieldMapping: body.fieldMapping,
                rag: body.rag
              },
              runtimeConfig
            )
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : "PDP GEO generation failed.";
          return {
            status: "rejected" as const,
            failure: {
              index,
              error: message
            },
            diagnostics: createFailureDiagnostics(message)
          };
        }
      }));
      const succeeded = runs.filter((run) => run.status === "fulfilled");
      const failed = runs.filter((run) => run.status === "rejected");

      return jsonResponse(
        {
          results: succeeded.map((run) => run.run.result),
          logs: [
            ...succeeded.map((run) => ({
              diagnostics: run.run.diagnostics,
              process: run.run.process
            })),
            ...failed.map((run) => ({
              diagnostics: run.diagnostics,
              process: createFailureProcess(run.failure.error)
            }))
          ],
          failures: failed.map((run) => run.failure)
        },
        failed.length > 0 ? 207 : 200
      );
    } catch (error) {
      return jsonResponse(
        {
          error: error instanceof Error ? error.message : "PDP GEO generation failed."
        },
        500
      );
    }
  };
}

function createFailureDiagnostics(error: string): Partial<PdpGeoDiagnostics> {
  const generatedAt = new Date().toISOString();
  return {
    recommendations: [],
    evidence: [
      {
        field: "generation",
        source: "repair",
        value: error
      }
    ],
    selectedRagChunks: [],
    ragUsage: [],
    validationWarnings: [error],
    ragMode: "local-versioned-rag",
    generatedAt
  };
}

const failureStepMessages: Record<PdpGeoGenerationStageId, Pick<PdpGeoGenerationStep, "title" | "description">> = {
  input: {
    title: "입력 검증",
    description: "임의 상품 JSON과 옵션을 검증"
  },
  normalize: {
    title: "상품 신호 정규화",
    description: "REST/API/PDP JSON을 내부 ProductSignal로 변환"
  },
  "rag-load": {
    title: "RAG 프로필 로드",
    description: "schema.org, E-E-A-T, CEP, GEO, BestPractice, locale 용어집 로드"
  },
  chunk: {
    title: "RAG chunk 구성",
    description: "버전 문서와 상품 컨텍스트를 검색 가능한 chunk로 준비"
  },
  embed: {
    title: "임베딩 구성",
    description: "로컬 또는 managed vector store 임베딩 전략 적용"
  },
  retrieve: {
    title: "RAG 검색",
    description: "상품/locale/schema 목표에 맞는 관련 문서 검색"
  },
  rerank: {
    title: "리랭킹",
    description: "schema, locale, terminology, GEO 관련성을 기준으로 재정렬"
  },
  generate: {
    title: "GEO 산출물 생성",
    description: "JSON-LD schema markup과 HTML content 생성"
  },
  validate: {
    title: "문법 검증",
    description: "JSON-LD와 HTML 구조 검증"
  },
  repair: {
    title: "방어 보정",
    description: "누락된 필수 필드와 안전하지 않은 HTML 보정"
  },
  artifact: {
    title: "최종 아티팩트 생성",
    description: "복사 가능한 schemaMarkup과 content 결과 생성"
  }
};

function createFailureProcess(error: string): PdpGeoGenerationStep[] {
  const generatedAt = new Date().toISOString();
  const order: PdpGeoGenerationStageId[] = ["input", "normalize", "rag-load", "chunk", "embed", "retrieve", "rerank", "generate", "validate", "repair", "artifact"];

  return order.map((id, index) => ({
    id,
    ...failureStepMessages[id],
    status: index === 0 ? "done" : index === 1 ? "error" : "pending",
    message: index === 0 ? "입력을 수신했습니다." : index === 1 ? error : failureStepMessages[id].description,
    startedAt: index <= 1 ? generatedAt : undefined,
    completedAt: index <= 1 ? generatedAt : undefined
  }));
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

export { pdpGeoGeneratorRagManifest };
