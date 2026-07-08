import { createImageOcrPrompt, createKeywordClassificationPromptParts } from "../prompt";
import {
  chatCompletionsImageOcrResponseFormat,
  chatCompletionsKeywordClassificationResponseFormat
} from "../schemas";
import type {
  ImageTextExtractionRequest,
  ImageTextExtractionResponse,
  KeywordClassificationRequest,
  KeywordClassificationResponse,
  KeywordClassifier,
  LlmProviderConfig
} from "../types";
import type { AiTokenUsage } from "../../types";
import {
  downloadImageAsDataUrl,
  extractJsonObjectText,
  fetchWithTimeout,
  isUnsupportedStructuredOutputError,
  mergeTokenUsages,
  numberField,
  parseImageOcrPayloadText,
  resolveImageInputs,
  responseErrorSuffix,
  sumOptional,
  temperatureBody
} from "./shared";

export { temperatureBody } from "./shared";

type ChatCompletionsPayload = {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: unknown;
};

const CHAT_COMPLETIONS_TIMEOUT_MS = 300_000;

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
        response_format: chatCompletionsKeywordClassificationResponseFormat,
        ...temperatureBody(this.config.temperature)
      },
      "Azure keyword classification"
    );
    const rawText = payload.choices?.[0]?.message?.content ?? "";
    const jsonText = extractJsonObjectText(rawText);
    const result = jsonText ? JSON.parse(jsonText) as KeywordClassificationResponse : { keywords: [], summary: "No parseable JSON returned.", rawText };
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

    const directImages = resolveImageInputs(request);

    try {
      const direct = await this.requestImageOcr(request, directImages, deployment);
      const missingInputs = imageInputsWithoutExtractedText(directImages, direct.images);

      if (missingInputs.length === 0) {
        return direct;
      }

      const fallback = await this.extractImageTextsWithDownloadedImages(
        { ...request, imageUrls: missingInputs.map((input) => input.displayUrl), imageInputs: missingInputs },
        deployment,
        new Error(`${missingInputs.length} remote image OCR result(s) returned no readable text.`)
      );

      return fallback.images.length > 0
        ? mergeImageTextExtractionResponses(direct, fallback)
        : direct;
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
        response_format: chatCompletionsImageOcrResponseFormat,
        ...temperatureBody(this.config.temperature)
      },
      "Azure image OCR"
    );
    return {
      ...parseImageOcrPayloadText(payload.choices?.[0]?.message?.content ?? "", images.map((image) => image.displayUrl)),
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

    for (const input of resolveImageInputs(request)) {
      try {
        const dataUrl = input.inputUrl.startsWith("data:") ? input.inputUrl : await downloadImageAsDataUrl(input.inputUrl);
        const extracted = await this.requestImageOcr(request, [{ displayUrl: input.displayUrl, inputUrl: dataUrl }], deployment);
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

function imageInputsWithoutExtractedText(
  requestedInputs: Array<{ displayUrl: string; inputUrl: string }>,
  extractedImages: ImageTextExtractionResponse["images"]
): Array<{ displayUrl: string; inputUrl: string }> {
  const extractedUrls = new Set(extractedImages.map((image) => image.imageUrl));
  return requestedInputs.filter((input) => !extractedUrls.has(input.displayUrl));
}

function mergeImageTextExtractionResponses(
  primary: ImageTextExtractionResponse,
  fallback: ImageTextExtractionResponse
): ImageTextExtractionResponse {
  const seen = new Set<string>();
  const images = [...primary.images, ...fallback.images].filter((image) => {
    const key = image.imageUrl;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return image.text.trim().length > 0;
  });

  return {
    images,
    rawText: [primary.rawText, fallback.rawText].filter(Boolean).join("\n"),
    usage: mergeTokenUsages([primary.usage, fallback.usage].filter((usage): usage is AiTokenUsage => Boolean(usage)))
  };
}

async function requestChatCompletionsJson(
  url: string,
  authHeaders: Record<string, string>,
  body: Record<string, unknown>,
  failureLabel: string
): Promise<ChatCompletionsPayload> {
  let currentBody = body;
  let response = await postChatCompletions(url, authHeaders, currentBody, failureLabel);

  if (!response.ok) {
    const suffix = await responseErrorSuffix(response);

    if (currentBody.response_format !== undefined && isUnsupportedStructuredOutputError(suffix)) {
      const { response_format: _responseFormat, ...retryBody } = currentBody;
      currentBody = retryBody;
      response = await postChatCompletions(url, authHeaders, currentBody, failureLabel);
    } else if (currentBody.temperature !== undefined && isUnsupportedTemperatureError(suffix)) {
      const { temperature: _temperature, ...retryBody } = currentBody;
      currentBody = retryBody;
      response = await postChatCompletions(url, authHeaders, currentBody, failureLabel);
    } else {
      throw new Error(`${failureLabel} failed: ${response.status}${suffix}`);
    }
  }

  if (!response.ok) {
    const suffix = await responseErrorSuffix(response);

    if (currentBody.temperature !== undefined && isUnsupportedTemperatureError(suffix)) {
      const { temperature: _temperature, ...retryBody } = currentBody;
      const retryResponse = await postChatCompletions(url, authHeaders, retryBody, failureLabel);

      if (retryResponse.ok) {
        return retryResponse.json() as Promise<ChatCompletionsPayload>;
      }

      throw new Error(`${failureLabel} failed: ${retryResponse.status}${await responseErrorSuffix(retryResponse)}`);
    }

    throw new Error(`${failureLabel} failed: ${response.status}${suffix}`);
  }

  return response.json() as Promise<ChatCompletionsPayload>;
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
  const totalTokens = numberField(usage.total_tokens) ?? sumOptional(inputTokens, outputTokens);
  return inputTokens !== undefined || outputTokens !== undefined || totalTokens !== undefined
    ? { inputTokens, outputTokens, totalTokens }
    : undefined;
}
