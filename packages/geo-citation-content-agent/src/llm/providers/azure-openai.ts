import type {
  GeoCitationDraftWriter,
  GeoCitationDraftWriterRequest,
  GeoCitationDraftWriterResult,
  RedditCitationArtifact
} from "../../types";
import {
  createPublicRedditTitle,
  sanitizePublicRedditText
} from "../../surfaces/reddit/public-copy";

interface AzureOpenAiGeoCitationDraftWriterConfig {
  apiKey?: string;
  endpoint?: string;
  deployment?: string;
  apiVersion?: string;
  temperature?: number;
}

type ChatCompletionsPayload = {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: unknown;
};

const CHAT_COMPLETIONS_TIMEOUT_MS = 60_000;

/** Azure OpenAI adapter using deployment-scoped chat completions, matching the other packages. */
export class AzureOpenAiGeoCitationDraftWriter implements GeoCitationDraftWriter {
  constructor(private readonly config: AzureOpenAiGeoCitationDraftWriterConfig) {}

  async writeRedditArtifact(request: GeoCitationDraftWriterRequest): Promise<GeoCitationDraftWriterResult> {
    if (!this.config.apiKey || !this.config.endpoint || !this.config.deployment) {
      throw new Error("AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, and AZURE_OPENAI_DEPLOYMENT are required for GEO citation content generation.");
    }

    const payload = await requestChatCompletionsJson(
      this.chatCompletionsUrl(this.config.deployment),
      { "api-key": this.config.apiKey },
      {
        messages: [
          {
            role: "system",
            content: [
              "You generate one Reddit discussion artifact for a GEO citation content agent.",
              "Return strict JSON only. Do not wrap it in markdown.",
              "The title and bodyMarkdown fields must be public Reddit copy that can be pasted directly into Reddit.",
              "Never include internal evidence IDs, RAG IDs, diagnostics, source counts, or labels like Evidence refs in public copy.",
              "Never expose target audience settings. Rewrite them as natural product-fit context.",
              "Do not dump raw INCI or full ingredient lists; mention at most 2-3 key actives.",
              "Keep the title under 120 characters.",
              "Do not invent firsthand use, fake identity, fake reviews, or unsupported evidence.",
              "Avoid sales CTAs, affiliate language, and promotional tone."
            ].join("\n")
          },
          {
            role: "user",
            content: request.prompt
          }
        ],
        response_format: { type: "json_object" },
        ...temperatureBody(this.config.temperature)
      },
      "Azure GEO citation Reddit draft"
    );
    const rawText = payload.choices?.[0]?.message?.content ?? "";

    return {
      artifact: normalizeAzureRedditArtifact(parseRedditArtifactJson(rawText), request)
    };
  }

  private chatCompletionsUrl(deployment: string): string {
    const apiVersion = this.config.apiVersion ?? "2025-04-01-preview";
    const endpoint = this.config.endpoint?.replace(/\/$/, "");
    return `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;
  }
}

function parseRedditArtifactJson(text: string): Partial<RedditCitationArtifact> {
  const jsonText = extractJson(text);
  const parsed = JSON.parse(jsonText) as Record<string, unknown>;

  return {
    surface: "reddit",
    title: stringField(parsed.title),
    bodyMarkdown: stringField(parsed.bodyMarkdown) ?? stringField(parsed.body),
    flairSuggestion: stringField(parsed.flairSuggestion),
    subredditFitNotes: stringArrayField(parsed.subredditFitNotes),
    disclosureNote: stringField(parsed.disclosureNote),
    commentSeeds: stringArrayField(parsed.commentSeeds)
  };
}

function normalizeAzureRedditArtifact(
  artifact: Partial<RedditCitationArtifact>,
  request: GeoCitationDraftWriterRequest
): RedditCitationArtifact {
  return {
    surface: "reddit",
    title: artifact.title?.trim() || createPublicRedditTitle(request.product),
    bodyMarkdown: sanitizePublicRedditText(artifact.bodyMarkdown?.trim() || fallbackBody(request), request.product),
    flairSuggestion: artifact.flairSuggestion?.trim() || "Discussion",
    subredditFitNotes: artifact.subredditFitNotes && artifact.subredditFitNotes.length > 0
      ? artifact.subredditFitNotes
      : [
          "Generated from a question-led Reddit surface profile.",
          "Uses evidence-backed claims and caveats instead of direct promotion."
        ],
    disclosureNote: artifact.disclosureNote?.trim() || "Add an affiliation disclosure before posting if there is any commercial relationship.",
    commentSeeds: artifact.commentSeeds && artifact.commentSeeds.length > 0
      ? artifact.commentSeeds
      : [
          request.variantStrategy.communityQuestion,
          "What would you compare this against?"
        ]
  };
}

function fallbackBody(request: GeoCitationDraftWriterRequest): string {
  return [
    `I was looking into ${request.product.name} and tried to separate the evidence from the marketing language.`,
    "",
    "Short version:",
    ...request.brief.answerChunks.map((chunk) => `- ${sanitizePublicRedditText(chunk.answer, request.product)}${chunk.caveat ? ` ${sanitizePublicRedditText(chunk.caveat, request.product)}` : ""}`),
    "",
    `Question: ${request.variantStrategy.communityQuestion}`
  ].join("\n");
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? text;
  const jsonMatch = candidate.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    throw new Error("Azure GEO citation draft returned no parseable JSON object.");
  }

  return jsonMatch[0];
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function stringArrayField(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const items = value
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter((item) => item.length > 0);

  return items.length > 0 ? items : undefined;
}

function temperatureBody(temperature: number | undefined): { temperature?: number } {
  return typeof temperature === "number" && Number.isFinite(temperature) ? { temperature } : {};
}

async function requestChatCompletionsJson(
  url: string,
  authHeaders: Record<string, string>,
  body: Record<string, unknown>,
  failureLabel: string
): Promise<ChatCompletionsPayload> {
  const response = await postChatCompletions(url, authHeaders, body, failureLabel);

  if (response.ok) {
    return response.json() as Promise<ChatCompletionsPayload>;
  }

  const suffix = await responseErrorSuffix(response);
  if ((body.temperature !== undefined || body.response_format !== undefined) && shouldRetryWithoutOptionalFields(suffix)) {
    const { temperature: _temperature, response_format: _responseFormat, ...retryBody } = body;
    const retryResponse = await postChatCompletions(url, authHeaders, retryBody, failureLabel);

    if (retryResponse.ok) {
      return retryResponse.json() as Promise<ChatCompletionsPayload>;
    }

    throw new Error(`${failureLabel} failed: ${retryResponse.status}${await responseErrorSuffix(retryResponse)}`);
  }

  throw new Error(`${failureLabel} failed: ${response.status}${suffix}`);
}

function postChatCompletions(
  url: string,
  authHeaders: Record<string, string>,
  body: Record<string, unknown>,
  failureLabel: string
): Promise<Response> {
  return fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders
    },
    body: JSON.stringify(body)
  }, CHAT_COMPLETIONS_TIMEOUT_MS, failureLabel);
}

function shouldRetryWithoutOptionalFields(message: string): boolean {
  return /unsupported value[^]*(?:temperature|response_format)|(?:temperature|response_format)[^]*(?:unsupported|only the default)/i.test(message);
}

async function responseErrorSuffix(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return text ? ` ${text.slice(0, 1200)}` : "";
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, label: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`${label} timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
