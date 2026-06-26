import { createPdpGeoContentHtml } from "./generate";
import type {
  JsonObject,
  PdpGeoContentArtifact,
  PdpGeoCopyRefinementRequest,
  PdpGeoCopyRefinementResult,
  PdpGeoCopyRefinementSettings,
  PdpGeoCopyRefiner,
  PdpGeoEvidence,
  PdpGeoGeneratorOptions,
  PdpGeoLocale,
  PdpGeoSchemaMarkup,
  PdpGeoTokenUsage
} from "./types";

interface CopyRefinementApplication {
  schemaMarkup: PdpGeoSchemaMarkup;
  content: PdpGeoContentArtifact;
  evidence: PdpGeoEvidence[];
  warnings: string[];
  usage?: PdpGeoTokenUsage;
  called: boolean;
  applied: boolean;
}

interface ModelBackedCopyRefinerConfig {
  provider: Exclude<PdpGeoGeneratorOptions["provider"], undefined>;
  apiKey?: string;
  model?: string;
  endpoint?: string;
  deployment?: string;
  apiVersion?: string;
  temperature?: number;
}

type ChatCompletionsPayload = {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: unknown;
};

const CHAT_COMPLETIONS_TIMEOUT_MS = 60_000;
const maxEvidenceItems = 10;
const maxRagChunks = 8;
const strategicRagKinds = new Set(["geo-research", "geo-paper", "cep", "eeat"]);

export async function refinePdpGeoCopy(
  request: PdpGeoCopyRefinementRequest,
  options: PdpGeoGeneratorOptions
): Promise<CopyRefinementApplication> {
  const resolved = resolveCopyRefiner(options);
  const baseApplication: CopyRefinementApplication = {
    schemaMarkup: request.schemaMarkup,
    content: request.content,
    evidence: [],
    warnings: [],
    called: false,
    applied: false
  };

  if (!resolved.refiner) {
    if (resolved.warning) {
      baseApplication.warnings.push(resolved.warning);
      baseApplication.evidence.push({ field: "copy.refinement", source: "llm", value: `Copy refinement skipped: ${resolved.warning}` });
    }
    return baseApplication;
  }

  try {
    const result = await resolved.refiner.refineCopy(request);
    const applied = applyCopyRefinement(request, result);
    const warnings = [
      ...(result.warnings ?? []),
      ...applied.warnings
    ];
    const evidence = [...applied.evidence];
    const strategicSources = strategicExposureSourceSummary(request);

    if (applied.applied) {
      evidence.push({
        field: "copy.refinement",
        source: "llm",
        value: "Model-backed copy refinement selected AI-exposure-worthy product facts using GEO research, CEP, and E-E-A-T guidance, then rewrote schema/content descriptions without adding unsupported claims."
      });
    } else {
      evidence.push({
        field: "copy.refinement",
        source: "llm",
        value: "Model-backed copy refinement returned no accepted public-copy changes."
      });
    }
    if (strategicSources) {
      evidence.push({
        field: "copy.refinement.strategy",
        source: "rag",
        value: `Strategic copy selection considered GEO research/geo-paper, CEP, and E-E-A-T guidance from: ${strategicSources}`
      });
    }
    for (const warning of warnings) {
      evidence.push({ field: "copy.refinement.warning", source: "llm", value: warning });
    }

    return {
      ...baseApplication,
      schemaMarkup: applied.schemaMarkup,
      content: applied.content,
      evidence,
      warnings,
      usage: result.usage,
      called: true,
      applied: applied.applied
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Copy refinement provider failed.";
    return {
      ...baseApplication,
      evidence: [{ field: "copy.refinement", source: "llm", value: `Copy refinement skipped: ${message}` }],
      warnings: [message],
      called: true
    };
  }
}

export class ModelBackedCopyRefiner implements PdpGeoCopyRefiner {
  constructor(private readonly config: ModelBackedCopyRefinerConfig) {}

  async refineCopy(request: PdpGeoCopyRefinementRequest): Promise<PdpGeoCopyRefinementResult> {
    switch (this.config.provider) {
      case "openai":
        return this.refineWithOpenAI(request);
      case "gemini":
        return this.refineWithGemini(request);
      case "azure-openai":
        return this.refineWithAzureApi(request);
      case "aistudio":
        return this.refineWithAistudio(request);
      case "custom":
      case "mock":
      default:
        return { warnings: [`${this.config.provider} copy refinement provider has no model-backed adapter.`] };
    }
  }

  private async refineWithOpenAI(request: PdpGeoCopyRefinementRequest): Promise<PdpGeoCopyRefinementResult> {
    if (!this.config.apiKey || !this.config.model) {
      throw new Error("OPENAI_API_KEY and OPENAI_MODEL are required for copy refinement.");
    }

    const prompt = createCopyRefinementPrompt(request);
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
      throw new Error(`OpenAI copy refinement failed: ${response.status}`);
    }

    const payloadText = await response.text();
    const payload = JSON.parse(payloadText) as Record<string, unknown>;
    return {
      ...parseCopyRefinementJson(payloadText),
      usage: tokenUsageFromOpenAi(payload.usage)
    };
  }

  private async refineWithGemini(request: PdpGeoCopyRefinementRequest): Promise<PdpGeoCopyRefinementResult> {
    if (!this.config.apiKey || !this.config.model) {
      throw new Error("GEMINI_API_KEY and GEMINI_MODEL are required for copy refinement.");
    }

    const prompt = createCopyRefinementPrompt(request);
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
      throw new Error(`Gemini copy refinement failed: ${response.status}`);
    }

    const payload = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: unknown;
    };
    const rawText = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("\n") ?? "";
    return {
      ...parseCopyRefinementJson(rawText),
      usage: tokenUsageFromGemini(payload.usageMetadata)
    };
  }

  private async refineWithAzureApi(request: PdpGeoCopyRefinementRequest): Promise<PdpGeoCopyRefinementResult> {
    if (!this.config.apiKey || !this.config.endpoint || !this.config.deployment) {
      throw new Error("AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, and AZURE_OPENAI_DEPLOYMENT are required for copy refinement.");
    }

    const apiVersion = this.config.apiVersion ?? "2025-04-01-preview";
    const endpoint = this.config.endpoint.replace(/\/$/, "");
    const url = `${endpoint}/openai/deployments/${this.config.deployment}/chat/completions?api-version=${apiVersion}`;
    const prompt = createCopyRefinementPrompt(request);
    const payload = await requestChatCompletionsJson(
      url,
      { "api-key": this.config.apiKey },
      {
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user }
        ],
        ...temperatureBody(this.config.temperature)
      },
      "Azure copy refinement"
    );
    return {
      ...parseCopyRefinementJson(payload.choices?.[0]?.message?.content ?? ""),
      usage: tokenUsageFromChatCompletions(payload.usage)
    };
  }

  private async refineWithAistudio(request: PdpGeoCopyRefinementRequest): Promise<PdpGeoCopyRefinementResult> {
    if (!this.config.apiKey || !this.config.endpoint || !this.config.deployment) {
      throw new Error("AI Studio endpoint, API key, and a reasoning model id are required for copy refinement.");
    }

    // AI Studio proxies Azure OpenAI chat completions: same path, Bearer auth, optional api-version.
    const endpoint = this.config.endpoint.replace(/\/$/, "");
    const apiVersion = this.config.apiVersion?.trim();
    const query = apiVersion ? `?api-version=${encodeURIComponent(apiVersion)}` : "";
    const url = `${endpoint}/openai/deployments/${this.config.deployment}/chat/completions${query}`;
    const prompt = createCopyRefinementPrompt(request);
    const payload = await requestChatCompletionsJson(
      url,
      { Authorization: `Bearer ${this.config.apiKey}` },
      {
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user }
        ],
        ...temperatureBody(this.config.temperature)
      },
      "AI Studio copy refinement"
    );
    return {
      ...parseCopyRefinementJson(payload.choices?.[0]?.message?.content ?? ""),
      usage: tokenUsageFromChatCompletions(payload.usage)
    };
  }
}

/**
 * Builds the optional `temperature` portion of a chat-completions body.
 * Returns an empty object when no temperature is configured so the request omits
 * the field entirely, letting models that only accept their default value (e.g. gpt-5.5) succeed.
 */
export function temperatureBody(temperature: number | undefined): { temperature?: number } {
  return typeof temperature === "number" && Number.isFinite(temperature) ? { temperature } : {};
}

async function requestChatCompletionsJson(
  url: string,
  authHeaders: Record<string, string>,
  body: Record<string, unknown>,
  failureLabel: string
): Promise<ChatCompletionsPayload> {
  const response = await postChatCompletions(url, authHeaders, body, failureLabel);

  if (response.ok) {
    return response.json() as Promise<ChatCompletionsPayload>;
  }

  const suffix = await responseErrorSuffix(response);
  if (body.temperature !== undefined && isUnsupportedTemperatureError(suffix)) {
    const { temperature: _temperature, ...retryBody } = body;
    const retryResponse = await postChatCompletions(url, authHeaders, retryBody, failureLabel);

    if (retryResponse.ok) {
      return retryResponse.json() as Promise<ChatCompletionsPayload>;
    }

    throw new Error(`${failureLabel} failed: ${retryResponse.status}${await responseErrorSuffix(retryResponse)}`);
  }

  throw new Error(`${failureLabel} failed: ${response.status}${suffix}`);
}

function postChatCompletions(
  url: string,
  authHeaders: Record<string, string>,
  body: Record<string, unknown>,
  failureLabel: string
): Promise<Response> {
  return fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders
    },
    body: JSON.stringify(body)
  }, CHAT_COMPLETIONS_TIMEOUT_MS, failureLabel);
}

function isUnsupportedTemperatureError(message: string): boolean {
  return /unsupported value[^]*temperature|temperature[^]*(?:unsupported|only the default)/i.test(message);
}

async function responseErrorSuffix(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned ? ` - ${cleaned.slice(0, 500)}` : "";
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

function resolveCopyRefiner(options: PdpGeoGeneratorOptions): { refiner?: PdpGeoCopyRefiner; warning?: string } {
  if (options.customCopyRefiner) {
    return { refiner: options.customCopyRefiner };
  }

  const settings = options.copyRefinement;
  const provider = settings?.provider ?? options.provider ?? "mock";
  const explicitEnabled = settings?.enabled;
  const enabled = explicitEnabled ?? (provider !== "mock" && provider !== "custom" && Boolean(settings?.apiKey ?? options.apiKey));

  if (!enabled) {
    return {};
  }
  if (provider === "mock" || provider === "custom") {
    return explicitEnabled
      ? { warning: `${provider} copy refinement requires customCopyRefiner.` }
      : {};
  }

  return {
    refiner: new ModelBackedCopyRefiner({
      provider,
      apiKey: settings?.apiKey ?? options.apiKey,
      model: settings?.model ?? options.model,
      endpoint: settings?.endpoint ?? options.endpoint,
      deployment: settings?.deployment ?? options.deployments?.reasoning ?? options.deployment,
      apiVersion: settings?.apiVersion ?? options.apiVersion,
      temperature: options.temperature
    })
  };
}

function createCopyRefinementPrompt(request: PdpGeoCopyRefinementRequest): { system: string; user: string } {
  return {
    system: [
      "You are a conservative GEO product-copy reasoning agent for structured PDP schema descriptions.",
      "Return strict JSON only: {\"schemaDescriptions\":{\"webPage\":\"\",\"product\":\"\"},\"schemaProperties\":{\"Ingredient/effect detail\":\"\",\"Reported details\":\"\",\"Customer review context\":\"\"},\"faqAnswers\":[{\"question\":\"\",\"answer\":\"\"}],\"contentSections\":{\"description\":\"\",\"quickFacts\":\"\",\"faq\":\"\"},\"warnings\":[]}.",
      "Your job is to use GEO research/geo-paper, CEP, and E-E-A-T guidance to identify product facts, keywords, and source-backed phrases that are likely to be useful in AI answer exposure.",
      "Use selected strategic chunks as the primary task-specific guidance. Use hydrated full RAG documents only as controlled background for missing context, conflict resolution, and policy completeness.",
      "When guidance conflicts, apply this priority: source product evidence first, E-E-A-T trust and claim safety, schema validity, GEO answer-readiness, then CEP/customer phrasing.",
      "Extract those useful facts from the supplied product evidence only, then combine them into natural public product sentences.",
      "Prioritize concrete facts: product type, target concern or customer entry point, differentiating formula/ingredient, measured effect, usage context, and review-intent language.",
      "Use only the supplied product evidence and strategic RAG guidance. Do not invent claims, ingredients, metrics, study details, prices, awards, or certifications.",
      "Preserve numeric claims, study populations, usage instructions, ingredient names, and product names exactly when they appear in evidence.",
      "For schemaProperties, refine only existing Product.additionalProperty values. Rewrite rigid labels such as Reported details, Ingredient/effect detail, and Customer review context into natural source-backed target-locale sentences.",
      "For faqAnswers, keep the same question intent and order as currentCopy.faqAnswers. Improve answer naturalness and GEO usefulness by blending ingredient, benefit/effect, metric, usage, and review evidence only when supplied.",
      "Never add a new number, percentage, duration, sample size, study population, usage period, certification, or claim mechanism that is absent from productEvidence or currentCopy.",
      "Rewrite OCR-like evidence into natural target-locale sentences before using it. Never copy raw all-caps image text, footnote markers, bilingual product labels, or alternate-language product-type labels into public copy.",
      "Respect field evidence contracts: HowTo and usage answers may contain only actionable usage directions; ingredient sections may contain only ingredient/formula/full-INCI evidence; benefit sections may contain only outcomes, effects, review-backed positives, or concise evidence topics.",
      "If a sentence is useful evidence but belongs to a different field, rewrite it only in the correct field and do not move the raw phrase across public fields.",
      "Do not mention the strategy labels in the public copy: no RAG, GEO, geo-paper, CEP, E-E-A-T, schema optimization, citation-ready, OCR, image caption, product shot, pack shot, with text, or in the corner.",
      "Keep the output in the requested locale and make Product.description suitable for schema.org Product.description.",
      "If evidence is insufficient, return the current copy unchanged and explain the limitation in warnings."
    ].join("\n"),
    user: JSON.stringify(createCopyRefinementPayload(request), null, 2)
  };
}

function createCopyRefinementPayload(request: PdpGeoCopyRefinementRequest): Record<string, unknown> {
  const descriptions = readSchemaDescriptions(request.schemaMarkup.jsonLd);
  const schemaProperties = readProductAdditionalProperties(request.schemaMarkup.jsonLd);
  const faqAnswers = readSchemaFaqItems(request.schemaMarkup.jsonLd);
  const strategicChunks = selectStrategicRagGuidanceChunks(request.ragChunks, maxRagChunks);
  return {
    task: "Select AI-exposure-worthy product keywords and sentences from productEvidence, guided by GEO research/geo-paper, CEP, and E-E-A-T. Combine only grounded facts into public PDP description copy.",
    locale: request.locale,
    market: request.market,
    currentCopy: {
      schemaDescriptions: descriptions,
      schemaProperties,
      faqAnswers,
      contentSections: {
        description: request.content.sections.description,
        quickFacts: request.content.sections.quickFacts,
        faq: request.content.sections.faq
      }
    },
    productEvidence: {
      name: request.product.name,
      originalName: request.product.originalName,
      brand: request.product.brand,
      category: request.product.category,
      benefits: request.product.benefits.slice(0, maxEvidenceItems),
      effects: request.product.effects.slice(0, maxEvidenceItems),
      ingredients: request.product.ingredients.slice(0, maxEvidenceItems),
      usage: request.product.usage.slice(0, maxEvidenceItems),
      metrics: request.product.metrics.slice(0, maxEvidenceItems),
      reviewSummary: {
        rating: request.product.reviews.rating,
        reviewCount: request.product.reviews.reviewCount,
        keywords: request.product.reviews.keywords.slice(0, maxEvidenceItems),
        examples: request.product.reviews.items.map((review) => review.body).slice(0, 5)
      },
      sourceTexts: unique(request.product.sourceTexts).slice(0, maxEvidenceItems)
    },
    extractionPriorities: [
      "Choose product facts that directly answer likely generative-search questions.",
      "Prefer source-backed specificity over broad marketing language.",
      "Map CEP/customer-entry-point language to the product's actual target concern, routine moment, or comparison context.",
      "Use E-E-A-T guidance to keep claims verifiable, attributed to page evidence, and free of exaggeration.",
      "Use GEO research guidance to make descriptions answer-ready without exposing internal optimization language."
    ],
    strategicExposureGuidance: strategicChunks.map(formatRagGuidanceChunk),
    strategicFullDocuments: (request.hydratedRagDocuments ?? []).map(formatHydratedRagDocument),
    hydrationPolicy: [
      "Selected chunks are the highest-priority task guidance.",
      "Hydrated full documents are included to prevent missing policy context and to resolve overlaps.",
      "Do not apply any hydrated document example or claim unless the productEvidence supports it.",
      "Do not mention internal strategy labels in public copy."
    ],
    ragGuidance: request.ragChunks.slice(0, maxRagChunks).map((chunk) => ({
      ...formatRagGuidanceChunk(chunk),
      priority: isStrategicExposureChunk(chunk) ? "strategic" : "supporting"
    })),
    reasoning: request.reasoning ? {
      principles: request.reasoning.principles,
      selectedSources: request.reasoning.selectedSources,
      decisions: request.reasoning.decisions.map((decision) => ({
        principle: decision.principle,
        enabled: decision.enabled,
        confidence: decision.confidence,
        rationale: decision.rationale,
        ragSources: decision.ragSources,
        productEvidence: decision.productEvidence
      }))
    } : undefined
  };
}

function applyCopyRefinement(
  request: PdpGeoCopyRefinementRequest,
  result: PdpGeoCopyRefinementResult
): Pick<CopyRefinementApplication, "schemaMarkup" | "content" | "evidence" | "warnings" | "applied"> {
  const warnings: string[] = [];
  const evidence: PdpGeoEvidence[] = [];
  const descriptions = readSchemaDescriptions(request.schemaMarkup.jsonLd);
  const claimEvidenceCorpus = createClaimEvidenceCorpus(request);
  const productDescription = acceptRefinedText(
    result.schemaDescriptions?.product ?? result.contentSections?.description,
    descriptions.product ?? request.content.sections.description,
    "Product.description",
    warnings,
    { evidenceCorpus: claimEvidenceCorpus, requireSupportedClaimTokens: true }
  );
  const webPageDescription = acceptRefinedText(
    result.schemaDescriptions?.webPage,
    descriptions.webPage,
    "WebPage.description",
    warnings,
    { evidenceCorpus: claimEvidenceCorpus, requireSupportedClaimTokens: true }
  );
  const contentDescription = acceptRefinedText(
    result.contentSections?.description ?? productDescription,
    request.content.sections.description,
    "content.sections.description",
    warnings,
    { evidenceCorpus: claimEvidenceCorpus, requireSupportedClaimTokens: true }
  );
  const contentQuickFacts = acceptRefinedText(
    result.contentSections?.quickFacts,
    request.content.sections.quickFacts,
    "content.sections.quickFacts",
    warnings,
    { minLength: 20, maxLength: 2200, evidenceCorpus: claimEvidenceCorpus, requireSupportedClaimTokens: true }
  );
  const contentFaq = acceptRefinedText(
    result.contentSections?.faq,
    request.content.sections.faq,
    "content.sections.faq",
    warnings,
    { minLength: 20, maxLength: 3200, evidenceCorpus: claimEvidenceCorpus, requireSupportedClaimTokens: true }
  );

  const nextProductDescription = productDescription ?? contentDescription;
  const nextContentDescription = contentDescription ?? productDescription;
  let schemaMarkup = request.schemaMarkup;
  let content = request.content;
  let applied = false;

  if (nextProductDescription && nextProductDescription !== descriptions.product) {
    schemaMarkup = writeSchemaDescription(schemaMarkup, "Product", nextProductDescription);
    evidence.push({ field: "schema.Product.description", source: "llm", value: summarizeRefinement(descriptions.product, nextProductDescription) });
    applied = true;
  }

  if (webPageDescription && webPageDescription !== descriptions.webPage) {
    schemaMarkup = writeSchemaDescription(schemaMarkup, "WebPage", webPageDescription);
    evidence.push({ field: "schema.WebPage.description", source: "llm", value: summarizeRefinement(descriptions.webPage, webPageDescription) });
    applied = true;
  }

  if (nextContentDescription && nextContentDescription !== request.content.sections.description) {
    const sections = {
      ...request.content.sections,
      description: nextContentDescription
    };
    content = {
      ...request.content,
      sections,
      html: createPdpGeoContentHtml(sections, request.locale)
    };
    evidence.push({ field: "content.description", source: "llm", value: summarizeRefinement(request.content.sections.description, nextContentDescription) });
    applied = true;
  }

  const propertyRefinements = acceptedSchemaPropertyRefinements(
    request,
    result.schemaProperties,
    warnings,
    claimEvidenceCorpus
  );
  for (const refinement of propertyRefinements) {
    schemaMarkup = writeProductAdditionalProperty(schemaMarkup, refinement.name, refinement.value);
    evidence.push({ field: `schema.Product.additionalProperty.${refinement.name}`, source: "llm", value: summarizeRefinement(refinement.before, refinement.value) });
    applied = true;
  }

  const faqRefinements = acceptedFaqAnswerRefinements(request, result.faqAnswers, warnings, claimEvidenceCorpus);
  for (const refinement of faqRefinements) {
    schemaMarkup = writeFaqAnswer(schemaMarkup, refinement.index, refinement.answer);
    evidence.push({ field: `schema.FAQPage.mainEntity.${refinement.index + 1}.acceptedAnswer`, source: "llm", value: summarizeRefinement(refinement.before, refinement.answer) });
    applied = true;
  }

  const nextQuickFacts = contentQuickFacts;
  const nextFaq = contentFaq ?? (faqRefinements.length > 0 ? createFaqSectionFromSchema(schemaMarkup.jsonLd) : undefined);
  if ((nextQuickFacts && nextQuickFacts !== content.sections.quickFacts) || (nextFaq && nextFaq !== content.sections.faq)) {
    const sections = {
      ...content.sections,
      quickFacts: nextQuickFacts ?? content.sections.quickFacts,
      faq: nextFaq ?? content.sections.faq
    };
    content = {
      ...content,
      sections,
      html: createPdpGeoContentHtml(sections, request.locale)
    };
    if (nextQuickFacts && nextQuickFacts !== request.content.sections.quickFacts) {
      evidence.push({ field: "content.quickFacts", source: "llm", value: summarizeRefinement(request.content.sections.quickFacts, nextQuickFacts) });
    }
    if (nextFaq && nextFaq !== request.content.sections.faq) {
      evidence.push({ field: "content.faq", source: "llm", value: summarizeRefinement(request.content.sections.faq, nextFaq) });
    }
    applied = true;
  }

  return {
    schemaMarkup,
    content,
    evidence,
    warnings,
    applied
  };
}

interface AcceptRefinedTextOptions {
  minLength?: number;
  maxLength?: number;
  evidenceCorpus?: string;
  requireSupportedClaimTokens?: boolean;
}

function acceptRefinedText(
  value: unknown,
  fallbackValue: string | undefined,
  field: string,
  warnings: string[],
  options: AcceptRefinedTextOptions = {}
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const text = cleanText(value);
  if (!text || text === fallbackValue) {
    return text || undefined;
  }
  const minLength = options.minLength ?? 40;
  const maxLength = options.maxLength ?? 1800;
  if (text.length < minLength) {
    warnings.push(`${field} refinement rejected because it is too short.`);
    return undefined;
  }
  if (text.length > maxLength) {
    warnings.push(`${field} refinement rejected because it is too long.`);
    return undefined;
  }
  if (containsInternalOrVisualArtifact(text)) {
    warnings.push(`${field} refinement rejected because it contains internal labels or visual-caption artifacts.`);
    return undefined;
  }
  if (options.requireSupportedClaimTokens && hasUnsupportedClaimTokens(text, options.evidenceCorpus ?? "")) {
    warnings.push(`${field} refinement rejected because it introduced unsupported numeric or study claim details.`);
    return undefined;
  }

  return text;
}

const refinableSchemaPropertyNames = new Set([
  "Ingredient/effect detail",
  "Reported details",
  "Customer review context"
]);

function acceptedSchemaPropertyRefinements(
  request: PdpGeoCopyRefinementRequest,
  values: PdpGeoCopyRefinementResult["schemaProperties"],
  warnings: string[],
  evidenceCorpus: string
): Array<{ name: string; value: string; before: string }> {
  if (!values || !isRecord(values)) {
    return [];
  }

  const currentProperties = readProductAdditionalProperties(request.schemaMarkup.jsonLd);
  return Object.entries(values).flatMap(([name, value]) => {
    if (!refinableSchemaPropertyNames.has(name)) {
      return [];
    }
    const before = currentProperties[name];
    if (!before) {
      return [];
    }
    const accepted = acceptRefinedText(
      value,
      before,
      `Product.additionalProperty.${name}`,
      warnings,
      { minLength: 12, maxLength: 900, evidenceCorpus, requireSupportedClaimTokens: true }
    );
    return accepted && accepted !== before ? [{ name, value: accepted, before }] : [];
  });
}

function acceptedFaqAnswerRefinements(
  request: PdpGeoCopyRefinementRequest,
  values: PdpGeoCopyRefinementResult["faqAnswers"],
  warnings: string[],
  evidenceCorpus: string
): Array<{ index: number; answer: string; before: string }> {
  if (!Array.isArray(values)) {
    return [];
  }

  const currentFaq = readSchemaFaqItems(request.schemaMarkup.jsonLd);
  return values.flatMap((item, index) => {
    if (!isRecord(item)) {
      return [];
    }
    const answer = typeof item.answer === "string" ? item.answer : undefined;
    const matchingIndex = typeof item.question === "string"
      ? currentFaq.findIndex((faq) => normalizeComparableText(faq.question) === normalizeComparableText(item.question ?? ""))
      : index;
    const faqIndex = matchingIndex >= 0 ? matchingIndex : index;
    const before = currentFaq[faqIndex]?.answer;
    if (!before) {
      return [];
    }
    const accepted = acceptRefinedText(
      answer,
      before,
      `FAQPage.mainEntity.${faqIndex + 1}.acceptedAnswer`,
      warnings,
      { minLength: 24, maxLength: 900, evidenceCorpus, requireSupportedClaimTokens: true }
    );
    return accepted && accepted !== before ? [{ index: faqIndex, answer: accepted, before }] : [];
  });
}

function normalizeComparableText(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function createClaimEvidenceCorpus(request: PdpGeoCopyRefinementRequest): string {
  return normalizeClaimTokenText(JSON.stringify({
    product: request.product,
    currentCopy: {
      schemaDescriptions: readSchemaDescriptions(request.schemaMarkup.jsonLd),
      schemaProperties: readProductAdditionalProperties(request.schemaMarkup.jsonLd),
      faqAnswers: readSchemaFaqItems(request.schemaMarkup.jsonLd),
      contentSections: request.content.sections
    }
  }));
}

function hasUnsupportedClaimTokens(value: string, evidenceCorpus: string): boolean {
  const corpus = normalizeClaimTokenText(evidenceCorpus);
  return extractClaimTokens(value).some((token) => !corpus.includes(token));
}

function extractClaimTokens(value: string): string[] {
  return unique([
    ...(value.match(/[+\-−]?\d+(?:\.\d+)?\s?(?:%|배)/gi) ?? []),
    ...(value.match(/\b\d+(?:\.\d+)?\s?(?:weeks?|days?|hours?|users?|participants?|women|men|subjects?|reviews?)\b/gi) ?? []),
    ...(value.match(/\b(?:after|in)\s+\d+(?:\.\d+)?\s?(?:weeks?|days?|hours?)\b/gi) ?? []),
    ...(value.match(/\b\d+(?:\.\d+)?\s?(?:명|인|참여자|대상|사용자|여성|남성|주|일|시간|회)\b/g) ?? [])
  ].map(normalizeClaimTokenText));
}

function normalizeClaimTokenText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function readSchemaDescriptions(jsonLd: JsonObject): { webPage?: string; product?: string } {
  const graph = Array.isArray(jsonLd["@graph"]) ? jsonLd["@graph"] : [];
  const webPage = graph.find((node) => isSchemaNodeOfType(node, "WebPage"));
  const product = graph.find((node) => isSchemaNodeOfType(node, "Product"));
  return {
    webPage: readDescription(webPage),
    product: readDescription(product)
  };
}

function readProductAdditionalProperties(jsonLd: JsonObject): Record<string, string> {
  const graph = Array.isArray(jsonLd["@graph"]) ? jsonLd["@graph"] : [];
  const product = graph.find((node) => isSchemaNodeOfType(node, "Product"));
  if (!isRecord(product) || !Array.isArray(product.additionalProperty)) {
    return {};
  }

  const properties: Record<string, string> = {};
  for (const item of product.additionalProperty) {
    if (!isRecord(item) || typeof item.name !== "string" || typeof item.value !== "string") {
      continue;
    }
    properties[item.name] = item.value;
  }
  return properties;
}

function readSchemaFaqItems(jsonLd: JsonObject): Array<{ question: string; answer: string }> {
  const graph = Array.isArray(jsonLd["@graph"]) ? jsonLd["@graph"] : [];
  const faqPage = graph.find((node) => isSchemaNodeOfType(node, "FAQPage"));
  if (!isRecord(faqPage) || !Array.isArray(faqPage.mainEntity)) {
    return [];
  }

  return faqPage.mainEntity.flatMap((item): Array<{ question: string; answer: string }> => {
    if (!isRecord(item) || typeof item.name !== "string") {
      return [];
    }
    const acceptedAnswer = isRecord(item.acceptedAnswer) ? item.acceptedAnswer : undefined;
    const answer = acceptedAnswer && typeof acceptedAnswer.text === "string" ? acceptedAnswer.text : undefined;
    return answer ? [{ question: item.name, answer }] : [];
  });
}

function writeSchemaDescription(schemaMarkup: PdpGeoSchemaMarkup, type: "WebPage" | "Product", description: string): PdpGeoSchemaMarkup {
  const jsonLd = cloneJsonObject(schemaMarkup.jsonLd);
  const graph = Array.isArray(jsonLd["@graph"]) ? jsonLd["@graph"] : [];
  for (const node of graph) {
    if (isSchemaNodeOfType(node, type) && isRecord(node)) {
      node.description = description;
    }
  }
  return schemaMarkupFromJsonLd(jsonLd);
}

function writeProductAdditionalProperty(schemaMarkup: PdpGeoSchemaMarkup, name: string, value: string): PdpGeoSchemaMarkup {
  const jsonLd = cloneJsonObject(schemaMarkup.jsonLd);
  const graph = Array.isArray(jsonLd["@graph"]) ? jsonLd["@graph"] : [];
  const product = graph.find((node) => isSchemaNodeOfType(node, "Product"));
  if (isRecord(product) && Array.isArray(product.additionalProperty)) {
    for (const item of product.additionalProperty) {
      if (isRecord(item) && item.name === name) {
        item.value = value;
      }
    }
  }
  return schemaMarkupFromJsonLd(jsonLd);
}

function writeFaqAnswer(schemaMarkup: PdpGeoSchemaMarkup, index: number, answer: string): PdpGeoSchemaMarkup {
  const jsonLd = cloneJsonObject(schemaMarkup.jsonLd);
  const graph = Array.isArray(jsonLd["@graph"]) ? jsonLd["@graph"] : [];
  const faqPage = graph.find((node) => isSchemaNodeOfType(node, "FAQPage"));
  const item = isRecord(faqPage) && Array.isArray(faqPage.mainEntity) ? faqPage.mainEntity[index] : undefined;
  const acceptedAnswer = isRecord(item) && isRecord(item.acceptedAnswer) ? item.acceptedAnswer : undefined;
  if (acceptedAnswer) {
    acceptedAnswer.text = answer;
  }
  return schemaMarkupFromJsonLd(jsonLd);
}

function schemaMarkupFromJsonLd(jsonLd: JsonObject): PdpGeoSchemaMarkup {
  return {
    jsonLd,
    scriptTag: `<script type="application/ld+json">${escapeScriptJson(JSON.stringify(jsonLd, null, 2))}</script>`
  };
}

function createFaqSectionFromSchema(jsonLd: JsonObject): string | undefined {
  const items = readSchemaFaqItems(jsonLd);
  return items.length > 0
    ? items.map((item) => `Q. ${item.question}\nA. ${item.answer}`).join("\n\n")
    : undefined;
}

function readDescription(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.description !== "string") {
    return undefined;
  }
  return value.description;
}

function isSchemaNodeOfType(value: unknown, type: string): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const nodeType = value["@type"];
  return nodeType === type || (Array.isArray(nodeType) && nodeType.includes(type));
}

function summarizeRefinement(before: string | undefined, after: string): string {
  return `Refined from "${truncate(before ?? "", 180)}" to "${truncate(after, 220)}"`;
}

function parseCopyRefinementJson(text: string): PdpGeoCopyRefinementResult {
  const rawText = parseProviderText(text);
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { warnings: ["No parseable copy refinement JSON returned."], rawText };
  }

  const payload = JSON.parse(jsonMatch[0]) as Partial<PdpGeoCopyRefinementResult>;
  return {
    schemaDescriptions: isRecord(payload.schemaDescriptions) ? {
      webPage: typeof payload.schemaDescriptions.webPage === "string" ? payload.schemaDescriptions.webPage : undefined,
      product: typeof payload.schemaDescriptions.product === "string" ? payload.schemaDescriptions.product : undefined
    } : undefined,
    schemaProperties: isRecord(payload.schemaProperties)
      ? Object.fromEntries(Object.entries(payload.schemaProperties).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : undefined,
    faqAnswers: Array.isArray(payload.faqAnswers)
      ? payload.faqAnswers
        .filter(isRecord)
        .map((item) => ({
          question: typeof item.question === "string" ? item.question : undefined,
          answer: typeof item.answer === "string" ? item.answer : undefined
        }))
      : undefined,
    contentSections: isRecord(payload.contentSections)
      ? {
          description: typeof payload.contentSections.description === "string" ? payload.contentSections.description : undefined,
          quickFacts: typeof payload.contentSections.quickFacts === "string" ? payload.contentSections.quickFacts : undefined,
          faq: typeof payload.contentSections.faq === "string" ? payload.contentSections.faq : undefined
        }
      : undefined,
    warnings: Array.isArray(payload.warnings) ? payload.warnings.map(String).filter(Boolean) : undefined,
    rawText
  };
}

function isStrategicExposureChunk(chunk: PdpGeoCopyRefinementRequest["ragChunks"][number]): boolean {
  const kind = String(chunk.kind);
  return strategicRagKinds.has(kind)
    || /geo[-_\s]?(research|paper)|generative|cep|customer entry point|e-e-a-t|eeat/i.test(`${chunk.source} ${chunk.title ?? ""}`);
}

function selectStrategicRagGuidanceChunks(
  chunks: PdpGeoCopyRefinementRequest["ragChunks"],
  limit: number
): PdpGeoCopyRefinementRequest["ragChunks"] {
  const strategicChunks = chunks.filter(isStrategicExposureChunk);
  const selected: PdpGeoCopyRefinementRequest["ragChunks"] = [];
  const selectedKeys = new Set<string>();

  for (const kind of strategicRagKinds) {
    const candidate = strategicChunks.find((chunk) => chunk.kind === kind);
    if (!candidate) {
      continue;
    }
    selected.push(candidate);
    selectedKeys.add(ragGuidanceChunkKey(candidate));
  }

  for (const chunk of strategicChunks) {
    if (selected.length >= limit) {
      break;
    }
    const key = ragGuidanceChunkKey(chunk);
    if (selectedKeys.has(key)) {
      continue;
    }
    selected.push(chunk);
    selectedKeys.add(key);
  }

  return selected;
}

function ragGuidanceChunkKey(chunk: PdpGeoCopyRefinementRequest["ragChunks"][number]): string {
  return `${chunk.source}:${chunk.title ?? ""}:${chunk.id}`;
}

function formatRagGuidanceChunk(chunk: PdpGeoCopyRefinementRequest["ragChunks"][number]): Record<string, unknown> {
  return {
    source: chunk.source,
    title: chunk.title,
    kind: chunk.kind,
    intents: chunk.intents ?? [],
    fieldTargets: chunk.fieldTargets ?? [],
    score: chunk.score,
    excerpt: truncate(cleanText(chunk.text), 700)
  };
}

function formatHydratedRagDocument(document: NonNullable<PdpGeoCopyRefinementRequest["hydratedRagDocuments"]>[number]): Record<string, unknown> {
  return {
    source: document.source,
    version: document.version,
    kind: document.kind,
    hydrationMode: document.hydrationMode,
    selectedChunkTitles: document.selectedChunkTitles,
    content: document.content
  };
}

function strategicExposureSourceSummary(request: PdpGeoCopyRefinementRequest): string | undefined {
  const sources = unique(request.ragChunks
    .filter(isStrategicExposureChunk)
    .map((chunk) => chunk.title ? `${chunk.source}#${chunk.title}` : chunk.source))
    .slice(0, 6);
  return sources.length > 0 ? sources.join(", ") : undefined;
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

function tokenUsageFromOpenAi(value: unknown): PdpGeoTokenUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return compactTokenUsage({
    inputTokens: numberField(value.input_tokens) ?? numberField(value.prompt_tokens),
    outputTokens: numberField(value.output_tokens) ?? numberField(value.completion_tokens),
    totalTokens: numberField(value.total_tokens)
  });
}

function tokenUsageFromGemini(value: unknown): PdpGeoTokenUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return compactTokenUsage({
    inputTokens: numberField(value.promptTokenCount),
    outputTokens: numberField(value.candidatesTokenCount),
    totalTokens: numberField(value.totalTokenCount)
  });
}

function tokenUsageFromChatCompletions(value: unknown): PdpGeoTokenUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const inputTokens = numberField(value.prompt_tokens) ?? numberField(value.input_tokens);
  const outputTokens = numberField(value.completion_tokens) ?? numberField(value.output_tokens);
  return compactTokenUsage({
    inputTokens,
    outputTokens,
    totalTokens: numberField(value.total_tokens) ?? sumOptional(inputTokens, outputTokens)
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

function containsInternalOrVisualArtifact(value: string): boolean {
  return /\b(RAG|GEO|geo-paper|geo research|CEP|E-E-A-T|EEAT|OCR|schema optimization|citation-ready|image caption|product shot|pack shot|with text|in the corner|person applying|model applying)\b/i.test(value);
}

function cloneJsonObject(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function escapeScriptJson(value: string): string {
  return value.replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

function cleanText(value: string): string {
  return value
    .replace(/```(?:json)?/gi, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 1)).trim()}...` : value;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map(cleanText).filter(Boolean)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
