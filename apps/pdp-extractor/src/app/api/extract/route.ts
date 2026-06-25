import { createProductExtractorRestHandler } from "@agentic-geo/pdp-extractor-agent/rest";
import { readProductExtractorRagProfile } from "@agentic-geo/pdp-extractor-agent/rag-profile";

type Provider = "mock" | "openai" | "gemini" | "azure-openai" | "aistudio";

const provider = (process.env.AGENTIC_GEO_PROVIDER ?? "mock") as Provider;
const rerankerProvider = (process.env.AGENTIC_GEO_RERANKER_PROVIDER as "cohere" | "azure-ai-search-semantic" | "local-hybrid" | undefined) ?? "cohere";
const envAzureOpenAiTemperature = optionalNumber(process.env.AZURE_OPENAI_TEMPERATURE);

/** Local/server deployment endpoint powered by the package's reusable REST adapter. */
export async function POST(request: Request): Promise<Response> {
  const ragProfile = await readProductExtractorRagProfile().catch(() => undefined);
  const handler = createProductExtractorRestHandler({
    provider,
    apiKey: process.env.OPENAI_API_KEY ?? process.env.GEMINI_API_KEY ?? process.env.AZURE_OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL ?? process.env.GEMINI_MODEL,
    endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
    deployments: {
      ocr: process.env.AZURE_OPENAI_OCR_DEPLOYMENT ?? process.env.AZURE_OPENAI_DEPLOYMENT,
      reasoning: process.env.AZURE_OPENAI_REASONING_DEPLOYMENT ?? process.env.AZURE_OPENAI_DEPLOYMENT,
      embedding: process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT
    },
    apiVersion: process.env.AZURE_OPENAI_API_VERSION,
    temperature: envAzureOpenAiTemperature,
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
      content: document.content
    }))
  });

  return handler(request);
}

function optionalNumber(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}
