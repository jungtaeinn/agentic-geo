import type {
  JsonValue,
  PdpGeoEvidence,
  PdpGeoGeneratorOptions,
  PdpGeoLocale,
  PdpGeoProductNormalizationRequest,
  PdpGeoProductNormalizationResult,
  PdpGeoProductNormalizer,
  PdpSemanticFacts,
  PdpSemanticIngredientBenefitLink,
  PdpSemanticMetricClaim,
  PdpGeoTokenUsage,
  PdpProductSignal
} from "./types";
import { z } from "zod";
import { temperatureBody } from "./copy-refiner";
import { filterCurrentProductUsageInstructions } from "./product-scope";
import { inferPdpEvidenceRoles, sanitizePdpSemanticFacts } from "./normalize";

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

const nullableText = z.string().nullable();
const nullableNumber = z.number().finite().nullable();
const metricClaimOutputSchema = z.object({
  label: nullableText,
  subject: nullableText,
  value: nullableText,
  unit: nullableText,
  metric: nullableText,
  direction: nullableText,
  timing: nullableText,
  baseline: nullableText,
  comparator: nullableText,
  period: nullableText,
  sample: nullableText,
  method: nullableText,
  institution: nullableText,
  evidenceGroup: nullableText,
  caveat: nullableText,
  sentence: nullableText,
  sourceText: nullableText
}).strict();
const ingredientBenefitLinkOutputSchema = z.object({
  ingredient: nullableText,
  benefit: nullableText,
  effect: nullableText,
  sentence: nullableText,
  sourceText: nullableText
}).strict();
const semanticFactsOutputSchema = z.object({
  ingredients: z.array(z.string()),
  benefits: z.array(z.string()),
  effects: z.array(z.string()),
  skinTypes: z.array(z.string()),
  usageSteps: z.array(z.string()),
  safetyTests: z.array(z.string()),
  metricClaims: z.array(metricClaimOutputSchema),
  evidenceSentences: z.array(z.string()),
  ingredientBenefitLinks: z.array(ingredientBenefitLinkOutputSchema)
}).strict();
const productPatchOutputSchema = z.object({
  name: nullableText,
  originalName: nullableText,
  description: nullableText,
  brand: nullableText,
  category: nullableText,
  price: z.object({ raw: z.string(), amount: nullableNumber, currency: nullableText }).strict().nullable(),
  images: z.array(z.string()).nullable(),
  options: z.array(z.string()).nullable(),
  benefits: z.array(z.string()).nullable(),
  effects: z.array(z.string()).nullable(),
  ingredients: z.array(z.string()).nullable(),
  usage: z.array(z.string()).nullable(),
  metrics: z.array(z.string()).nullable(),
  faq: z.array(z.object({ question: z.string(), answer: z.string() }).strict()).nullable(),
  reviews: z.object({
    rating: nullableNumber,
    reviewCount: nullableNumber,
    items: z.array(z.object({
      body: z.string(),
      author: nullableText,
      rating: nullableNumber,
      datePublished: nullableText
    }).strict()),
    keywords: z.array(z.string())
  }).strict().nullable(),
  breadcrumbs: z.array(z.object({ name: z.string(), url: nullableText }).strict()).nullable(),
  sourceTexts: z.array(z.string()).nullable(),
  semanticFacts: semanticFactsOutputSchema.nullable()
}).strict();
const productNormalizationOutputSchema = z.object({
  product: productPatchOutputSchema,
  locale: z.enum(["ko-KR", "ja-JP", "en-US", "en-GB"]),
  market: nullableText,
  warnings: z.array(z.string())
}).strict();

/** Provider-enforced patch schema: unchanged fields are null, avoiding the
 * huge full-product echoes that previously caused truncated/malformed JSON. */
const { $schema: _normalizationSchemaDialect, ...productNormalizationJsonSchema } = z.toJSONSchema(productNormalizationOutputSchema);

const flexibleProductNormalizationEnvelopeSchema = z.object({
  product: z.object({
    name: z.string().nullable().optional(),
    originalName: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    brand: z.string().nullable().optional(),
    category: z.string().nullable().optional(),
    price: z.object({ raw: z.string(), amount: z.number().finite().nullable().optional(), currency: z.string().nullable().optional() }).strict().nullable().optional(),
    images: z.array(z.string()).nullable().optional(),
    options: z.array(z.string()).nullable().optional(),
    benefits: z.array(z.string()).nullable().optional(),
    effects: z.array(z.string()).nullable().optional(),
    ingredients: z.array(z.string()).nullable().optional(),
    usage: z.array(z.string()).nullable().optional(),
    metrics: z.array(z.string()).nullable().optional(),
    faq: z.array(z.object({ question: z.string(), answer: z.string() }).strict()).nullable().optional(),
    reviews: z.object({
      rating: z.number().finite().nullable().optional(),
      reviewCount: z.number().finite().nullable().optional(),
      items: z.array(z.object({
        body: z.string(),
        author: z.string().nullable().optional(),
        rating: z.number().finite().nullable().optional(),
        datePublished: z.string().nullable().optional()
      }).strict()).optional(),
      keywords: z.array(z.string()).optional()
    }).strict().nullable().optional(),
    breadcrumbs: z.array(z.object({ name: z.string(), url: z.string().nullable().optional() }).strict()).nullable().optional(),
    sourceTexts: z.array(z.string()).nullable().optional(),
    semanticFacts: semanticFactsOutputSchema.partial().strict().nullable().optional()
  }).strict().optional(),
  locale: z.enum(["ko-KR", "ja-JP", "en-US", "en-GB"]).optional(),
  market: z.string().nullable().optional(),
  warnings: z.array(z.string()).optional()
}).strict();

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
    const normalizationRequest = {
      ...request,
      ragDocuments: request.ragDocuments.slice(0, options.productNormalization?.maxRagDocuments ?? defaultMaxRagDocuments)
    };
    let result = await resolved.normalizer.normalizeProduct(normalizationRequest);
    let correctiveRetryWarning: string | undefined;
    if (resolved.normalizer instanceof ModelBackedProductNormalizer && productNormalizationNeedsCorrectiveRetry(result)) {
      const retry = await resolved.normalizer.normalizeProduct({
        ...normalizationRequest,
        analysisPrompt: [
          normalizationRequest.analysisPrompt,
          "CORRECTIVE_STRUCTURED_RETRY: The previous response was not parseable or did not satisfy the normalization patch schema. Return only the compact schema-conformant JSON patch; use null for unchanged fields and preserve atomic evidence roles."
        ].filter(Boolean).join("\n")
      });
      if (!productNormalizationNeedsCorrectiveRetry(retry)) {
        result = {
          ...retry,
          usage: mergeProductNormalizationUsage(result.usage, retry.usage),
          warnings: [...(retry.warnings ?? []), "Product normalization recovered after one corrective structured retry."]
        };
      } else {
        result = {
          ...retry,
          usage: mergeProductNormalizationUsage(result.usage, retry.usage),
          warnings: [...(result.warnings ?? []), ...(retry.warnings ?? [])]
        };
        correctiveRetryWarning = "DEGRADED_MODE: Product normalization remained invalid after one corrective structured retry; source-backed deterministic classification was used and incomplete clinical atoms were kept out of clinical summaries.";
      }
    }
    const applied = applyProductNormalization(request.bootstrapProduct, result, request.rawProduct);
    const warnings = [
      ...(result.warnings ?? []),
      ...applied.warnings,
      ...(correctiveRetryWarning ? [correctiveRetryWarning] : [])
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

function productNormalizationNeedsCorrectiveRetry(result: PdpGeoProductNormalizationResult): boolean {
  return !result.product
    && (result.warnings ?? []).some((warning) => /(?:no parseable|could not be parsed|schema validation)/iu.test(warning));
}

function mergeProductNormalizationUsage(
  first: PdpGeoTokenUsage | undefined,
  second: PdpGeoTokenUsage | undefined
): PdpGeoTokenUsage | undefined {
  if (!first && !second) {
    return undefined;
  }
  const sum = (left: number | undefined, right: number | undefined): number | undefined =>
    left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
  return {
    inputTokens: sum(first?.inputTokens, second?.inputTokens),
    outputTokens: sum(first?.outputTokens, second?.outputTokens),
    totalTokens: sum(first?.totalTokens, second?.totalTokens)
  };
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
        input: prompt.user,
        text: {
          format: {
            type: "json_schema",
            name: "pdp_product_normalization_patch",
            strict: true,
            schema: productNormalizationJsonSchema
          }
        }
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
        contents: [{ role: "user", parts: [{ text: prompt.user }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: toGeminiProductNormalizationSchema(productNormalizationJsonSchema),
          ...temperatureBody(this.config.temperature)
        }
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
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "pdp_product_normalization_patch",
            strict: true,
            schema: productNormalizationJsonSchema
          }
        },
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
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "pdp_product_normalization_patch",
            strict: true,
            schema: productNormalizationJsonSchema
          }
        },
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
  const mayInheritProviderSettings = settings.provider === undefined || settings.provider === options.provider;
  if (provider === "mock" || provider === "custom") {
    return { warning: `${provider} product normalization requires customProductNormalizer.` };
  }

  return {
    normalizer: new ModelBackedProductNormalizer({
      provider,
      apiKey: settings.apiKey ?? (mayInheritProviderSettings ? options.apiKey : undefined),
      model: settings.model ?? (mayInheritProviderSettings ? options.model : undefined),
      endpoint: settings.endpoint ?? (mayInheritProviderSettings ? options.endpoint : undefined),
      deployment: settings.deployment ?? (mayInheritProviderSettings ? options.deployments?.reasoning ?? options.deployment : undefined),
      apiVersion: settings.apiVersion ?? (mayInheritProviderSettings ? options.apiVersion : undefined),
      temperature: options.temperature,
      maxSourceCharacters: settings.maxSourceCharacters
    })
  };
}

function createProductNormalizationPrompt(request: PdpGeoProductNormalizationRequest, maxSourceCharacters = defaultMaxSourceCharacters): { system: string; user: string } {
  return {
    system: [
      "You are a conservative product-data normalization agent for PDP GEO generation.",
      "Return only the strict product-normalization patch JSON required by the response schema.",
      "The product object is a patch, not a full echo of the input. Return null for every unchanged scalar/object/array field. When an array is changed, return the complete audited replacement array; when semanticFacts is changed, return its complete classified arrays. This keeps the response compact and prevents truncation.",
      "Infer the normalized ProductSignal from the raw product JSON, bootstrap ProductSignal, fieldMapping, hints, and RAG policy documents.",
      "Your job is field routing and evidence-preserving normalization, not public copywriting.",
      "Use source product data only. Do not invent claims, ingredients, effects, prices, reviews, metrics, awards, or certifications.",
      "Prefer complete source-backed sentences over isolated tokens. Keep ingredient, benefit, effect, usage, FAQ, review, metric, and sourceTexts fields separated.",
      "Route fields by evidence role before returning ProductSignal: usage must be actionable customer directions, ingredients must be ingredient/formula/full-INCI evidence, benefits/effects must be outcomes or supported results, reviews must be customer language, and metrics must be measured or countable evidence.",
      "Preserve usage structure from bootstrapProduct. If bootstrap usage already contains actionable directions, leave product.usage null instead of splitting, merging, reordering, paraphrasing, or replacing those items. semanticFacts.usageSteps must keep the same source boundaries; one source instruction remains one item and an explicit source sequence keeps its count and order.",
      "An ingredient is a named substance, INCI entry, identifiable complex, or proprietary formula/technology. Do not classify attributes or outcomes such as absorption, retention, persistence, texture, skin type, efficacy, or a research duration as ingredients.",
      "Do not put a product-result sentence, clinical metric, review summary, or ingredient explanation into usage just because it mentions timing, application, use, or the current product. Test application and measured post-application results are evidence, not customer directions.",
      "Normalize product identity into a representative product entity and a SKU/variant layer: preserve source-backed bracketed names, small-size labels, volume, option names, and SKU names in originalName/options/sourceTexts; keep the main product name concise when the source clearly separates brand, representative product, and variant.",
      "For prices, preserve the price that is closest to the current SKU/volume/option evidence. Do not mix a full-size offer price into a small-size SKU when the source contains a nearer option-specific price.",
      "For FAQ, keep complete source-backed question/answer pairs across benefit, ingredient/technology, usage, review, suitability, evidence, variant comparison, routine synergy, renewal, and purchase context when those intents appear in the raw PDP.",
      "Use RAG policy to resolve overlaps: commerce UI, coupon, delivery, exchange, refund, return, legal, and page chrome text must not become product benefits.",
      "If the bootstrap value is safer or better supported than your inferred value, return the bootstrap value or omit the field.",
      "Keep arrays concise and semantically deduplicated: paraphrases of the same usage action or the same skin type in another language count as one fact. Keep product facts close to source wording.",
      "Classify each atomic evidence unit before routing it. Use one primary role among ingredient, benefit, effect, audience, usage, safety, review, metric, FAQ, commerce, or source; add a secondary role only when the same sentence explicitly supports it. Do not infer a role from a nearby heading alone.",
      "Separate source assertions, source-backed synthesis, and query hypotheses before normalization. ProductSignal fields and semanticFacts may contain only source assertions or lossless normalization of them. A plausible customer question, common category convention, seasonal/weather association, time-of-day assumption, occasion, or general market belief is a non-evidentiary query hypothesis; if it is useful, put it only in warnings prefixed QUERY_HYPOTHESIS_ONLY and never route it into product facts.",
      "Do not create a causal or suitability relationship from co-occurrence. Two facts appearing on the same page, in neighboring sections, or in separate array entries do not prove that one causes, supports, is recommended for, or is used during the other. Record a relation only when one source sentence or structured source fact explicitly connects the current product, context, and outcome.",
      "When a sentence explicitly links a named ingredient or technology to an outcome, keep the named entity in ingredients and record the source-backed relation in semanticFacts.ingredientBenefitLinks. Do not copy that ingredient outcome into product benefits/effects unless a separate source assertion explicitly makes it a finished-product claim. Do not place the full explanatory sentence or the outcome phrase in the ingredient-name list.",
      "Classify completed safety, dermatology, sensitive-skin, allergy, eye-irritation, paediatric, non-comedogenic, and similar product tests into semanticFacts.safetyTests as separate atomic source-backed test names. Do not merge them into efficacy metrics, ingredients, benefits, or usage, and do not infer an unlisted test from a related certification label.",
      "Treat outcome-like words inside a standalone proper ingredient, complex, blend, technology, or formula name as part of that name, not as a benefit/effect or causal relation. Require an explicit source assertion outside the name before adding an outcome role.",
      "Review bodies, review keywords, ratings, testimonials, and customer-experience sections have review provenance. Do not promote terms found only in those sources into product benefits, effects, ingredients, or ingredient-outcome relations; a non-review product-fact source must independently support that role.",
      "Return benefits, effects, and ingredients as complete audited arrays, including an empty array when every bootstrap value is misrouted. An explicit empty array clears that role; omitting a field preserves the bootstrap value.",
      "A metric must remain an atomic claim with its measured outcome and available period, sample, method, comparison, or caveat. A bare percentage, duration, volume, option size, or price is not a result metric. Product volume and SKU size belong to options/sourceTexts.",
      "When OCR or extracted copy compresses multiple measurements and a footnote into one run-on block, infer the evidence atoms before routing: create one semanticFacts.metricClaims item per independently measured endpoint and retain its label/subject, value/unit, direction, timing, baseline/comparator, sample, period, method, and caveat when the source supports them. Keep the original block only as sourceText/evidenceSentences provenance; never return that whole block as one public metric, effect, review, or usage item.",
      "Share institution, study dates, population/sample, method, or baseline across metricClaims only when the source groups those outcomes under the same footnote, study marker, or explicit study statement. Depth/delivery, formulation retention, duration, customer skin outcome, and review satisfaction are different evidence roles unless the source explicitly connects them. Do not attach an ambiguous percentage or comparison to a clinical study merely because it appears nearby in OCR order.",
      "Safety and suitability cautions such as patch testing are not HowTo steps. A skin type mentioned only in a caution is not automatically the recommended skin type. FAQ answers must be answer statements, never another question or a shopper's question fragment.",
      "Use the requested locale as the output-language contract: Korean PDP evidence produces ko-KR normalized public-language fields, and US PDP evidence produces en-US normalized public-language fields. Preserve source-language proper nouns and INCI names where translation would change identity."
    ].join("\n"),
    user: JSON.stringify(createProductNormalizationPayload(request, maxSourceCharacters), null, 2)
  };
}

function createProductNormalizationPayload(request: PdpGeoProductNormalizationRequest, maxSourceCharacters: number): JsonValue {
  return {
    task: "Infer a source-backed normalized ProductSignal with fewer hardcoded field assumptions.",
    inferenceBoundary: {
      factualOutput: "Only source assertions or lossless normalization of source assertions may enter ProductSignal and semanticFacts.",
      queryHypothesis: "Unsupported seasonal, weather, occasion, time-of-day, demographic, or general category associations belong only in warnings prefixed QUERY_HYPOTHESIS_ONLY."
    },
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
  const productFactCorpus = createProductFactCorpus(rawProduct, bootstrapProduct);
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
  applyStringArrayField(next, "benefits", incoming.benefits, productFactCorpus, changedFields, warnings, { authoritative: true });
  applyStringArrayField(next, "effects", incoming.effects, productFactCorpus, changedFields, warnings, { authoritative: true });
  applyStringArrayField(next, "ingredients", incoming.ingredients, productFactCorpus, changedFields, warnings, { authoritative: true });
  const bootstrapUsage = filterValuesByEvidenceRole(bootstrapProduct.usage, "usage");
  if (bootstrapUsage.length > 0) {
    next.usage = bootstrapUsage;
    if (Array.isArray(incoming.usage)) {
      const acceptedIncomingUsage = sourceBackedStringArray(incoming.usage, sourceCorpus);
      if (normalizeEvidenceText(acceptedIncomingUsage.join("\n")) !== normalizeEvidenceText(bootstrapUsage.join("\n"))) {
        warnings.push("Model usage normalization was ignored to preserve source instruction boundaries and order.");
      }
    }
  } else {
    applyStringArrayField(next, "usage", incoming.usage, sourceCorpus, changedFields, warnings);
  }
  applyStringArrayField(next, "metrics", incoming.metrics, sourceCorpus, changedFields, warnings);
  applyStringArrayField(next, "sourceTexts", incoming.sourceTexts, sourceCorpus, changedFields, warnings);
  applySemanticFacts(next, incoming.semanticFacts, sourceCorpus, productFactCorpus, changedFields, warnings);

  next.benefits = filterValuesByEvidenceRole(next.benefits, "benefit");
  next.effects = filterValuesByEvidenceRole(next.effects, "effect");
  next.ingredients = filterValuesByEvidenceRole(next.ingredients, "ingredient");
  next.usage = filterValuesByEvidenceRole(next.usage, "usage");
  next.metrics = filterValuesByEvidenceRole(next.metrics, "metric");

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

function filterValuesByEvidenceRole(
  values: string[],
  role: "benefit" | "effect" | "ingredient" | "usage" | "metric"
): string[] {
  return unique(values.filter((value) => {
    const inference = inferPdpEvidenceRoles(value);
    if (inference.roles.includes(role)) {
      return true;
    }
    // The value is already source-backed and was explicitly routed by the
    // normalization model. Keep novel vocabulary unless a deterministic role
    // conflict proves that it belongs elsewhere. This avoids turning the
    // lexical fallback into a product/ingredient allowlist.
    if (role === "ingredient") {
      return isSafeModelRoutedIngredient(value, inference.roles);
    }
    if (role === "benefit" || role === "effect") {
      return isSafeModelRoutedOutcome(value, inference.roles);
    }
    return false;
  }));
}

function isSafeModelRoutedIngredient(value: string, inferredRoles: string[]): boolean {
  const text = value.trim();
  const conflicting = inferredRoles.some((role) => ["audience", "benefit", "effect", "usage", "safety", "review", "metric", "faq", "commerce"].includes(role));
  if (!text || text.length > 120 || conflicting || /[?？]/u.test(text)) {
    return false;
  }
  return !/^(?:absorption|absorbency|retention|persistence|texture|finish|efficacy|effect|duration|hydration|moisture|firmness|흡수력|흡수성|잔존|유지력|지속력|제형|질감|사용감|효능|효과|기간|보습력|수분감|탄력|피부\s*타입)$/iu.test(text)
    && !/^\d+(?:[.,]\d+)?\s*(?:%|％|배|hours?|days?|weeks?|시간|일|주)?$/iu.test(text);
}

function isSafeModelRoutedOutcome(value: string, inferredRoles: string[]): boolean {
  const text = value.trim();
  const conflicting = inferredRoles.some((role) => ["usage", "safety", "review", "metric", "faq", "commerce"].includes(role));
  return Boolean(text) && text.length <= 320 && !conflicting && !/[?？]/u.test(text);
}

function applySemanticFacts(
  product: PdpProductSignal,
  value: Partial<PdpSemanticFacts> | undefined,
  sourceCorpus: string,
  productFactCorpus: string,
  changedFields: string[],
  warnings: string[]
): void {
  if (!value || typeof value !== "object") {
    if (product.semanticFacts) {
      product.semanticFacts = sanitizePdpSemanticFacts(product.semanticFacts);
    }
    return;
  }

  const candidate: Partial<PdpSemanticFacts> = {
    ingredients: sourceBackedStringArray(value.ingredients ?? [], productFactCorpus, { allowShortOverlap: true }),
    benefits: sourceBackedStringArray(value.benefits ?? [], productFactCorpus, { allowShortOverlap: true }),
    effects: sourceBackedStringArray(value.effects ?? [], productFactCorpus, { allowShortOverlap: true }),
    skinTypes: sourceBackedStringArray(value.skinTypes ?? [], sourceCorpus, { allowShortOverlap: true }),
    usageSteps: sourceBackedStringArray(value.usageSteps ?? [], sourceCorpus, { allowShortOverlap: true }),
    safetyTests: sourceBackedStringArray(value.safetyTests ?? [], sourceCorpus, { allowShortOverlap: true }),
    evidenceSentences: sourceBackedStringArray(value.evidenceSentences ?? [], sourceCorpus),
    metricClaims: (value.metricClaims ?? []).flatMap((claim) => sourceBackedMetricClaim(claim, sourceCorpus)),
    ingredientBenefitLinks: (value.ingredientBenefitLinks ?? []).flatMap((link) => sourceBackedIngredientBenefitLink(link, productFactCorpus))
  };
  const sanitizedBase = sanitizePdpSemanticFacts(candidate);
  const explicitlyVettedLinks = candidate.ingredientBenefitLinks ?? [];
  const linkOutcomeKeys = new Set(explicitlyVettedLinks
    .flatMap((link) => [link.benefit, link.effect])
    .filter((item): item is string => Boolean(item))
    .map(normalizeEvidenceText));
  const bootstrapOutcomeKeys = new Set([
    ...product.benefits,
    ...product.effects,
    ...(product.semanticFacts?.benefits ?? []),
    ...(product.semanticFacts?.effects ?? [])
  ].map(normalizeEvidenceText));
  const isIndependentFinishedProductOutcome = (value: string): boolean => {
    const key = normalizeEvidenceText(value);
    return !linkOutcomeKeys.has(key) || bootstrapOutcomeKeys.has(key);
  };
  const sanitized: PdpSemanticFacts = {
    ...sanitizedBase,
    ingredients: unique([
      ...sanitizedBase.ingredients,
      ...explicitlyVettedLinks.map((link) => link.ingredient ?? "")
    ]).slice(0, 24),
    benefits: unique(sanitizedBase.benefits.filter(isIndependentFinishedProductOutcome)).slice(0, 24),
    effects: unique(sanitizedBase.effects.filter(isIndependentFinishedProductOutcome)).slice(0, 24),
    ingredientBenefitLinks: uniqueBy(
      [...sanitizedBase.ingredientBenefitLinks, ...explicitlyVettedLinks],
      (link) => normalizeEvidenceText([link.ingredient, link.benefit, link.effect, link.sourceText, link.sentence].filter(Boolean).join(" "))
    ).slice(0, 24)
  };
  const acceptedCount = semanticFactCount(sanitized);
  if (acceptedCount > 0) {
    product.semanticFacts = sanitized;
    changedFields.push("semanticFacts");
    return;
  }
  if (semanticFactInputCount(value) > 0) {
    warnings.push("Model semanticFacts normalization was rejected because no role-coherent source-backed facts remained.");
  }
}

function sourceBackedMetricClaim(claim: PdpSemanticMetricClaim, sourceCorpus: string): PdpSemanticMetricClaim[] {
  const sentence = sourceBackedString(claim.sentence, sourceCorpus);
  const sourceText = sourceBackedString(claim.sourceText, sourceCorpus);
  if (!sentence && !sourceText) {
    return [];
  }
  const backedField = (value: string | undefined): string | undefined =>
    sourceBackedString(value, sourceCorpus, { allowShortOverlap: true });
  return [{
    label: backedField(claim.label),
    subject: backedField(claim.subject),
    value: backedField(claim.value),
    unit: backedField(claim.unit),
    metric: backedField(claim.metric),
    direction: backedField(claim.direction),
    timing: backedField(claim.timing),
    baseline: backedField(claim.baseline),
    comparator: backedField(claim.comparator),
    period: backedField(claim.period),
    sample: backedField(claim.sample),
    method: backedField(claim.method),
    institution: backedField(claim.institution),
    evidenceGroup: cleanString(claim.evidenceGroup),
    caveat: backedField(claim.caveat),
    sentence,
    sourceText
  }];
}

function sourceBackedIngredientBenefitLink(link: PdpSemanticIngredientBenefitLink, sourceCorpus: string): PdpSemanticIngredientBenefitLink[] {
  const sentence = sourceBackedString(link.sentence, sourceCorpus);
  const sourceText = sourceBackedString(link.sourceText, sourceCorpus);
  const ingredient = sourceBackedString(link.ingredient, sourceCorpus, { allowShortOverlap: true });
  const benefit = sourceBackedString(link.benefit, sourceCorpus, { allowShortOverlap: true });
  const effect = sourceBackedString(link.effect, sourceCorpus, { allowShortOverlap: true });
  const outcome = benefit ?? effect;
  const relationEvidence = unique([sourceText, sentence].filter((value): value is string => Boolean(value)));
  if (!ingredient || !outcome || relationEvidence.length === 0) {
    return [];
  }
  const hasExplicitSourceRelation = relationEvidence.some((evidence) =>
    hasExplicitRelationshipLanguage(evidence)
    && relationEvidenceContainsTerm(evidence, ingredient)
    && relationEvidenceContainsTerm(evidence, outcome)
  );
  if (!hasExplicitSourceRelation) {
    return [];
  }
  return [{ ingredient, benefit, effect, sentence, sourceText }];
}

function hasExplicitRelationshipLanguage(value: string): boolean {
  return /\b(?:helps?|supports?|improves?|contributes?\s+to|designed\s+for|formulated\s+for|for)\b|(?:도와|돕|지원|개선|강화|기여|위한|바탕|기반)|(?:助け|支え|改善|寄与|ため|向け|もと)/iu.test(value);
}

function relationEvidenceContainsTerm(evidence: string, term: string): boolean {
  const normalizedEvidence = normalizeEvidenceText(evidence);
  const normalizedTerm = normalizeEvidenceText(term);
  return normalizedEvidence.includes(normalizedTerm)
    || normalizedTerm.includes(normalizedEvidence)
    || tokenOverlapRatio(term, evidence) >= 0.6;
}

function semanticFactCount(value: PdpSemanticFacts): number {
  return value.ingredients.length
    + value.benefits.length
    + value.effects.length
    + value.skinTypes.length
    + value.usageSteps.length
    + (value.safetyTests?.length ?? 0)
    + value.metricClaims.length
    + value.ingredientBenefitLinks.length;
}

function semanticFactInputCount(value: Partial<PdpSemanticFacts>): number {
  return (value.ingredients?.length ?? 0)
    + (value.benefits?.length ?? 0)
    + (value.effects?.length ?? 0)
    + (value.skinTypes?.length ?? 0)
    + (value.usageSteps?.length ?? 0)
    + (value.safetyTests?.length ?? 0)
    + (value.metricClaims?.length ?? 0)
    + (value.evidenceSentences?.length ?? 0)
    + (value.ingredientBenefitLinks?.length ?? 0);
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
  options: { allowUrlLike?: boolean; authoritative?: boolean } = {}
) {
  if (!Array.isArray(value)) {
    return;
  }
  const accepted = sourceBackedStringArray(value, sourceCorpus, options);
  if (accepted.length > 0 || options.authoritative) {
    product[field] = accepted as PdpProductSignal[T];
    changedFields.push(field);
    if (options.authoritative && value.length > 0 && accepted.length === 0) {
      warnings.push(`Model ${field} normalization cleared the bootstrap field because no role-coherent source-backed values remained.`);
    }
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

/**
 * Corpus for model-routed product facts. Review evidence remains available to
 * review/FAQ normalization through createSourceCorpus, but it cannot be
 * promoted into ingredient or outcome fields merely because the same words
 * occur in a review branch.
 */
function createProductFactCorpus(rawProduct: unknown, bootstrapProduct: PdpProductSignal): string {
  const reviewTexts = unique([
    ...flattenReviewProvenanceTextValues(rawProduct),
    ...bootstrapProduct.reviews.items.map((item) => item.body),
    ...bootstrapProduct.reviews.keywords
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0));
  const reviewTextKeys = reviewTexts.map(normalizeEvidenceText).filter(Boolean);
  const nonReviewRawTexts = flattenNonReviewTextValues(rawProduct)
    .filter((text) => !isReviewBackedSourceUnit(text, reviewTextKeys));

  return unique([
    ...nonReviewRawTexts,
    // These arrays have already passed deterministic source-role routing in
    // the bootstrap product, so preserve novel, non-allowlisted vocabulary.
    ...bootstrapProduct.benefits,
    ...bootstrapProduct.effects,
    ...bootstrapProduct.ingredients,
    ...(bootstrapProduct.semanticFacts?.ingredients ?? []),
    ...(bootstrapProduct.semanticFacts?.benefits ?? []),
    ...(bootstrapProduct.semanticFacts?.effects ?? []),
    ...(bootstrapProduct.semanticFacts?.ingredientBenefitLinks.flatMap((link) => [
      link.ingredient,
      link.benefit,
      link.effect,
      link.sentence,
      link.sourceText
    ]) ?? [])
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0)).join("\n");
}

function flattenNonReviewTextValues(value: unknown, depth = 0): string[] {
  if (depth > 12) {
    return [];
  }
  if (typeof value === "string") {
    const text = cleanString(value);
    return text ? [text] : [];
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenNonReviewTextValues(item, depth + 1));
  }
  if (!value || typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  if (isReviewProvenanceRecord(record)) {
    return [];
  }
  return Object.entries(record).flatMap(([key, item]) =>
    isReviewProvenanceKey(key) ? [] : flattenNonReviewTextValues(item, depth + 1));
}

function flattenReviewProvenanceTextValues(value: unknown, reviewScope = false, depth = 0): string[] {
  if (depth > 12) {
    return [];
  }
  if (typeof value === "string") {
    const text = cleanString(value);
    return reviewScope && text ? [text] : [];
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return reviewScope ? [String(value)] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => flattenReviewProvenanceTextValues(item, reviewScope, depth + 1));
  }
  if (!value || typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  const recordReviewScope = reviewScope || isReviewProvenanceRecord(record);
  return Object.entries(record).flatMap(([key, item]) =>
    flattenReviewProvenanceTextValues(item, recordReviewScope || isReviewProvenanceKey(key), depth + 1));
}

function isReviewProvenanceKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  return /(?:review|reviewer|customerfeedback|testimonial|rating|feedback|리뷰|후기|평점|レビュー|口コミ|評価)/iu.test(normalized);
}

function isReviewProvenanceRecord(record: Record<string, unknown>): boolean {
  return Object.entries(record).some(([key, value]) =>
    /^(?:category|kind|role|sectionType|source|sourceType|type)$/i.test(key)
    && typeof value === "string"
    && /(?:review|customer\s*(?:experience|feedback)|testimonial|리뷰|후기|レビュー|口コミ)/iu.test(value));
}

function isReviewBackedSourceUnit(value: string, normalizedReviewTexts: string[]): boolean {
  const normalized = normalizeEvidenceText(value);
  if (!normalized) {
    return false;
  }
  return normalizedReviewTexts.some((reviewText) =>
    reviewText === normalized
    || (normalized.length >= 12 && reviewText.includes(normalized))
    || (reviewText.length >= 12 && normalized.includes(reviewText)));
}

function parseProductNormalizationJson(rawText: string): PdpGeoProductNormalizationResult {
  const jsonText = jsonTextFromProviderPayload(rawText);
  if (!jsonText) {
    return { warnings: ["No parseable product normalization JSON returned."], rawText };
  }

  try {
    const decoded = JSON.parse(jsonText) as unknown;
    const validated = flexibleProductNormalizationEnvelopeSchema.safeParse(decoded);
    if (!validated.success) {
      const issues = validated.error.issues.slice(0, 3)
        .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
        .join("; ");
      return {
        warnings: [`Product normalization JSON failed schema validation${issues ? `: ${issues}` : "."}`],
        rawText
      };
    }
    const parsed = validated.data;
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

function toGeminiProductNormalizationSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(toGeminiProductNormalizationSchema);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  const alternatives = Array.isArray(record.anyOf) ? record.anyOf : undefined;
  if (alternatives?.length === 2) {
    const nonNull = alternatives.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).type !== "null");
    const nullable = alternatives.some((item) => item && typeof item === "object" && (item as Record<string, unknown>).type === "null");
    if (nonNull && nullable) {
      return {
        ...(toGeminiProductNormalizationSchema(nonNull) as Record<string, unknown>),
        nullable: true
      };
    }
  }
  return Object.fromEntries(Object.entries(record).flatMap(([key, child]) => {
    if (key === "$schema" || key === "additionalProperties" || key === "description") {
      return [];
    }
    if (key === "type" && typeof child === "string") {
      return [[key, child.toUpperCase()]];
    }
    return [[key, toGeminiProductNormalizationSchema(child)]];
  }));
}

function normalizePartialProduct(value: unknown): Partial<PdpProductSignal> | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const compacted = compactNullishPatch(value);
  return compacted && typeof compacted === "object"
    ? compacted as Partial<PdpProductSignal>
    : undefined;
}

function compactNullishPatch(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(compactNullishPatch).filter((item) => item !== undefined);
  }
  if (!value || typeof value !== "object") {
    return value === null ? undefined : value;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
    const compacted = compactNullishPatch(item);
    return compacted === undefined ? [] : [[key, compacted]];
  }));
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
