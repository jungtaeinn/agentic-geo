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

const CHAT_COMPLETIONS_TIMEOUT_MS = 420_000;
const maxEvidenceItems = 10;
const maxRagChunks = 8;
const maxHydratedDocumentChars = 8_000;
const maxEvidenceTextChars = 520;
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
    }, CHAT_COMPLETIONS_TIMEOUT_MS, "OpenAI copy refinement");

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
    }, CHAT_COMPLETIONS_TIMEOUT_MS, "Gemini copy refinement");

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
      "Return strict JSON only: {\"schemaDescriptions\":{\"webPage\":\"\",\"product\":\"\"},\"schemaProperties\":{\"Target customer\":\"\",\"Brand science\":\"\",\"Usage\":\"\",\"Key ingredients and technologies\":\"\",\"Ingredient/effect detail\":\"\",\"Reported details\":\"\",\"Customer review context\":\"\"},\"faqAnswers\":[{\"question\":\"\",\"answer\":\"\"}],\"contentSections\":{\"description\":\"\",\"quickFacts\":\"\",\"faq\":\"\"},\"warnings\":[]}.",
      "Your job is to use GEO research/geo-paper, CEP, and E-E-A-T guidance to identify product facts, keywords, and source-backed phrases that are likely to be useful in AI answer exposure.",
      "Top priority: make public copy more likely to be selected, quoted, or cited by AI answer engines such as ChatGPT, Gemini, Perplexity, and Google AI by creating concise, self-contained, source-backed answer units.",
      "Use selected strategic chunks as the primary task-specific guidance. Use hydrated full RAG documents only as controlled background for missing context, conflict resolution, and policy completeness.",
      "When guidance conflicts, apply this priority: source product evidence first, E-E-A-T trust and claim safety, schema validity, GEO answer-readiness, then CEP/customer phrasing.",
      "Follow official AI/Search guidance as constraints: build helpful, crawlable, people-first content; do not rely on AI-only markup tricks; make structured data consistent with visible source facts and current PDP evidence.",
      "Extract those useful facts from the supplied product evidence only, then combine them into natural public product sentences.",
      "Prioritize concrete facts: product type, target concern or customer entry point, differentiating formula/ingredient, measured effect, usage context, and review-intent language.",
      "Treat Product.name as the representative product entity. Keep SKU badges, bracketed commerce labels, volume/size qualifiers, and option labels in alternateName, offer, option, or FAQ context only when they are source-backed; do not let them dominate Product.description.",
      "Use only the supplied product evidence and strategic RAG guidance. Do not invent claims, ingredients, metrics, study details, prices, awards, or certifications.",
      "Preserve numeric claims, study populations, usage instructions, ingredient names, and product names exactly when they appear in evidence.",
      "For schemaProperties, refine only existing Product.additionalProperty values. Rewrite rigid labels such as Reported details, Ingredient/effect detail, and Customer review context into natural source-backed target-locale sentences.",
      "For Product.description, describe the product entity: product type, target customer, benefits, ingredients/technology, texture/review context, and measured result when supported. Do not append concrete application steps such as \"화장솜에 적당량을 덜어 피부결을 따라 닦아냅니다\"; actionable use directions belong in Usage and HowTo.",
      "For faqAnswers, keep the same question intent and order as currentCopy.faqAnswers. Improve answer naturalness and GEO usefulness by blending ingredient, benefit/effect, metric, usage, and review evidence only when supplied.",
      "For FAQ breadth, prefer BestPractice-level coverage when evidence exists: benefit, ingredient/technology, usage, review texture, skin suitability, evidence/metric, variant comparison, routine synergy, persistence, renewal/replacement, and purchase/gift context. Keep unsupported intents unchanged rather than inventing answers.",
      "For faqAnswers, make the first sentence directly answer the question and stand alone as a citation-ready claim unit: include the product name, target concern or customer, product type, key ingredient/technology, benefit/effect, usage context, or metric only when each fact is supported.",
      "For Korean and English public copy, avoid meta-narration: outside the opening WebPage.description page-introduction sentence, do not make the page, source material, evidence, information, product details, usage guidance, context, or generation process the grammatical subject of a sentence. The customer-facing subject should be the product, ingredient/technology, benefit, usage action, review pattern, option, or customer concern.",
      "For English public copy, avoid observer frames such as \"source-backed evidence reports\", \"product details include\", \"usage guidance covers\", \"texture context supports\", or \"routine context can be compared\". Prefer direct product sentences such as \"the formula includes\", \"customer reviews mention\", \"the product is suitable for\", \"use it\", or \"the option differs by\".",
      "For WebPage.description, start by introducing the PDP/product page, but make product evidence the first reasoning source: product name, product type, target customer or concern, benefits, ingredients/technology, usage, reviews, variants, offers, and reported results. Then infer the page-level coverage from available page elements and user intents instead of inserting stock wording such as \"The page helps answer...\".",
      "For Korean WebPage.description openings, prefer concrete citation units over abstract labels: name the supported benefit, ingredient/technology, review or measured-result fact when evidence exists instead of saying only \"효능, 성분/기술, 사용 루틴\" or \"상품 정보\". Avoid concrete usage actions in the opening.",
      "For Korean WebPage.description openings, keep the target customer readable as the actor or beneficiary of the page, not as a possessive noun-stack modifier. Prefer natural structures like the customer selecting/evaluating a product or the page guiding information for that customer; avoid cramped phrases such as \"민감·건조 피부의 세안 후 첫 단계...\".",
      "For Korean WebPage.description openings, prefer a natural recommendation frame such as \"상품 페이지에서는 [target customer]에게 [benefit context]에 효과적인 [product noun]을 추천합니다\" when recommendation, suitability, target-customer, or skin-type evidence supports that relationship. Use \"소개합니다\" only when recommendation/suitability evidence is weak. Avoid mechanical frames such as \"고객이 [product]를 선택할 때 [facts]를 확인할 수 있습니다\".",
      "For Korean WebPage.description openings, do not make a skin type itself the grammatical actor. Avoid wording such as \"민감 피부 또는 건조 피부가 ... 비교할 때\"; write \"민감 피부 또는 건조 피부 고객이 ... 선택할 때\" or another natural customer/person-centered phrasing.",
      "For Korean WebPage.description openings, do not make the target customer the subject of a usage action such as \"고객이 세안 후 첫 단계에 쓰는...\". Put routine timing and application actions in Usage/HowTo coverage, not in the target-customer clause.",
      "For Korean WebPage.description, avoid full application directions. Concrete steps such as \"손바닥에 덜어 얼굴 전체에 펴 바른 뒤 두드려 흡수\" belong in HowTo or Usage, not in WebPage.description. WebPage.description may mention that usage guidance exists only at a high level.",
      "For Korean WebPage.description, avoid redundant FAQ/HowTo or purchase-info navigation sentences such as \"FAQ에서는 ... 확인할 수 있습니다\" or \"구매 정보와 FAQ가 함께 제공됩니다\". FAQ content belongs in FAQPage, purchase details belong in Offer, and usage steps belong in HowTo/Usage.",
      "For Korean WebPage.description, prefer direct product-fact sentences over page-navigation frames. Instead of \"포뮬러 특징을 살펴볼 수 있습니다\", write \"핵심 성분/기술은 ...입니다\" or another source-backed product fact.",
      "For Korean WebPage.description, do not use patent numbers or patent-application identifiers as the core page sentence. Keep patent identifiers in Brand science/Product.additionalProperty; WebPage.description should connect target customer, benefit/effect, key ingredient/technology, review or reported-result facts.",
      "For Korean WebPage.description, omit FAQ-topic navigation sentences such as \"캡슐이 워터 안에 떠 있는 이유와 ... 관련 질문도 함께 다룹니다\". FAQ topics belong in FAQPage, not in WebPage.description.",
      "For Korean WebPage.description, do not combine an ingredient/technology list and multiple numeric test results into one sentence ending with \"선택의 핵심 근거\". Split them into separate source-backed sentences: one for key ingredients/technologies and one for reported results.",
      "For Korean metric sentences, preserve source scientific test-method labels such as English or Latin method names instead of inventing translations. Place the method label before the measured result, e.g. \"[method] 테스트에서 [subject] [value]\", so it is not mistaken for an example marker or a product benefit.",
      "For WebPage.description, do not list usage guidance as the final item in an ingredient/technology list. Separate formula coverage from usage coverage in different clauses or sentences; avoid structures such as \"ceramide capsule, formula, usage directions\" or \"포뮬러, 사용법을 확인\".",
      "For WebPage.description, do not merge a HowTo step with FAQ topics in one object list. Avoid structures such as \"application method and capsule FAQ topics can be checked in FAQ and HowTo\"; keep FAQ topics and HowTo steps separate or omit the HowTo step from WebPage.description.",
      "For WebPage.description, keep field roles separated: ingredient/technology evidence may describe formula or brand science, while usage coverage may describe only actual actions such as dispense, apply, spread, pat, rinse, massage, or absorb. Never write a usage-area sentence whose main content is an ingredient/technology mechanism.",
      "For Target customer, infer the customer from explicit source evidence. Prefer stated skin type, concern, routine moment, or customer-entry-point evidence. Do not infer visible-aging, wrinkle, or anti-aging intent from weak texture or generic care words unless explicit aging/wrinkle/anti-aging evidence exists.",
      "For Brand science, use source-backed ingredient, technology, formula, patent, proprietary method, or research evidence. Do not turn Brand science into a HowTo step.",
      "For Usage, include only actionable directions. Exclude formula mechanisms, technology explanations, measured results, review comments, and sentences that merely say what happens when the product is used.",
      "Do not solve copy quality by copying a fixed template. Infer the sentence structure from the target locale, product type, supported evidence, user intent, and field role. Vary syntax naturally while keeping the claim verifiable.",
      "For Korean and English faqAnswers, write direct commerce-answer sentences. Start with the answer itself, then add one supported fact. Use natural predicate families such as suitability, inclusion, care support, benefit delivery, usage action, review texture, comparison, or measured result; avoid passive observer/reporting frames unless the question literally asks about a source or document.",
      "For Korean FAQ answers asking whether two capsules, variants, products, or ingredients are the same, answer the same/different/uncertain point first. Keep only one concise source-backed support phrase; do not append patent application numbers or broad formula-technology explanations unless the question asks about patents.",
      "For suitability/benefit questions, infer a natural sentence that connects product, customer concern, product type, and supported benefit. Do not force a fixed wording pattern when the evidence points to another structure.",
      "For Korean suitability/benefit FAQ answers, preserve supported numeric values but use customer-facing effect predicates such as \"효과가 있습니다\" or \"도움이 됩니다\" instead of report-style endings such as \"결과가 제시됩니다\", unless the question asks for evidence, tests, or reported results.",
      "For ingredient/technology questions, infer a natural sentence that connects ingredient or technology to the supported benefit without inventing a mechanism.",
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
  const fieldSeparatedEvidence = createFieldSeparatedEvidencePayload(request);
  return {
    task: "Select AI-exposure-worthy product keywords and sentences from productEvidence, guided by GEO research/geo-paper, CEP, and E-E-A-T. Use model reasoning to compose natural target-locale public PDP copy from grounded facts; do not rely on fixed public sentence templates.",
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
      benefits: compactEvidenceList(request.product.benefits, maxEvidenceItems),
      effects: compactEvidenceList(request.product.effects, maxEvidenceItems),
      ingredients: compactEvidenceList(request.product.ingredients, maxEvidenceItems),
      usage: compactEvidenceList(request.product.usage, maxEvidenceItems),
      metrics: compactEvidenceList(request.product.metrics, maxEvidenceItems),
      faq: request.product.faq.slice(0, 12).map((item) => ({
        question: truncate(cleanText(item.question), 220),
        answer: truncate(cleanText(item.answer), 900)
      })),
      reviewSummary: {
        rating: request.product.reviews.rating,
        reviewCount: request.product.reviews.reviewCount,
        keywords: compactEvidenceList(request.product.reviews.keywords, maxEvidenceItems),
        examples: compactEvidenceList(request.product.reviews.items.map((review) => review.body), 5)
      },
      sourceTexts: selectHighValueEvidenceTexts(request.product.sourceTexts, maxEvidenceItems)
    },
    descriptionEvidence: {
      purpose: "Use these compact, source-backed candidates to reason about richer WebPage.description and Product.description. Do not copy all items; select the strongest evidence for each field.",
      webPageRole: "Start by introducing the PDP/product page as the page for this product. Ground that opening in product information first: product identity, product type, target customer or concern, major benefits, ingredients or technology, usage, reviews, options, offers, and reported results when supported. Then describe page coverage at a higher level.",
      productRole: "Describe the product entity itself: product type, customer concern, key benefits, ingredients/technology, usage or routine fit, reviews, and supported metrics.",
      sourceBackedFaq: request.product.faq.slice(0, 12).map((item) => ({
        question: truncate(cleanText(item.question), 220),
        answer: truncate(cleanText(item.answer), 900)
      })),
      semanticMetricClaims: (request.product.semanticFacts?.metricClaims ?? []).slice(0, 8).map((claim) => ({
        label: claim.label,
        subject: claim.subject,
        value: claim.value,
        unit: claim.unit,
        metric: claim.metric,
        timing: claim.timing,
        period: claim.period,
        sample: claim.sample,
        method: claim.method,
        sentence: claim.sentence ? truncate(cleanText(claim.sentence), maxEvidenceTextChars) : undefined,
        sourceText: claim.sourceText ? truncate(cleanText(claim.sourceText), maxEvidenceTextChars) : undefined
      })),
      ingredientBenefitLinks: (request.product.semanticFacts?.ingredientBenefitLinks ?? []).slice(0, 8).map((link) => ({
        ingredient: link.ingredient,
        benefit: link.benefit,
        effect: link.effect,
        sentence: link.sentence ? truncate(cleanText(link.sentence), maxEvidenceTextChars) : undefined,
        sourceText: link.sourceText ? truncate(cleanText(link.sourceText), maxEvidenceTextChars) : undefined
      })),
      evidenceSentences: selectHighValueEvidenceTexts(request.product.semanticFacts?.evidenceSentences ?? [], 10),
      highValueSourceTexts: selectHighValueEvidenceTexts(request.product.sourceTexts, 10)
    },
    fieldRoleContracts: {
      targetCustomer: "Infer from explicit skin type, concern, customer-entry-point, routine moment, or test-audience evidence. Do not transfer an unrelated product's target concern.",
      brandScience: "Use only ingredient, technology, formula, patent, proprietary method, or research evidence. Keep this separate from use directions.",
      usage: "Use only actionable directions: dispense, apply, spread, pat, press, massage, rinse, absorb, or equivalent target-locale verbs.",
      webPageDescription: "Introduce the product page and then describe coverage from actual page elements. Keep the target customer readable as an actor or beneficiary in the opening sentence, and keep ingredient/technology and usage-action evidence in separate clauses."
    },
    fieldSeparatedEvidence,
    extractionPriorities: [
      "Choose product facts that directly answer likely generative-search questions.",
      "Compose the first FAQ answer sentence as a self-contained answer unit that an AI answer engine can quote without surrounding context.",
      "Prefer source-backed specificity over broad marketing language.",
      "Map CEP/customer-entry-point language to the product's actual target concern, routine moment, or comparison context.",
      "Use E-E-A-T guidance to keep claims verifiable, attributed to page evidence, and free of exaggeration.",
      "Use GEO research guidance to make descriptions answer-ready without exposing internal optimization language.",
      "When currentCopy contains stiff fallback wording, rewrite the meaning from productEvidence instead of paraphrasing the fallback template.",
      "For English as well as Korean, generate the final sentence through evidence-based reasoning rather than inserting a stock phrase.",
      "For WebPage.description, make the first sentence a product-page introduction grounded first in productEvidence, then replace fallback frames like \"The page helps answer...\" with natural page-level coverage language grounded in actual FAQ, HowTo, review, variant, offer, ingredient, benefit, or reported-result evidence.",
      "For Korean WebPage.description, if benefit, ingredient/technology, review, or measured-result evidence exists, use the actual supported names or values in the opening sentence. Do not replace them with generic category labels, and do not add concrete HowTo actions.",
      "For Korean WebPage.description, do not compress target customer, routine moment, benefit, formula, and product type into one long modifier before the verb. If that happens, rewrite the opening so the customer, product type, and page coverage are separate clauses.",
      "For Korean WebPage.description, avoid opening sentences whose main predicate is only \"확인할 수 있습니다\" after \"선택할 때\". Reframe them as a product-page introduction for the target customer whenever possible.",
      "For Korean WebPage.description, do not let a skin condition noun be the actor of comparing, selecting, referencing, or checking product information. A skin type can modify a customer, concern, or suitability context, but it cannot act by itself.",
      "For Korean WebPage.description, separate target-customer reasoning from usage reasoning: the opening may say who evaluates/selects the product, while a later usage sentence may say how or when it is applied.",
      "For WebPage.description, keep ingredient/technology coverage and usage coverage grammatically separated. A sentence may mention both only when usage is in its own clause, not as part of the ingredient/technology object list.",
      "For Korean metric sentences, do not translate scientific method labels unless the source provides the translation; preserve the label and make it grammatically function as the test method.",
      "For Korean WebPage.description, prefer omitting concrete HowTo steps entirely; rely on FAQ/HowTo schema for detailed application directions."
    ],
    publicCopyQualityGate: [
      "Reject meta-narration where the grammatical subject is source material, evidence, product details, page information, usage guidance, context, or the generation process.",
      "Reject WebPage.description if it does not begin by introducing the product page or if the page introduction is not grounded in concrete product information.",
      "Reject Korean WebPage.description openings that use only generic labels such as \"상품 정보로 효능, 성분/기술, 사용 루틴\" when specific evidence is available.",
      "Reject Korean WebPage.description openings where the target skin/customer phrase becomes an awkward possessive modifier such as \"피부의 세안 후\" or \"피부의 첫 단계\".",
      "Reject Korean WebPage.description openings that mechanically say \"고객이 ... 선택할 때 ... 확인할 수 있습니다\" when they can be written as a natural product-page introduction.",
      "Reject Korean WebPage.description openings where a skin type itself acts as the subject, such as \"민감 피부 또는 건조 피부가 ... 비교할 때\".",
      "Reject Korean WebPage.description openings where a target customer phrase directly performs a usage action such as \"고객이 세안 후 첫 단계에 쓰는\".",
      "Reject Product.description when a full usage step is appended after benefit, ingredient, or metric claims.",
      "Reject WebPage.description sentences where ingredient/technology names and usage directions are merged into one comma-separated object list.",
      "Reject WebPage.description sentences where a full usage step and FAQ topics are merged into one sentence with \"FAQ와 HowTo\".",
      "Reject Korean WebPage.description sentences that only route the reader to FAQ, HowTo, or purchase information, such as \"FAQ에서는 ... 확인할 수 있습니다\" or \"구매 정보와 FAQ가 함께 제공됩니다\".",
      "Reject Korean WebPage.description sentences that say only that formula, ingredient, technology, or measurement details can be checked or viewed, such as \"포뮬러 특징을 살펴볼 수 있습니다\".",
      "Reject Korean WebPage.description sentences where the main product-fact sentence is \"핵심 기술은 ... 특허 출원 번호는 ...\".",
      "Reject Korean WebPage.description sentences that route to FAQ-like topics with \"질문도 함께 다룹니다\".",
      "Reject Korean FAQ answers for same/different comparison questions when they append patent numbers or formula-technology dumps after the direct answer.",
      "Reject Korean WebPage.description sentences that merge ingredient/technology lists and numeric test results into an awkward selection-evidence predicate, such as \"성분 구성과 ... 개선 수치가 선택의 핵심 근거로를 제공합니다\".",
      "Reject WebPage.description wording that uses a stock helper phrase such as \"The page helps answer\" instead of reasoning from the actual page elements and supported customer intent.",
      "Reject copy that reads like a report about available information instead of product-facing PDP content.",
      "Accept only sentences that remain natural when quoted by ChatGPT, Gemini, Google AI, or another answer engine.",
      "Accept fewer FAQ answers when only fewer distinct source-backed search intents are available."
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

function createFieldSeparatedEvidencePayload(request: PdpGeoCopyRefinementRequest): Record<string, unknown> {
  const howToSteps = readSchemaHowToSteps(request.schemaMarkup.jsonLd);
  const targetCustomerEvidence = selectHighValueEvidenceTexts([
    request.product.description,
    ...(request.product.semanticFacts?.skinTypes ?? []),
    ...request.product.benefits,
    ...request.product.effects,
    ...request.product.sourceTexts.filter((text) => /민감|건조|장벽|수분|보습|노화|안티에이징|주름|탄력|sensitive|dry|barrier|hydration|moisture|aging|anti[-\s]?aging|wrinkle|firm/i.test(text))
  ].filter((value): value is string => Boolean(value)), 8);
  const ingredientTechnologyEvidence = selectHighValueEvidenceTexts([
    ...request.product.ingredients,
    ...(request.product.semanticFacts?.ingredients ?? []),
    ...(request.product.semanticFacts?.ingredientBenefitLinks ?? []).flatMap((link) => [link.sentence, link.sourceText].filter((value): value is string => Boolean(value))),
    ...request.product.sourceTexts.filter((text) => /성분|기술|포뮬러|복합체|캡슐|특허|세라마이드|히알루론산|레티놀|펩타이드|ingredient|technology|formula|complex|capsule|patent|ceramide|hyaluronic|retinol|peptide/i.test(text))
  ], 10);
  const usageDirections = selectHighValueEvidenceTexts([
    ...request.product.usage,
    ...(request.product.semanticFacts?.usageSteps ?? []),
    ...howToSteps,
    ...request.product.sourceTexts.filter((text) => isActionableUsageCopy(text))
  ], 8);

  return {
    targetCustomerEvidence,
    ingredientTechnologyEvidence,
    usageDirections,
    pageElementAvailability: {
      hasFaq: readSchemaFaqItems(request.schemaMarkup.jsonLd).length > 0,
      hasHowTo: howToSteps.length > 0,
      hasOffer: hasSchemaNode(request.schemaMarkup.jsonLd, "Offer") || Boolean(request.product.price),
      hasReportedResults: request.product.metrics.length > 0 || (request.product.semanticFacts?.metricClaims.length ?? 0) > 0,
      hasReviews: request.product.reviews.items.length > 0 || Boolean(request.product.reviews.reviewCount)
    },
    routingWarnings: [
      "Use ingredientTechnologyEvidence for Brand science or ingredient fields, not Usage.",
      "Use usageDirections for Usage and HowTo wording, not formula mechanism explanation.",
      "Use targetCustomerEvidence for Target customer and the opening WebPage.description sentence."
    ]
  };
}

function compactEvidenceList(values: string[], limit: number): string[] {
  return selectHighValueEvidenceTexts(values, limit);
}

function selectHighValueEvidenceTexts(values: string[], limit: number): string[] {
  return unique(values
    .map(cleanText)
    .filter((value) => value.length >= 4)
    .sort((left, right) => evidenceTextScore(right) - evidenceTextScore(left)))
    .slice(0, limit)
    .map((value) => truncate(value, maxEvidenceTextChars));
}

function evidenceTextScore(value: string): number {
  let score = 0;
  if (/[0-9０-９]/.test(value)) {
    score += 6;
  }
  if (/%|배|\b(?:weeks?|days?|hours?|participants?|women|men|subjects?|reviews?)\b|명|인|주|일|시간/i.test(value)) {
    score += 7;
  }
  if (/(?:임상|인체\s*적용|자가\s*평가|시험|테스트|결과|개선|지속|만족|clinical|study|self[-\s]?assessment|instrumental|result|improvement|agreed)/i.test(value)) {
    score += 6;
  }
  if (/(?:성분|기술|포뮬러|진세노믹스|펩타이드|비타민|콜라겐|레티놀|ingredient|technology|formula|peptide|vitamin|collagen|retinol|ginseng)/i.test(value)) {
    score += 5;
  }
  if (/(?:보습|수분|탄력|주름|피부결|장벽|진정|리프팅|밀도|hydration|firming|wrinkle|texture|barrier|soothing|lifting|density)/i.test(value)) {
    score += 5;
  }
  if (/(?:사용|아침|저녁|루틴|단계|apply|use|routine|morning|night)/i.test(value)) {
    score += 2;
  }
  return score;
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
  if (field !== "WebPage.description" && containsPublicMetaNarrationArtifact(text)) {
    warnings.push(`${field} refinement rejected because it uses meta-narration instead of customer-facing product copy.`);
    return undefined;
  }
  if (field === "WebPage.description" && !startsWithProductPageIntroduction(text)) {
    warnings.push(`${field} refinement rejected because it does not start with a product-page introduction grounded in product information.`);
    return undefined;
  }
  if (field === "WebPage.description" && containsAwkwardKoreanWebPageOpening(text)) {
    warnings.push(`${field} refinement rejected because its Korean opening compresses the target customer into an awkward possessive noun stack.`);
    return undefined;
  }
  if (field === "WebPage.description" && containsMechanicalKoreanSelectionCheckOpening(text)) {
    warnings.push(`${field} refinement rejected because its Korean opening uses a mechanical selection/check frame instead of a natural product-page introduction.`);
    return undefined;
  }
  if (field === "WebPage.description" && containsKoreanSkinTypeAsActorOpening(text)) {
    warnings.push(`${field} refinement rejected because its Korean opening makes a skin type the actor instead of a customer or concern.`);
    return undefined;
  }
  if (field === "WebPage.description" && containsGenericKoreanWebPageCoverageLead(text)) {
    warnings.push(`${field} refinement rejected because its Korean opening uses generic coverage labels instead of concrete product facts.`);
    return undefined;
  }
  if (field === "WebPage.description" && containsMisroutedUsageTechnologySentence(text)) {
    warnings.push(`${field} refinement rejected because it routes ingredient/technology explanation through a usage-area sentence.`);
    return undefined;
  }
  if (field === "WebPage.description" && containsIngredientTechnologyUsageCoverageBlend(text)) {
    warnings.push(`${field} refinement rejected because it merges ingredient/technology coverage and usage coverage into the same list sentence.`);
    return undefined;
  }
  if (field === "WebPage.description" && containsMixedFaqHowToUsageSentence(text)) {
    warnings.push(`${field} refinement rejected because it merges full usage steps with FAQ topics in the same WebPage sentence.`);
    return undefined;
  }
  if (field === "WebPage.description" && containsRedundantKoreanFaqHowToNavigationSentence(text)) {
    warnings.push(`${field} refinement rejected because it adds redundant FAQ/HowTo navigation instead of citation-worthy product facts.`);
    return undefined;
  }
  if (field === "WebPage.description" && containsKoreanWebPageFactNavigationSentence(text)) {
    warnings.push(`${field} refinement rejected because it uses check/view navigation wording instead of direct product facts.`);
    return undefined;
  }
  if (field === "WebPage.description" && containsKoreanWebPagePatentNumberSentence(text)) {
    warnings.push(`${field} refinement rejected because it uses patent identifiers as a core WebPage description sentence instead of benefit-linked product facts.`);
    return undefined;
  }
  if (field === "WebPage.description" && containsKoreanWebPageQuestionNavigationSentence(text)) {
    warnings.push(`${field} refinement rejected because FAQ-topic navigation belongs in FAQPage rather than WebPage.description.`);
    return undefined;
  }
  if (field === "WebPage.description" && containsKoreanWebPageMixedIngredientMetricEvidenceSentence(text)) {
    warnings.push(`${field} refinement rejected because it merges ingredient/technology lists and numeric test results into one awkward selection-evidence sentence.`);
    return undefined;
  }
  if (field === "Product.description" && containsConcreteProductDescriptionUsageStep(text)) {
    warnings.push(`${field} refinement rejected because it appends concrete usage directions that belong in Usage or HowTo.`);
    return undefined;
  }
  if (containsBrokenKoreanCopyFragment(text)) {
    warnings.push(`${field} refinement rejected because it contains a broken Korean sentence fragment.`);
    return undefined;
  }
  if (options.requireSupportedClaimTokens && hasUnsupportedClaimTokens(text, options.evidenceCorpus ?? "")) {
    warnings.push(`${field} refinement rejected because it introduced unsupported numeric or study claim details.`);
    return undefined;
  }

  return text;
}

const refinableSchemaPropertyNames = new Set([
  "Target customer",
  "Key ingredients and technologies",
  "Ingredient/effect detail",
  "Brand science",
  "Usage",
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
    if (accepted && !isAcceptedSchemaPropertyValue(name, accepted, request, warnings)) {
      return [];
    }
    return accepted && accepted !== before ? [{ name, value: accepted, before }] : [];
  });
}

function isAcceptedSchemaPropertyValue(
  name: string,
  value: string,
  request: PdpGeoCopyRefinementRequest,
  warnings: string[]
): boolean {
  if (/^Usage$/i.test(name) && !isActionableUsageCopy(value)) {
    warnings.push(`Product.additionalProperty.${name} refinement rejected because usage values must contain actionable use directions only.`);
    return false;
  }
  if (/^Target customer$/i.test(name) && !isSupportedTargetCustomerCopy(value, request)) {
    warnings.push(`Product.additionalProperty.${name} refinement rejected because the target-customer concern is not supported by product evidence.`);
    return false;
  }
  if (/^Brand science$/i.test(name) && isActionableUsageCopy(value) && !hasIngredientTechnologyEvidence(value)) {
    warnings.push(`Product.additionalProperty.${name} refinement rejected because brand science should describe formula, technology, research, or ingredient evidence rather than a usage step.`);
    return false;
  }
  if (/^Key ingredients and technologies$/i.test(name) && !hasIngredientTechnologyEvidence(value)) {
    warnings.push(`Product.additionalProperty.${name} refinement rejected because it does not contain ingredient or technology evidence.`);
    return false;
  }
  return true;
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
    const question = currentFaq[faqIndex]?.question ?? (typeof item.question === "string" ? item.question : "");
    const accepted = acceptRefinedText(
      answer,
      before,
      `FAQPage.mainEntity.${faqIndex + 1}.acceptedAnswer`,
      warnings,
      { minLength: 24, maxLength: 900, evidenceCorpus, requireSupportedClaimTokens: true }
    );
    if (accepted && !isAcceptedFaqAnswerValue(question, accepted, warnings, faqIndex)) {
      return [];
    }
    return accepted && accepted !== before ? [{ index: faqIndex, answer: accepted, before }] : [];
  });
}

function isAcceptedFaqAnswerValue(question: string, answer: string, warnings: string[], index: number): boolean {
  if (isKoreanComparisonFaqQuestion(question) && isOvermixedKoreanComparisonFaqAnswer(answer) && !/특허|patent/i.test(question)) {
    warnings.push(`FAQPage.mainEntity.${index + 1}.acceptedAnswer refinement rejected because comparison FAQ answers should not append patent identifiers or broad formula-technology details.`);
    return false;
  }
  if (isKoreanBenefitFaqQuestion(question) && hasKoreanReportStyleMetricFaqAnswer(answer) && !/근거|테스트|임상|결과|수치/u.test(question)) {
    warnings.push(`FAQPage.mainEntity.${index + 1}.acceptedAnswer refinement rejected because benefit FAQ answers should express supported metrics as customer-facing effects instead of report-style result wording.`);
    return false;
  }
  return true;
}

function isKoreanComparisonFaqQuestion(question: string): boolean {
  return /[가-힣]/.test(question) && /(?:동일|같은|같나요|같습니까|차이|다른|비교)/u.test(question);
}

function isOvermixedKoreanComparisonFaqAnswer(answer: string): boolean {
  return /[가-힣]/.test(answer)
    && /특허\s*출원|특허출원번호|특허\s*성분|KR\d|포뮬러\s*기술|기술과\s*특허/u.test(answer)
    && /(?:동일|같은|단정|캡슐)/u.test(answer);
}

function isKoreanBenefitFaqQuestion(question: string): boolean {
  return /[가-힣]/.test(question)
    && /효능|효과|고민|적합|추천|어떤\s*고객|누구(?:에게)?|피부\s*타입|피부타입|권장/u.test(question);
}

function hasKoreanReportStyleMetricFaqAnswer(answer: string): boolean {
  return /[가-힣]/.test(answer)
    && /(?:(?:사용|도포|적용)\s*(?:직후|후|전후)?|\d+(?:\.\d+)?\s*(?:시간|일|주|개월)\s*후|\d+(?:\.\d+)?\s*(?:배|%))[^.。！？]{0,90}?(?:증가|개선|회복|감소|완화|지속|상승|향상)(?:된|한)?\s*결과가\s*제시됩니다/u.test(answer);
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

function readSchemaHowToSteps(jsonLd: JsonObject): string[] {
  const graph = Array.isArray(jsonLd["@graph"]) ? jsonLd["@graph"] : [];
  const howTo = graph.find((node) => isSchemaNodeOfType(node, "HowTo"));
  if (!isRecord(howTo) || !Array.isArray(howTo.step)) {
    return [];
  }
  return howTo.step.flatMap((item) => {
    if (!isRecord(item) || typeof item.text !== "string") {
      return [];
    }
    return [item.text];
  });
}

function hasSchemaNode(jsonLd: JsonObject, type: string): boolean {
  const graph = Array.isArray(jsonLd["@graph"]) ? jsonLd["@graph"] : [];
  return graph.some((node) => isSchemaNodeOfType(node, type));
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
  const cleanContent = cleanText(document.content);
  return {
    source: document.source,
    version: document.version,
    kind: document.kind,
    hydrationMode: document.hydrationMode,
    selectedChunkTitles: document.selectedChunkTitles,
    content: truncate(cleanContent, maxHydratedDocumentChars),
    contentTruncated: cleanContent.length > maxHydratedDocumentChars
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

function containsPublicMetaNarrationArtifact(value: string): boolean {
  return containsEnglishPublicMetaNarrationArtifact(value) || containsKoreanPublicMetaNarrationArtifact(value);
}

function containsEnglishPublicMetaNarrationArtifact(value: string): boolean {
  if (/\bThe\s+page\s+helps\s+answer\b/i.test(value)) {
    return true;
  }
  const sourceSubject = "(?:source-backed\\s+)?(?:product\\s+)?(?:evidence|source\\s+evidence|source\\s+material|product-detail\\s+evidence|product\\s+detail\\s+context|usage\\s+guidance|texture\\s+context|routine\\s+context|reported\\s+benefit\\s+cues)";
  const reportingPredicate = "(?:reports?|includes?|adds?|organizes?|organises?|presents?|summari[sz]es?|covers?|supports?|reflects?|states?|can\\s+be\\s+compared|is\\s+described|is\\s+framed)";
  return new RegExp(`\\b${sourceSubject}\\b[^.!?\\n]{0,56}\\b${reportingPredicate}\\b`, "i").test(value);
}

function containsKoreanPublicMetaNarrationArtifact(value: string): boolean {
  if (!/[가-힣]/.test(value)) {
    return false;
  }
  const sourceSubject = "(?:상품|제품|페이지|상품\\s*상세|상품\\s*정보|제품\\s*정보|제품\\s*자료|확인(?:된)?\\s*(?:근거|정보|결과)|근거|내용|자료|성분\\s*영역|효능\\s*정보|리뷰\\s*(?:기반\\s*)?표현)";
  const reportingPredicate = "(?:정리|요약|제시|설명|노출|포함|구성)";
  return new RegExp(`${sourceSubject}.{0,28}(?:은|는|에는|에서는|으로는|로|를|을)?[^.!?。！？\\n]{0,48}${reportingPredicate}(?:하|되|됩|합니다|됩니다)`).test(value);
}

function startsWithProductPageIntroduction(value: string): boolean {
  const opening = value.split(/[.!?。！？]\s+/)[0] ?? value;
  return /(?:product\s+page|product-detail\s+page|PDP|상품\s*페이지|제품\s*페이지|商品ページ)/i.test(opening)
    && /(?:product|상품|제품|成分|ベネフィット|benefit|ingredient|technology|formula|routine|usage|review|variant|offer|reported|customer|concern|skin|피부|고객|クリーム|美容液|化粧水|クレンザー)/i.test(opening);
}

function containsMisroutedUsageTechnologySentence(value: string): boolean {
  return splitPublicSentences(value).some((sentence) => {
    if (!/(?:사용법\s*영역|HowTo|how\s*to\s*use|usage\s+(?:area|section|guidance|steps?))/i.test(sentence)) {
      return false;
    }
    return isIngredientTechnologyUsageLeak(sentence);
  });
}

function containsIngredientTechnologyUsageCoverageBlend(value: string): boolean {
  return splitPublicSentences(value).some(isIngredientTechnologyUsageCoverageBlendSentence);
}

function containsMixedFaqHowToUsageSentence(value: string): boolean {
  return splitPublicSentences(value).some((sentence) => {
    const text = cleanText(sentence);
    if (!/[가-힣]/.test(text) || !/(?:FAQ\s*(?:와|및|\/|과)\s*HowTo|HowTo\s*(?:와|및|\/|과)\s*FAQ)/i.test(text)) {
      return false;
    }
    return /(?:손바닥|적당량|얼굴\s*전체|피부결|펴\s*바른|펴\s*발라|흡수|두드려|도포|바르는\s*방법|사용\s*방법|사용법)[^.!?。！？]{0,120}(?:이유|동일\s*여부|차이|문의|질문|FAQ|캡슐|워터)/i.test(text)
      || /(?:방법|사용법)(?:과|와)[^.!?。！？]{0,120}(?:이유|동일\s*여부|차이|FAQ|캡슐|워터)/i.test(text);
  });
}

function containsRedundantKoreanFaqHowToNavigationSentence(value: string): boolean {
  return splitPublicSentences(value).some((sentence) => {
    const text = cleanText(sentence);
    if (!/[가-힣]/.test(text) || !/(?:FAQ|HowTo|사용법\s*영역|FAQ\s*영역)/i.test(text)) {
      return false;
    }
    return /(?:FAQ|HowTo|사용법\s*영역|FAQ\s*영역)[^.!?。！？]{0,160}(?:확인할\s*수\s*있습니다|확인합니다|다룹니다|답변으로\s*다룹니다|살펴볼\s*수\s*있습니다|(?:함께\s*)?제공됩니다)/i.test(text);
  });
}

function containsKoreanWebPageFactNavigationSentence(value: string): boolean {
  return splitPublicSentences(value).some((sentence) => {
    const text = cleanText(sentence);
    if (!/[가-힣]/.test(text)) {
      return false;
    }
    return /(?:포뮬러|성분\/기술|성분|기술|측정\/평가|측정|평가|수치|결과)\s*(?:특징|정보|내용|결과)?[^.!?。！？]{0,120}(?:살펴볼|확인할|참고할)\s*수\s*있습니다/u.test(text);
  });
}

function containsKoreanWebPageMixedIngredientMetricEvidenceSentence(value: string): boolean {
  return splitPublicSentences(value).some((sentence) => {
    const text = cleanText(sentence);
    if (!/[가-힣]/.test(text) || !hasIngredientTechnologyEvidence(text) || !/%/.test(text)) {
      return false;
    }
    return /(?:선택의\s*)?(?:핵심\s*)?근거(?:로를|로|를)?\s*(?:제공합니다|제시합니다|됩니다)[.!?。！？]?$/u.test(text)
      || /근거로를\s*제공합니다[.!?。！？]?$/u.test(text);
  });
}

function containsKoreanWebPagePatentNumberSentence(value: string): boolean {
  return splitPublicSentences(value).some((sentence) => {
    const text = cleanText(sentence);
    return /[가-힣]/.test(text)
      && /특허\s*출원\s*번호/.test(text)
      && /(?:핵심\s*)?(?:기술|성분\/기술|포뮬러)(?:은|는)/.test(text);
  });
}

function containsKoreanWebPageQuestionNavigationSentence(value: string): boolean {
  return splitPublicSentences(value).some((sentence) => {
    const text = cleanText(sentence);
    return /[가-힣]/.test(text)
      && /(?:질문|문의|궁금증)(?:도)?\s*(?:함께\s*)?(?:다룹니다|제공됩니다|확인할\s*수\s*있습니다)[.!?。！？]?$/u.test(text)
      && /(?:이유|동일|관련|차이|캡슐|워터|크림|FAQ|HowTo)/i.test(text);
  });
}

function containsConcreteProductDescriptionUsageStep(value: string): boolean {
  return splitPublicSentences(value).some((sentence) => {
    const text = cleanText(sentence);
    if (!/[가-힣]/.test(text) || !hasActionableApplicationVerb(text)) {
      return false;
    }
    return /(?:사용\s*시|사용할\s*때|사용\s*방법|사용법|화장솜|손바닥|손에|적당량|얼굴\s*전체|피부결|펴\s*바르|펴\s*발라|닦아내|흡수|두드려|도포)/u.test(text);
  });
}

function isIngredientTechnologyUsageCoverageBlendSentence(value: string): boolean {
  const text = cleanText(value);
  if (!hasIngredientTechnologyEvidence(text) || !/(?:사용법|사용\s*방법|HowTo|how\s*to\s*use|usage\s+guidance|directions?)/i.test(text)) {
    return false;
  }
  return /(?:성분|기술|포뮬러|복합체|캡슐|세라마이드|콜레스테롤|지방산|PHA|formula|technology|complex|capsule|ceramide)[^.!?。！？]{0,160},\s*(?:사용법|사용\s*방법|HowTo|how\s*to\s*use|usage\s+guidance|directions?)(?:을|를)?\s*(?:확인|비교|살펴|다루|안내|제공|check|compare|review|cover|include)/i.test(text)
    || /(?:고객|사용자|customers?|users?)[^.!?。！？]{0,40}(?:은|는)?[^.!?。！？]{0,180}(?:성분|기술|포뮬러|복합체|캡슐|세라마이드|콜레스테롤|지방산|PHA|formula|technology|complex|capsule|ceramide)[^.!?。！？]{0,120}(?:사용법|사용\s*방법|HowTo|how\s*to\s*use|usage\s+guidance|directions?)(?:을|를)?\s*(?:확인|비교|살펴|check|compare|review)/i.test(text);
}

function containsBrokenKoreanCopyFragment(value: string): boolean {
  return /(?:설명된다|설명됩니다|제시된다|제시됩니다)\s+사용법을\s+다룹니다/.test(value);
}

function containsGenericKoreanWebPageCoverageLead(value: string): boolean {
  const opening = splitPublicSentences(value)[0] ?? value;
  if (!/[가-힣]/.test(opening) || !/상품\s*페이지/.test(opening)) {
    return false;
  }
  return /상품\s*정보(?:로|를)?[^.!?。！？]{0,40}(?:효능|benefit)[^.!?。！？]{0,24}성분\s*\/\s*기술[^.!?。！？]{0,32}(?:사용\s*루틴|사용법|HowTo)/i.test(opening)
    || /(?:주요\s*)?효능\s*,\s*성분\s*\/\s*기술\s*,\s*(?:사용\s*루틴|사용법)(?:\s*등)?(?:을|를)?\s*(?:안내|제시|설명|확인)/i.test(opening);
}

function containsKoreanSkinTypeAsActorOpening(value: string): boolean {
  const opening = splitPublicSentences(value)[0] ?? value;
  if (!/[가-힣]/.test(opening) || !/상품\s*페이지/.test(opening)) {
    return false;
  }
  const skinTypeActor = /(?:민감|건조|건성|지성|복합성|트러블|여드름|수부지|악건성|장벽\s*약한|민감\s*건조)\s*피부(?:\s*(?:또는|혹은|및|과|와)\s*(?:민감|건조|건성|지성|복합성|트러블|여드름|수부지|악건성|장벽\s*약한|민감\s*건조)\s*피부)*\s*(?:이|가)\s+[^.!?。！？]{0,120}(?:비교|선택|참고|확인|살펴|찾|고려)/u;
  return skinTypeActor.test(opening) && !/(?:고객|사용자|분|사람|소비자|구매자)\s*(?:이|가)/u.test(opening);
}

function containsMechanicalKoreanSelectionCheckOpening(value: string): boolean {
  const opening = splitPublicSentences(value)[0] ?? value;
  if (!/[가-힣]/.test(opening) || !/상품\s*페이지/.test(opening)) {
    return false;
  }
  return /(?:고객|사용자|소비자|구매자|분)(?:이|가)\s+[^.!?。！？]{2,80}?(?:상품|제품|토너|크림|세럼|로션|앰플|에센스|클렌저|수분\s*토너)[^.!?。！？]{0,40}(?:선택|비교|참고|확인|고려)할\s*때[^.!?。！？]{2,160}(?:확인할\s*수\s*있습니다|직접\s*확인할\s*수\s*있습니다)/u.test(opening);
}

function containsAwkwardKoreanWebPageOpening(value: string): boolean {
  const opening = splitPublicSentences(value)[0] ?? value;
  if (!/[가-힣]/.test(opening) || !/상품\s*페이지/.test(opening)) {
    return false;
  }
  if (/(?:민감|건조|건성|지성|복합성|트러블|여드름|노화|주름|탄력|장벽|수분)[^.!?。！？]{0,30}피부의\s*(?:세안|첫\s*단계|수분|보습|장벽|피부결|케어|진정|탄력|주름)/u.test(opening)) {
    return true;
  }
  if (/(?:고객|피부)의\s*(?:세안|첫\s*단계|수분|보습|장벽|피부결|케어)\s/u.test(opening)) {
    return true;
  }
  if (/(?:고객|피부)[^.!?。！？]{0,24}(?:이|가)\s*(?:세안\s*후|첫\s*단계|아침|저녁|스킨케어|루틴)[^.!?。！？]{0,36}(?:쓰는|사용하는|바르는|도포하는)\s/u.test(opening)) {
    return true;
  }
  if (/(?:민감|건조|건성|지성|복합성|트러블|여드름|장벽|수분)[^.!?。！？]{0,50}고객[^.!?。！？]{0,18}(?:세안\s*후|첫\s*단계)[^.!?。！？]{0,36}(?:쓰는|사용하는|바르는|도포하는)\s/u.test(opening)) {
    return true;
  }
  const lead = opening.match(/상품\s*페이지는\s+(.{20,160}?)(?:을|를)\s+(?:소개|안내|설명)합니다/u)?.[1];
  if (!lead) {
    return false;
  }
  const modifierLoad = [
    /(?:피부|고객)의/u,
    /고객(?:이|가).{0,36}(?:쓰는|사용하는|바르는|도포하는)/u,
    /세안\s*후/u,
    /첫\s*단계/u,
    /(?:수분|보습|장벽|피부결)\s*(?:충전|개선|케어|보습|정돈)/u,
    /위한/u,
    /(?:제형|캡슐|토너|크림|세럼|에센스|로션)$/u
  ].filter((pattern) => pattern.test(lead)).length;
  return modifierLoad >= 4;
}

function isActionableUsageCopy(value: string): boolean {
  const parts = value
    .split(/\s*;\s*|\n+|(?<=[.!?。！？])\s+/u)
    .map((part) => cleanText(part).replace(/^\s*(?:step\s*)?\d+\s*(?:단계|段階)?\s*[:.)-]?\s*/i, ""))
    .filter((part) => part.length >= 8);
  return parts.length > 0 && parts.every((part) => hasActionableApplicationVerb(part) && !isIngredientTechnologyUsageLeak(part));
}

function hasIngredientTechnologyEvidence(value: string): boolean {
  return /(?:성분|기술|포뮬러|복합체|캡슐|세라마이드|히알루론산|레티놀|나이아신아마이드|펩타이드|특허|독자|연구|formula|technology|complex|capsule|ceramide|hyaluronic|retinol|niacinamide|peptide|patent|proprietary|research)/i.test(value);
}

function isSupportedTargetCustomerCopy(value: string, request: PdpGeoCopyRefinementRequest): boolean {
  const text = cleanText(value);
  const evidence = cleanText(JSON.stringify({
    description: request.product.description,
    benefits: request.product.benefits,
    effects: request.product.effects,
    sourceTexts: request.product.sourceTexts,
    semanticSkinTypes: request.product.semanticFacts?.skinTypes
  }));
  if (/(?:노화|안티에이징|주름|팔자|미간|이마|목\s*주름|aging|anti[-\s]?aging|wrinkles?|fine\s*lines?)/i.test(text)
    && !/(?:노화|안티에이징|주름|팔자|미간|이마|목\s*주름|aging|anti[-\s]?aging|wrinkles?|fine\s*lines?)/i.test(evidence)) {
    return false;
  }
  if (/(?:민감|sensitive)/i.test(text) && !/(?:민감|sensitive)/i.test(evidence)) {
    return false;
  }
  if (/(?:건조|건성|dry)/i.test(text) && !/(?:건조|건성|dry)/i.test(evidence)) {
    return false;
  }
  return true;
}

function isIngredientTechnologyUsageLeak(value: string): boolean {
  const text = cleanText(value);
  const hasFormulaOrTechnology = hasIngredientTechnologyEvidence(text);
  const hasInstructionCue = /(?:사용\s*방법|사용법|\bhow\s+to\s+use\b|\bdirections?\b|적당량|손에|얼굴에|피부결|펴\s*바르|발라|흡수|도포|massage|apply|dispense|pat|press|spread|smooth|rinse|lather)/i.test(text);
  const hasOnlyDescriptiveUse = /(?:사용할\s*때마다|사용\s*시|when\s+used|with\s+each\s+use)/i.test(text) && !hasInstructionCue;
  const hasReportingFrame = /(?:적용|설계|제공|도출|방출|설명|특징|구성|함유|담(?:긴|은)|녹지\s*않|patent|proprietary|designed|delivers?|provides?|contains?|features?)/i.test(text);
  return hasFormulaOrTechnology && (hasOnlyDescriptiveUse || hasReportingFrame) && !hasActionableApplicationVerb(text);
}

function hasActionableApplicationVerb(value: string): boolean {
  const text = cleanText(value);
  return /\b(?:apply|dispense|massage|lather|rinse|pat|press|spread|smooth|warm|pump)\b|なじませ|塗布/i.test(text)
    || /(?:적당량|손에|물과\s*함께|거품\s*내|거품내|얼굴에|문지르|미온수|헹구|화장솜|덜어|펴\s*바르|펴\s*바릅|펴\s*발라|바르(?:고|며|듯|세요|십시오|기|면|는|도록)|바릅|바른\s*후|발라(?:주|주세요|줍니다|서|가며)|마사지(?:하듯|하[고여]|한\s*후|해|하세요|하며)|흡수(?:시켜|시키|될\s*때까지|되도록|해\s*주세요|시킵)|마무리(?:해|하세요|합니다|하십시오)|도포(?:해|하세요|합니다|하십시오|한\s*(?:뒤|후)))/.test(text);
}

function splitPublicSentences(value: string): string[] {
  return value
    .split(/(?<=[.!?。！？])\s+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
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
