import { temperatureBody } from "./llm/providers/azure-openai";
import type { AzureRoleDeployments } from "./llm/types";
import type {
  AiTokenUsage,
  ExtractionEvidence,
  ProductContentCategory,
  ProductExtractorProductNormalizationRequest,
  ProductExtractorProductNormalizationResult,
  ProductExtractorProductNormalizer,
  ProductExtractorProductNormalizationSettings,
  ProductExtractionInput,
  ProductProfile
} from "./types";

interface ProductNormalizerRuntimeOptions {
  provider?: ProductExtractionInput["aiProvider"];
  apiKey?: string;
  model?: string;
  endpoint?: string;
  deployment?: string;
  deployments?: AzureRoleDeployments;
  apiVersion?: string;
  temperature?: number;
  analysisPrompt?: string;
  ragDocuments?: Array<{
    name: string;
    content: string;
    version?: string;
  }>;
  productNormalization?: ProductExtractorProductNormalizationSettings;
  customProductNormalizer?: ProductExtractorProductNormalizer;
}

interface ProductProfileNormalizationApplication {
  product: ProductProfile;
  evidence: ExtractionEvidence[];
  warnings: string[];
  usage?: AiTokenUsage;
  called: boolean;
  applied: boolean;
}

interface ModelBackedProductProfileNormalizerConfig {
  provider: Exclude<ProductExtractionInput["aiProvider"], undefined>;
  apiKey?: string;
  model?: string;
  endpoint?: string;
  deployment?: string;
  apiVersion?: string;
  temperature?: number;
  maxSourceCharacters?: number;
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

const defaultMaxRagDocuments = 8;
const defaultMaxSourceCharacters = 35_000;

export async function normalizeExtractorProductProfileWithAgent(
  request: ProductExtractorProductNormalizationRequest,
  options: ProductNormalizerRuntimeOptions
): Promise<ProductProfileNormalizationApplication> {
  const resolved = resolveProductProfileNormalizer(options);
  const baseApplication: ProductProfileNormalizationApplication = {
    product: request.bootstrapProduct,
    evidence: [],
    warnings: [],
    called: false,
    applied: false
  };

  if (!resolved.normalizer) {
    if (resolved.warning) {
      baseApplication.warnings.push(resolved.warning);
      baseApplication.evidence.push({
        field: "product.normalization",
        source: "llm",
        value: `Product profile normalization skipped: ${resolved.warning}`
      });
    }
    return baseApplication;
  }

  try {
    const result = await resolved.normalizer.normalizeProductProfile({
      ...request,
      ragDocuments: (request.ragDocuments ?? []).slice(0, options.productNormalization?.maxRagDocuments ?? defaultMaxRagDocuments)
    });
    const applied = applyProductProfileNormalization(request.bootstrapProduct, result, request.rawSource);
    const warnings = [
      ...(result.warnings ?? []),
      ...applied.warnings
    ];
    const evidence = [...applied.evidence];

    if (applied.applied) {
      evidence.push({
        field: "product.normalization",
        source: "llm",
        value: `Model-backed product profile normalization updated: ${applied.changedFields.join(", ")}`
      });
    } else {
      evidence.push({
        field: "product.normalization",
        source: "llm",
        value: "Model-backed product profile normalization returned no accepted source-backed field changes."
      });
    }

    for (const warning of warnings) {
      evidence.push({ field: "product.normalization.warning", source: "llm", value: warning });
    }

    return {
      product: applied.product,
      evidence,
      warnings,
      usage: result.usage,
      called: true,
      applied: applied.applied
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Product profile normalization provider failed.";
    return {
      ...baseApplication,
      evidence: [{ field: "product.normalization", source: "llm", value: `Product profile normalization skipped: ${message}` }],
      warnings: [message],
      called: true
    };
  }
}

export class ModelBackedProductProfileNormalizer implements ProductExtractorProductNormalizer {
  constructor(private readonly config: ModelBackedProductProfileNormalizerConfig) {}

  async normalizeProductProfile(request: ProductExtractorProductNormalizationRequest): Promise<ProductExtractorProductNormalizationResult> {
    switch (this.config.provider) {
      case "openai":
        return this.normalizeWithOpenAI(request);
      case "gemini":
        return this.normalizeWithGemini(request);
      case "azure-openai":
        return this.normalizeWithAzureApi(request);
      case "mock":
      default:
        return { warnings: [`${this.config.provider} product profile normalization provider has no model-backed adapter.`] };
    }
  }

  private async normalizeWithOpenAI(request: ProductExtractorProductNormalizationRequest): Promise<ProductExtractorProductNormalizationResult> {
    if (!this.config.apiKey || !this.config.model) {
      throw new Error("OPENAI_API_KEY and OPENAI_MODEL are required for product profile normalization.");
    }

    const prompt = createProductProfileNormalizationPrompt(request, this.config.maxSourceCharacters);
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
      throw new Error(`OpenAI product profile normalization failed: ${response.status}`);
    }

    const payloadText = await response.text();
    const payload = JSON.parse(payloadText) as Record<string, unknown>;
    return {
      ...parseProductProfileNormalizationJson(payloadText),
      usage: tokenUsageFromOpenAi(payload.usage)
    };
  }

  private async normalizeWithGemini(request: ProductExtractorProductNormalizationRequest): Promise<ProductExtractorProductNormalizationResult> {
    if (!this.config.apiKey || !this.config.model) {
      throw new Error("GEMINI_API_KEY and GEMINI_MODEL are required for product profile normalization.");
    }

    const prompt = createProductProfileNormalizationPrompt(request, this.config.maxSourceCharacters);
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
      throw new Error(`Gemini product profile normalization failed: ${response.status}`);
    }

    const payload = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: unknown;
    };
    const rawText = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("\n") ?? "";
    return {
      ...parseProductProfileNormalizationJson(rawText),
      usage: tokenUsageFromGemini(payload.usageMetadata)
    };
  }

  private async normalizeWithAzureApi(request: ProductExtractorProductNormalizationRequest): Promise<ProductExtractorProductNormalizationResult> {
    if (!this.config.apiKey || !this.config.endpoint || !this.config.deployment) {
      throw new Error("AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, and AZURE_OPENAI_DEPLOYMENT are required for product profile normalization.");
    }

    const apiVersion = this.config.apiVersion ?? "2025-04-01-preview";
    const endpoint = this.config.endpoint.replace(/\/$/, "");
    const url = `${endpoint}/openai/deployments/${this.config.deployment}/chat/completions?api-version=${apiVersion}`;
    const prompt = createProductProfileNormalizationPrompt(request, this.config.maxSourceCharacters);
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
        ...temperatureBody(this.config.temperature)
      })
    });

    if (!response.ok) {
      throw new Error(`Azure product profile normalization failed: ${response.status}`);
    }

    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: unknown };
    return {
      ...parseProductProfileNormalizationJson(payload.choices?.[0]?.message?.content ?? ""),
      usage: tokenUsageFromChatCompletions(payload.usage)
    };
  }
}

function resolveProductProfileNormalizer(options: ProductNormalizerRuntimeOptions): { normalizer?: ProductExtractorProductNormalizer; warning?: string } {
  if (options.customProductNormalizer) {
    return { normalizer: options.customProductNormalizer };
  }

  const settings = options.productNormalization;
  if (!settings?.enabled) {
    return {};
  }

  const provider = settings.provider ?? options.provider ?? "mock";
  if (provider === "mock") {
    return { warning: "mock product profile normalization requires customProductNormalizer." };
  }

  return {
    normalizer: new ModelBackedProductProfileNormalizer({
      provider,
      apiKey: settings.apiKey ?? options.apiKey,
      model: settings.model ?? options.model,
      endpoint: settings.endpoint ?? options.endpoint,
      deployment: settings.deployment ?? options.deployments?.reasoning ?? options.deployment,
      apiVersion: settings.apiVersion ?? options.apiVersion,
      temperature: options.temperature,
      maxSourceCharacters: settings.maxSourceCharacters
    })
  };
}

function createProductProfileNormalizationPrompt(
  request: ProductExtractorProductNormalizationRequest,
  maxSourceCharacters = defaultMaxSourceCharacters
): { system: string; user: string } {
  return {
    system: [
      "You are a conservative product extraction normalization agent.",
      "Return strict JSON only: {\"product\":{},\"warnings\":[]}.",
      "Infer ProductProfile fields from raw source data, bootstrap ProductProfile, and RAG policy documents.",
      "Your job is source-backed field routing, not public copywriting.",
      "Use source product data only. Do not invent claims, ingredients, effects, prices, reviews, metrics, awards, or certifications.",
      "Prefer complete source-backed sentences over isolated tokens. Keep benefit, effect, ingredient, usage, FAQ, metric, option, and image fields separated.",
      "Use RAG policy to resolve overlaps: commerce UI, coupon, delivery, exchange, refund, return, legal, and page chrome text must not become product evidence.",
      "If the bootstrap value is safer or better supported than your inferred value, return the bootstrap value or omit the field."
    ].join("\n"),
    user: JSON.stringify(createProductProfileNormalizationPayload(request, maxSourceCharacters), null, 2)
  };
}

function createProductProfileNormalizationPayload(
  request: ProductExtractorProductNormalizationRequest,
  maxSourceCharacters: number
): JsonValue {
  return {
    task: "Infer a source-backed ProductProfile with fewer hardcoded field assumptions.",
    source: request.source,
    sourceType: request.sourceType,
    bootstrapProduct: toJsonValue(request.bootstrapProduct),
    rawSource: trimJsonForPrompt(request.rawSource, maxSourceCharacters),
    ragPolicy: [
      request.analysisPrompt ? { name: "analysis-prompt", content: request.analysisPrompt.slice(0, 2400) } : undefined,
      ...(request.ragDocuments ?? []).map((document) => ({
        name: document.name,
        version: document.version ?? null,
        content: document.content.slice(0, 2400)
      }))
    ].filter(Boolean) as JsonValue
  };
}

function applyProductProfileNormalization(
  bootstrapProduct: ProductProfile,
  result: ProductExtractorProductNormalizationResult,
  rawSource: unknown
): {
  product: ProductProfile;
  evidence: ExtractionEvidence[];
  warnings: string[];
  changedFields: string[];
  applied: boolean;
} {
  const sourceCorpus = createSourceCorpus(rawSource, bootstrapProduct);
  const incoming = result.product ?? {};
  const evidence: ExtractionEvidence[] = [];
  const warnings: string[] = [];
  const changedFields: string[] = [];
  const next: ProductProfile = {
    ...bootstrapProduct,
    images: [...bootstrapProduct.images],
    options: [...bootstrapProduct.options],
    benefits: [...bootstrapProduct.benefits],
    effects: [...bootstrapProduct.effects],
    ingredients: [...bootstrapProduct.ingredients],
    usage: [...bootstrapProduct.usage],
    metrics: [...bootstrapProduct.metrics],
    faq: [...bootstrapProduct.faq],
    contentSections: [...bootstrapProduct.contentSections]
  };

  applyStringField(next, "name", incoming.name, sourceCorpus, changedFields, warnings);
  applyStringField(next, "description", incoming.description, sourceCorpus, changedFields, warnings);
  applyStringField(next, "price", incoming.price, sourceCorpus, changedFields, warnings);
  applyStringField(next, "currency", incoming.currency, sourceCorpus, changedFields, warnings);
  applyStringArrayField(next, "images", incoming.images, sourceCorpus, changedFields, warnings, { allowUrlLike: true });
  applyStringArrayField(next, "options", incoming.options, sourceCorpus, changedFields, warnings);
  applyStringArrayField(next, "benefits", incoming.benefits, sourceCorpus, changedFields, warnings);
  applyStringArrayField(next, "effects", incoming.effects, sourceCorpus, changedFields, warnings);
  applyStringArrayField(next, "ingredients", incoming.ingredients, sourceCorpus, changedFields, warnings);
  applyStringArrayField(next, "usage", incoming.usage, sourceCorpus, changedFields, warnings);
  applyStringArrayField(next, "metrics", incoming.metrics, sourceCorpus, changedFields, warnings, { allowShortOverlap: true });

  if (Array.isArray(incoming.faq)) {
    const faq = incoming.faq.flatMap((item) => {
      const question = sourceBackedString(item.question, sourceCorpus);
      const answer = sourceBackedString(item.answer, sourceCorpus);
      return question && answer ? [{ question, answer }] : [];
    });
    if (faq.length > 0) {
      next.faq = uniqueBy(faq, (item) => `${item.question}\n${item.answer}`).slice(0, 12);
      changedFields.push("faq");
    } else if (incoming.faq.length > 0) {
      warnings.push("Model FAQ normalization was rejected because question/answer evidence was not source-backed.");
    }
  }

  if (Array.isArray(incoming.contentSections)) {
    const sections = incoming.contentSections.flatMap((item) => {
      const title = sourceBackedString(item.title, sourceCorpus) ?? cleanString(item.title);
      const text = sourceBackedString(item.text, sourceCorpus);
      const category = isProductContentCategory(item.category) ? item.category : "unknown";
      const bullets = Array.isArray(item.bullets) ? sourceBackedStringArray(item.bullets, sourceCorpus) : [];
      return title && text ? [{ title, category, text, bullets }] : [];
    });
    if (sections.length > 0) {
      next.contentSections = uniqueBy(sections, (item) => `${item.category}\n${item.title}\n${item.text}`).slice(0, 24);
      changedFields.push("contentSections");
    } else if (incoming.contentSections.length > 0) {
      warnings.push("Model contentSections normalization was rejected because section text evidence was not source-backed.");
    }
  }

  for (const field of unique(changedFields)) {
    evidence.push({ field: `product.${field}`, source: "llm", value: "Accepted source-backed model normalization." });
  }

  return {
    product: next,
    evidence,
    warnings,
    changedFields: unique(changedFields),
    applied: changedFields.length > 0
  };
}

function applyStringField<T extends keyof Pick<ProductProfile, "name" | "description" | "price" | "currency">>(
  product: ProductProfile,
  field: T,
  value: unknown,
  sourceCorpus: string,
  changedFields: string[],
  warnings: string[]
) {
  const accepted = sourceBackedString(value, sourceCorpus);
  if (!accepted) {
    if (typeof value === "string" && value.trim()) {
      warnings.push(`Model ${field} normalization was rejected because it was not source-backed.`);
    }
    return;
  }
  if (accepted !== product[field]) {
    product[field] = accepted as ProductProfile[T];
    changedFields.push(field);
  }
}

function applyStringArrayField<T extends keyof Pick<ProductProfile, "images" | "options" | "benefits" | "effects" | "ingredients" | "usage" | "metrics">>(
  product: ProductProfile,
  field: T,
  value: unknown,
  sourceCorpus: string,
  changedFields: string[],
  warnings: string[],
  options: { allowUrlLike?: boolean; allowShortOverlap?: boolean } = {}
) {
  if (!Array.isArray(value)) {
    return;
  }
  const accepted = sourceBackedStringArray(value, sourceCorpus, options);
  if (accepted.length > 0) {
    product[field] = accepted as ProductProfile[T];
    changedFields.push(field);
  } else if (value.length > 0) {
    warnings.push(`Model ${field} normalization was rejected because no values were source-backed.`);
  }
}

function parseProductProfileNormalizationJson(rawText: string): ProductExtractorProductNormalizationResult {
  const jsonText = jsonTextFromProviderPayload(rawText);
  if (!jsonText) {
    return { warnings: ["No parseable product profile normalization JSON returned."], rawText };
  }

  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    const warnings = Array.isArray(parsed.warnings)
      ? parsed.warnings.flatMap((item) => {
          const warning = cleanString(item);
          return warning ? [warning] : [];
        })
      : [];
    return {
      product: normalizePartialProductProfile(parsed.product),
      warnings,
      rawText
    };
  } catch {
    return { warnings: ["Product profile normalization JSON could not be parsed."], rawText };
  }
}

function jsonTextFromProviderPayload(rawText: string): string | undefined {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const payload = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof payload.output_text === "string") {
      return payload.output_text;
    }
    const output = Array.isArray(payload.output) ? payload.output : [];
    const text = output
      .flatMap((item) => typeof item === "object" && item && "content" in item ? (item as { content?: unknown }).content : [])
      .flatMap((content) => Array.isArray(content) ? content : [content])
      .map((content) => typeof content === "object" && content && "text" in content ? String((content as { text?: unknown }).text ?? "") : "")
      .join("\n");
    if (text.trim()) {
      return text;
    }
  } catch {
    // Fall through to direct JSON extraction.
  }
  return trimmed.match(/\{[\s\S]*\}/)?.[0];
}

function normalizePartialProductProfile(value: unknown): Partial<ProductProfile> | undefined {
  return value && typeof value === "object" ? value as Partial<ProductProfile> : undefined;
}

function sourceBackedStringArray(values: unknown[], sourceCorpus: string, options: { allowUrlLike?: boolean; allowShortOverlap?: boolean } = {}): string[] {
  return unique(values.flatMap((value) => {
    const accepted = sourceBackedString(value, sourceCorpus, options);
    return accepted ? [accepted] : [];
  }));
}

function sourceBackedString(value: unknown, sourceCorpus: string, options: { allowUrlLike?: boolean; allowShortOverlap?: boolean } = {}): string | undefined {
  const text = cleanString(value);
  if (!text) {
    return undefined;
  }
  if (options.allowUrlLike && /^https?:\/\//i.test(text)) {
    return text;
  }
  const normalizedCorpus = normalizeEvidenceText(sourceCorpus);
  const normalizedText = normalizeEvidenceText(text);
  if (normalizedCorpus.includes(normalizedText)) {
    return text;
  }
  if ((options.allowShortOverlap || text.length >= 12) && tokenOverlapRatio(text, sourceCorpus) >= 0.66) {
    return text;
  }
  return undefined;
}

function createSourceCorpus(rawSource: unknown, bootstrapProduct: ProductProfile): string {
  return unique([
    ...flattenTextValues(rawSource),
    bootstrapProduct.name,
    bootstrapProduct.price,
    bootstrapProduct.currency,
    bootstrapProduct.description,
    ...bootstrapProduct.images,
    ...bootstrapProduct.options,
    ...bootstrapProduct.benefits,
    ...bootstrapProduct.effects,
    ...bootstrapProduct.ingredients,
    ...bootstrapProduct.usage,
    ...bootstrapProduct.metrics,
    ...bootstrapProduct.faq.flatMap((item) => [item.question, item.answer]),
    ...bootstrapProduct.contentSections.flatMap((item) => [item.title, item.text, ...item.bullets])
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0)).join("\n");
}

function trimJsonForPrompt(value: unknown, maxCharacters: number): JsonValue {
  const text = JSON.stringify(toJsonValue(value), null, 2);
  if (text.length <= maxCharacters) {
    return toJsonValue(value);
  }
  return {
    truncated: true,
    text: text.slice(0, maxCharacters)
  };
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 80).map(toJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 200).map(([key, item]) => [key, toJsonValue(item)]));
  }
  return String(value ?? "");
}

function flattenTextValues(value: unknown): string[] {
  if (typeof value === "string") {
    const text = cleanString(value);
    return text ? [text] : [];
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap(flattenTextValues);
  }
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap(flattenTextValues);
  }
  return [];
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

function tokenUsageFromGemini(value: unknown): AiTokenUsage | undefined {
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

function compactTokenUsage(usage: AiTokenUsage): AiTokenUsage | undefined {
  return usage.inputTokens !== undefined || usage.outputTokens !== undefined || usage.totalTokens !== undefined ? usage : undefined;
}

function sumOptional(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined && right === undefined) {
    return undefined;
  }
  return (left ?? 0) + (right ?? 0);
}

function tokenOverlapRatio(value: string, corpus: string): number {
  const tokens = tokenize(value);
  if (tokens.length === 0) {
    return 0;
  }
  const corpusTokens = new Set(tokenize(corpus));
  const overlap = tokens.filter((token) => corpusTokens.has(token)).length;
  return overlap / tokens.length;
}

function tokenize(value: string): string[] {
  return normalizeEvidenceText(value).split(/\s+/).filter((token) => token.length >= 2);
}

function normalizeEvidenceText(value: string): string {
  return value.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

function cleanString(value: unknown): string | undefined {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() || undefined : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isProductContentCategory(value: unknown): value is ProductContentCategory {
  return value === "benefit"
    || value === "effect"
    || value === "ingredient"
    || value === "usage"
    || value === "faq"
    || value === "review"
    || value === "rating"
    || value === "metric"
    || value === "unknown";
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function uniqueBy<T>(items: T[], getKey: (item: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = getKey(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}
