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

const RESPONSES_TIMEOUT_MS = 300_000;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 60_000;

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
    const response = await fetchWithTimeout("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.config.model,
        instructions: prompt.system,
        input: prompt.user
      })
    }, RESPONSES_TIMEOUT_MS, "OpenAI keyword classification");

    if (!response.ok) {
      throw new Error(`OpenAI keyword classification failed: ${response.status}`);
    }

    return parseProviderJson(await response.text());
  }

  async extractImageTexts(request: ImageTextExtractionRequest): Promise<ImageTextExtractionResponse> {
    if (!this.config.apiKey) {
      throw new Error("OPENAI_API_KEY is required for OpenAI image OCR.");
    }
    if (!this.config.model) {
      throw new Error("OPENAI_MODEL is required for OpenAI image OCR.");
    }

    const directImages = request.imageUrls.map((imageUrl) => ({
      displayUrl: imageUrl,
      inputUrl: imageUrl
    }));

    try {
      const direct = await this.requestImageOcr(request, directImages);
      const missingImageUrls = imageUrlsWithoutExtractedText(request.imageUrls, direct.images);

      if (missingImageUrls.length === 0) {
        return direct;
      }

      const fallback = await this.extractImageTextsWithDownloadedImages(
        { ...request, imageUrls: missingImageUrls },
        new Error(`${missingImageUrls.length} remote image OCR result(s) returned no readable text.`)
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
    const response = await fetchWithTimeout("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.config.model,
        input: [
          {
            role: "user",
            content
          }
        ]
      })
    }, RESPONSES_TIMEOUT_MS, "OpenAI image OCR");

    if (!response.ok) {
      throw new Error(`OpenAI image OCR failed: ${response.status}${await responseErrorSuffix(response)}`);
    }

    return parseImageOcrJson(await response.text(), images.map((image) => image.displayUrl));
  }

  private async extractImageTextsWithDownloadedImages(
    request: ImageTextExtractionRequest,
    directError: unknown
  ): Promise<ImageTextExtractionResponse> {
    const images: ImageTextExtractionResponse["images"] = [];
    const errors: string[] = [];
    const usages: AiTokenUsage[] = [];

    for (const imageUrl of request.imageUrls) {
      try {
        const direct = await this.requestImageOcr(request, [{ displayUrl: imageUrl, inputUrl: imageUrl }]);
        if (direct.images.length > 0) {
          images.push(...direct.images);
          if (direct.usage) {
            usages.push(direct.usage);
          }
          continue;
        }
        errors.push(direct.rawText ? `Remote image OCR returned no readable text: ${direct.rawText.slice(0, 240)}` : "Remote image OCR returned no readable text.");
      } catch (error) {
        if (isQuotaOrBillingError(error)) {
          throw error;
        }
        errors.push(error instanceof Error ? error.message : String(error));
      }

      try {
        const dataUrl = await downloadImageAsDataUrl(imageUrl);
        const extracted = await this.requestImageOcr(request, [{ displayUrl: imageUrl, inputUrl: dataUrl }]);
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

function parseProviderJson(text: string): KeywordClassificationResponse {
  const parsed = JSON.parse(text);
  const rawText =
    parsed.output_text ??
    parsed.output?.flatMap((item: { content?: Array<{ text?: string }> }) => item.content ?? []).map((item: { text?: string }) => item.text).join("\n") ??
    text;
  const jsonMatch = String(rawText).match(/\{[\s\S]*\}/);
  const result = jsonMatch ? JSON.parse(jsonMatch[0]) as KeywordClassificationResponse : { keywords: [], summary: "No parseable JSON returned.", rawText };
  return {
    ...result,
    usage: tokenUsageFromOpenAi(parsed.usage)
  };
}

function createImageOcrPrompt(request: ImageTextExtractionRequest): string {
  return [
    "Extract visible text from product detail page images for a GEO product extraction pipeline.",
    "Return strict JSON only: {\"images\":[{\"imageUrl\":\"\",\"text\":\"\"}]}",
    "Do not summarize, rewrite, translate, or infer claims.",
    "Preserve visible line order, percentages, footnote markers, and short headings as plain text.",
    "For clinical result images, keep rows like headings, claims, and percentages together.",
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
        image_url: image.inputUrl
      }
    ])
  ];
}

function parseImageOcrJson(text: string, imageUrls: string[]): ImageTextExtractionResponse {
  const parsed = JSON.parse(text);
  const rawText =
    parsed.output_text ??
    parsed.output?.flatMap((item: { content?: Array<{ text?: string }> }) => item.content ?? []).map((item: { text?: string }) => item.text).join("\n") ??
    text;
  const jsonMatch = String(rawText).match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    return { images: [], rawText, usage: tokenUsageFromOpenAi(parsed.usage) };
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
    rawText,
    usage: tokenUsageFromOpenAi(parsed.usage)
  };
}

function imageUrlsWithoutExtractedText(requestedImageUrls: string[], extractedImages: ImageTextExtractionResponse["images"]): string[] {
  const extractedUrls = new Set(extractedImages.map((image) => image.imageUrl));
  return requestedImageUrls.filter((imageUrl) => !extractedUrls.has(imageUrl));
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
  return compactTokenUsage({
    inputTokens: numberField(usage.input_tokens) ?? numberField(usage.prompt_tokens),
    outputTokens: numberField(usage.output_tokens) ?? numberField(usage.completion_tokens),
    totalTokens: numberField(usage.total_tokens)
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

function isQuotaOrBillingError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(exceeded your current quota|insufficient_quota|billing|check your plan|rate limit|too many requests)/i.test(message);
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
