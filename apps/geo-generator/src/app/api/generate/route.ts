import { extractProduct } from "@agentic-geo/pdp-extractor-agent";
import { readProductExtractorRagProfile } from "@agentic-geo/pdp-extractor-agent/rag-profile";
import type {
  ProductExtractionDiagnostics,
  ProductExtractionInput,
  ProductExtractionResult
} from "@agentic-geo/pdp-extractor-agent/types";
import { generatePdpGeo } from "@agentic-geo/pdp-geo-generator-agent";
import { readPdpGeoGeneratorRagProfile } from "@agentic-geo/pdp-geo-generator-agent/rag-profile";
import type {
  PdpGeoGenerationInput,
  PdpGeoGenerationResult,
  PdpGeoGenerationStep
} from "@agentic-geo/pdp-geo-generator-agent/types";

type Provider = "mock" | "openai" | "gemini" | "azure-openai";
type SourceMode = "url" | "restApi" | "manual-json";

interface GeoGeneratorRequest {
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
    apiVersion?: string;
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

const provider = (process.env.AGENTIC_GEO_PROVIDER ?? "mock") as Provider;

export async function POST(request: Request): Promise<Response> {
  try {
    const body = await request.json() as GeoGeneratorRequest;
    const runtimeProvider = body.llm?.provider ?? provider;
    const [extractorRagProfile, generatorRagProfile] = await Promise.all([
      readProductExtractorRagProfile().catch(() => undefined),
      readPdpGeoGeneratorRagProfile().catch(() => undefined)
    ]);
    const sources = Array.isArray(body.sources) ? body.sources.filter(Boolean) : [];
    const directProducts = Array.isArray(body.products) ? body.products : body.product !== undefined ? [body.product] : [];
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
            deployment: body.llm?.deployment ?? process.env.AZURE_OPENAI_DEPLOYMENT,
            apiVersion: body.llm?.apiVersion ?? process.env.AZURE_OPENAI_API_VERSION,
            analysisPrompt: generatorRagProfile?.analysisPrompt,
            ragDocuments: generatorRagProfile?.documents.map((document) => ({
              name: document.name,
              content: document.content,
              version: document.version
            }))
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

    for (const source of sources) {
      const sourceType = body.sourceType ?? "url";
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
            deployment: body.llm?.deployment ?? process.env.AZURE_OPENAI_DEPLOYMENT,
            apiVersion: body.llm?.apiVersion ?? process.env.AZURE_OPENAI_API_VERSION,
            analysisPrompt: body.extractorRag?.analysisPrompt ?? extractorRagProfile?.analysisPrompt,
            ragDocuments: (body.extractorRag?.documents ?? extractorRagProfile?.documents ?? []).map((document) => ({
              name: document.name,
              content: document.content
            }))
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
            deployment: body.llm?.deployment ?? process.env.AZURE_OPENAI_DEPLOYMENT,
            apiVersion: body.llm?.apiVersion ?? process.env.AZURE_OPENAI_API_VERSION,
            analysisPrompt: generatorRagProfile?.analysisPrompt,
            ragDocuments: generatorRagProfile?.documents.map((document) => ({
              name: document.name,
              content: document.content,
              version: document.version
            }))
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

    if (results.length === 0 && failures.length === 0) {
      return jsonResponse({ error: "At least one URL, REST API source, or product JSON payload is required." }, 400);
    }

    return jsonResponse(
      {
        results,
        logs,
        failures
      },
      failures.length > 0 ? 207 : 200
    );
  } catch (error) {
    return jsonResponse(
      {
        error: error instanceof Error ? error.message : "PDP GEO generation failed."
      },
      500
    );
  }
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
