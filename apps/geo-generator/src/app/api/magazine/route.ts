import { generateGeoCitationContent } from "@agentic-geo/geo-citation-content-agent";
import type {
  GeoCitationContentInput,
  GeoCitationDiagnostics,
  GeoCitationEvidenceBuckets,
  GeoCitationGenerationResult,
  GeoCitationGenerationStep,
  GeoCitationGeneratorOptions,
  GeoCitationProviderId
} from "@agentic-geo/geo-citation-content-agent/types";
import { extractProduct } from "@agentic-geo/pdp-extractor-agent";
import { readProductExtractorRagProfile } from "@agentic-geo/pdp-extractor-agent/rag-profile";
import type {
  GeoProductRawData,
  ProductExtractionDiagnostics,
  ProductExtractionInput,
  ProductExtractionResult,
  ProductExtractionStep
} from "@agentic-geo/pdp-extractor-agent/types";

type Provider = "mock" | "openai" | "gemini" | "azure-openai" | "aistudio";
type SourceMode = "url" | "restApi" | "manual-json";

interface MagazineGeneratorRequest {
  stream?: boolean;
  sources?: string[];
  sourceType?: ProductExtractionInput["sourceType"];
  product?: unknown;
  products?: unknown[];
  headers?: Record<string, string>;
  target?: GeoCitationContentInput["target"];
  strategy?: GeoCitationContentInput["strategy"];
  evidence?: GeoCitationContentInput["evidence"];
  rag?: GeoCitationContentInput["rag"];
  extractorRag?: {
    analysisPrompt?: string;
    documents?: Array<{
      name: string;
      content: string;
      version?: string;
    }>;
  };
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
}

interface MagazineGeneratorResult {
  id: string;
  source: string;
  sourceType: SourceMode;
  extractor?: ProductExtractionResult;
  magazine: GeoCitationGenerationResult;
}

interface MagazineGeneratorLog {
  source: string;
  extractor?: ProductExtractionDiagnostics;
  magazine: GeoCitationDiagnostics;
  magazineProcess: GeoCitationGenerationStep[];
}

interface MagazineGeneratorResponsePayload {
  results: MagazineGeneratorResult[];
  logs: MagazineGeneratorLog[];
  failures: Array<{ source: string; sourceType: SourceMode; error: string }>;
}

interface MagazineGeneratorProgressEvent {
  type: "progress";
  group: "extractor" | "magazine";
  source: string;
  sourceType: SourceMode;
  sourceIndex: number;
  sourceCount: number;
  step: ProductExtractionStep | GeoCitationGenerationStep;
}

type MagazineGeneratorStreamEvent =
  | MagazineGeneratorProgressEvent
  | { type: "result"; payload: MagazineGeneratorResponsePayload }
  | { type: "error"; error: string };

type ProgressEmitter = (event: MagazineGeneratorProgressEvent) => void;

const provider = (process.env.AGENTIC_GEO_PROVIDER ?? "mock") as Provider;
const rerankerProvider = (process.env.AGENTIC_GEO_RERANKER_PROVIDER as "cohere" | "azure-ai-search-semantic" | "local-hybrid" | undefined) ?? "cohere";
const envAzureOpenAiTemperature = optionalNumber(process.env.AZURE_OPENAI_TEMPERATURE);

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json() as MagazineGeneratorRequest;
    if (body.stream) {
      return streamMagazineGenerator(body);
    }

    const payload = await runMagazineGenerator(body);

    if (payload.results.length === 0 && payload.failures.length === 0) {
      return jsonResponse({ error: "At least one URL, REST API source, or product JSON payload is required." }, 400);
    }

    return jsonResponse(payload, payload.failures.length > 0 ? 207 : 200);
  } catch (error) {
    return jsonResponse(
      {
        error: error instanceof Error ? error.message : "GEO magazine/content generation failed."
      },
      500
    );
  }
}

async function runMagazineGenerator(body: MagazineGeneratorRequest, emitProgress?: ProgressEmitter): Promise<MagazineGeneratorResponsePayload> {
  const runtimeProvider = body.llm?.provider ?? provider;
  const extractorRagProfile = await readProductExtractorRagProfile().catch(() => undefined);
  const sources = Array.isArray(body.sources) ? body.sources.filter(Boolean) : [];
  const directProducts = Array.isArray(body.products) ? body.products : body.product !== undefined ? [body.product] : [];
  const sourceCount = Math.max(directProducts.length + sources.length, 1);
  const results: MagazineGeneratorResult[] = [];
  const logs: MagazineGeneratorLog[] = [];
  const failures: Array<{ source: string; sourceType: SourceMode; error: string }> = [];

  for (const [index, product] of directProducts.entries()) {
    const source = `manual-json-${index + 1}`;
    try {
      const magazineRun = await generateGeoCitationContent(
        {
          product,
          source: {
            type: "manual-json",
            observedAt: new Date().toISOString()
          },
          evidence: body.evidence,
          target: createRedditTarget(body.target),
          strategy: createDefaultStrategy(body.strategy),
          rag: body.rag
        },
        createCitationOptions(body, runtimeProvider, (step) => emitProgress?.({
          type: "progress",
          group: "magazine",
          source,
          sourceType: "manual-json",
          sourceIndex: index,
          sourceCount,
          step
        }))
      );

      results.push({
        id: `${source}-${magazineRun.result.diagnostics.generatedAt}`,
        source,
        sourceType: "manual-json",
        magazine: magazineRun.result
      });
      logs.push({
        source,
        magazine: magazineRun.diagnostics,
        magazineProcess: magazineRun.process
      });
    } catch (error) {
      failures.push({
        source,
        sourceType: "manual-json",
        error: error instanceof Error ? error.message : "GEO magazine/content generation failed."
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
          ...createExtractorOptions(body, runtimeProvider),
          analysisPrompt: body.extractorRag?.analysisPrompt ?? extractorRagProfile?.analysisPrompt,
          ragDocuments: (body.extractorRag?.documents ?? extractorRagProfile?.documents ?? []).map((document) => ({
            name: document.name,
            content: document.content,
            version: document.version
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

      const magazineRun = await generateGeoCitationContent(
        {
          product: extractorRun.result.geoProduct,
          source: {
            type: "pdp-extractor",
            url: source,
            observedAt: extractorRun.result.generatedAt
          },
          evidence: mergeCitationEvidence(body.evidence, createCitationEvidenceFromExtraction(extractorRun.result.geoProduct, source)),
          target: createRedditTarget(body.target),
          strategy: createDefaultStrategy(body.strategy),
          rag: body.rag
        },
        createCitationOptions(body, runtimeProvider, (step) => emitProgress?.({
          type: "progress",
          group: "magazine",
          source,
          sourceType,
          sourceIndex,
          sourceCount,
          step
        }))
      );

      results.push({
        id: `${source}-${magazineRun.result.diagnostics.generatedAt}`,
        source,
        sourceType,
        extractor: extractorRun.result,
        magazine: magazineRun.result
      });
      logs.push({
        source,
        extractor: extractorRun.diagnostics,
        magazine: magazineRun.diagnostics,
        magazineProcess: magazineRun.process
      });
    } catch (error) {
      failures.push({
        source,
        sourceType,
        error: error instanceof Error ? error.message : "GEO magazine/content orchestration failed."
      });
    }
  }

  return {
    results,
    logs,
    failures
  };
}

function streamMagazineGenerator(body: MagazineGeneratorRequest): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (event: MagazineGeneratorStreamEvent) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };

      void runMagazineGenerator(body, write)
        .then((payload) => {
          if (payload.results.length === 0 && payload.failures.length === 0) {
            write({ type: "error", error: "At least one URL, REST API source, or product JSON payload is required." });
            return;
          }
          write({ type: "result", payload });
        })
        .catch((error) => {
          write({ type: "error", error: error instanceof Error ? error.message : "GEO magazine/content generation failed." });
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

function createExtractorOptions(body: MagazineGeneratorRequest, runtimeProvider: Provider) {
  return {
    provider: runtimeProvider,
    apiKey: resolveApiKey(body, runtimeProvider),
    model: body.llm?.model ?? resolveProviderModel(runtimeProvider),
    endpoint: body.llm?.endpoint ?? process.env.AZURE_OPENAI_ENDPOINT,
    deployment: resolveReasoningDeployment(body),
    deployments: resolveRoleDeployments(body),
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
    }
  };
}

function createCitationOptions(
  body: MagazineGeneratorRequest,
  runtimeProvider: Provider,
  onProgress: (step: GeoCitationGenerationStep) => void
): GeoCitationGeneratorOptions {
  const providerId = resolveCitationProvider(runtimeProvider);
  return {
    provider: providerId,
    apiKey: providerId === "azure-openai" ? resolveApiKey(body, runtimeProvider) : undefined,
    model: body.llm?.model,
    endpoint: providerId === "azure-openai" ? body.llm?.endpoint ?? process.env.AZURE_OPENAI_ENDPOINT : undefined,
    deployment: providerId === "azure-openai" ? resolveReasoningDeployment(body) : undefined,
    deployments: providerId === "azure-openai" ? { reasoning: resolveReasoningDeployment(body) } : undefined,
    apiVersion: providerId === "azure-openai" ? body.llm?.apiVersion ?? process.env.AZURE_OPENAI_API_VERSION : undefined,
    temperature: body.llm?.temperature ?? envAzureOpenAiTemperature,
    rag: body.rag,
    ragDocuments: body.rag?.documents,
    onProgress
  };
}

function resolveCitationProvider(runtimeProvider: Provider): GeoCitationProviderId {
  return runtimeProvider === "azure-openai" ? "azure-openai" : "mock";
}

function resolveApiKey(body: MagazineGeneratorRequest, runtimeProvider: Provider): string | undefined {
  return body.llm?.apiKey ?? resolveProviderApiKey(runtimeProvider);
}

function resolveProviderApiKey(runtimeProvider: Provider): string | undefined {
  switch (runtimeProvider) {
    case "openai":
      return process.env.OPENAI_API_KEY;
    case "gemini":
      return process.env.GEMINI_API_KEY;
    case "azure-openai":
      return process.env.AZURE_OPENAI_API_KEY;
    case "aistudio":
    case "mock":
    default:
      return undefined;
  }
}

function resolveProviderModel(runtimeProvider: Provider): string | undefined {
  switch (runtimeProvider) {
    case "openai":
      return process.env.OPENAI_MODEL;
    case "gemini":
      return process.env.GEMINI_MODEL;
    case "azure-openai":
      return process.env.AZURE_OPENAI_REASONING_DEPLOYMENT ?? process.env.AZURE_OPENAI_DEPLOYMENT;
    case "aistudio":
    case "mock":
    default:
      return undefined;
  }
}

function resolveReasoningDeployment(body: MagazineGeneratorRequest): string | undefined {
  return body.llm?.deployments?.reasoning ?? body.llm?.deployment ?? process.env.AZURE_OPENAI_REASONING_DEPLOYMENT ?? process.env.AZURE_OPENAI_DEPLOYMENT;
}

function resolveRoleDeployments(body: MagazineGeneratorRequest): NonNullable<MagazineGeneratorRequest["llm"]>["deployments"] {
  return body.llm?.deployments ?? {
    ocr: process.env.AZURE_OPENAI_OCR_DEPLOYMENT ?? process.env.AZURE_OPENAI_DEPLOYMENT,
    reasoning: process.env.AZURE_OPENAI_REASONING_DEPLOYMENT ?? process.env.AZURE_OPENAI_DEPLOYMENT,
    embedding: process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT
  };
}

function createRedditTarget(target: GeoCitationContentInput["target"]): GeoCitationContentInput["target"] {
  if (!target) {
    return {
      surface: "reddit"
    };
  }

  return {
    ...target,
    surface: "reddit"
  };
}

function createDefaultStrategy(strategy: GeoCitationContentInput["strategy"]): GeoCitationContentInput["strategy"] {
  return {
    avoidPromotionalTone: true,
    contentAngle: "buyer-question",
    generationMode: "single-best",
    ...strategy,
    variants: {
      diversity: "high",
      avoidNearDuplicate: true,
      ...strategy?.variants
    }
  };
}

function createCitationEvidenceFromExtraction(product: GeoProductRawData, source: string): GeoCitationEvidenceBuckets {
  const observedAt = new Date().toISOString();
  return {
    reviews: [
      ...product.reviews.items.map((review, index) => ({
        id: `review-${index + 1}`,
        sourceType: "review",
        title: review.author ? `Review by ${review.author}` : `Review ${index + 1}`,
        text: review.body,
        author: review.author,
        rating: review.rating,
        publishedAt: review.datePublished,
        observedAt
      })),
      ...product.reviews.keywords.map((keyword, index) => ({
        id: `review-keyword-${index + 1}`,
        sourceType: "review",
        title: "Review keyword",
        text: keyword,
        observedAt
      }))
    ],
    images: [
      ...product.images.map((imageUrl, index) => ({
        id: `image-${index + 1}`,
        sourceType: "image",
        title: `Product image ${index + 1}`,
        text: imageUrl,
        url: imageUrl,
        observedAt
      })),
      ...product.sourceExtraction.ocr.imageTexts.map((item, index) => ({
        id: `ocr-image-${index + 1}`,
        sourceType: "image",
        title: `OCR image text ${index + 1}`,
        text: item.text,
        url: item.imageUrl,
        observedAt
      }))
    ],
    existingGeoArtifacts: product.rag.chunks.map((chunk, index) => ({
      id: `extractor-rag-${index + 1}`,
      sourceType: "existing-geo",
      title: `${chunk.kind} evidence`,
      text: chunk.text,
      url: source,
      observedAt
    })),
    custom: [
      ...product.metrics.map((metric, index) => ({
        id: `metric-${index + 1}`,
        sourceType: "custom",
        title: "Product metric",
        text: metric,
        url: source,
        observedAt
      })),
      ...product.faq.map((faq, index) => ({
        id: `faq-${index + 1}`,
        sourceType: "custom",
        title: faq.question,
        text: faq.answer,
        url: source,
        observedAt
      }))
    ]
  };
}

function mergeCitationEvidence(
  base: GeoCitationContentInput["evidence"],
  extracted: GeoCitationEvidenceBuckets
): GeoCitationEvidenceBuckets {
  return {
    reviews: [...(base?.reviews ?? []), ...(extracted.reviews ?? [])],
    images: [...(base?.images ?? []), ...(extracted.images ?? [])],
    newsArticles: [...(base?.newsArticles ?? []), ...(extracted.newsArticles ?? [])],
    researchPapers: [...(base?.researchPapers ?? []), ...(extracted.researchPapers ?? [])],
    existingGeoArtifacts: [...(base?.existingGeoArtifacts ?? []), ...(extracted.existingGeoArtifacts ?? [])],
    custom: [...(base?.custom ?? []), ...(extracted.custom ?? [])]
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

function optionalNumber(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}
