import { createProductExtractorRestHandler } from "@agentic-geo/product-extractor-agent/rest";
import { readProductExtractorRagProfile } from "@agentic-geo/product-extractor-agent/rag-profile";

type Provider = "mock" | "openai" | "gemini" | "azure-openai";

const provider = (process.env.AGENTIC_GEO_PROVIDER ?? "mock") as Provider;

/** Local/server deployment endpoint powered by the package's reusable REST adapter. */
export async function POST(request: Request): Promise<Response> {
  const ragProfile = await readProductExtractorRagProfile().catch(() => undefined);
  const handler = createProductExtractorRestHandler({
    provider,
    apiKey: process.env.OPENAI_API_KEY ?? process.env.GEMINI_API_KEY ?? process.env.AZURE_OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL ?? process.env.GEMINI_MODEL,
    endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    deployment: process.env.AZURE_OPENAI_DEPLOYMENT,
    apiVersion: process.env.AZURE_OPENAI_API_VERSION,
    analysisPrompt: ragProfile?.analysisPrompt,
    ragDocuments: ragProfile?.documents.map((document) => ({
      name: document.name,
      content: document.content
    }))
  });

  return handler(request);
}
