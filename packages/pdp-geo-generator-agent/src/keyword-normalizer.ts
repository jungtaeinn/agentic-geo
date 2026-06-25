import type {
  PdpGeoEvidence,
  PdpGeoGeneratorOptions,
  PdpGeoKeywordCorrection,
  PdpGeoKeywordNormalizationRequest,
  PdpGeoKeywordNormalizationResult,
  PdpGeoKeywordNormalizationSettings,
  PdpGeoKeywordNormalizer,
  PdpGeoLocale,
  PdpGeoTokenUsage,
  PdpProductSignal
} from "./types";
import { temperatureBody } from "./copy-refiner";

interface KeywordNormalizationApplication {
  product: PdpProductSignal;
  evidence: PdpGeoEvidence[];
  warnings: string[];
  usage?: PdpGeoTokenUsage;
}

interface ModelBackedKeywordNormalizerConfig {
  provider: Exclude<PdpGeoGeneratorOptions["provider"], undefined>;
  apiKey?: string;
  model?: string;
  endpoint?: string;
  deployment?: string;
  apiVersion?: string;
  temperature?: number;
}

const CHAT_COMPLETIONS_TIMEOUT_MS = 60_000;
const defaultConfidenceThreshold = 0.78;
const defaultMaxKeywords = 16;

export async function normalizeProductReviewKeywords(
  product: PdpProductSignal,
  locale: PdpGeoLocale,
  market: string | undefined,
  options: PdpGeoGeneratorOptions
): Promise<KeywordNormalizationApplication> {
  const evidence: PdpGeoEvidence[] = [];
  const warnings: string[] = [];
  let normalizedProduct = product;
  let usage: PdpGeoTokenUsage | undefined;

  const settings = options.keywordNormalization;
  const resolved = resolveKeywordNormalizer(options);
  if (!resolved.normalizer) {
    if (settings?.enabled && resolved.warning) {
      warnings.push(resolved.warning);
      evidence.push({ field: "reviews.keywords", source: "llm", value: resolved.warning });
    }
    return {
      product: normalizedProduct,
      evidence,
      warnings
    };
  }

  const request = createKeywordNormalizationRequest(normalizedProduct, locale, market, settings);
  if (request.reviewKeywords.length === 0) {
    return {
      product: normalizedProduct,
      evidence,
      warnings
    };
  }

  try {
    const result = await resolved.normalizer.normalizeKeywords(request);
    usage = result.usage;
    const accepted = selectSafeCorrections(
      request.reviewKeywords,
      result.corrections,
      locale,
      settings?.confidenceThreshold ?? defaultConfidenceThreshold
    );

    if (accepted.length > 0) {
      normalizedProduct = applyReviewKeywordCorrections(normalizedProduct, accepted);
      evidence.push({
        field: "reviews.keywords",
        source: "llm",
        value: `Accepted model-backed keyword corrections: ${formatCorrectionSummary(accepted)}`
      });
    }

    warnings.push(...(result.warnings ?? []));
    for (const warning of result.warnings ?? []) {
      evidence.push({ field: "reviews.keywords", source: "llm", value: warning });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Keyword normalization provider failed.";
    warnings.push(message);
    evidence.push({
      field: "reviews.keywords",
      source: "llm",
      value: `Keyword normalization skipped: ${message}`
    });
  }

  return {
    product: normalizedProduct,
    evidence,
    warnings,
    usage
  };
}

export class ModelBackedKeywordNormalizer implements PdpGeoKeywordNormalizer {
  constructor(private readonly config: ModelBackedKeywordNormalizerConfig) {}

  async normalizeKeywords(request: PdpGeoKeywordNormalizationRequest): Promise<PdpGeoKeywordNormalizationResult> {
    switch (this.config.provider) {
      case "openai":
        return this.normalizeWithOpenAI(request);
      case "gemini":
        return this.normalizeWithGemini(request);
      case "azure-openai":
        return this.normalizeWithAzureApi(request);
      case "custom":
      case "mock":
      default:
        return { corrections: [], warnings: [`${this.config.provider} keyword normalization provider has no model-backed adapter.`] };
    }
  }

  private async normalizeWithOpenAI(request: PdpGeoKeywordNormalizationRequest): Promise<PdpGeoKeywordNormalizationResult> {
    if (!this.config.apiKey || !this.config.model) {
      throw new Error("OPENAI_API_KEY and OPENAI_MODEL are required for keyword normalization.");
    }

    const prompt = createKeywordNormalizationPrompt(request);
    const response = await fetch("https://api.openai.com/v1/responses", {
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
    });

    if (!response.ok) {
      throw new Error(`OpenAI keyword normalization failed: ${response.status}`);
    }

    const payloadText = await response.text();
    const payload = JSON.parse(payloadText) as Record<string, unknown>;
    return {
      ...parseKeywordNormalizationJson(payloadText),
      usage: tokenUsageFromOpenAi(payload.usage)
    };
  }

  private async normalizeWithGemini(request: PdpGeoKeywordNormalizationRequest): Promise<PdpGeoKeywordNormalizationResult> {
    if (!this.config.apiKey || !this.config.model) {
      throw new Error("GEMINI_API_KEY and GEMINI_MODEL are required for keyword normalization.");
    }

    const prompt = createKeywordNormalizationPrompt(request);
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${this.config.model}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": this.config.apiKey
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: prompt.system }] },
        contents: [{ role: "user", parts: [{ text: prompt.user }] }]
      })
    });

    if (!response.ok) {
      throw new Error(`Gemini keyword normalization failed: ${response.status}`);
    }

    const payload = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: unknown;
    };
    const rawText = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("\n") ?? "";
    return {
      ...parseKeywordNormalizationJson(rawText),
      usage: tokenUsageFromGemini(payload.usageMetadata)
    };
  }

  private async normalizeWithAzureApi(request: PdpGeoKeywordNormalizationRequest): Promise<PdpGeoKeywordNormalizationResult> {
    if (!this.config.apiKey || !this.config.endpoint || !this.config.deployment) {
      throw new Error("AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, and AZURE_OPENAI_DEPLOYMENT are required for keyword normalization.");
    }

    const apiVersion = this.config.apiVersion ?? "2025-04-01-preview";
    const endpoint = this.config.endpoint.replace(/\/$/, "");
    const url = `${endpoint}/openai/deployments/${this.config.deployment}/chat/completions?api-version=${apiVersion}`;
    const prompt = createKeywordNormalizationPrompt(request);
    const response = await fetchWithTimeout(url, {
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
        ...temperatureBody(this.config.temperature)
      })
    }, CHAT_COMPLETIONS_TIMEOUT_MS, "Azure keyword normalization");

    if (!response.ok) {
      throw new Error(`Azure keyword normalization failed: ${response.status}`);
    }

    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: unknown };
    return {
      ...parseKeywordNormalizationJson(payload.choices?.[0]?.message?.content ?? ""),
      usage: tokenUsageFromChatCompletions(payload.usage)
    };
  }
}

function tokenUsageFromOpenAi(value: unknown): PdpGeoTokenUsage | undefined {
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

function tokenUsageFromGemini(value: unknown): PdpGeoTokenUsage | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const usage = value as Record<string, unknown>;
  return compactTokenUsage({
    inputTokens: numberField(usage.promptTokenCount),
    outputTokens: numberField(usage.candidatesTokenCount),
    totalTokens: numberField(usage.totalTokenCount)
  });
}

function tokenUsageFromChatCompletions(value: unknown): PdpGeoTokenUsage | undefined {
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

function compactTokenUsage(usage: PdpGeoTokenUsage): PdpGeoTokenUsage | undefined {
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

function resolveKeywordNormalizer(options: PdpGeoGeneratorOptions): { normalizer?: PdpGeoKeywordNormalizer; warning?: string } {
  if (options.customKeywordNormalizer) {
    return { normalizer: options.customKeywordNormalizer };
  }

  const settings = options.keywordNormalization;
  if (!settings?.enabled) {
    return {};
  }

  const provider = settings.provider ?? options.provider ?? "mock";
  if (provider === "mock" || provider === "custom") {
    return { warning: `${provider} keyword normalization requires customKeywordNormalizer.` };
  }

  return {
    normalizer: new ModelBackedKeywordNormalizer({
      provider,
      apiKey: settings.apiKey ?? options.apiKey,
      model: settings.model ?? options.model,
      endpoint: settings.endpoint ?? options.endpoint,
      deployment: settings.deployment ?? options.deployment,
      apiVersion: settings.apiVersion ?? options.apiVersion,
      temperature: options.temperature
    })
  };
}

function createKeywordNormalizationRequest(
  product: PdpProductSignal,
  locale: PdpGeoLocale,
  market: string | undefined,
  settings?: PdpGeoKeywordNormalizationSettings
): PdpGeoKeywordNormalizationRequest {
  const maxKeywords = settings?.maxKeywords ?? defaultMaxKeywords;
  return {
    productName: product.name,
    locale,
    market,
    reviewKeywords: unique(product.reviews.keywords).slice(0, maxKeywords),
    reviewBodies: unique(product.reviews.items.map((review) => review.body)).slice(0, 6),
    benefits: unique(product.benefits).slice(0, 8),
    effects: unique(product.effects).slice(0, 8),
    sourceTexts: unique(product.sourceTexts).slice(0, 10)
  };
}

function applyReviewKeywordCorrections(product: PdpProductSignal, corrections: PdpGeoKeywordCorrection[]): PdpProductSignal {
  if (corrections.length === 0) {
    return product;
  }
  const correctionMap = new Map(corrections.map((correction) => [keywordKey(correction.original), cleanKeyword(correction.normalized)]));
  return {
    ...product,
    reviews: {
      ...product.reviews,
      keywords: unique(product.reviews.keywords.map((keyword) => correctionMap.get(keywordKey(keyword)) ?? keyword))
    }
  };
}

function selectSafeCorrections(
  sourceKeywords: string[],
  corrections: PdpGeoKeywordCorrection[],
  locale: PdpGeoLocale,
  confidenceThreshold: number
): PdpGeoKeywordCorrection[] {
  const sourceMap = new Map(sourceKeywords.map((keyword) => [keywordKey(keyword), keyword]));
  const accepted: PdpGeoKeywordCorrection[] = [];

  for (const correction of corrections) {
    const original = sourceMap.get(keywordKey(correction.original));
    const normalized = cleanKeyword(correction.normalized);
    if (!original || !normalized || correction.confidence < confidenceThreshold) {
      continue;
    }
    if (keywordKey(original) === keywordKey(normalized) || !isSafeKeywordCorrection(original, normalized, locale)) {
      continue;
    }
    accepted.push({
      original,
      normalized,
      confidence: correction.confidence,
      reason: correction.reason
    });
  }

  return uniqueCorrections(accepted);
}

function isSafeKeywordCorrection(original: string, normalized: string, locale: PdpGeoLocale): boolean {
  const source = cleanKeyword(original);
  const target = cleanKeyword(normalized);
  if (!target || target.length < 2 || target.length > 32 || /[,/|;:()[\]{}<>]/.test(target) || /https?:\/\//i.test(target)) {
    return false;
  }
  if (target.split(/\s+/).length > 4) {
    return false;
  }
  if (hasMixedLanguageExpansion(source, target)) {
    return false;
  }

  const distance = levenshteinDistance(keywordFingerprint(source), keywordFingerprint(target));
  const limit = correctionDistanceLimit(source, target, locale);
  return distance <= limit;
}

function correctionDistanceLimit(original: string, normalized: string, locale: PdpGeoLocale): number {
  const length = Math.max(keywordFingerprint(original).length, keywordFingerprint(normalized).length);
  if (locale === "ko-KR" || /[가-힣]/.test(`${original}${normalized}`)) {
    return length <= 4 ? 2 : Math.max(2, Math.floor(length * 0.35));
  }
  return length <= 8 ? 2 : Math.max(2, Math.floor(length * 0.25));
}

function hasMixedLanguageExpansion(original: string, normalized: string): boolean {
  const sourceHasKorean = /[가-힣]/.test(original);
  const targetHasKorean = /[가-힣]/.test(normalized);
  const sourceHasLatin = /[A-Za-z]/.test(original);
  const targetHasLatin = /[A-Za-z]/.test(normalized);
  return (sourceHasKorean && targetHasLatin && !sourceHasLatin) || (sourceHasLatin && targetHasKorean && !sourceHasKorean);
}

function createKeywordNormalizationPrompt(request: PdpGeoKeywordNormalizationRequest): { system: string; user: string } {
  return {
    system: [
      "You are a conservative typo-normalization agent for product review keywords.",
      "Return strict JSON only: {\"corrections\":[{\"original\":\"\",\"normalized\":\"\",\"confidence\":0.0,\"reason\":\"\"}],\"warnings\":[]}.",
      "Only correct obvious typos, OCR mistakes, keyboard-adjacent mistakes, or spacing mistakes in the original keyword language.",
      "Do not translate, expand, summarize, add new claims, add new benefits, or rewrite a keyword into marketing copy.",
      "If uncertain, omit the correction. Keep normalized keywords concise and source-backed."
    ].join("\n"),
    user: JSON.stringify({
      task: "Normalize only misspelled review keywords. Leave valid keywords unchanged by omitting them from corrections.",
      productName: request.productName,
      locale: request.locale,
      market: request.market,
      reviewKeywords: request.reviewKeywords,
      context: {
        reviewBodies: request.reviewBodies,
        benefits: request.benefits,
        effects: request.effects,
        sourceTexts: request.sourceTexts
      }
    }, null, 2)
  };
}

function parseKeywordNormalizationJson(text: string): PdpGeoKeywordNormalizationResult {
  const rawText = parseProviderText(text);
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { corrections: [], warnings: ["No parseable keyword normalization JSON returned."], rawText };
  }

  const payload = JSON.parse(jsonMatch[0]) as Partial<PdpGeoKeywordNormalizationResult>;
  return {
    corrections: Array.isArray(payload.corrections)
      ? payload.corrections
        .map(normalizeCorrection)
        .filter((correction): correction is PdpGeoKeywordCorrection => Boolean(correction))
      : [],
    warnings: Array.isArray(payload.warnings) ? payload.warnings.map(String).filter(Boolean) : undefined,
    rawText
  };
}

function parseProviderText(text: string): string {
  try {
    const parsed = JSON.parse(text) as {
      output_text?: string;
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    return parsed.output_text
      ?? parsed.output?.flatMap((item) => item.content ?? []).map((item) => item.text ?? "").join("\n")
      ?? text;
  } catch {
    return text;
  }
}

function normalizeCorrection(value: unknown): PdpGeoKeywordCorrection | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const original = typeof value.original === "string" ? cleanKeyword(value.original) : "";
  const normalized = typeof value.normalized === "string" ? cleanKeyword(value.normalized) : "";
  const confidence = typeof value.confidence === "number" ? value.confidence : Number(value.confidence);
  if (!original || !normalized || !Number.isFinite(confidence)) {
    return undefined;
  }
  return {
    original,
    normalized,
    confidence,
    reason: typeof value.reason === "string" ? value.reason : undefined
  };
}

function formatCorrectionSummary(corrections: PdpGeoKeywordCorrection[]): string {
  return corrections.map((correction) => `${correction.original} -> ${correction.normalized}`).join(", ");
}

function uniqueCorrections(corrections: PdpGeoKeywordCorrection[]): PdpGeoKeywordCorrection[] {
  const seen = new Set<string>();
  return corrections.filter((correction) => {
    const key = `${keywordKey(correction.original)}:${keywordKey(correction.normalized)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function keywordFingerprint(value: string): string {
  return cleanKeyword(value).toLowerCase().replace(/[^a-z0-9가-힣ぁ-んァ-ン一-龯]+/gi, "");
}

function keywordKey(value: string): string {
  return cleanKeyword(value).toLowerCase();
}

function cleanKeyword(value: string): string {
  return value.replace(/\s+/g, " ").replace(/\s+([,.!?。！？])/g, "$1").trim();
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map(cleanKeyword).filter(Boolean)));
}

function levenshteinDistance(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  if (!left) {
    return right.length;
  }
  if (!right) {
    return left.length;
  }

  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  const current = Array.from({ length: right.length + 1 }, () => 0);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    current[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      const insertion = (current[rightIndex - 1] ?? 0) + 1;
      const deletion = (previous[rightIndex] ?? 0) + 1;
      const substitution = (previous[rightIndex - 1] ?? 0) + cost;
      current[rightIndex] = Math.min(
        insertion,
        deletion,
        substitution
      );
    }
    for (let index = 0; index < previous.length; index += 1) {
      previous[index] = current[index] ?? 0;
    }
  }

  return previous[right.length] ?? 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
