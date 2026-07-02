import { generateGeoCitationContent } from "./agent";
import type {
  GeoCitationContentInput,
  GeoCitationGeneratorOptions
} from "./types";

export interface GeoCitationContentRestRequest extends GeoCitationContentInput {
  llm?: Partial<Pick<GeoCitationGeneratorOptions, "provider" | "apiKey" | "model" | "endpoint" | "deployment" | "deployments" | "apiVersion" | "temperature">>;
}

export interface GeoCitationContentRestConfig extends GeoCitationGeneratorOptions {}

export function createGeoCitationContentRestHandler(config: GeoCitationContentRestConfig = {}) {
  return async function geoCitationContentRestHandler(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed. Use POST." }, 405);
    }

    try {
      const body = await request.json() as GeoCitationContentRestRequest;
      const run = await generateGeoCitationContent(body, {
        ...config,
        ...body.llm,
        rag: {
          ...config.rag,
          ...body.rag
        }
      });

      return jsonResponse({
        result: run.result,
        diagnostics: run.diagnostics,
        process: run.process
      });
    } catch (error) {
      return jsonResponse(
        {
          error: error instanceof Error ? error.message : "GEO citation content generation failed."
        },
        500
      );
    }
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
