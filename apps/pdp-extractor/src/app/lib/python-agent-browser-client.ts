export interface BrowserMockExtractionRun {
  result: unknown;
  diagnostics: unknown;
}

export interface GeoProductRefinementRequest {
  result: unknown;
  instruction: string;
}

export interface GeoProductRefinementResponse {
  result: unknown;
  changes: string[];
  summary: string;
}

export async function requestMockProductExtraction<Run = BrowserMockExtractionRun>(sources: readonly string[]): Promise<Run[]> {
  return (await requestMockProductExtractionWithMetadata<Run>(sources)).runs;
}

export async function requestMockProductExtractionWithMetadata<Run = BrowserMockExtractionRun>(
  sources: readonly string[],
  requestId?: string
): Promise<{ runs: Run[]; requestId?: string }> {
  const response = await postPythonAgentJson<Run[]>("/mock", sources, requestId);
  return { runs: response.body, ...(response.requestId ? { requestId: response.requestId } : {}) };
}

export async function requestGeoProductRefinement<Result>(
  input: GeoProductRefinementRequest & { result: Result }
): Promise<GeoProductRefinementResponse & { result: Result }> {
  return (await postPythonAgentJson<GeoProductRefinementResponse & { result: Result }>("/refine", input)).body;
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

function normalizeRequestId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : undefined;
}

async function postPythonAgentJson<T>(
  path: string,
  payload: unknown,
  requestId?: string
): Promise<{ body: T; requestId?: string }> {
  const submittedRequestId = normalizeRequestId(requestId);
  const response = await fetch(pythonAgentBrowserEndpoint(path), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...(submittedRequestId ? { "x-request-id": submittedRequestId } : {})
    },
    body: JSON.stringify(payload),
    cache: "no-store"
  });
  const body = await response.json() as T & { error?: unknown };
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : `Python agent request failed: ${response.status}`);
  }
  const echoedRequestId = normalizeRequestId(response.headers.get("x-request-id"));
  return {
    body,
    ...(submittedRequestId && echoedRequestId === submittedRequestId ? { requestId: echoedRequestId } : {})
  };
}
