import { extractProduct } from "@agentic-geo/pdp-extractor-agent";
import { readProductExtractorRagProfile } from "@agentic-geo/pdp-extractor-agent/rag-profile";
import type {
  ProductExtractionDiagnostics,
  ProductExtractionInput,
  ProductExtractionResult,
  ProductExtractionStep
} from "@agentic-geo/pdp-extractor-agent/types";
import { generatePdpGeo } from "@agentic-geo/pdp-geo-generator-agent";
import { readPdpGeoGeneratorRagProfile } from "@agentic-geo/pdp-geo-generator-agent/rag-profile";
import type {
  PdpGeoGenerationInput,
  PdpGeoGenerationResult,
  PdpGeoGenerationStep
} from "@agentic-geo/pdp-geo-generator-agent/types";

type Provider = "mock" | "openai" | "gemini" | "azure-openai" | "aistudio";
type SourceMode = "url" | "restApi" | "manual-json";

interface GeoGeneratorRequest {
  stream?: boolean;
  sources?: string[];
  sourceType?: ProductExtractionInput["sourceType"];
  product?: unknown;
  products?: unknown[];
  headers?: Record<string, string>;
  hints?: PdpGeoGenerationInput["hints"];
  fieldMapping?: PdpGeoGenerationInput["fieldMapping"];
  llm?: {
    provider?: Provider;
    apiKey?: string;
    model?: string;
    endpoint?: string;
    deployment?: string;
    deployments?: {
      ocr?: string;
      reasoning?: string;
      embedding?: string;
    };
    apiVersion?: string;
    temperature?: number;
    embedding?: {
      provider?: "local" | "azure-openai" | "aistudio";
      apiKey?: string;
      endpoint?: string;
      deployment?: string;
      apiVersion?: string;
      model?: string;
    };
    reranker?: {
      provider?: "local-hybrid" | "cohere" | "azure-ai-search-semantic" | "aistudio-bedrock-cohere";
      apiKey?: string;
      endpoint?: string;
      model?: string;
      indexName?: string;
      semanticConfiguration?: string;
      queryLanguage?: string;
    };
  };
  rag?: PdpGeoGenerationInput["rag"];
  extractorRag?: {
    analysisPrompt?: string;
    documents?: Array<{
      name: string;
      content: string;
      version?: string;
    }>;
  };
}

interface GeoGeneratorResult {
  id: string;
  source: string;
  sourceType: SourceMode;
  extractor?: ProductExtractionResult;
  generator: PdpGeoGenerationResult;
}

interface GeoGeneratorLog {
  source: string;
  extractor?: ProductExtractionDiagnostics;
  generator: PdpGeoGenerationResult["diagnostics"];
  generatorProcess: PdpGeoGenerationStep[];
}

interface GeoGeneratorResponsePayload {
  results: GeoGeneratorResult[];
  logs: GeoGeneratorLog[];
  failures: Array<{ source: string; sourceType: SourceMode; error: string }>;
}

interface GeoGeneratorProgressEvent {
  type: "progress";
  group: "extractor" | "generator";
  source: string;
  sourceType: SourceMode;
  sourceIndex: number;
  sourceCount: number;
  step: ProductExtractionStep | PdpGeoGenerationStep;
}

type GeoGeneratorStreamEvent =
  | GeoGeneratorProgressEvent
  | { type: "result"; payload: GeoGeneratorResponsePayload }
  | { type: "error"; error: string };

type ProgressEmitter = (event: GeoGeneratorProgressEvent) => void;

const provider = (process.env.AGENTIC_GEO_PROVIDER ?? "mock") as Provider;
const rerankerProvider = (process.env.AGENTIC_GEO_RERANKER_PROVIDER as "cohere" | "azure-ai-search-semantic" | "local-hybrid" | undefined) ?? "cohere";
const envAzureOpenAiTemperature = optionalNumber(process.env.AZURE_OPENAI_TEMPERATURE);

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json() as GeoGeneratorRequest;
    if (body.stream) {
      return streamGeoGenerator(body);
    }

    const payload = await runGeoGenerator(body);

    if (payload.results.length === 0 && payload.failures.length === 0) {
      return jsonResponse({ error: "At least one URL, REST API source, or product JSON payload is required." }, 400);
    }

    return jsonResponse(payload, payload.failures.length > 0 ? 207 : 200);
  } catch (error) {
    return jsonResponse(
      {
        error: error instanceof Error ? error.message : "PDP GEO generation failed."
      },
      500
    );
  }
}

async function runGeoGenerator(body: GeoGeneratorRequest, emitProgress?: ProgressEmitter): Promise<GeoGeneratorResponsePayload> {
    const runtimeProvider = body.llm?.provider ?? provider;
    const [extractorRagProfile, generatorRagProfile] = await Promise.all([
      readProductExtractorRagProfile().catch(() => undefined),
      readPdpGeoGeneratorRagProfile().catch(() => undefined)
    ]);
    const sources = Array.isArray(body.sources) ? body.sources.filter(Boolean) : [];
    const directProducts = Array.isArray(body.products) ? body.products : body.product !== undefined ? [body.product] : [];
    const sourceCount = Math.max(directProducts.length + sources.length, 1);
    const results: GeoGeneratorResult[] = [];
    const logs: GeoGeneratorLog[] = [];
    const failures: Array<{ source: string; sourceType: SourceMode; error: string }> = [];

    for (const [index, product] of directProducts.entries()) {
      const source = `manual-json-${index + 1}`;
      try {
        const generatorRun = await generatePdpGeo(
          {
            product,
            source: {
              type: "manual-json"
            },
            hints: body.hints,
            fieldMapping: body.fieldMapping,
            rag: withRuntimeRagDefaults(body.rag)
          },
          {
            provider: runtimeProvider,
            apiKey: body.llm?.apiKey ?? process.env.OPENAI_API_KEY ?? process.env.GEMINI_API_KEY ?? process.env.AZURE_OPENAI_API_KEY,
            model: body.llm?.model ?? process.env.OPENAI_MODEL ?? process.env.GEMINI_MODEL,
            endpoint: body.llm?.endpoint ?? process.env.AZURE_OPENAI_ENDPOINT,
            deployment: body.llm?.deployments?.reasoning ?? body.llm?.deployment ?? process.env.AZURE_OPENAI_REASONING_DEPLOYMENT ?? process.env.AZURE_OPENAI_DEPLOYMENT,
            deployments: body.llm?.deployments ?? {
              ocr: process.env.AZURE_OPENAI_OCR_DEPLOYMENT ?? process.env.AZURE_OPENAI_DEPLOYMENT,
              reasoning: process.env.AZURE_OPENAI_REASONING_DEPLOYMENT ?? process.env.AZURE_OPENAI_DEPLOYMENT,
              embedding: process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT
            },
            apiVersion: body.llm?.apiVersion ?? process.env.AZURE_OPENAI_API_VERSION,
            temperature: body.llm?.temperature ?? envAzureOpenAiTemperature,
            embedding: body.llm?.embedding ?? {
              provider: process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT ? "azure-openai" : "local",
              apiKey: process.env.AZURE_OPENAI_API_KEY,
              endpoint: process.env.AZURE_OPENAI_ENDPOINT,
              deployment: process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT,
              apiVersion: process.env.AZURE_OPENAI_API_VERSION
            },
            reranker: body.llm?.reranker ?? {
              provider: rerankerProvider,
              apiKey: rerankerProvider === "azure-ai-search-semantic" ? process.env.AZURE_AI_SEARCH_API_KEY : process.env.AZURE_COHERE_RERANK_API_KEY,
              endpoint: rerankerProvider === "azure-ai-search-semantic" ? process.env.AZURE_AI_SEARCH_ENDPOINT : process.env.AZURE_COHERE_RERANK_ENDPOINT,
              model: rerankerProvider === "cohere" ? process.env.AZURE_COHERE_RERANK_MODEL : undefined,
              indexName: process.env.AZURE_AI_SEARCH_INDEX_NAME,
              semanticConfiguration: process.env.AZURE_AI_SEARCH_SEMANTIC_CONFIGURATION,
              queryLanguage: process.env.AZURE_AI_SEARCH_QUERY_LANGUAGE
            },
            analysisPrompt: generatorRagProfile?.analysisPrompt,
            ragDocuments: generatorRagProfile?.documents.map((document) => ({
              name: document.name,
              content: document.content,
              version: document.version
            })),
            onProgress: (step) => emitProgress?.({
              type: "progress",
              group: "generator",
              source,
              sourceType: "manual-json",
              sourceIndex: index,
              sourceCount,
              step
            })
          }
        );

        results.push({
          id: `${source}-${generatorRun.result.generatedAt}`,
          source,
          sourceType: "manual-json",
          generator: generatorRun.result
        });
        logs.push({
          source,
          generator: generatorRun.diagnostics,
          generatorProcess: generatorRun.process
        });
      } catch (error) {
        failures.push({
          source,
          sourceType: "manual-json",
          error: error instanceof Error ? error.message : "GEO generation failed."
        });
      }
    }

    for (const [sourceOffset, source] of sources.entries()) {
      const sourceType = body.sourceType ?? "url";
      const sourceIndex = directProducts.length + sourceOffset;
      try {
        const extractorRun = await extractProduct(
          {
            source,
            sourceType,
            headers: body.headers,
            aiProvider: runtimeProvider
          },
          {
            provider: runtimeProvider,
            apiKey: body.llm?.apiKey ?? process.env.OPENAI_API_KEY ?? process.env.GEMINI_API_KEY ?? process.env.AZURE_OPENAI_API_KEY,
            model: body.llm?.model ?? process.env.OPENAI_MODEL ?? process.env.GEMINI_MODEL,
            endpoint: body.llm?.endpoint ?? process.env.AZURE_OPENAI_ENDPOINT,
            deployment: body.llm?.deployments?.reasoning ?? body.llm?.deployment ?? process.env.AZURE_OPENAI_REASONING_DEPLOYMENT ?? process.env.AZURE_OPENAI_DEPLOYMENT,
            deployments: body.llm?.deployments ?? {
              ocr: process.env.AZURE_OPENAI_OCR_DEPLOYMENT ?? process.env.AZURE_OPENAI_DEPLOYMENT,
              reasoning: process.env.AZURE_OPENAI_REASONING_DEPLOYMENT ?? process.env.AZURE_OPENAI_DEPLOYMENT,
              embedding: process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT
            },
            apiVersion: body.llm?.apiVersion ?? process.env.AZURE_OPENAI_API_VERSION,
            temperature: body.llm?.temperature ?? envAzureOpenAiTemperature,
            embedding: body.llm?.embedding ?? {
              provider: process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT ? "azure-openai" : "local",
              apiKey: process.env.AZURE_OPENAI_API_KEY,
              endpoint: process.env.AZURE_OPENAI_ENDPOINT,
              deployment: process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT,
              apiVersion: process.env.AZURE_OPENAI_API_VERSION
            },
            reranker: body.llm?.reranker ?? {
              provider: rerankerProvider,
              apiKey: rerankerProvider === "azure-ai-search-semantic" ? process.env.AZURE_AI_SEARCH_API_KEY : process.env.AZURE_COHERE_RERANK_API_KEY,
              endpoint: rerankerProvider === "azure-ai-search-semantic" ? process.env.AZURE_AI_SEARCH_ENDPOINT : process.env.AZURE_COHERE_RERANK_ENDPOINT,
              model: rerankerProvider === "cohere" ? process.env.AZURE_COHERE_RERANK_MODEL : undefined,
              indexName: process.env.AZURE_AI_SEARCH_INDEX_NAME,
              semanticConfiguration: process.env.AZURE_AI_SEARCH_SEMANTIC_CONFIGURATION,
              queryLanguage: process.env.AZURE_AI_SEARCH_QUERY_LANGUAGE
            },
            analysisPrompt: body.extractorRag?.analysisPrompt ?? extractorRagProfile?.analysisPrompt,
            ragDocuments: (body.extractorRag?.documents ?? extractorRagProfile?.documents ?? []).map((document) => ({
              name: document.name,
              content: document.content
            })),
            onProgress: (step) => emitProgress?.({
              type: "progress",
              group: "extractor",
              source,
              sourceType,
              sourceIndex,
              sourceCount,
              step
            })
          }
        );
        const generatorRun = await generatePdpGeo(
          {
            product: extractorRun.result.geoProduct,
            source: {
              type: "pdp-extractor",
              url: source
            },
            hints: body.hints,
            fieldMapping: body.fieldMapping,
            rag: withRuntimeRagDefaults(body.rag)
          },
          {
            provider: runtimeProvider,
            apiKey: body.llm?.apiKey ?? process.env.OPENAI_API_KEY ?? process.env.GEMINI_API_KEY ?? process.env.AZURE_OPENAI_API_KEY,
            model: body.llm?.model ?? process.env.OPENAI_MODEL ?? process.env.GEMINI_MODEL,
            endpoint: body.llm?.endpoint ?? process.env.AZURE_OPENAI_ENDPOINT,
            deployment: body.llm?.deployments?.reasoning ?? body.llm?.deployment ?? process.env.AZURE_OPENAI_REASONING_DEPLOYMENT ?? process.env.AZURE_OPENAI_DEPLOYMENT,
            deployments: body.llm?.deployments ?? {
              ocr: process.env.AZURE_OPENAI_OCR_DEPLOYMENT ?? process.env.AZURE_OPENAI_DEPLOYMENT,
              reasoning: process.env.AZURE_OPENAI_REASONING_DEPLOYMENT ?? process.env.AZURE_OPENAI_DEPLOYMENT,
              embedding: process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT
            },
            apiVersion: body.llm?.apiVersion ?? process.env.AZURE_OPENAI_API_VERSION,
            temperature: body.llm?.temperature ?? envAzureOpenAiTemperature,
            embedding: body.llm?.embedding ?? {
              provider: process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT ? "azure-openai" : "local",
              apiKey: process.env.AZURE_OPENAI_API_KEY,
              endpoint: process.env.AZURE_OPENAI_ENDPOINT,
              deployment: process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT,
              apiVersion: process.env.AZURE_OPENAI_API_VERSION
            },
            reranker: body.llm?.reranker ?? {
              provider: rerankerProvider,
              apiKey: rerankerProvider === "azure-ai-search-semantic" ? process.env.AZURE_AI_SEARCH_API_KEY : process.env.AZURE_COHERE_RERANK_API_KEY,
              endpoint: rerankerProvider === "azure-ai-search-semantic" ? process.env.AZURE_AI_SEARCH_ENDPOINT : process.env.AZURE_COHERE_RERANK_ENDPOINT,
              model: rerankerProvider === "cohere" ? process.env.AZURE_COHERE_RERANK_MODEL : undefined,
              indexName: process.env.AZURE_AI_SEARCH_INDEX_NAME,
              semanticConfiguration: process.env.AZURE_AI_SEARCH_SEMANTIC_CONFIGURATION,
              queryLanguage: process.env.AZURE_AI_SEARCH_QUERY_LANGUAGE
            },
            analysisPrompt: generatorRagProfile?.analysisPrompt,
            ragDocuments: generatorRagProfile?.documents.map((document) => ({
              name: document.name,
              content: document.content,
              version: document.version
            })),
            onProgress: (step) => emitProgress?.({
              type: "progress",
              group: "generator",
              source,
              sourceType,
              sourceIndex,
              sourceCount,
              step
            })
          }
        );

        results.push({
          id: `${source}-${generatorRun.result.generatedAt}`,
          source,
          sourceType,
          extractor: extractorRun.result,
          generator: generatorRun.result
        });
        logs.push({
          source,
          extractor: extractorRun.diagnostics,
          generator: generatorRun.diagnostics,
          generatorProcess: generatorRun.process
        });
      } catch (error) {
        failures.push({
          source,
          sourceType,
          error: error instanceof Error ? error.message : "PDP GEO orchestration failed."
        });
      }
    }

  return {
    results,
    logs,
    failures
  };
}

function streamGeoGenerator(body: GeoGeneratorRequest): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (event: GeoGeneratorStreamEvent) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      void runGeoGenerator(body, write)
        .then((payload) => {
          if (payload.results.length === 0 && payload.failures.length === 0) {
            write({ type: "error", error: "At least one URL, REST API source, or product JSON payload is required." });
            return;
          }
          write({ type: "result", payload });
        })
        .catch((error) => {
          write({ type: "error", error: error instanceof Error ? error.message : "PDP GEO generation failed." });
        })
        .finally(() => controller.close());
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no"
    }
  });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function withRuntimeRagDefaults(rag: PdpGeoGenerationInput["rag"]): PdpGeoGenerationInput["rag"] {
  if (rag?.mode !== "managed-vector-store-rag") {
    return rag;
  }

  return {
    ...rag,
    vectorStoreId: rag.vectorStoreId ?? process.env.OPENAI_VECTOR_STORE_ID
  };
}

function optionalNumber(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}
