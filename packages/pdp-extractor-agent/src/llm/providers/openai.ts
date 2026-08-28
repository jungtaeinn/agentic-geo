import { createImageOcrPrompt, createKeywordClassificationPromptParts } from "../prompt";
import { openAiImageOcrTextFormat, openAiKeywordClassificationTextFormat } from "../schemas";
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
  temperatureBody
} from "./shared";

const RESPONSES_TIMEOUT_MS = 300_000;

/** OpenAI Responses API adapter for OCR keyword classification. */
export class OpenAIKeywordClassifier implements KeywordClassifier {
  constructor(private readonly config: LlmProviderConfig) {}

  async classifyKeywords(request: KeywordClassificationRequest): Promise<KeywordClassificationResponse> {
    if (!this.config.apiKey) {
      throw new Error("OPENAI_API_KEY is required for the OpenAI keyword classifier.");
    }
    if (!this.config.model) {
      throw new Error("OPENAI_MODEL is required for the OpenAI keyword classifier.");
    }

    const prompt = createKeywordClassificationPromptParts(request);
    const payload = await this.requestResponsesJson({
      model: this.config.model,
      instructions: prompt.system,
      input: prompt.user,
      ...temperatureBody(this.config.temperature),
      text: openAiKeywordClassificationTextFormat
    }, "OpenAI keyword classification");

    return parseProviderJson(payload);
  }

  async extractImageTexts(request: ImageTextExtractionRequest): Promise<ImageTextExtractionResponse> {
    if (!this.config.apiKey) {
      throw new Error("OPENAI_API_KEY is required for OpenAI image OCR.");
    }
    if (!this.config.model) {
      throw new Error("OPENAI_MODEL is required for OpenAI image OCR.");
    }

    const directImages = resolveImageInputs(request);

    try {
      const direct = await this.requestImageOcr(request, directImages);
      const missingInputs = imageInputsWithoutExtractedText(directImages, direct.images);

      if (missingInputs.length === 0) {
        return direct;
      }

      const fallback = await this.extractImageTextsWithDownloadedImages(
        { ...request, imageUrls: missingInputs.map((input) => input.displayUrl), imageInputs: missingInputs },
        new Error(`${missingInputs.length} remote image OCR result(s) returned no readable text.`)
      );

      return fallback.images.length > 0
        ? mergeImageTextExtractionResponses(direct, fallback)
        : direct;
    } catch (directError) {
      if (isQuotaOrBillingError(directError)) {
        throw directError;
      }

      const fallback = await this.extractImageTextsWithDownloadedImages(request, directError);

      if (fallback.images.length > 0) {
        return fallback;
      }

      throw directError;
    }
  }

  private async requestImageOcr(
    request: ImageTextExtractionRequest,
    images: Array<{ displayUrl: string; inputUrl: string }>
  ): Promise<ImageTextExtractionResponse> {
    const content = createImageOcrContent(request, images);
    const payload = await this.requestResponsesJson({
      model: this.config.model,
      input: [
        {
          role: "user",
          content
        }
      ],
      ...temperatureBody(this.config.temperature),
      text: openAiImageOcrTextFormat
    }, "OpenAI image OCR");

    return parseImageOcrJson(payload, images.map((image) => image.displayUrl));
  }

  /**
   * Posts a Responses API body, retrying once without the structured-output
   * `text` format (and once without `temperature`) when the target model
   * rejects those request fields, so older deployments keep working.
   */
  private async requestResponsesJson(body: Record<string, unknown>, label: string): Promise<Record<string, unknown>> {
    let currentBody = body;
    let response = await this.postResponses(currentBody, label);

    if (!response.ok) {
      const suffix = await responseErrorSuffix(response);

      if (currentBody.text !== undefined && isUnsupportedStructuredOutputError(suffix)) {
        const { text: _text, ...retryBody } = currentBody;
        currentBody = retryBody;
        response = await this.postResponses(currentBody, label);
      } else if (currentBody.temperature !== undefined && isUnsupportedTemperatureError(suffix)) {
        const { temperature: _temperature, ...retryBody } = currentBody;
        currentBody = retryBody;
        response = await this.postResponses(currentBody, label);
      } else {
        throw new Error(`${label} failed: ${response.status}${suffix}`);
      }
    }

    if (!response.ok) {
      throw new Error(`${label} failed: ${response.status}${await responseErrorSuffix(response)}`);
    }

    return JSON.parse(await response.text()) as Record<string, unknown>;
  }

  private postResponses(body: Record<string, unknown>, label: string): Promise<Response> {
    return fetchWithTimeout("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }, RESPONSES_TIMEOUT_MS, label);
  }

  private async extractImageTextsWithDownloadedImages(
    request: ImageTextExtractionRequest,
    directError: unknown
  ): Promise<ImageTextExtractionResponse> {
    const images: ImageTextExtractionResponse["images"] = [];
    const errors: string[] = [];
    const usages: AiTokenUsage[] = [];

    for (const input of resolveImageInputs(request)) {
      if (input.inputUrl.startsWith("data:")) {
        try {
          const direct = await this.requestImageOcr(request, [input]);
          images.push(...direct.images);
          if (direct.usage) {
            usages.push(direct.usage);
          }
          if (direct.images.length === 0) {
            errors.push(direct.rawText ? `Inline image OCR returned no readable text: ${direct.rawText.slice(0, 240)}` : "Inline image OCR returned no readable text.");
          }
        } catch (error) {
          if (isQuotaOrBillingError(error)) {
            throw error;
          }
          errors.push(error instanceof Error ? error.message : String(error));
        }
        continue;
      }

      try {
        const dataUrl = await downloadImageAsDataUrl(input.inputUrl);
        const extracted = await this.requestImageOcr(request, [{ displayUrl: input.displayUrl, inputUrl: dataUrl }]);
        images.push(...extracted.images);
        if (extracted.usage) {
          usages.push(extracted.usage);
        }
      } catch (error) {
        if (isQuotaOrBillingError(error)) {
          throw error;
        }
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

function responsesOutputText(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === "string") {
    return payload.output_text;
  }
  const output = payload.output as Array<{ content?: Array<{ text?: string }> }> | undefined;
  return output?.flatMap((item) => item.content ?? []).map((item) => item.text ?? "").join("\n") ?? "";
}

function parseProviderJson(payload: Record<string, unknown>): KeywordClassificationResponse {
  const rawText = responsesOutputText(payload);
  const jsonText = extractJsonObjectText(rawText);
  const result = jsonText
    ? JSON.parse(jsonText) as KeywordClassificationResponse
    : { keywords: [], summary: "No parseable JSON returned.", rawText };
  return {
    ...result,
    usage: tokenUsageFromOpenAi(payload.usage)
  };
}

function createImageOcrContent(
  request: ImageTextExtractionRequest,
  images: Array<{ displayUrl: string; inputUrl: string }>
) {
  return [
    {
      type: "input_text",
      text: createImageOcrPrompt({
        ...request,
        imageUrls: images.map((image) => image.displayUrl)
      })
    },
    ...images.flatMap((image, index) => [
      {
        type: "input_text",
        text: `Image ${index + 1}: ${image.displayUrl}`
      },
      {
        type: "input_image",
        image_url: image.inputUrl,
        detail: "high"
      }
    ])
  ];
}

function parseImageOcrJson(payload: Record<string, unknown>, imageUrls: string[]): ImageTextExtractionResponse {
  return {
    ...parseImageOcrPayloadText(responsesOutputText(payload), imageUrls),
    usage: tokenUsageFromOpenAi(payload.usage)
  };
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

function tokenUsageFromOpenAi(value: unknown): AiTokenUsage | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const usage = value as Record<string, unknown>;
  const inputTokens = numberField(usage.input_tokens) ?? numberField(usage.prompt_tokens);
  const outputTokens = numberField(usage.output_tokens) ?? numberField(usage.completion_tokens);
  const totalTokens = numberField(usage.total_tokens);
  return inputTokens !== undefined || outputTokens !== undefined || totalTokens !== undefined
    ? { inputTokens, outputTokens, totalTokens }
    : undefined;
}

function isUnsupportedTemperatureError(message: string): boolean {
  return /unsupported value[^]*temperature|temperature[^]*(?:unsupported|only the default)/i.test(message);
}

function isQuotaOrBillingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(exceeded your current quota|insufficient_quota|billing|check your plan|rate limit|too many requests)/i.test(message);
}
