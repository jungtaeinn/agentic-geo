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

/** Azure API adapter using deployment-scoped chat completions. */
export class AzureApiKeywordClassifier implements KeywordClassifier {
  constructor(private readonly config: LlmProviderConfig) {}

  async classifyKeywords(request: KeywordClassificationRequest): Promise<KeywordClassificationResponse> {
    const deployment = this.config.deployments?.reasoning ?? this.config.deployment;
    if (!this.config.apiKey || !this.config.endpoint || !deployment) {
      throw new Error("AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, and an Azure reasoning deployment are required.");
    }

    const apiVersion = this.config.apiVersion ?? "2025-04-01-preview";
    const endpoint = this.config.endpoint.replace(/\/$/, "");
    const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
    const prompt = createKeywordClassificationPromptParts(request);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": this.config.apiKey
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user }
        ],
        temperature: 0.1
      })
    });

    if (!response.ok) {
      throw new Error(`Azure keyword classification failed: ${response.status}`);
    }

    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: unknown };
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
      throw new Error("AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, and an Azure OCR deployment are required for image OCR.");
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
    const apiVersion = this.config.apiVersion ?? "2025-04-01-preview";
    const endpoint = this.config.endpoint?.replace(/\/$/, "");
    const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": this.config.apiKey ?? ""
      },
      body: JSON.stringify({
        messages: [
          {
            role: "user",
            content: createImageOcrContent({
              ...request,
              imageUrls: images.map((image) => image.displayUrl)
            }, images)
          }
        ],
        temperature: 0
      })
    });

    if (!response.ok) {
      throw new Error(`Azure image OCR failed: ${response.status}${await responseErrorSuffix(response)}`);
    }

    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: unknown };
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

function tokenUsageFromChatCompletions(value: unknown): AiTokenUsage | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const usage = value as Record<string, unknown>;
  return compactTokenUsage({
    inputTokens: numberField(usage.prompt_tokens),
    outputTokens: numberField(usage.completion_tokens),
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
