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
  PdpGeoContentPlanningSettings,
  PdpGeoFinalProofreadingSettings,
  PdpGeoGenerationInput,
  PdpGeoGenerationResult,
  PdpGeoGenerationStep,
  PdpGeoProviderId,
  PdpGeoProductNormalizationSettings
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
      proofreading?: string;
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
    /**
     * Optional per-request override. When omitted, source-backed semantic
     * normalization is enabled for a configured non-mock LLM.
     */
    productNormalization?: PdpGeoProductNormalizationSettings;
    /** Optional semantic content/schema planning override. */
    contentPlanning?: PdpGeoContentPlanningSettings;
    /** Final, fluency-only pass over fixed public schema strings. */
    finalProofreading?: PdpGeoFinalProofreadingSettings;
  };
  /** Top-level override takes precedence over llm.productNormalization. */
  productNormalization?: PdpGeoProductNormalizationSettings;
  /** Top-level override takes precedence over llm.contentPlanning. */
  contentPlanning?: PdpGeoContentPlanningSettings;
  /** Top-level override takes precedence over llm.finalProofreading. */
  finalProofreading?: PdpGeoFinalProofreadingSettings;
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
    assertSafeRequestEndpoints(body, body.llm?.provider ?? provider);
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
      error instanceof RequestConfigurationError ? 400 : 500
    );
  }
}

async function runGeoGenerator(body: GeoGeneratorRequest, emitProgress?: ProgressEmitter): Promise<GeoGeneratorResponsePayload> {
    const runtimeProvider = body.llm?.provider ?? provider;
    const runtimeApiKey = body.llm?.apiKey ?? resolveProviderApiKey(runtimeProvider);
    const runtimeModel = body.llm?.model ?? resolveProviderModel(runtimeProvider);
    const runtimeDeployment = body.llm?.deployments?.reasoning
      ?? body.llm?.deployment
      ?? (runtimeProvider === "aistudio" ? body.llm?.model : undefined)
      ?? resolveProviderDeployment(runtimeProvider);
    const runtimeDeployments = body.llm?.deployments
      ?? (runtimeProvider === "aistudio" && body.llm?.model ? { reasoning: body.llm.model } : resolveProviderDeployments(runtimeProvider));
    const runtimeProductNormalization = resolveProductNormalization(body, runtimeProvider, runtimeApiKey);
    const runtimeContentPlanning = resolveContentPlanning(body, runtimeProvider, runtimeApiKey);
    const runtimeFinalProofreading = resolveFinalProofreading(body, runtimeProvider, runtimeApiKey);
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
            apiKey: runtimeApiKey,
            model: runtimeModel,
            endpoint: body.llm?.endpoint ?? resolveProviderEndpoint(runtimeProvider),
            deployment: runtimeDeployment,
            deployments: runtimeDeployments,
            apiVersion: body.llm?.apiVersion ?? resolveProviderApiVersion(runtimeProvider),
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
            productNormalization: runtimeProductNormalization,
            contentPlanning: runtimeContentPlanning,
            finalProofreading: runtimeFinalProofreading,
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
            apiKey: runtimeApiKey,
            model: runtimeModel,
            endpoint: body.llm?.endpoint ?? resolveProviderEndpoint(runtimeProvider),
            deployment: runtimeDeployment,
            deployments: runtimeDeployments,
            apiVersion: body.llm?.apiVersion ?? resolveProviderApiVersion(runtimeProvider),
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
            apiKey: runtimeApiKey,
            model: runtimeModel,
            endpoint: body.llm?.endpoint ?? resolveProviderEndpoint(runtimeProvider),
            deployment: runtimeDeployment,
            deployments: runtimeDeployments,
            apiVersion: body.llm?.apiVersion ?? resolveProviderApiVersion(runtimeProvider),
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
            productNormalization: runtimeProductNormalization,
            contentPlanning: runtimeContentPlanning,
            finalProofreading: runtimeFinalProofreading,
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

function resolveProductNormalization(
  body: GeoGeneratorRequest,
  runtimeProvider: Provider,
  runtimeApiKey: string | undefined
): PdpGeoProductNormalizationSettings {
  const nestedSettings = body.llm?.productNormalization;
  const topLevelSettings = body.productNormalization;
  const mergedSettings = {
    ...nestedSettings,
    ...topLevelSettings
  };
  const normalizationProvider = mergedSettings.provider ?? runtimeProvider;
  const normalizationApiKey = mergedSettings.apiKey ?? (
    normalizationProvider === runtimeProvider
      ? runtimeApiKey
      : normalizationProvider === "custom"
        ? undefined
        : resolveProviderApiKey(normalizationProvider)
  );
  const explicitlyEnabled = topLevelSettings?.enabled ?? nestedSettings?.enabled;
  const enabled = explicitlyEnabled ?? (
    normalizationProvider !== "mock"
    && normalizationProvider !== "custom"
    && Boolean(normalizationApiKey)
  );

  return {
    ...mergedSettings,
    enabled,
    provider: normalizationProvider,
    apiKey: normalizationApiKey,
    model: mergedSettings.model ?? resolveProviderModel(normalizationProvider),
    endpoint: mergedSettings.endpoint ?? resolveProviderEndpoint(normalizationProvider),
    deployment: mergedSettings.deployment
      ?? (normalizationProvider === "aistudio" ? mergedSettings.model : undefined)
      ?? resolveProviderDeployment(normalizationProvider),
    apiVersion: mergedSettings.apiVersion ?? resolveProviderApiVersion(normalizationProvider)
  };
}

function resolveContentPlanning(
  body: GeoGeneratorRequest,
  runtimeProvider: Provider,
  runtimeApiKey: string | undefined
): PdpGeoContentPlanningSettings {
  const nestedSettings = body.llm?.contentPlanning;
  const topLevelSettings = body.contentPlanning;
  const mergedSettings = {
    ...nestedSettings,
    ...topLevelSettings
  };
  const planningProvider = mergedSettings.provider ?? runtimeProvider;
  const planningApiKey = mergedSettings.apiKey ?? (
    planningProvider === runtimeProvider
      ? runtimeApiKey
      : planningProvider === "custom"
        ? undefined
        : resolveProviderApiKey(planningProvider)
  );
  const explicitlyEnabled = topLevelSettings?.enabled ?? nestedSettings?.enabled;
  const enabled = explicitlyEnabled ?? (
    planningProvider !== "mock"
    && planningProvider !== "custom"
    && Boolean(planningApiKey)
  );

  return {
    ...mergedSettings,
    enabled,
    provider: planningProvider,
    apiKey: planningApiKey,
    model: mergedSettings.model ?? resolveProviderModel(planningProvider),
    endpoint: mergedSettings.endpoint ?? resolveProviderEndpoint(planningProvider),
    deployment: mergedSettings.deployment
      ?? (planningProvider === "aistudio" ? mergedSettings.model : undefined)
      ?? resolveProviderDeployment(planningProvider),
    apiVersion: mergedSettings.apiVersion ?? resolveProviderApiVersion(planningProvider)
  };
}

function resolveFinalProofreading(
  body: GeoGeneratorRequest,
  runtimeProvider: Provider,
  runtimeApiKey: string | undefined
): PdpGeoFinalProofreadingSettings {
  const nestedSettings = body.llm?.finalProofreading;
  const topLevelSettings = body.finalProofreading;
  const mergedSettings = {
    ...nestedSettings,
    ...topLevelSettings
  };
  const proofreadingProvider = mergedSettings.provider ?? runtimeProvider;
  const proofreadingApiKey = mergedSettings.apiKey ?? (
    proofreadingProvider === runtimeProvider
      ? runtimeApiKey
      : proofreadingProvider === "custom"
        ? undefined
        : resolveProviderApiKey(proofreadingProvider)
  );
  const explicitlyEnabled = topLevelSettings?.enabled ?? nestedSettings?.enabled;
  const enabled = explicitlyEnabled ?? (
    proofreadingProvider !== "mock"
    && proofreadingProvider !== "custom"
    && Boolean(proofreadingApiKey)
  );
  const azureProofreadingDeployment = proofreadingProvider === "azure-openai"
    ? body.llm?.deployments?.proofreading ?? process.env.AZURE_OPENAI_PROOFREADING_DEPLOYMENT
    : undefined;

  return {
    ...mergedSettings,
    enabled,
    provider: proofreadingProvider,
    apiKey: proofreadingApiKey,
    model: mergedSettings.model ?? azureProofreadingDeployment ?? resolveProviderModel(proofreadingProvider),
    endpoint: mergedSettings.endpoint ?? resolveProviderEndpoint(proofreadingProvider),
    deployment: mergedSettings.deployment
      ?? azureProofreadingDeployment
      ?? (proofreadingProvider === "aistudio" ? mergedSettings.model : undefined)
      ?? resolveProviderDeployment(proofreadingProvider),
    apiVersion: mergedSettings.apiVersion ?? resolveProviderApiVersion(proofreadingProvider)
  };
}

class RequestConfigurationError extends Error {}

function assertSafeRequestEndpoints(body: GeoGeneratorRequest, runtimeProvider: Provider): void {
  assertEndpointCredentialPair({
    label: "llm.endpoint",
    provider: runtimeProvider,
    endpoint: body.llm?.endpoint,
    requestApiKey: body.llm?.apiKey
  });

  const normalization = {
    ...body.llm?.productNormalization,
    ...body.productNormalization
  };
  const normalizationProvider = normalization.provider ?? runtimeProvider;
  assertEndpointCredentialPair({
    label: "productNormalization.endpoint",
    provider: normalizationProvider,
    endpoint: normalization.endpoint,
    requestApiKey: normalization.apiKey ?? (normalizationProvider === runtimeProvider ? body.llm?.apiKey : undefined)
  });

  const planning = {
    ...body.llm?.contentPlanning,
    ...body.contentPlanning
  };
  const planningProvider = planning.provider ?? runtimeProvider;
  assertEndpointCredentialPair({
    label: "contentPlanning.endpoint",
    provider: planningProvider,
    endpoint: planning.endpoint,
    requestApiKey: planning.apiKey ?? (planningProvider === runtimeProvider ? body.llm?.apiKey : undefined)
  });

  const proofreading = {
    ...body.llm?.finalProofreading,
    ...body.finalProofreading
  };
  const proofreadingProvider = proofreading.provider ?? runtimeProvider;
  assertEndpointCredentialPair({
    label: "finalProofreading.endpoint",
    provider: proofreadingProvider,
    endpoint: proofreading.endpoint,
    requestApiKey: proofreading.apiKey ?? (proofreadingProvider === runtimeProvider ? body.llm?.apiKey : undefined)
  });
}

function assertEndpointCredentialPair(input: {
  label: string;
  provider: PdpGeoProviderId;
  endpoint?: string;
  requestApiKey?: string;
}): void {
  if (!input.endpoint || input.requestApiKey || !resolveProviderApiKey(input.provider)) return;
  const configuredEndpoint = resolveProviderEndpoint(input.provider);
  if (configuredEndpoint && endpointIdentity(configuredEndpoint) === endpointIdentity(input.endpoint)) return;
  throw new RequestConfigurationError(
    `${input.label} cannot override the configured provider endpoint while using a server-managed API key. Supply the matching request API key or use the configured endpoint.`
  );
}

function endpointIdentity(value: string): string {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) throw new Error("unsafe endpoint components");
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.protocol}//${url.host}${pathname}`;
  } catch {
    throw new RequestConfigurationError(`Invalid provider endpoint URL: ${value}`);
  }
}

function resolveProviderApiKey(runtimeProvider: PdpGeoProviderId): string | undefined {
  switch (runtimeProvider) {
    case "openai":
      return process.env.OPENAI_API_KEY;
    case "gemini":
      return process.env.GEMINI_API_KEY;
    case "azure-openai":
      return process.env.AZURE_OPENAI_API_KEY;
    case "aistudio":
      return process.env.AISTUDIO_API_KEY;
    case "mock":
    default:
      return undefined;
  }
}

function resolveProviderModel(runtimeProvider: PdpGeoProviderId): string | undefined {
  switch (runtimeProvider) {
    case "openai":
      return process.env.OPENAI_MODEL;
    case "gemini":
      return process.env.GEMINI_MODEL;
    case "azure-openai":
      return process.env.AZURE_OPENAI_REASONING_DEPLOYMENT ?? process.env.AZURE_OPENAI_DEPLOYMENT;
    case "aistudio":
      return process.env.AISTUDIO_MODEL;
    case "mock":
    default:
      return undefined;
  }
}

function resolveProviderEndpoint(runtimeProvider: PdpGeoProviderId): string | undefined {
  if (runtimeProvider === "azure-openai") return process.env.AZURE_OPENAI_ENDPOINT;
  if (runtimeProvider === "aistudio") return process.env.AISTUDIO_ENDPOINT;
  return undefined;
}

function resolveProviderDeployment(runtimeProvider: PdpGeoProviderId): string | undefined {
  if (runtimeProvider === "azure-openai") {
    return process.env.AZURE_OPENAI_REASONING_DEPLOYMENT ?? process.env.AZURE_OPENAI_DEPLOYMENT;
  }
  if (runtimeProvider === "aistudio") return process.env.AISTUDIO_MODEL;
  return undefined;
}

function resolveProviderDeployments(runtimeProvider: PdpGeoProviderId): { ocr?: string; reasoning?: string; embedding?: string; proofreading?: string } | undefined {
  if (runtimeProvider === "azure-openai") {
    return {
      ocr: process.env.AZURE_OPENAI_OCR_DEPLOYMENT ?? process.env.AZURE_OPENAI_DEPLOYMENT,
      reasoning: process.env.AZURE_OPENAI_REASONING_DEPLOYMENT ?? process.env.AZURE_OPENAI_DEPLOYMENT,
      embedding: process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT,
      proofreading: process.env.AZURE_OPENAI_PROOFREADING_DEPLOYMENT
    };
  }
  if (runtimeProvider === "aistudio") {
    return { reasoning: process.env.AISTUDIO_MODEL };
  }
  return undefined;
}

function resolveProviderApiVersion(runtimeProvider: PdpGeoProviderId): string | undefined {
  if (runtimeProvider === "azure-openai") return process.env.AZURE_OPENAI_API_VERSION;
  if (runtimeProvider === "aistudio") return process.env.AISTUDIO_API_VERSION;
  return undefined;
}

function optionalNumber(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}
