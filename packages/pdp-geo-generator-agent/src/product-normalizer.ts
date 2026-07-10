import type {
  JsonValue,
  PdpGeoEvidence,
  PdpGeoGeneratorOptions,
  PdpGeoLocale,
  PdpGeoProductNormalizationRequest,
  PdpGeoProductNormalizationResult,
  PdpGeoProductNormalizer,
  PdpGeoTokenUsage,
  PdpProductSignal
} from "./types";
import { temperatureBody } from "./copy-refiner";
import { filterCurrentProductUsageInstructions } from "./product-scope";

interface ProductNormalizationApplication {
  product: PdpProductSignal;
  locale: PdpGeoLocale;
  market?: string;
  evidence: PdpGeoEvidence[];
  warnings: string[];
  usage?: PdpGeoTokenUsage;
  called: boolean;
  applied: boolean;
}

interface ModelBackedProductNormalizerConfig {
  provider: Exclude<PdpGeoGeneratorOptions["provider"], undefined>;
  apiKey?: string;
  model?: string;
  endpoint?: string;
  deployment?: string;
  apiVersion?: string;
  temperature?: number;
  maxSourceCharacters?: number;
}

const defaultMaxRagDocuments = 8;
const defaultMaxSourceCharacters = 35_000;
const PRODUCT_NORMALIZATION_TIMEOUT_MS = 300_000;

export async function normalizePdpProductWithAgent(
  request: PdpGeoProductNormalizationRequest,
  options: PdpGeoGeneratorOptions
): Promise<ProductNormalizationApplication> {
  const resolved = resolveProductNormalizer(options);
  const baseApplication: ProductNormalizationApplication = {
    product: request.bootstrapProduct,
    locale: request.locale,
    market: request.market,
    evidence: [],
    warnings: [],
    called: false,
    applied: false
  };

  if (!resolved.normalizer) {
    if (resolved.warning) {
      baseApplication.warnings.push(resolved.warning);
      baseApplication.evidence.push({ field: "product.normalization", source: "llm", value: `Product normalization skipped: ${resolved.warning}` });
    }
    return baseApplication;
  }

  try {
    const result = await resolved.normalizer.normalizeProduct({
      ...request,
      ragDocuments: request.ragDocuments.slice(0, options.productNormalization?.maxRagDocuments ?? defaultMaxRagDocuments)
    });
    const applied = applyProductNormalization(request.bootstrapProduct, result, request.rawProduct);
    const warnings = [
      ...(result.warnings ?? []),
      ...applied.warnings
    ];
    const evidence = [...applied.evidence];

    if (applied.applied) {
      evidence.push({
        field: "product.normalization",
        source: "llm",
        value: `Model-backed product normalization updated: ${applied.changedFields.join(", ")}`
      });
    } else {
      evidence.push({
        field: "product.normalization",
        source: "llm",
        value: "Model-backed product normalization returned no accepted source-backed field changes."
      });
    }
    for (const warning of warnings) {
      evidence.push({ field: "product.normalization.warning", source: "llm", value: warning });
    }

    return {
      product: applied.product,
      locale: applied.locale ?? request.locale,
      market: applied.market ?? request.market,
      evidence,
      warnings,
      usage: result.usage,
      called: true,
      applied: applied.applied
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Product normalization provider failed.";
    return {
      ...baseApplication,
      evidence: [{ field: "product.normalization", source: "llm", value: `Product normalization skipped: ${message}` }],
      warnings: [message],
      called: true
    };
  }
}

export class ModelBackedProductNormalizer implements PdpGeoProductNormalizer {
  constructor(private readonly config: ModelBackedProductNormalizerConfig) {}

  async normalizeProduct(request: PdpGeoProductNormalizationRequest): Promise<PdpGeoProductNormalizationResult> {
    switch (this.config.provider) {
      case "openai":
        return this.normalizeWithOpenAI(request);
      case "gemini":
        return this.normalizeWithGemini(request);
      case "azure-openai":
        return this.normalizeWithAzureApi(request);
      case "aistudio":
        return this.normalizeWithAistudio(request);
      case "custom":
      case "mock":
      default:
        return { warnings: [`${this.config.provider} product normalization provider has no model-backed adapter.`] };
    }
  }

  private async normalizeWithOpenAI(request: PdpGeoProductNormalizationRequest): Promise<PdpGeoProductNormalizationResult> {
    if (!this.config.apiKey || !this.config.model) {
      throw new Error("OPENAI_API_KEY and OPENAI_MODEL are required for product normalization.");
    }

    const prompt = createProductNormalizationPrompt(request, this.config.maxSourceCharacters);
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
    }, PRODUCT_NORMALIZATION_TIMEOUT_MS, "OpenAI product normalization");

    if (!response.ok) {
      throw new Error(`OpenAI product normalization failed: ${response.status}`);
    }

    const payloadText = await response.text();
    const payload = JSON.parse(payloadText) as Record<string, unknown>;
    return {
      ...parseProductNormalizationJson(payloadText),
      usage: tokenUsageFromOpenAi(payload.usage)
    };
  }

  private async normalizeWithGemini(request: PdpGeoProductNormalizationRequest): Promise<PdpGeoProductNormalizationResult> {
    if (!this.config.apiKey || !this.config.model) {
      throw new Error("GEMINI_API_KEY and GEMINI_MODEL are required for product normalization.");
    }

    const prompt = createProductNormalizationPrompt(request, this.config.maxSourceCharacters);
    const response = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${this.config.model}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": this.config.apiKey
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: prompt.system }] },
        contents: [{ role: "user", parts: [{ text: prompt.user }] }]
      })
    }, PRODUCT_NORMALIZATION_TIMEOUT_MS, "Gemini product normalization");

    if (!response.ok) {
      throw new Error(`Gemini product normalization failed: ${response.status}`);
    }

    const payload = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: unknown;
    };
    const rawText = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("\n") ?? "";
    return {
      ...parseProductNormalizationJson(rawText),
      usage: tokenUsageFromGemini(payload.usageMetadata)
    };
  }

  private async normalizeWithAzureApi(request: PdpGeoProductNormalizationRequest): Promise<PdpGeoProductNormalizationResult> {
    if (!this.config.apiKey || !this.config.endpoint || !this.config.deployment) {
      throw new Error("AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, and AZURE_OPENAI_DEPLOYMENT are required for product normalization.");
    }

    const apiVersion = this.config.apiVersion ?? "2025-04-01-preview";
    const endpoint = this.config.endpoint.replace(/\/$/, "");
    const url = `${endpoint}/openai/deployments/${this.config.deployment}/chat/completions?api-version=${apiVersion}`;
    const prompt = createProductNormalizationPrompt(request, this.config.maxSourceCharacters);
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
    }, PRODUCT_NORMALIZATION_TIMEOUT_MS, "Azure product normalization");

    if (!response.ok) {
      throw new Error(`Azure product normalization failed: ${response.status}`);
    }

    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: unknown };
    return {
      ...parseProductNormalizationJson(payload.choices?.[0]?.message?.content ?? ""),
      usage: tokenUsageFromChatCompletions(payload.usage)
    };
  }

  private async normalizeWithAistudio(request: PdpGeoProductNormalizationRequest): Promise<PdpGeoProductNormalizationResult> {
    if (!this.config.apiKey || !this.config.endpoint || !this.config.deployment) {
      throw new Error("AI Studio endpoint, API key, and reasoning model id are required for product normalization.");
    }

    const endpoint = this.config.endpoint.replace(/\/$/, "");
    const apiVersion = this.config.apiVersion?.trim();
    const query = apiVersion ? `?api-version=${encodeURIComponent(apiVersion)}` : "";
    const url = `${endpoint}/openai/deployments/${this.config.deployment}/chat/completions${query}`;
    const prompt = createProductNormalizationPrompt(request, this.config.maxSourceCharacters);
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user }
        ],
        ...temperatureBody(this.config.temperature)
      })
    }, PRODUCT_NORMALIZATION_TIMEOUT_MS, "AI Studio product normalization");

    if (!response.ok) {
      throw new Error(`AI Studio product normalization failed: ${response.status}`);
    }

    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }>; usage?: unknown };
    return {
      ...parseProductNormalizationJson(payload.choices?.[0]?.message?.content ?? ""),
      usage: tokenUsageFromChatCompletions(payload.usage)
    };
  }
}

function resolveProductNormalizer(options: PdpGeoGeneratorOptions): { normalizer?: PdpGeoProductNormalizer; warning?: string } {
  if (options.customProductNormalizer) {
    return { normalizer: options.customProductNormalizer };
  }

  const settings = options.productNormalization;
  if (!settings?.enabled) {
    return {};
  }

  const provider = settings.provider ?? options.provider ?? "mock";
  if (provider === "mock" || provider === "custom") {
    return { warning: `${provider} product normalization requires customProductNormalizer.` };
  }

  return {
    normalizer: new ModelBackedProductNormalizer({
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

function createProductNormalizationPrompt(request: PdpGeoProductNormalizationRequest, maxSourceCharacters = defaultMaxSourceCharacters): { system: string; user: string } {
  return {
    system: [
      "You are a conservative product-data normalization agent for PDP GEO generation.",
      "Return strict JSON only: {\"product\":{},\"locale\":\"ko-KR|ja-JP|en-US|en-GB\",\"market\":\"\",\"warnings\":[]}.",
      "Infer the normalized ProductSignal from the raw product JSON, bootstrap ProductSignal, fieldMapping, hints, and RAG policy documents.",
      "Your job is field routing and evidence-preserving normalization, not public copywriting.",
      "Use source product data only. Do not invent claims, ingredients, effects, prices, reviews, metrics, awards, or certifications.",
      "Prefer complete source-backed sentences over isolated tokens. Keep ingredient, benefit, effect, usage, FAQ, review, metric, and sourceTexts fields separated.",
      "Route fields by evidence role before returning ProductSignal: usage must be actionable customer directions, ingredients must be ingredient/formula/full-INCI evidence, benefits/effects must be outcomes or supported results, reviews must be customer language, and metrics must be measured or countable evidence.",
      "Do not put a product-result sentence, clinical metric, review summary, or ingredient explanation into usage just because it mentions timing or the current product.",
      "Normalize product identity into a representative product entity and a SKU/variant layer: preserve source-backed bracketed names, small-size labels, volume, option names, and SKU names in originalName/options/sourceTexts; keep the main product name concise when the source clearly separates brand, representative product, and variant.",
      "For prices, preserve the price that is closest to the current SKU/volume/option evidence. Do not mix a full-size offer price into a small-size SKU when the source contains a nearer option-specific price.",
      "For FAQ, keep complete source-backed question/answer pairs across benefit, ingredient/technology, usage, review, suitability, evidence, variant comparison, routine synergy, renewal, and purchase context when those intents appear in the raw PDP.",
      "Use RAG policy to resolve overlaps: commerce UI, coupon, delivery, exchange, refund, return, legal, and page chrome text must not become product benefits.",
      "If the bootstrap value is safer or better supported than your inferred value, return the bootstrap value or omit the field.",
      "Keep arrays concise and deduplicated. Keep product facts close to source wording."
    ].join("\n"),
    user: JSON.stringify(createProductNormalizationPayload(request, maxSourceCharacters), null, 2)
  };
}

function createProductNormalizationPayload(request: PdpGeoProductNormalizationRequest, maxSourceCharacters: number): JsonValue {
  return {
    task: "Infer a source-backed normalized ProductSignal with fewer hardcoded field assumptions.",
    source: toJsonValue(request.source ?? null),
    hints: toJsonValue(request.hints ?? null),
    fieldMapping: toJsonValue(request.fieldMapping ?? null),
    locale: request.locale,
    market: request.market ?? null,
    bootstrapProduct: toJsonValue(request.bootstrapProduct),
    rawProduct: trimJsonForPrompt(request.rawProduct, maxSourceCharacters),
    ragPolicy: [
      request.analysisPrompt ? { name: "analysis-prompt", content: request.analysisPrompt.slice(0, 2400) } : undefined,
      ...request.ragDocuments.map((document) => ({
        name: document.name,
        version: document.version ?? null,
        content: document.content.slice(0, 2400)
      }))
    ].filter(Boolean) as JsonValue
  };
}

function applyProductNormalization(
  bootstrapProduct: PdpProductSignal,
  result: PdpGeoProductNormalizationResult,
  rawProduct: unknown
): {
  product: PdpProductSignal;
  locale?: PdpGeoLocale;
  market?: string;
  evidence: PdpGeoEvidence[];
  warnings: string[];
  changedFields: string[];
  applied: boolean;
} {
  const sourceCorpus = createSourceCorpus(rawProduct, bootstrapProduct);
  const incoming = result.product ?? {};
  const evidence: PdpGeoEvidence[] = [];
  const warnings: string[] = [];
  const changedFields: string[] = [];
  const next: PdpProductSignal = {
    ...bootstrapProduct,
    price: bootstrapProduct.price ? { ...bootstrapProduct.price } : undefined,
    reviews: {
      ...bootstrapProduct.reviews,
      items: [...bootstrapProduct.reviews.items],
      keywords: [...bootstrapProduct.reviews.keywords]
    },
    breadcrumbs: [...bootstrapProduct.breadcrumbs]
  };

  applyStringField(next, "name", incoming.name, sourceCorpus, changedFields, warnings);
  applyStringField(next, "originalName", incoming.originalName, sourceCorpus, changedFields, warnings);
  applyStringField(next, "description", incoming.description, sourceCorpus, changedFields, warnings);
  applyStringField(next, "brand", incoming.brand, sourceCorpus, changedFields, warnings);
  applyStringField(next, "category", incoming.category, sourceCorpus, changedFields, warnings);
  applyStringArrayField(next, "images", incoming.images, sourceCorpus, changedFields, warnings, { allowUrlLike: true });
  applyStringArrayField(next, "options", incoming.options, sourceCorpus, changedFields, warnings);
  applyStringArrayField(next, "benefits", incoming.benefits, sourceCorpus, changedFields, warnings);
  applyStringArrayField(next, "effects", incoming.effects, sourceCorpus, changedFields, warnings);
  applyStringArrayField(next, "ingredients", incoming.ingredients, sourceCorpus, changedFields, warnings);
  applyStringArrayField(next, "usage", incoming.usage, sourceCorpus, changedFields, warnings);
  applyStringArrayField(next, "metrics", incoming.metrics, sourceCorpus, changedFields, warnings);
  applyStringArrayField(next, "sourceTexts", incoming.sourceTexts, sourceCorpus, changedFields, warnings);

  if (incoming.price) {
    const raw = sourceBackedString(incoming.price.raw, sourceCorpus);
    const currency = cleanString(incoming.price.currency);
    if (raw) {
      next.price = {
        raw,
        amount: typeof incoming.price.amount === "number" && Number.isFinite(incoming.price.amount) ? incoming.price.amount : bootstrapProduct.price?.amount,
        currency: currency || bootstrapProduct.price?.currency
      };
      changedFields.push("price");
    }
  }

  if (Array.isArray(incoming.faq)) {
    const faq = incoming.faq
      .flatMap((item) => {
        const question = sourceBackedString(item.question, sourceCorpus);
        const answer = sourceBackedString(item.answer, sourceCorpus);
        return question && answer ? [{ question, answer }] : [];
      });
    if (faq.length > 0) {
      next.faq = uniqueBy(faq, (item) => `${item.question}\n${item.answer}`).slice(0, 10);
      changedFields.push("faq");
    } else if (incoming.faq.length > 0) {
      warnings.push("Model FAQ normalization was rejected because question/answer evidence was not source-backed.");
    }
  }

  if (incoming.reviews) {
    const items = Array.isArray(incoming.reviews.items)
      ? incoming.reviews.items.flatMap((item) => {
          const body = sourceBackedString(item.body, sourceCorpus);
          return body ? [{ ...item, body }] : [];
        })
      : [];
    const keywords = Array.isArray(incoming.reviews.keywords)
      ? sourceBackedStringArray(incoming.reviews.keywords, sourceCorpus, { allowShortOverlap: true }).slice(0, 18)
      : [];
    if (items.length > 0 || keywords.length > 0 || typeof incoming.reviews.rating === "number" || typeof incoming.reviews.reviewCount === "number") {
      next.reviews = {
        rating: typeof incoming.reviews.rating === "number" && Number.isFinite(incoming.reviews.rating) ? incoming.reviews.rating : bootstrapProduct.reviews.rating,
        reviewCount: typeof incoming.reviews.reviewCount === "number" && Number.isFinite(incoming.reviews.reviewCount) ? incoming.reviews.reviewCount : bootstrapProduct.reviews.reviewCount,
        items: items.length > 0 ? uniqueBy(items, (item) => item.body).slice(0, 12) : bootstrapProduct.reviews.items,
        keywords: keywords.length > 0 ? keywords : bootstrapProduct.reviews.keywords
      };
      changedFields.push("reviews");
    }
  }

  if (Array.isArray(incoming.breadcrumbs)) {
    const breadcrumbs = incoming.breadcrumbs.flatMap((item) => {
      const name = sourceBackedString(item.name, sourceCorpus);
      const url = cleanString(item.url);
      return name ? [{ name, url }] : [];
    });
    if (breadcrumbs.length > 0) {
      next.breadcrumbs = breadcrumbs.slice(0, 8);
      changedFields.push("breadcrumbs");
    }
  }

  for (const field of unique(changedFields)) {
    evidence.push({ field: `product.${field}`, source: "llm", value: "Accepted source-backed model normalization." });
  }

  const scopedProduct = filterCurrentProductUsageInstructions(next);
  if (scopedProduct.usage.length !== next.usage.length) {
    changedFields.push("usage");
    evidence.push({ field: "product.usage", source: "llm", value: "Removed usage instructions that matched a related but different product in the same routine." });
  }

  return {
    product: scopedProduct,
    locale: result.locale,
    market: cleanString(result.market),
    evidence,
    warnings,
    changedFields: unique(changedFields),
    applied: changedFields.length > 0
  };
}

function applyStringField<T extends keyof Pick<PdpProductSignal, "name" | "originalName" | "description" | "brand" | "category">>(
  product: PdpProductSignal,
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
    product[field] = accepted as PdpProductSignal[T];
    changedFields.push(field);
  }
}

function applyStringArrayField<T extends keyof Pick<PdpProductSignal, "images" | "options" | "benefits" | "effects" | "ingredients" | "usage" | "metrics" | "sourceTexts">>(
  product: PdpProductSignal,
  field: T,
  value: unknown,
  sourceCorpus: string,
  changedFields: string[],
  warnings: string[],
  options: { allowUrlLike?: boolean } = {}
) {
  if (!Array.isArray(value)) {
    return;
  }
  const accepted = sourceBackedStringArray(value, sourceCorpus, options);
  if (accepted.length > 0) {
    product[field] = accepted as PdpProductSignal[T];
    changedFields.push(field);
  } else if (value.length > 0) {
    warnings.push(`Model ${field} normalization was rejected because no values were source-backed.`);
  }
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

function createSourceCorpus(rawProduct: unknown, bootstrapProduct: PdpProductSignal): string {
  return unique([
    ...flattenTextValues(rawProduct),
    bootstrapProduct.name,
    bootstrapProduct.originalName,
    bootstrapProduct.description,
    bootstrapProduct.brand,
    bootstrapProduct.category,
    bootstrapProduct.price?.raw,
    bootstrapProduct.price?.currency,
    ...bootstrapProduct.images,
    ...bootstrapProduct.options,
    ...bootstrapProduct.benefits,
    ...bootstrapProduct.effects,
    ...bootstrapProduct.ingredients,
    ...bootstrapProduct.usage,
    ...bootstrapProduct.metrics,
    ...bootstrapProduct.sourceTexts,
    ...bootstrapProduct.faq.flatMap((item) => [item.question, item.answer]),
    ...bootstrapProduct.reviews.items.map((item) => item.body),
    ...bootstrapProduct.reviews.keywords,
    ...bootstrapProduct.breadcrumbs.flatMap((item) => [item.name, item.url])
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0)).join("\n");
}

function parseProductNormalizationJson(rawText: string): PdpGeoProductNormalizationResult {
  const jsonText = jsonTextFromProviderPayload(rawText);
  if (!jsonText) {
    return { warnings: ["No parseable product normalization JSON returned."], rawText };
  }

  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    const product = normalizePartialProduct(parsed.product);
    const warnings = Array.isArray(parsed.warnings)
      ? parsed.warnings.flatMap((item) => {
          const warning = cleanString(item);
          return warning ? [warning] : [];
        })
      : [];
    return {
      product,
      locale: isPdpGeoLocale(parsed.locale) ? parsed.locale : undefined,
      market: cleanString(parsed.market),
      warnings,
      rawText
    };
  } catch {
    return { warnings: ["Product normalization JSON could not be parsed."], rawText };
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

function normalizePartialProduct(value: unknown): Partial<PdpProductSignal> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Partial<PdpProductSignal>;
  return record;
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

function isPdpGeoLocale(value: unknown): value is PdpGeoLocale {
  return value === "ko-KR" || value === "ja-JP" || value === "en-US" || value === "en-GB";
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
