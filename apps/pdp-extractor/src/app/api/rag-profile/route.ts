import {
  readProductExtractorRagProfile,
  resetProductExtractorRagProfile,
  writeProductExtractorRagProfile
} from "@agentic-geo/pdp-extractor-agent/rag-profile";

interface RagProfileRequest {
  analysisPrompt?: string;
  documents?: Array<{
    name?: string;
    version?: string;
    content?: string;
  }>;
}

export const dynamic = "force-static";

/** Reads the package-managed product extractor RAG profile for the settings UI. */
export async function GET(): Promise<Response> {
  try {
    return jsonResponse(await readProductExtractorRagProfile());
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "RAG profile load failed." }, 500);
  }
}

/** Writes settings UI changes back into packages/pdp-extractor-agent/src/rag. */
export async function PUT(request: Request): Promise<Response> {
  try {
    const body = await request.json() as RagProfileRequest;

    return jsonResponse(await writeProductExtractorRagProfile({
      analysisPrompt: body.analysisPrompt ?? "",
      documents: (body.documents ?? [])
        .filter((document) => document.name && typeof document.content === "string")
        .map((document) => ({
          name: document.name ?? "rag-document_v1.md",
          version: document.version ?? "v1",
          content: document.content ?? ""
        }))
    }));
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "RAG profile save failed." }, 500);
  }
}

/** Restores the package RAG profile defaults and clears custom RAG attachments. */
export async function DELETE(): Promise<Response> {
  try {
    return jsonResponse(await resetProductExtractorRagProfile());
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "RAG profile reset failed." }, 500);
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
