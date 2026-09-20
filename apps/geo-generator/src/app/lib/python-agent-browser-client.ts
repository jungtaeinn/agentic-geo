export interface GeoQualityEvaluationDto {
  overallScore: number;
  dimensions: Array<{
    id: "geo" | "cep" | "eeat";
    label: string;
    score: number;
    criteria: string;
    summary: string;
    evidence: string[];
    improvements: string[];
  }>;
  validationDetails: string[];
  validationImprovements: string[];
}

export async function requestGeoQualityEvaluation(
  input: unknown,
  language: "ko" | "en"
): Promise<GeoQualityEvaluationDto> {
  const response = await fetch(pythonAgentBrowserEndpoint("/evaluation"), {
    method: "POST",
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify({ input, language }),
    cache: "no-store"
  });
  const body = await response.json() as GeoQualityEvaluationDto & { error?: unknown };
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : `Evaluation request failed: ${response.status}`);
  }
  return body;
}

export function pythonAgentBrowserEndpoint(path: string): string {
  if (process.env.NEXT_PUBLIC_DEPLOY_TARGET !== "github-pages") {
    return `/api${path}`;
  }

  const configured = process.env.NEXT_PUBLIC_AGENTIC_GEO_API_URL?.trim();
  if (!configured) {
    throw new Error("NEXT_PUBLIC_AGENTIC_GEO_API_URL is required for static console requests.");
  }
  return new URL(path.replace(/^\/+/, ""), configured.endsWith("/") ? configured : `${configured}/`).toString();
}
