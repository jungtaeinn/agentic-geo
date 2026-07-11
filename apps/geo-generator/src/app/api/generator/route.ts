import { createPdpGeoGeneratorRestHandler } from "@agentic-geo/pdp-geo-generator-agent/rest";
import { readPdpGeoGeneratorRagProfile } from "@agentic-geo/pdp-geo-generator-agent/rag-profile";

type Provider = "mock" | "openai" | "gemini" | "azure-openai" | "aistudio";
type RerankerProvider = "cohere" | "azure-ai-search-semantic" | "local-hybrid" | "aistudio-bedrock-cohere";

const provider = (process.env.AGENTIC_GEO_PROVIDER ?? "mock") as Provider;
const rerankerProvider = (process.env.AGENTIC_GEO_RERANKER_PROVIDER as RerankerProvider | undefined) ?? "cohere";
const envAzureOpenAiTemperature = optionalNumber(process.env.AZURE_OPENAI_TEMPERATURE);

/** Standalone deployment endpoint powered by the package's reusable GEO generator REST adapter. */
export async function POST(request: Request): Promise<Response> {
  const ragProfile = await readPdpGeoGeneratorRagProfile().catch(() => undefined);
  const handler = createPdpGeoGeneratorRestHandler({
    provider,
    apiKey: resolveProviderApiKey(provider),
    model: resolveProviderModel(provider),
    endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    deployment: process.env.AZURE_OPENAI_REASONING_DEPLOYMENT ?? process.env.AZURE_OPENAI_DEPLOYMENT,
    deployments: {
      ocr: process.env.AZURE_OPENAI_OCR_DEPLOYMENT ?? process.env.AZURE_OPENAI_DEPLOYMENT,
      reasoning: process.env.AZURE_OPENAI_REASONING_DEPLOYMENT ?? process.env.AZURE_OPENAI_DEPLOYMENT,
      embedding: process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT,
      proofreading: process.env.AZURE_OPENAI_PROOFREADING_DEPLOYMENT
    },
    apiVersion: process.env.AZURE_OPENAI_API_VERSION,
    temperature: envAzureOpenAiTemperature,
    finalProofreading: {
      enabled: provider !== "mock" && Boolean(resolveProviderApiKey(provider)),
      provider,
      apiKey: resolveProviderApiKey(provider),
      model: provider === "azure-openai"
        ? process.env.AZURE_OPENAI_PROOFREADING_DEPLOYMENT ?? resolveProviderModel(provider)
        : resolveProviderModel(provider),
      endpoint: process.env.AZURE_OPENAI_ENDPOINT,
      deployment: provider === "azure-openai"
        ? process.env.AZURE_OPENAI_PROOFREADING_DEPLOYMENT
          ?? process.env.AZURE_OPENAI_REASONING_DEPLOYMENT
          ?? process.env.AZURE_OPENAI_DEPLOYMENT
        : undefined,
      apiVersion: process.env.AZURE_OPENAI_API_VERSION
    },
    embedding: {
      provider: process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT ? "azure-openai" : "local",
      apiKey: process.env.AZURE_OPENAI_API_KEY,
      endpoint: process.env.AZURE_OPENAI_ENDPOINT,
      deployment: process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT,
      apiVersion: process.env.AZURE_OPENAI_API_VERSION
    },
    reranker: {
      provider: rerankerProvider,
      apiKey: rerankerProvider === "azure-ai-search-semantic" ? process.env.AZURE_AI_SEARCH_API_KEY : process.env.AZURE_COHERE_RERANK_API_KEY,
      endpoint: rerankerProvider === "azure-ai-search-semantic" ? process.env.AZURE_AI_SEARCH_ENDPOINT : process.env.AZURE_COHERE_RERANK_ENDPOINT,
      model: rerankerProvider === "cohere" ? process.env.AZURE_COHERE_RERANK_MODEL : undefined,
      indexName: process.env.AZURE_AI_SEARCH_INDEX_NAME,
      semanticConfiguration: process.env.AZURE_AI_SEARCH_SEMANTIC_CONFIGURATION,
      queryLanguage: process.env.AZURE_AI_SEARCH_QUERY_LANGUAGE
    },
    analysisPrompt: ragProfile?.analysisPrompt,
    ragDocuments: ragProfile?.documents.map((document) => ({
      name: document.name,
      content: document.content,
      version: document.version
    })),
    rag: process.env.OPENAI_VECTOR_STORE_ID
      ? {
          vectorStoreId: process.env.OPENAI_VECTOR_STORE_ID
        }
      : undefined
  });

  return handler(request);
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

function optionalNumber(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}
