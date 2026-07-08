import type { AiTokenUsage } from "../../types";
import type { ImageTextExtractionRequest, ImageTextExtractionResponse } from "../types";

export const IMAGE_DOWNLOAD_TIMEOUT_MS = 60_000;

/** Image payload pair used by vision OCR providers: prompt label vs model input. */
export interface ResolvedImageInput {
  displayUrl: string;
  inputUrl: string;
}

/** Resolves the images a vision OCR request should send, preferring prepared inputs (e.g. tall-image slices). */
export function resolveImageInputs(request: ImageTextExtractionRequest): ResolvedImageInput[] {
  if (request.imageInputs && request.imageInputs.length > 0) {
    return request.imageInputs;
  }
  return request.imageUrls.map((imageUrl) => ({ displayUrl: imageUrl, inputUrl: imageUrl }));
}

/** Parses a base64 data URL into its mime type and payload. */
export function parseDataUrl(dataUrl: string): { mimeType: string; base64: string } | undefined {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/s);
  return match && match[1] && match[2] ? { mimeType: match[1], base64: match[2] } : undefined;
}

/**
 * Builds the optional `temperature` portion of a model request body.
 * Returns an empty object when no temperature is configured so the request omits
 * the field entirely, letting models that only accept their default value (e.g. gpt-5.5) succeed.
 */
export function temperatureBody(temperature: number | undefined): { temperature?: number } {
  return typeof temperature === "number" && Number.isFinite(temperature) ? { temperature } : {};
}

/** Detects provider errors caused by unsupported structured-output/schema request fields. */
export function isUnsupportedStructuredOutputError(message: string): boolean {
  return /(response_format|text\.format|json_schema|response[_ ]?schema|structured outputs?|invalid schema)/i.test(message);
}

/**
 * Extracts the first JSON object from raw model text. Prefers a direct parse
 * (structured outputs return pure JSON), then strips Markdown code fences,
 * then falls back to the widest balanced-looking object match.
 */
export function extractJsonObjectText(rawText: string): string | undefined {
  const text = String(rawText).trim();

  if (text.startsWith("{") && text.endsWith("}")) {
    return text;
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)?.[1]?.trim();
  if (fenced && fenced.startsWith("{")) {
    return fenced;
  }

  return text.match(/\{[\s\S]*\}/)?.[0];
}

interface RawOcrImagePayload {
  index?: unknown;
  imageUrl?: unknown;
  text?: unknown;
  confidence?: unknown;
}

/**
 * Parses model OCR text output into image/text pairs. Maps entries back to the
 * requested image URLs by the 1-based prompt index first, then by echoed URL,
 * then by array position, so mixed-up echoes cannot misattribute text.
 */
export function parseImageOcrPayloadText(rawText: string, imageUrls: string[]): ImageTextExtractionResponse {
  const jsonText = extractJsonObjectText(rawText);

  if (!jsonText) {
    return { images: [], rawText };
  }

  let payload: { images?: RawOcrImagePayload[] };
  try {
    payload = JSON.parse(jsonText) as { images?: RawOcrImagePayload[] };
  } catch {
    return { images: [], rawText };
  }

  const requestedUrls = new Set(imageUrls);
  const images = (payload.images ?? [])
    .map((image, position) => {
      const indexUrl = typeof image.index === "number" && Number.isInteger(image.index)
        ? imageUrls[image.index - 1]
        : undefined;
      const echoedUrl = typeof image.imageUrl === "string" && requestedUrls.has(image.imageUrl)
        ? image.imageUrl
        : undefined;
      const imageUrl = indexUrl ?? echoedUrl ?? (typeof image.imageUrl === "string" && image.imageUrl.length > 0 ? image.imageUrl : imageUrls[position]) ?? "";
      const confidence = typeof image.confidence === "number" && Number.isFinite(image.confidence)
        ? Math.min(1, Math.max(0, image.confidence))
        : undefined;

      return {
        imageUrl,
        text: typeof image.text === "string" ? image.text : "",
        ...(confidence !== undefined ? { confidence } : {})
      };
    })
    .filter((image) => image.imageUrl.length > 0 && image.text.trim().length > 0);

  return { images, rawText };
}

/** Merges token usage entries from multiple provider calls into one total. */
export function mergeTokenUsages(usages: AiTokenUsage[]): AiTokenUsage | undefined {
  const merged = usages.reduce<AiTokenUsage>((total, usage) => ({
    inputTokens: sumOptional(total.inputTokens, usage.inputTokens),
    outputTokens: sumOptional(total.outputTokens, usage.outputTokens),
    totalTokens: sumOptional(total.totalTokens, usage.totalTokens)
  }), {});
  return compactTokenUsage(merged);
}

export function compactTokenUsage(usage: AiTokenUsage): AiTokenUsage | undefined {
  return usage.inputTokens !== undefined || usage.outputTokens !== undefined || usage.totalTokens !== undefined ? usage : undefined;
}

export function sumOptional(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined && right === undefined) {
    return undefined;
  }
  return (left ?? 0) + (right ?? 0);
}

export function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Downloads an image and returns its mime type and base64 payload for inline model input. */
export async function downloadImageAsBase64(imageUrl: string): Promise<{ mimeType: string; base64: string }> {
  const response = await fetchWithTimeout(imageUrl, {
    headers: {
      Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"
    }
  }, IMAGE_DOWNLOAD_TIMEOUT_MS, "Image download for OCR");

  if (!response.ok) {
    throw new Error(`Image download failed: ${response.status}${await responseErrorSuffix(response)}`);
  }

  const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim() || "image/jpeg";

  if (!mimeType.startsWith("image/")) {
    throw new Error(`Image download returned non-image content-type: ${mimeType}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const maxBytes = 10 * 1024 * 1024;

  if (buffer.byteLength > maxBytes) {
    throw new Error(`Image is too large for OCR fallback: ${buffer.byteLength} bytes`);
  }

  return { mimeType, base64: buffer.toString("base64") };
}

/** Downloads an image and returns a base64 data URL for providers that accept data URLs. */
export async function downloadImageAsDataUrl(imageUrl: string): Promise<string> {
  const { mimeType, base64 } = await downloadImageAsBase64(imageUrl);
  return `data:${mimeType};base64,${base64}`;
}

export async function responseErrorSuffix(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned ? ` - ${cleaned.slice(0, 500)}` : "";
}

export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, label: string): Promise<Response> {
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
