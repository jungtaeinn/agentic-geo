import { createKeywordClassificationPromptParts } from "../prompt";
import type {
  ImageTextExtractionRequest,
  ImageTextExtractionResponse,
  KeywordClassificationRequest,
  KeywordClassificationResponse,
  KeywordClassifier,
  LlmProviderConfig
} from "../types";
import type { AiTokenUsage } from "../../types";

type ChatCompletionsPayload = {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: unknown;
};

const CHAT_COMPLETIONS_TIMEOUT_MS = 60_000;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 20_000;

/** Azure API adapter using deployment-scoped chat completions. */
export class AzureApiKeywordClassifier implements KeywordClassifier {
  constructor(protected readonly config: LlmProviderConfig) {}

  /** Builds the chat completions URL for a deployment. Overridden by gateway adapters with a different path/auth scheme. */
  protected chatCompletionsUrl(deployment: string): string {
    const apiVersion = this.config.apiVersion ?? "2025-04-01-preview";
    const endpoint = this.config.endpoint?.replace(/\/$/, "");
    return `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
  }

  /** Auth headers for deployment-scoped calls. Azure uses the api-key header; gateways may override with a Bearer token. */
  protected authHeaders(): Record<string, string> {
    return { "api-key": this.config.apiKey ?? "" };
  }

  async classifyKeywords(request: KeywordClassificationRequest): Promise<KeywordClassificationResponse> {
    const deployment = this.config.deployments?.reasoning ?? this.config.deployment;
    if (!this.config.apiKey || !this.config.endpoint || !deployment) {
      throw new Error("API key, endpoint, and a reasoning deployment/model id are required.");
    }

    const url = this.chatCompletionsUrl(deployment);
    const prompt = createKeywordClassificationPromptParts(request);
    const payload = await requestChatCompletionsJson(
      url,
      this.authHeaders(),
      {
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user }
        ],
        ...temperatureBody(this.config.temperature)
      },
      "Azure keyword classification"
    );
    const rawText = payload.choices?.[0]?.message?.content ?? "";
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    const result = jsonMatch ? JSON.parse(jsonMatch[0]) as KeywordClassificationResponse : { keywords: [], summary: "No parseable JSON returned.", rawText };
    return {
      ...result,
      usage: tokenUsageFromChatCompletions(payload.usage)
    };
  }

  async extractImageTexts(request: ImageTextExtractionRequest): Promise<ImageTextExtractionResponse> {
    const deployment = this.config.deployments?.ocr ?? this.config.deployment;
    if (!this.config.apiKey || !this.config.endpoint || !deployment) {
      throw new Error("API key, endpoint, and an OCR deployment/model id are required for image OCR.");
    }

    const directImages = request.imageUrls.map((imageUrl) => ({
      displayUrl: imageUrl,
      inputUrl: imageUrl
    }));

    try {
      return await this.requestImageOcr(request, directImages, deployment);
    } catch (directError) {
      const fallback = await this.extractImageTextsWithDownloadedImages(request, deployment, directError);

      if (fallback.images.length > 0) {
        return fallback;
      }

      throw directError;
    }
  }

  private async requestImageOcr(
    request: ImageTextExtractionRequest,
    images: Array<{ displayUrl: string; inputUrl: string }>,
    deployment: string
  ): Promise<ImageTextExtractionResponse> {
    const url = this.chatCompletionsUrl(deployment);
    const payload = await requestChatCompletionsJson(
      url,
      this.authHeaders(),
      {
        messages: [
          {
            role: "user",
            content: createImageOcrContent({
              ...request,
              imageUrls: images.map((image) => image.displayUrl)
            }, images)
          }
        ],
        ...temperatureBody(this.config.temperature)
      },
      "Azure image OCR"
    );
    return {
      ...parseImageOcrJson(payload.choices?.[0]?.message?.content ?? "", images.map((image) => image.displayUrl)),
      usage: tokenUsageFromChatCompletions(payload.usage)
    };
  }

  private async extractImageTextsWithDownloadedImages(
    request: ImageTextExtractionRequest,
    deployment: string,
    directError: unknown
  ): Promise<ImageTextExtractionResponse> {
    const images: ImageTextExtractionResponse["images"] = [];
    const errors: string[] = [];
    const usages: AiTokenUsage[] = [];

    for (const imageUrl of request.imageUrls) {
      try {
        const dataUrl = await downloadImageAsDataUrl(imageUrl);
        const extracted = await this.requestImageOcr(request, [{ displayUrl: imageUrl, inputUrl: dataUrl }], deployment);
        images.push(...extracted.images);
        if (extracted.usage) {
          usages.push(extracted.usage);
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    return {
      images,
      rawText: [
        directError instanceof Error ? directError.message : String(directError),
        ...errors
      ].join("\n"),
      usage: mergeTokenUsages(usages)
    };
  }
}

function createImageOcrPrompt(request: ImageTextExtractionRequest): string {
  return [
    "Extract visible text from product detail page images for a GEO product extraction pipeline.",
    "Return strict JSON only: {\"images\":[{\"imageUrl\":\"\",\"text\":\"\"}]}",
    "Do not summarize, rewrite, translate, or infer claims.",
    "Preserve visible line order, percentages, footnote markers, row/column labels, and short headings as plain text.",
    "For tables, ingredient charts, clinical result images, and comparison blocks, keep each row together.",
    "If an image has no readable product text, return an empty string for that image.",
    `Source: ${request.source}`,
    `Product name: ${request.productName ?? "unknown"}`,
    ...request.imageUrls.map((imageUrl, index) => `Image ${index + 1}: ${imageUrl}`)
  ].join("\n");
}

function createImageOcrContent(
  request: ImageTextExtractionRequest,
  images: Array<{ displayUrl: string; inputUrl: string }>
) {
  return [
    {
      type: "text",
      text: createImageOcrPrompt({
        ...request,
        imageUrls: images.map((image) => image.displayUrl)
      })
    },
    ...images.flatMap((image, index) => [
      {
        type: "text",
        text: `Image ${index + 1}: ${image.displayUrl}`
      },
      {
        type: "image_url",
        image_url: {
          url: image.inputUrl,
          detail: "high"
        }
      }
    ])
  ];
}

function parseImageOcrJson(text: string, imageUrls: string[]): ImageTextExtractionResponse {
  const jsonMatch = String(text).match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    return { images: [], rawText: text };
  }

  const payload = JSON.parse(jsonMatch[0]) as {
    images?: Array<{
      imageUrl?: string;
      text?: string;
    }>;
  };

  return {
    images: (payload.images ?? [])
      .map((image, index) => ({
        imageUrl: image.imageUrl || imageUrls[index] || "",
        text: image.text ?? ""
      }))
      .filter((image) => image.imageUrl.length > 0 && image.text.trim().length > 0),
    rawText: text
  };
}

/**
 * Builds the optional `temperature` portion of a chat-completions body.
 * Returns an empty object when no temperature is configured so the request omits
 * the field entirely, letting models that only accept their default value (e.g. gpt-5.5) succeed.
 */
export function temperatureBody(temperature: number | undefined): { temperature?: number } {
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
  if (body.temperature !== undefined && isUnsupportedTemperatureError(suffix)) {
    const { temperature: _temperature, ...retryBody } = body;
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

function isUnsupportedTemperatureError(message: string): boolean {
  return /unsupported value[^]*temperature|temperature[^]*(?:unsupported|only the default)/i.test(message);
}

function tokenUsageFromChatCompletions(value: unknown): AiTokenUsage | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const usage = value as Record<string, unknown>;
  const inputTokens = numberField(usage.prompt_tokens) ?? numberField(usage.input_tokens);
  const outputTokens = numberField(usage.completion_tokens) ?? numberField(usage.output_tokens);
  return compactTokenUsage({
    inputTokens,
    outputTokens,
    totalTokens: numberField(usage.total_tokens) ?? sumOptional(inputTokens, outputTokens)
  });
}

function mergeTokenUsages(usages: AiTokenUsage[]): AiTokenUsage | undefined {
  const merged = usages.reduce<AiTokenUsage>((total, usage) => ({
    inputTokens: sumOptional(total.inputTokens, usage.inputTokens),
    outputTokens: sumOptional(total.outputTokens, usage.outputTokens),
    totalTokens: sumOptional(total.totalTokens, usage.totalTokens)
  }), {});
  return compactTokenUsage(merged);
}

function compactTokenUsage(usage: AiTokenUsage): AiTokenUsage | undefined {
  return usage.inputTokens !== undefined || usage.outputTokens !== undefined || usage.totalTokens !== undefined ? usage : undefined;
}

function sumOptional(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined && right === undefined) {
    return undefined;
  }
  return (left ?? 0) + (right ?? 0);
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function downloadImageAsDataUrl(imageUrl: string): Promise<string> {
  const response = await fetchWithTimeout(imageUrl, {
    headers: {
      Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"
    }
  }, IMAGE_DOWNLOAD_TIMEOUT_MS, "Image download for OCR");

  if (!response.ok) {
    throw new Error(`Image download failed: ${response.status}${await responseErrorSuffix(response)}`);
  }

  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() || "image/jpeg";

  if (!contentType.startsWith("image/")) {
    throw new Error(`Image download returned non-image content-type: ${contentType}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const maxBytes = 10 * 1024 * 1024;

  if (buffer.byteLength > maxBytes) {
    throw new Error(`Image is too large for OCR fallback: ${buffer.byteLength} bytes`);
  }

  return `data:${contentType};base64,${buffer.toString("base64")}`;
}

async function responseErrorSuffix(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned ? ` - ${cleaned.slice(0, 500)}` : "";
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, label: string): Promise<Response> {
  const { signal, cancel } = createTimeoutSignal(timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal
    });
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s.`);
    }
    throw error;
  } finally {
    cancel();
  }
}

function createTimeoutSignal(timeoutMs: number): { signal: AbortSignal; cancel: () => void } {
  if (typeof AbortSignal.timeout === "function") {
    return {
      signal: AbortSignal.timeout(timeoutMs),
      cancel: () => {}
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timeout)
  };
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "name" in error
    && (error as { name?: unknown }).name === "AbortError";
}
