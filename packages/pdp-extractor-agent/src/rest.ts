import { extractProduct, type ProductExtractorOptions } from "./agent";
import { productExtractorRagManifest } from "./rag/manifest";
import type {
  ProductExtractionDiagnostics,
  ProductExtractionInput,
  ProductExtractionStageId,
  ProductExtractionStep
} from "./types";

/** REST request contract for calling the product extractor agent from another service. */
export interface ProductExtractorRestRequest {
  sources?: string[];
  sourceType?: ProductExtractionInput["sourceType"];
  headers?: Record<string, string>;
  llm?: Partial<Pick<ProductExtractorRestConfig, "provider" | "apiKey" | "model" | "endpoint" | "deployment" | "apiVersion">>;
  rag?: {
    analysisPrompt?: string;
    documents?: Array<{
      name: string;
      content: string;
    }>;
  };
}

/** Source-level failure returned when one URL/API source cannot be collected. */
export interface ProductExtractorRestFailure {
  source: string;
  sourceType: ProductExtractionInput["sourceType"];
  error: string;
}

/** Runtime config used by REST adapters without leaking provider details into UI code. */
export interface ProductExtractorRestConfig extends ProductExtractorOptions {
  defaultSourceType?: ProductExtractionInput["sourceType"];
}

/** Creates a Web API compatible REST handler for this package-local agent. */
export function createProductExtractorRestHandler(config: ProductExtractorRestConfig = {}) {
  return async function productExtractorRestHandler(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed. Use POST." }, 405);
    }

    try {
      const body = await request.json() as ProductExtractorRestRequest;
      const sources = Array.isArray(body.sources) ? body.sources.filter(Boolean) : [];
      const sourceType = body.sourceType ?? config.defaultSourceType ?? "url";
      const runtimeConfig = {
        ...config,
        ...body.llm,
        analysisPrompt: body.rag?.analysisPrompt,
        ragDocuments: body.rag?.documents
      };

      if (sources.length === 0) {
        return jsonResponse({ error: "At least one source is required." }, 400);
      }

      const runs = await Promise.all(
        sources.map(async (source) => {
          try {
            return {
              status: "fulfilled" as const,
              run: await extractProduct(
                {
                  source,
                  sourceType,
                  headers: body.headers,
                  aiProvider: runtimeConfig.provider ?? "mock"
                },
                runtimeConfig
              )
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : "Product extraction failed.";
            return {
              status: "rejected" as const,
              failure: {
                source,
                sourceType,
                error: message
              },
              diagnostics: createFailureDiagnostics(source, sourceType, message)
            };
          }
        })
      );
      const succeeded = runs.filter((run) => run.status === "fulfilled");
      const failed = runs.filter((run) => run.status === "rejected");

      return jsonResponse(
        {
          results: succeeded.map((run) => run.run.result),
          logs: [
            ...succeeded.map((run) => run.run.diagnostics),
            ...failed.map((run) => run.diagnostics)
          ],
          failures: failed.map((run) => run.failure)
        },
        failed.length > 0 ? 207 : 200
      );
    } catch (error) {
      return jsonResponse(
        {
          error: error instanceof Error ? error.message : "Product extraction failed."
        },
        500
      );
    }
  };
}

const failureStepMessages: Record<ProductExtractionStageId, Pick<ProductExtractionStep, "title" | "description">> = {
  input: {
    title: "입력 정규화",
    description: "URL/REST API 주소를 검증하고 실행 단위를 분리"
  },
  fetch: {
    title: "소스 수집",
    description: "페이지 HTML, 메타정보, JSON-LD, API 응답 수집"
  },
  extract: {
    title: "상품정보 추출",
    description: "상품명, 가격, 설명, 옵션, FAQ 후보 정규화"
  },
  ocr: {
    title: "OCR 문장/키워드 분석",
    description: "이미지/상세 영역의 효능, 효과, 성분 문장과 키워드 분류"
  },
  review: {
    title: "리뷰 신호 추출",
    description: "평점, 리뷰본문, 대표 키워드, 고객 표현 정리"
  },
  rag: {
    title: "RAG chunk 생성",
    description: "상품/리뷰/FAQ/OCR evidence를 RAG 데이터로 구성"
  },
  json: {
    title: "JSON 결과 생성",
    description: "복사 가능한 최종 JSON 아티팩트 생성"
  }
};

function createFailureDiagnostics(
  source: string,
  sourceType: ProductExtractionInput["sourceType"],
  error: string
): ProductExtractionDiagnostics {
  const generatedAt = new Date().toISOString();
  const order: ProductExtractionStageId[] = ["input", "fetch", "extract", "ocr", "review", "rag", "json"];

  return {
    source,
    sourceType,
    process: order.map((id): ProductExtractionStep => ({
      id,
      ...failureStepMessages[id],
      status: id === "input" ? "done" : id === "fetch" ? "error" : "pending",
      message: id === "input"
        ? sourceType === "restApi" ? "REST API 입력으로 정규화했습니다." : "상품 URL 입력으로 정규화했습니다."
        : id === "fetch" ? error : failureStepMessages[id].description,
      startedAt: id === "input" || id === "fetch" ? generatedAt : undefined,
      completedAt: id === "input" || id === "fetch" ? generatedAt : undefined
    })),
    evidence: [],
    warnings: [
      {
        code: "SOURCE_COLLECTION_FAILED",
        message: error
      }
    ],
    generatedAt,
    ragProfile: productExtractorRagManifest.profile
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}
