import { createImageOcrPrompt, createKeywordClassificationPromptParts } from "../prompt";
import { geminiImageOcrResponseSchema, geminiKeywordClassificationResponseSchema } from "../schemas";
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
  downloadImageAsBase64,
  extractJsonObjectText,
  fetchWithTimeout,
  isUnsupportedStructuredOutputError,
  numberField,
  parseDataUrl,
  parseImageOcrPayloadText,
  resolveImageInputs,
  responseErrorSuffix,
  temperatureBody
} from "./shared";

const GENERATE_CONTENT_TIMEOUT_MS = 300_000;

type GeminiPayload = {
  candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  usageMetadata?: unknown;
};

type GeminiGenerationConfig = {
  responseMimeType?: string;
  responseSchema?: Record<string, unknown>;
  temperature?: number;
};

/** Gemini generateContent adapter for OCR keyword classification and vision OCR. */
export class GeminiKeywordClassifier implements KeywordClassifier {
  constructor(private readonly config: LlmProviderConfig) {}

  async classifyKeywords(request: KeywordClassificationRequest): Promise<KeywordClassificationResponse> {
    if (!this.config.apiKey) {
      throw new Error("GEMINI_API_KEY is required for the Gemini keyword classifier.");
    }
    if (!this.config.model) {
      throw new Error("GEMINI_MODEL is required for the Gemini keyword classifier.");
    }

    const prompt = createKeywordClassificationPromptParts(request);
    const payload = await this.requestGenerateContent({
      systemInstruction: { parts: [{ text: prompt.system }] },
      contents: [{ role: "user", parts: [{ text: prompt.user }] }],
      generationConfig: this.createGenerationConfig(geminiKeywordClassificationResponseSchema)
    }, "Gemini keyword classification");

    const rawText = geminiOutputText(payload);
    const jsonText = extractJsonObjectText(rawText);
    const result = jsonText ? JSON.parse(jsonText) as KeywordClassificationResponse : { keywords: [], summary: "No parseable JSON returned.", rawText };
    return {
      ...result,
      usage: tokenUsageFromGemini(payload.usageMetadata)
    };
  }

  /**
   * Vision OCR via inline base64 image parts. Gemini does not fetch remote
   * image URLs, so every target is downloaded first; images that fail to
   * download are skipped and reported through rawText.
   */
  async extractImageTexts(request: ImageTextExtractionRequest): Promise<ImageTextExtractionResponse> {
    if (!this.config.apiKey) {
      throw new Error("GEMINI_API_KEY is required for Gemini image OCR.");
    }
    if (!this.config.model) {
      throw new Error("GEMINI_MODEL is required for Gemini image OCR.");
    }

    const inlineImages: Array<{ imageUrl: string; mimeType: string; base64: string }> = [];
    const errors: string[] = [];

    for (const input of resolveImageInputs(request)) {
      try {
        const inline = parseDataUrl(input.inputUrl) ?? await downloadImageAsBase64(input.inputUrl);
        inlineImages.push({ imageUrl: input.displayUrl, mimeType: inline.mimeType, base64: inline.base64 });
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    if (inlineImages.length === 0) {
      throw new Error(`Gemini image OCR could not download any image: ${errors.slice(0, 2).join(" | ") || "no images"}`);
    }

    const displayUrls = inlineImages.map((image) => image.imageUrl);
    const payload = await this.requestGenerateContent({
      contents: [
        {
          role: "user",
          parts: [
            { text: createImageOcrPrompt({ ...request, imageUrls: displayUrls }) },
            ...inlineImages.flatMap((image, index) => [
              { text: `Image ${index + 1}: ${image.imageUrl}` },
              { inline_data: { mime_type: image.mimeType, data: image.base64 } }
            ])
          ]
        }
      ],
      generationConfig: this.createGenerationConfig(geminiImageOcrResponseSchema as Record<string, unknown>)
    }, "Gemini image OCR");

    const parsed = parseImageOcrPayloadText(geminiOutputText(payload), displayUrls);
    return {
      ...parsed,
      rawText: [parsed.rawText, ...errors].filter(Boolean).join("\n"),
      usage: tokenUsageFromGemini(payload.usageMetadata)
    };
  }

  private createGenerationConfig(responseSchema: Record<string, unknown>): GeminiGenerationConfig {
    return {
      responseMimeType: "application/json",
      responseSchema,
      ...temperatureBody(this.config.temperature)
    };
  }

  /**
   * Posts a generateContent body, retrying once without responseSchema when the
   * target model rejects structured output so older Gemini models keep working.
   */
  private async requestGenerateContent(body: Record<string, unknown>, label: string): Promise<GeminiPayload> {
    let currentBody = body;
    let response = await this.postGenerateContent(currentBody, label);

    if (!response.ok) {
      const suffix = await responseErrorSuffix(response);
      const generationConfig = currentBody.generationConfig as GeminiGenerationConfig | undefined;

      if (generationConfig?.responseSchema && isUnsupportedStructuredOutputError(suffix)) {
        const { responseSchema: _responseSchema, ...retryConfig } = generationConfig;
        currentBody = { ...currentBody, generationConfig: retryConfig };
        response = await this.postGenerateContent(currentBody, label);
      } else {
        throw new Error(`${label} failed: ${response.status}${suffix}`);
      }
    }

    if (!response.ok) {
      throw new Error(`${label} failed: ${response.status}${await responseErrorSuffix(response)}`);
    }

    return await response.json() as GeminiPayload;
  }

  private postGenerateContent(body: Record<string, unknown>, label: string): Promise<Response> {
    return fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${this.config.model}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": this.config.apiKey ?? ""
      },
      body: JSON.stringify(body)
    }, GENERATE_CONTENT_TIMEOUT_MS, label);
  }
}

function geminiOutputText(payload: GeminiPayload): string {
  return payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("\n") ?? "";
}

function tokenUsageFromGemini(value: unknown): AiTokenUsage | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const usage = value as Record<string, unknown>;
  const result: AiTokenUsage = {
    inputTokens: numberField(usage.promptTokenCount),
    outputTokens: numberField(usage.candidatesTokenCount),
    totalTokens: numberField(usage.totalTokenCount)
  };
  return result.inputTokens !== undefined || result.outputTokens !== undefined || result.totalTokens !== undefined ? result : undefined;
}
