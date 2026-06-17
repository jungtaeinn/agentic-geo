import {
  readProductExtractorRagProfile,
  resetProductExtractorRagProfile,
  writeProductExtractorRagProfile
} from "@agentic-geo/pdp-extractor-agent/rag-profile";
import {
  readPdpGeoGeneratorRagProfile,
  resetPdpGeoGeneratorRagProfile,
  writePdpGeoGeneratorRagProfile
} from "@agentic-geo/pdp-geo-generator-agent/rag-profile";

interface RagProfileRequest {
  target?: "extractor" | "generator";
  analysisPrompt?: string;
  documents?: Array<{
    name?: string;
    version?: string;
    content?: string;
  }>;
}

export const dynamic = "force-dynamic";

/** Reads the package-managed extractor and generator RAG profiles for settings UI clients. */
export async function GET(): Promise<Response> {
  try {
    const [extractor, generator] = await Promise.all([
      readProductExtractorRagProfile(),
      readPdpGeoGeneratorRagProfile()
    ]);

    return jsonResponse({
      extractor,
      generator
    });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "RAG profile load failed." }, 500);
  }
}

/** Writes settings UI changes back into the selected package RAG directory. */
export async function PUT(request: Request): Promise<Response> {
  try {
    const body = await request.json() as RagProfileRequest;
    const payload = {
      analysisPrompt: body.analysisPrompt ?? "",
      documents: (body.documents ?? [])
        .filter((document) => document.name && typeof document.content === "string")
        .map((document) => ({
          name: document.name ?? "rag-document_v1.md",
          version: document.version ?? "v1",
          content: document.content ?? ""
        }))
    };

    if (body.target === "generator") {
      return jsonResponse({
        generator: await writePdpGeoGeneratorRagProfile(payload)
      });
    }

    return jsonResponse({
      extractor: await writeProductExtractorRagProfile(payload)
    });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "RAG profile save failed." }, 500);
  }
}

/** Restores RAG profile defaults and clears custom RAG attachments. */
export async function DELETE(request: Request): Promise<Response> {
  try {
    const target = new URL(request.url).searchParams.get("target");

    if (target === "extractor") {
      return jsonResponse({
        extractor: await resetProductExtractorRagProfile()
      });
    }

    if (target === "generator") {
      return jsonResponse({
        generator: await resetPdpGeoGeneratorRagProfile()
      });
    }

    const [extractor, generator] = await Promise.all([
      resetProductExtractorRagProfile(),
      resetPdpGeoGeneratorRagProfile()
    ]);

    return jsonResponse({
      extractor,
      generator
    });
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
