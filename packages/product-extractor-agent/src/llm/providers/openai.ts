import { createKeywordClassificationPrompt } from "../prompt";
import type {
  ImageTextExtractionRequest,
  ImageTextExtractionResponse,
  KeywordClassificationRequest,
  KeywordClassificationResponse,
  KeywordClassifier,
  LlmProviderConfig
} from "../types";

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

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: this.config.model,
        input: createKeywordClassificationPrompt(request)
      })
    });

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
      return await this.requestImageOcr(request, directImages);
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
    const response = await fetch("https://api.openai.com/v1/responses", {
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
    });

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

    for (const imageUrl of request.imageUrls) {
      try {
        const direct = await this.requestImageOcr(request, [{ displayUrl: imageUrl, inputUrl: imageUrl }]);
        images.push(...direct.images);
        continue;
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
      ].join("\n")
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
  return jsonMatch ? JSON.parse(jsonMatch[0]) : { keywords: [], summary: "No parseable JSON returned.", rawText };
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
    return { images: [], rawText };
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
    rawText
  };
}

async function downloadImageAsDataUrl(imageUrl: string): Promise<string> {
  const response = await fetch(imageUrl, {
    headers: {
      Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"
    }
  });

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
