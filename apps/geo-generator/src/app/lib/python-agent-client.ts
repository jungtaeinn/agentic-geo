/**
 * Server-side boundary for the Python Agent API. This module is imported only
 * by Next route handlers so AGENTIC_GEO_API_URL never enters a browser bundle.
 */
export async function proxyPythonAgent(request: Request, upstreamPath: string, options: ProxyPythonAgentOptions = {}): Promise<Response> {
  const requestUrl = new URL(request.url);
  // ``AGENTIC_GEO_API_URL`` is a deployment base, not only an origin.  A
  // leading slash would otherwise discard an ingress path such as
  // ``https://api.example/agent-api/``.
  const target = new URL(upstreamPath.replace(/^\/+/, ""), requiredAgentApiUrl());
  target.search = requestUrl.search;

  const headers = upstreamRequestHeaders(request, options);

  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
    cache: "no-store",
    signal: request.signal
  });

  const responseHeaders = publicResponseHeaders(upstream);

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders
  });
}

export interface ProxyPythonAgentOptions {
  console?: "extractor";
}

const FORWARDED_REQUEST_HEADERS = ["accept", "content-type", "x-request-id"] as const;
const FORWARDED_RESPONSE_HEADERS = ["content-type", "x-request-id", "x-accel-buffering"] as const;

function upstreamRequestHeaders(request: Request, options: ProxyPythonAgentOptions): Headers {
  const headers = copyAllowedHeaders(request.headers, FORWARDED_REQUEST_HEADERS);
  headers.set("cache-control", "no-store");
  if (options.console === "extractor") {
    headers.set("x-neo-console", "extractor");
  }
  return headers;
}

function publicResponseHeaders(upstream: Response): Headers {
  const headers = copyAllowedHeaders(upstream.headers, FORWARDED_RESPONSE_HEADERS);
  headers.set("cache-control", "no-store, no-transform");
  return headers;
}

function copyAllowedHeaders(source: Headers, names: readonly string[]): Headers {
  const headers = new Headers();
  for (const name of names) {
    const value = source.get(name);
    if (value !== null) {
      headers.set(name, value);
    }
  }
  return headers;
}

function requiredAgentApiUrl(): string {
  const configured = process.env.AGENTIC_GEO_API_URL?.trim();
  if (!configured) {
    throw new Error("AGENTIC_GEO_API_URL is required for Next BFF routes.");
  }
  return configured.endsWith("/") ? configured : `${configured}/`;
}
