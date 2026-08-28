/**
 * Simulated generative-engine harness for the citation-visibility benchmark.
 *
 * Ported from AutoGEO `generative_engine.py`: a fixed RAG prompt instructs the
 * model to answer a customer question using ONLY the provided indexed sources
 * and to cite every sentence with `[n]` markers. The answer is then scored by
 * `metrics.ts` for the target source's share-of-voice.
 *
 * This is an approximation of production engines (ChatGPT Search, Gemini,
 * Perplexity) — the prompt enforces the citation format that the metrics
 * parse. Treat scores as relative signals between paired runs (vanilla vs
 * generated), never as absolute citation probabilities.
 *
 * The harness is self-contained inside the eval tier on purpose: it must not
 * couple the runtime generation pipeline (`src/`) to benchmark-only provider
 * calls. Provider request shapes mirror `src/copy-refiner.ts` adapters.
 */

export type GeoEvalProvider = "openai" | "gemini" | "azure-openai" | "aistudio";

export interface GeoEvalEngineConfig {
  provider: GeoEvalProvider;
  apiKey: string;
  /** Model id (openai/gemini) — e.g. "gpt-4o-mini", "gemini-2.5-flash-lite". */
  model?: string;
  /** Deployment name (azure-openai/aistudio). */
  deployment?: string;
  /** Resource endpoint (azure-openai/aistudio). */
  endpoint?: string;
  apiVersion?: string;
  /** Sampling temperature. Lower is more reproducible; omit to use the provider default. */
  temperature?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
}

export interface GeoEvalEngineAnswer {
  answer: string;
  /** Stable identity of the engine for cache keys and reports. */
  engineId: string;
}

export { CITATION_ANSWER_INSTRUCTIONS, buildCitationAnswerPrompt } from "../prompts/citation-answer";
import { buildCitationAnswerPrompt } from "../prompts/citation-answer";

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 5000;
const DEFAULT_TIMEOUT_MS = 120000;

/** Stable engine identity used in cache keys and baseline records. */
export function geoEvalEngineId(config: GeoEvalEngineConfig): string {
  const model = config.model ?? config.deployment ?? "unknown-model";
  return `${config.provider}:${model}`;
}

/** Generates a cited answer from the simulated generative engine, with retries. */
export async function generateEngineAnswer(
  config: GeoEvalEngineConfig,
  query: string,
  sources: string[]
): Promise<GeoEvalEngineAnswer> {
  const prompt = buildCitationAnswerPrompt(query, sources);
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryDelayMs = config.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    try {
      const answer = await completeWithProvider(config, prompt.system, prompt.user);
      return { answer, engineId: geoEvalEngineId(config) };
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries - 1) {
        await sleep(retryDelayMs * (attempt + 1));
      }
    }
  }
  throw new Error(
    `Simulated engine ${geoEvalEngineId(config)} failed after ${maxRetries} attempts: ${errorMessage(lastError)}`
  );
}

/**
 * Single text completion against the configured provider. Exposed for the
 * offline judge calls (utility metrics, rule extraction) so every eval-tier
 * LLM call flows through one adapter.
 */
export async function completeWithProvider(
  config: GeoEvalEngineConfig,
  system: string,
  user: string
): Promise<string> {
  switch (config.provider) {
    case "openai":
      return completeOpenAi(config, system, user);
    case "gemini":
      return completeGemini(config, system, user);
    case "azure-openai":
    case "aistudio":
      return completeChatCompletions(config, system, user);
    default:
      throw new Error(`Unsupported geo-eval provider: ${String(config.provider)}`);
  }
}

async function completeOpenAi(config: GeoEvalEngineConfig, system: string, user: string): Promise<string> {
  if (!config.model) {
    throw new Error("geo-eval openai provider requires a model id.");
  }
  const response = await fetchWithTimeout("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.model,
      instructions: system,
      input: user,
      ...temperatureBody(config.temperature)
    })
  }, config.timeoutMs ?? DEFAULT_TIMEOUT_MS, "geo-eval OpenAI call");
  await assertOk(response, "geo-eval OpenAI call");

  const payload = await response.json() as {
    output_text?: string;
    output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  };
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }
  const text = (payload.output ?? [])
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
  if (!text.trim()) {
    throw new Error("geo-eval OpenAI call returned an empty answer.");
  }
  return text;
}

async function completeGemini(config: GeoEvalEngineConfig, system: string, user: string): Promise<string> {
  if (!config.model) {
    throw new Error("geo-eval gemini provider requires a model id.");
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent`;
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": config.apiKey
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      ...(typeof config.temperature === "number" ? { generationConfig: { temperature: config.temperature } } : {})
    })
  }, config.timeoutMs ?? DEFAULT_TIMEOUT_MS, "geo-eval Gemini call");
  await assertOk(response, "geo-eval Gemini call");

  const payload = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("\n") ?? "";
  if (!text.trim()) {
    throw new Error("geo-eval Gemini call returned an empty answer.");
  }
  return text;
}

async function completeChatCompletions(config: GeoEvalEngineConfig, system: string, user: string): Promise<string> {
  if (!config.endpoint || !config.deployment) {
    throw new Error(`geo-eval ${config.provider} provider requires endpoint and deployment.`);
  }
  const endpoint = config.endpoint.replace(/\/$/, "");
  const apiVersion = config.provider === "azure-openai"
    ? (config.apiVersion ?? "2025-04-01-preview")
    : config.apiVersion?.trim();
  const query = apiVersion ? `?api-version=${encodeURIComponent(apiVersion)}` : "";
  const url = `${endpoint}/openai/deployments/${config.deployment}/chat/completions${query}`;
  const authHeaders: Record<string, string> = config.provider === "azure-openai"
    ? { "api-key": config.apiKey }
    : { Authorization: `Bearer ${config.apiKey}` };

  const body: Record<string, unknown> = {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    ...temperatureBody(config.temperature)
  };

  let response = await postJson(url, authHeaders, body, config);
  if (!response.ok && body.temperature !== undefined) {
    const suffix = await responseErrorSuffix(response);
    if (/unsupported value[^]*temperature|temperature[^]*(?:unsupported|only the default)/i.test(suffix)) {
      const { temperature: _temperature, ...retryBody } = body;
      response = await postJson(url, authHeaders, retryBody, config);
    } else {
      throw new Error(`geo-eval ${config.provider} call failed: ${response.status}${suffix}`);
    }
  }
  await assertOk(response, `geo-eval ${config.provider} call`);

  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const text = payload.choices?.[0]?.message?.content ?? "";
  if (!text.trim()) {
    throw new Error(`geo-eval ${config.provider} call returned an empty answer.`);
  }
  return text;
}

function postJson(
  url: string,
  authHeaders: Record<string, string>,
  body: Record<string, unknown>,
  config: GeoEvalEngineConfig
): Promise<Response> {
  return fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders
    },
    body: JSON.stringify(body)
  }, config.timeoutMs ?? DEFAULT_TIMEOUT_MS, `geo-eval ${config.provider} call`);
}

function temperatureBody(temperature: number | undefined): { temperature?: number } {
  return typeof temperature === "number" && Number.isFinite(temperature) ? { temperature } : {};
}

async function assertOk(response: Response, label: string): Promise<void> {
  if (!response.ok) {
    throw new Error(`${label} failed: ${response.status}${await responseErrorSuffix(response)}`);
  }
}

async function responseErrorSuffix(response: Response): Promise<string> {
  const text = await response.clone().text().catch(() => "");
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned ? ` - ${cleaned.slice(0, 500)}` : "";
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, label: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
