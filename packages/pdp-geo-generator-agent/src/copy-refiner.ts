import { createPdpGeoContentHtml } from "./generate";
import { formatPolicyChecklistPayload, formatPolicyComplianceRecap } from "./rag/policy-compiler";
import type {
  JsonObject,
  PdpGeoContentArtifact,
  PdpGeoCopyRefinementFeedback,
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
  rejections: PdpGeoCopyRefinementFeedback[];
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
    applied: false,
    rejections: []
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
    let applied = applyCopyRefinement(request, result);
    let usage = result.usage;
    let retryWarnings: string[] = [];
    let retryLlmWarnings: string[] = [];
    const retryTargets = collectRetryTargets(applied);

    if (retryTargets.length > 0) {
      const retryRequest: PdpGeoCopyRefinementRequest = {
        ...request,
        schemaMarkup: applied.schemaMarkup,
        content: applied.content,
        refinementFeedback: retryTargets,
        // Reduced corrective-pass payload: drop the full hydrated RAG documents (the largest
        // payload block) since the corrective pass only needs to fix specific listed fields.
        hydratedRagDocuments: undefined
      };
      try {
        const retryResult = await resolved.refiner.refineCopy(retryRequest);
        const retryApplied = applyCopyRefinement(retryRequest, retryResult);
        usage = mergeTokenUsage(usage, retryResult.usage);
        retryLlmWarnings = retryResult.warnings ?? [];
        const remaining = collectRetryTargets(retryApplied);
        if (remaining.length > 0) {
          retryWarnings = [
            `Corrective refinement pass could not repair: ${remaining.map((item) => item.field).join(", ")} (corrective refinement pass exhausted).`
          ];
        }
        applied = {
          schemaMarkup: retryApplied.schemaMarkup,
          content: retryApplied.content,
          evidence: [
            ...applied.evidence,
            ...retryApplied.evidence,
            {
              field: "copy.refinement.retry",
              source: "llm",
              value: `Corrective refinement pass regenerated fields: ${retryTargets.map((item) => item.field).join(", ")}`
            }
          ],
          warnings: [...applied.warnings, ...retryApplied.warnings],
          rejections: retryApplied.rejections,
          applied: applied.applied || retryApplied.applied
        };
      } catch (retryError) {
        const message = retryError instanceof Error ? retryError.message : "Corrective refinement provider failed.";
        retryWarnings = [`Corrective refinement pass skipped: ${message}`];
      }
    }
    const warnings = [
      ...(result.warnings ?? []),
      ...applied.warnings,
      ...retryLlmWarnings,
      ...retryWarnings
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
    if (request.policyRules && request.policyRules.length > 0) {
      const criticalCount = request.policyRules.filter((rule) => rule.severity === "critical").length;
      evidence.push({
        field: "copy.refinement.policy",
        source: "rag",
        value: `Compiled policy checklist injected ${request.policyRules.length} rules (${criticalCount} critical) from all loaded RAG policy documents.`
      });
      const violated = result.ruleCompliance?.violatedRuleIds ?? [];
      if (violated.length > 0) {
        const notes = result.ruleCompliance?.notes ?? [];
        warnings.push(`Copy refinement reported unsatisfied policy rules: ${violated.join(", ")}${notes.length > 0 ? ` (${notes.join(" / ")})` : ""}`);
      } else if (result.ruleCompliance) {
        evidence.push({
          field: "copy.refinement.policy",
          source: "llm",
          value: "Copy refinement self-check confirmed all critical policy rules were satisfied."
        });
      }
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
      usage,
      called: true,
      applied: applied.applied,
      rejections: applied.rejections
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Copy refinement provider failed.";
    return {
      ...baseApplication,
      evidence: [{ field: "copy.refinement", source: "llm", value: `Copy refinement skipped: ${message}` }],
      warnings: [message],
      called: true,
      rejections: []
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
  const mayInheritProviderSettings = settings?.provider === undefined || settings.provider === options.provider;
  const apiKey = settings?.apiKey ?? (mayInheritProviderSettings ? options.apiKey : undefined);
  const explicitEnabled = settings?.enabled;
  const enabled = explicitEnabled ?? (provider !== "mock" && provider !== "custom" && Boolean(apiKey));

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
      apiKey,
      model: settings?.model ?? (mayInheritProviderSettings ? options.model : undefined),
      endpoint: settings?.endpoint ?? (mayInheritProviderSettings ? options.endpoint : undefined),
      deployment: settings?.deployment ?? (mayInheritProviderSettings ? options.deployments?.reasoning ?? options.deployment : undefined),
      apiVersion: settings?.apiVersion ?? (mayInheritProviderSettings ? options.apiVersion : undefined),
      temperature: options.temperature
    })
  };
}

function createCopyRefinementPrompt(request: PdpGeoCopyRefinementRequest): { system: string; user: string } {
  return {
    system: [
      "You are a conservative GEO product-copy reasoning agent for structured PDP schema descriptions.",
      "Return strict JSON only: {\"schemaDescriptions\":{\"webPage\":\"\",\"product\":\"\"},\"schemaProperties\":{\"Target customer\":\"\",\"Brand science\":\"\",\"Usage\":\"\",\"Key ingredients and technologies\":\"\",\"Ingredient/effect detail\":\"\",\"Reported details\":\"\",\"Customer review context\":\"\"},\"faqAnswers\":[{\"sourceQuestion\":\"\",\"question\":\"\",\"answer\":\"\"}],\"contentSections\":{\"description\":\"\",\"quickFacts\":\"\",\"faq\":\"\"},\"ruleCompliance\":{\"violatedRuleIds\":[],\"notes\":[]},\"warnings\":[]}.",
      "When the user payload includes policyChecklist, treat it as the complete compiled requirement set from all RAG policy documents: every [critical] rule is a hard constraint, [guidance] rules apply unless product evidence makes them inapplicable, and rules scoped to a field group apply to that output field.",
      "Work field by field: before writing each output field, scan the policyChecklist group for that field plus the General/cross-field group, then draft the copy to satisfy those rules together rather than reacting to individual rules.",
      "After drafting all fields, run a final self-check against every [critical] rule id and the complianceRecap list; fix violations first, and only report ids in ruleCompliance.violatedRuleIds when a rule genuinely cannot be satisfied with the available evidence, with a short reason in ruleCompliance.notes.",
      "Your job is to use GEO research/geo-paper, CEP, and E-E-A-T guidance to identify product facts, keywords, and source-backed phrases that are likely to be useful in AI answer exposure.",
      "Top priority: make public copy more likely to be selected, quoted, or cited by AI answer engines such as ChatGPT, Gemini, Perplexity, and Google AI by creating concise, self-contained, source-backed answer units.",
      "Use selected strategic chunks as the primary task-specific guidance. Use hydrated full RAG documents only as controlled background for missing context, conflict resolution, and policy completeness.",
      "When guidance conflicts, apply this priority: source product evidence first, E-E-A-T trust and claim safety, schema validity, GEO answer-readiness, then CEP/customer phrasing.",
      "Follow official AI/Search guidance as constraints: build helpful, crawlable, people-first content; do not rely on AI-only markup tricks; make structured data consistent with visible source facts and current PDP evidence.",
      "Extract those useful facts from the supplied product evidence only, then combine them into natural public product sentences.",
      "Treat brand identity RAG documents as brand-image, tone, mood, vocabulary, and positioning guidance only. Patents, official papers, research-center counts, heritage stories, or authority signals inside brand identity documents cannot become product claims, Product.additionalProperty facts, or ingredient/technology evidence unless the current product evidence independently contains the same product-level fact.",
      "Use brand identity keywords and personality to highlight product facts that are already supported by productEvidence, for example making supported barrier-care facts sound derma-science-aware or supported ginseng facts sound refined and ritual-led. Do not connect brand-only patents or papers to the product as proof.",
      "Prioritize concrete facts: product type, target concern or customer entry point, differentiating formula/ingredient, measured effect, usage context, and review-intent language.",
      "Treat Product.name as the representative product entity. Keep SKU badges, bracketed commerce labels, volume/size qualifiers, and option labels in alternateName, offer, option, or FAQ context only when they are source-backed; do not let them dominate Product.description.",
      "Use only the supplied product evidence and strategic RAG guidance. Do not invent claims, ingredients, metrics, study details, prices, awards, or certifications.",
      "Before composing, separate source assertions, source-backed synthesis, and query hypotheses. Public fields may use only source assertions and synthesis whose component facts and relationships are independently supported by productEvidence. RAG CEP examples, generativeQueryIntents, and common category knowledge are non-evidentiary hypotheses, not product facts.",
      "Seasonal/weather contexts, time-of-day, occasions, gifting, travel, life stage, and general category associations may appear in public copy only when productEvidence explicitly supports that same context for the current product. Otherwise keep the association as a diagnostic/query hypothesis and remove the unsupported context from descriptions, FAQ questions/answers, and schemaProperties.",
      "Do not infer causality, suitability, routine placement, or an ingredient-benefit relationship from co-occurrence. A relationship must be explicit in one product-evidence sentence or structured source fact; separately supported nouns may be summarized separately but must not be joined with because, supports, recommended for, or equivalent causal language.",
      "Preserve numeric claims, study populations, usage instructions, ingredient names, and product names exactly when they appear in evidence.",
      "For schemaProperties, refine only existing Product.additionalProperty values. Rewrite rigid labels such as Reported details, Ingredient/effect detail, and Customer review context into natural source-backed target-locale sentences.",
      "For Product.description and contentSections.description, compose one connected five-part buyer-answer narrative in this order when evidence exists: (1) product introduction and product type -> (2) target customer and concrete concern/CEP -> (3) detailed main ingredients, named technology, and supported formula structure -> (4) supported finished-product benefits/effects, including only explicitly linked ingredient roles and one deduplicated efficacy/test block when available -> (5) one attributed positive or neutral customer-review summary. Keep exact completed safety tests inside the benefit/evidence block, and keep the review summary last. Product.description may be materially more detailed than WebPage.description, but every detail must come from productEvidence. Select ingredients and technologies by routed role and explicit relationship strength rather than an allowlist; do not turn an educational FAQ/category statement into a current-product ingredient. Use wording that naturally answers likely generative-search intents such as who it is for, which concern it addresses, which ingredient matters, which result is officially supported, and what customers say, without exposing a question list. Product.description describes the product itself, not the PDP or page resource; never use page-level wording such as product page, page covers, 페이지에서는, or 상품 페이지 in Product.description. Do not preserve old fallback wording that violates this order; rewrite from productEvidence and omit facts that belong only to FAQ, HowTo, Offer, diagnostics, or brand identity.",
      "For Product.description and contentSections.description in every locale, keep the CEP readable by splitting dense clauses when needed: first state product identity for the target customer or concern, then connect ingredient/formula evidence to the supported benefit. Avoid one-sentence noun stacks such as \"[target customer]을 위한 [product name]은 [ingredients/formula]의 [benefit product type]입니다\", \"[product] is a [benefit product type] of [patent-pending formula]\", or \"[target]向けの[product]は[処方]の[商品]です\". Infer the ingredient/technology role and use natural locale predicates: ingredient/capsule facts are included or blended, formula/process facts are used/adopted/applied, and mixed ingredient-plus-formula facts become the basis or composition for the supported benefit. Keep patent-application wording in Brand science/additionalProperty when needed.",
      "Keep usage out of Product.description and contentSections.description so the five-part order remains stable. Routine placement and concrete application steps belong in Usage and HowTo.",
      "For faqAnswers, return the COMPLETE FAQ list in final display order. Every item must set sourceQuestion to the exact matching question from currentCopy.faqAnswers; items without a matching sourceQuestion are dropped. Never invent a new FAQ item that has no source question.",
      "Build each FAQ question backwards from a natural recommendation or comparison query, then build its answer forwards from productEvidence. For example, turn an indirect query such as '[concern A] and [concern B] product recommendation' into the product-specific question 'Is [product] suitable for customers with [concern A] and [concern B]?' only when those concerns are supported. generativeQueryIntents are non-evidentiary query hypotheses: use one only to identify a possible underlying intent, then rewrite the question using solely the context that productEvidence supports. Never claim verified query volume, and never copy an unsupported season, occasion, audience, causal premise, or general category association into the public question. Order FAQ by buying-consultation intent: recommendation/suitability first, then key ingredients/benefits, texture/use-feel, usage/routine, comparison/sameness, and evidence/measured results last; skip intents that have no evidence.",
      "For FAQ questions that ask a yes/no determination such as sameness, compatibility, or suitability, begin the answer with 네, or 아니요, (Yes,/No, in English locales) when productEvidence supports the determination, followed by one supported fact sentence. When the evidence cannot support the determination, do not guess and do not lead with a non-answer; answer the underlying intent directly with this product's supported fact.",
      "For FAQ breadth, prefer BestPractice-level coverage when evidence exists: benefit, ingredient/technology, usage, skin suitability, positive review use-feel intent, evidence/metric, variant comparison, routine synergy, persistence, renewal/replacement, and purchase/gift context. Keep unsupported intents unchanged rather than inventing answers.",
      "For faqAnswers, make the first sentence directly answer the question and stand alone as a citation-ready claim unit: include the product name, target concern or customer, product type, key ingredient/technology, benefit/effect, usage context, or metric only when each fact is supported.",
      "For suitability and recommendation FAQ answers, preserve this evidence ladder when each rung is available: explicit concern and target customer -> supported finished-product benefit/effect -> finished-product study result with timing/scope -> each ingredient's explicitly stated role -> recommendation bounded to the supported customer/concern -> individual-results-may-vary qualifier for study results. Omit unsupported rungs. If ingredient roles and finished-product results are not explicitly linked, use separate sentences and state that the evidence does not show an individual ingredient alone caused the finished-product result.",
      "For Korean and English public copy, avoid meta-narration: outside the opening WebPage.description page-introduction sentence, do not make the page, source material, evidence, information, product details, usage guidance, context, or generation process the grammatical subject of a sentence. The customer-facing subject should be the product, ingredient/technology, benefit, usage action, review pattern, option, or customer concern.",
      "For English public copy, avoid observer frames such as \"source-backed evidence reports\", \"product details include\", \"usage guidance covers\", \"texture context supports\", or \"routine context can be compared\". Prefer direct product sentences such as \"the formula includes\", \"customer reviews mention\", \"the product is suitable for\", \"use it\", or \"the option differs by\".",
      "For WebPage.description, write a compact but sufficiently specific page-level summary rather than a second Product.description. When evidence is rich, use two to four natural sentences: introduce the product page and source-backed brand; identify the supported target-customer, ingredient/technology, and benefit information available there as parallel page facts; then summarize directions, official tests or measurements, completed safety-test listings, recurring review themes, product-specific FAQs, variants, or offers. Do not reduce rich evidence to a generic section-name list. Add brand history, expertise, research, or manufacturing context only when separate current-source brand evidence states it. Do not copy the Product.description five-part narrative, exact HowTo actions, raw metric block, or review summary.",
      "Avoid vague WebPage helper wording such as \"The page helps answer\". Name the product, brand, and actual page scope in natural target-locale prose.",
      "For every locale, WebPage.description openings should identify the product page and source-backed brand before summarizing page coverage. Do not insert concrete usage actions, raw metrics, or a product-benefit sales claim into the opening.",
      "For Korean WebPage.description, use a natural page subject such as '[브랜드]의 [상품명] 상품 페이지는...' and keep page scope separate from product claims.",
      "For every locale, keep WebPage.description neutral. Do not turn page coverage into a new recommendation, suitability, efficacy, or superiority claim.",
      "For every locale, do not make a skin type, skin condition, or concern itself the grammatical actor of comparing, selecting, referencing, or checking product information. Write the customer, shopper, concern context, or product page as the actor/beneficiary.",
      "For every locale, do not make the target customer the subject of a concrete usage action. Put routine timing and application actions in Usage/HowTo coverage, not in the target-customer clause.",
      "For every locale, avoid full application directions in WebPage.description. Concrete steps such as dispense into palm, apply over face, spread, pat, rinse, massage, or absorb belong in HowTo or Usage. WebPage.description may mention routine or usage coverage only at a high level.",
      "For every locale, WebPage.description may summarize supported section types once, but must not narrate individual FAQ questions, HowTo actions, or purchase instructions.",
      "For every locale, page-coverage wording is valid in WebPage.description and invalid in Product.description. Keep detailed product facts in Product.description and their dedicated fields.",
      "For Product.description in every locale, connect target customer, ingredient/technology, and benefit/effect only when evidence supports the relationship. If ingredient and benefit facts are separate, keep them as separate sentences.",
      "For every locale, do not use patent numbers or patent-application identifiers in WebPage.description. Keep patent identifiers in Brand science/Product.additionalProperty; WebPage.description should stay focused on product-page identity, source-backed brand identity, and page scope.",
      "For every locale, omit FAQ-topic navigation sentences such as \"questions about why the capsule floats are also covered\". FAQ topics belong in FAQPage, not in WebPage.description.",
      "For Product.description, do not combine an ingredient/technology list and multiple numeric test results into one awkward sentence. Split composition from the supported benefit/evidence block.",
      "For Korean metric sentences, preserve source scientific test-method labels such as English or Latin method names instead of inventing translations. Place the method label before the measured result, e.g. \"[method] 테스트에서 [subject] [value]\", so it is not mistaken for an example marker or a product benefit.",
      "For every locale, avoid report-style predicates such as \"results are presented/shown\", \"figures are provided\", \"결과가 제시됩니다\", \"수치가 제시됩니다\", or \"나타났습니다\" unless the question explicitly asks about evidence or source reporting. For numeric evidence, infer a natural predicate from the measured change, such as recovered, increased, improved, decreased, lasted, or remained.",
      "For WebPage.description, list only high-level page coverage such as ingredients, benefits, directions, reviews, variants, offers, and reported tests; do not copy a HowTo action or full ingredient/metric sentence.",
      "For WebPage.description, do not merge a HowTo step with FAQ topics. A compact section-scope list is enough.",
      "For WebPage.description, keep brand context and page scope separate from current-product mechanisms. Brand-only science cannot prove a product benefit.",
      "For WebPage.description in every locale, do not expose internal analysis labels or patent identifiers. Use natural page-scope nouns in the target locale.",
      "For WebPage.description and Product.description in every locale, never include raw volume/size strings such as \"10.14 fl. oz. / 300 mL\"; volume, size, and count facts belong only in quickFacts, Product.additionalProperty, or Offer context.",
      "For WebPage.description, connect the product-page introduction, brand identity, concrete supported information, and remaining page scope with natural transitions. Keep it compact and avoid a detailed second product narrative.",
      "For Product.description, do not force measured evidence into the narrative. If a metric directly answers the concern, use one natural outcome sentence; otherwise keep full methods, caveats, and disclosures in Reported details. WebPage.description may say the page contains reported test information but should not repeat the figures.",
      "Treat review bodies or review examples that consist only of volume/size strings, product labels, or product names as non-review data: never use them as review context, review keywords, or use-feel evidence.",
      "For Target customer, infer the customer from explicit source evidence. Prefer stated skin type, concern, routine moment, or customer-entry-point evidence. Do not infer visible-aging, wrinkle, or anti-aging intent from weak texture or generic care words unless explicit aging/wrinkle/anti-aging evidence exists.",
      "For Brand science, use only current product-source-backed ingredient, technology, formula, patent, proprietary method, or research evidence. If a patent, paper, research center, or official article appears only in a brand identity document, keep it as brand-image/diagnostic context and do not write it as a product property.",
      "For Usage, include only procedural directions that combine an actual use action with context such as amount, tool, body area, order, frequency, or instruction mood. Exclude formula mechanisms, technology explanations, measured results, review comments, product marketing copy, benefit claims, and application-effect descriptions that merely say what happens when the product is used.",
      "Do not solve copy quality by copying a fixed template. Infer the sentence structure from the target locale, product type, supported evidence, user intent, and field role. Vary syntax naturally while keeping the claim verifiable.",
      "For Korean and English faqAnswers, write direct commerce-answer sentences. Start with the answer itself, then add one supported fact. Use natural predicate families such as suitability, inclusion, care support, benefit delivery, usage action, comparison, or measured result; avoid passive observer/reporting frames unless the question literally asks about a source or document.",
      "Never start an FAQ answer with source narration such as 제품 FAQ에서는, 상품 정보에 따르면, the product FAQ says, according to the page, or equivalent Japanese wording. For supported suitability and concern questions, answer in the order product + target concern/customer + supported finished-product effect; add an ingredient role only when productEvidence contains an explicit ingredient-benefit link. Use recommendation wording only when explicit suitability/recommendation evidence supports it, and never strengthen a neutral source answer merely because the question was reframed.",
      "Before returning public copy, collapse synonymous skin types and customer concerns into one expression in the requested locale; do not emit Korean and English duplicates together. Treat paraphrases of the same application action as one Usage/HowTo step, and keep test application or measured post-application results out of Usage/HowTo.",
      "Use repeated positive or neutral customer review language to infer review-backed recommendation contexts in Product.additionalProperty when it connects a customer situation to supported benefits, ingredients, and use-feel. Exclude negative review sentiment, scent complaints, ratings, and raw reviewer snippets.",
      "When deriving search questions from review-backed CEP, treat an indirect query as a customer-situation/category question that does not mention the product or brand, and a direct query as a product/brand-explicit question. Infer query wording from the customer need, product category, brand/product entity, supported benefits, and key ingredients rather than copying a fixed template.",
      "Keep inferred direct and indirect queries answer-ready: pair each question with short source-backed answer evidence and core keywords. Public schema must not expose the full question as PropertyValue.name; use stable names such as Indirect customer question or Direct product question and keep the inferred question/answer context in PropertyValue.value or route true Q/A pairs to FAQPage.mainEntity. Do not prefix values with labels such as direct query, indirect query, core keywords, or 핵심 키워드. Diagnostics should retain the query kind, question, keywords, answer basis, and whether the product or brand was mentioned.",
      "Do not create or preserve FAQ answers whose only purpose is customer-review sentiment, rating, scent preference, or reviewer experience. Positive review-intent FAQ may summarize reusable use-feel signals, while review-derived recommendation contexts belong in Product.additionalProperty.",
      "For Korean FAQ answers asking whether two capsules, variants, products, or ingredients are the same, answer the same/different point first only when the evidence supports it. When the evidence cannot confirm sameness, never lead with a cannot-confirm sentence such as \"동일 여부는 확인하기 어렵습니다\"; instead answer the underlying intent directly with this product's supported fact (what this product's capsule/formula is). Keep only one concise source-backed support phrase; do not append patent application numbers or broad formula-technology explanations unless the question asks about patents.",
      "Never begin any public FAQ answer, description, or property value with a non-answer such as 확인하기 어렵습니다, 알 수 없습니다, 미공개입니다, cannot be confirmed, or is unclear. If the evidence cannot answer the asked comparison, state the supported fact for this product only; if no supported fact exists for the question, drop the FAQ item instead of publishing a non-answer.",
      "Do not repeat the same metric clause, measured value, or list item twice within one sentence or one property value (e.g. duplicated \"사용 7일 후 87.3% 회복\" clauses or duplicated skin-type items). Each measured result appears exactly once per field.",
      "For suitability/benefit questions, infer a natural sentence that connects product, customer concern, product type, and supported benefit. Do not force a fixed wording pattern when the evidence points to another structure.",
      "For Korean suitability/benefit FAQ answers, preserve supported numeric values but use customer-facing effect predicates such as \"효과가 있습니다\" or \"도움이 됩니다\" instead of report-style endings such as \"결과가 제시됩니다\", unless the question asks for evidence, tests, or reported results.",
      "For Korean evidence/test FAQ answers, avoid \"나타났습니다\" and \"제시됩니다\"; prefer natural direct-result wording such as \"[method] 기준, [measured subject]은/는 [value] 개선되었습니다/증가했습니다/회복되었습니다\".",
      "For ingredient/technology questions, infer a natural sentence that connects ingredient or technology to the supported benefit without inventing a mechanism.",
      "Never add a new number, percentage, duration, sample size, study population, usage period, certification, or claim mechanism that is absent from productEvidence or currentCopy.",
      "Rewrite OCR-like evidence into natural target-locale sentences before using it. Never copy raw all-caps image text, footnote markers, bilingual product labels, or alternate-language product-type labels into public copy.",
      "Respect field evidence contracts: HowTo and usage answers may contain only actionable source directions; ingredient sections may contain only ingredient/formula/full-INCI evidence; benefit sections may contain only source-backed finished-product outcomes, effects, or concise evidence topics. Review-only experience must stay explicitly attributed to reviews and must not become product efficacy.",
      "If a sentence is useful evidence but belongs to a different field, rewrite it only in the correct field and do not move the raw phrase across public fields.",
      "Do not mention the strategy labels in the public copy: no RAG, GEO, geo-paper, CEP, E-E-A-T, schema optimization, citation-ready, OCR, image caption, product shot, pack shot, with text, or in the corner.",
      "Keep the output in the requested locale and make Product.description suitable for schema.org Product.description as an item description, not a page description.",
      "If evidence is insufficient, return the current copy unchanged and explain the limitation in warnings.",
      "When the user payload includes refinementFeedback, this is a corrective pass: regenerate ONLY the fields listed in refinementFeedback, fixing the stated rejection reason while keeping all other rules satisfied. Return empty strings or omit every field that is not listed in refinementFeedback."
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
    policyChecklist: formatPolicyChecklistPayload(request.policyRules ?? []),
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
        examples: compactEvidenceList(
          request.product.reviews.items
            .map((review) => review.body)
            .filter((body) => typeof body === "string" && !isVolumeOrLabelOnlyReviewText(body)),
          5
        )
      },
      sourceTexts: selectHighValueEvidenceTexts(request.product.sourceTexts, maxEvidenceItems)
    },
    descriptionEvidence: {
      purpose: "Use these compact, source-backed candidates to reason about richer WebPage.description and Product.description. Do not copy all items; select the strongest evidence for each field.",
      webPageRole: "Introduce the product page, identify the product and source-backed brand, and summarize the actual information categories available on the page. Keep it concise and page-level; do not repeat Product.description's product-detail narrative, figures, or review summary. Brand history, expertise, research, or manufacturing context requires separate current-source brand evidence.",
      productRole: "Describe the product entity in exactly this order when evidence exists: product introduction/type, target customer and concern, detailed main ingredients/named technology/supported formula structure, supported finished-product benefits/effects with explicit formula-to-benefit relations and one deduplicated evidence/test block, then attributed positive/neutral review context last. Do not append usage, promote educational category facts into product composition, infer unlisted tests, or use page-level wording such as product page/page covers/상품 페이지.",
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
        direction: claim.direction,
        timing: claim.timing,
        baseline: claim.baseline,
        comparator: claim.comparator,
        period: claim.period,
        sample: claim.sample,
        method: claim.method,
        institution: claim.institution,
        evidenceGroup: claim.evidenceGroup,
        caveat: claim.caveat,
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
      safetyTests: selectHighValueEvidenceTexts(request.product.semanticFacts?.safetyTests ?? [], 12),
      evidenceSentences: selectHighValueEvidenceTexts(request.product.semanticFacts?.evidenceSentences ?? [], 10),
      highValueSourceTexts: selectHighValueEvidenceTexts(request.product.sourceTexts, 10)
    },
    fieldRoleContracts: {
      targetCustomer: "Infer from explicit skin type, concern, customer-entry-point, routine moment, or test-audience evidence. Do not transfer an unrelated product's target concern.",
      brandScience: "Use only current product-source-backed ingredient, technology, formula, patent, proprietary method, or research evidence. Brand identity documents may influence tone and brand positioning, but brand-only patents, official papers, or research-center facts must stay out of product properties.",
      usage: "Use only procedural directions: an actual use action plus context such as amount, tool, body area, order, frequency, or instruction mood. Reject product marketing, benefit, or application-effect copy even when it contains a use/action verb.",
      cepRelationship: "Use a situation, occasion, audience, routine moment, constraint, or causal relationship as a public product fact only when productEvidence explicitly supports that same context and relationship. Otherwise treat it as a non-evidentiary query hypothesis.",
      productDescription: "Compose Product.description and content.sections.description as a five-part buyer-answer narrative: product introduction/type -> target customer and concern/CEP -> ingredient/technology composition -> supported finished-product benefit/effect and compact evidence/test context -> attributed positive or neutral review summary last. It must describe the product entity itself and must not mention the product page/PDP/page coverage or append usage. In every locale, keep CEP natural by splitting dense clauses, infer whether evidence is ingredient/capsule, formula/process, or mixed, and use natural product-facing predicates instead of patent/formula possessive noun stacks. Keep detailed methods in Reported details unless one natural outcome sentence directly answers the concern; remove unsupported or misrouted FAQ, purchase, brand-only, and HowTo facts.",
      webPageDescription: "Introduce the product page and source-backed brand, name concrete supported target-customer, ingredient/technology, and benefit information as parallel page facts, then summarize the remaining actual page scope. Do not copy Product.description's connected buyer narrative or add unsupported causal claims, concrete usage actions, raw metric blocks, patent identifiers, or unsupported brand history."
    },
    fieldSeparatedEvidence,
    extractionPriorities: [
      "Choose product facts that directly answer likely generative-search questions.",
      "Compose the first FAQ answer sentence as a self-contained answer unit that an AI answer engine can quote without surrounding context.",
      "Prefer source-backed specificity over broad marketing language.",
      "Map CEP/customer-entry-point language to the product's actual target concern, routine moment, or comparison context.",
      "Use E-E-A-T guidance to keep claims verifiable, attributed to page evidence, and free of exaggeration.",
      "Use GEO research guidance to make descriptions answer-ready without exposing internal optimization language.",
      "For Product.description and content.sections.description, rebuild the sentence flow as product introduction/type -> target customer and concern/CEP -> detailed main ingredients/named technology/supported substructure -> supported finished-product benefit/effect with explicit ingredient/technology relations and one compact evidence/test block -> concise attributed positive or neutral review pattern last. Group multiple measurements only when productEvidence establishes a shared study, footnote group, evidenceGroup, or explicit claim group, keep institution, dates, population/sample, method, baseline, timing, and caveat attached to that group, and render that group only once even if several metricClaims repeat the same sourceText. Keep Product.description product-centric and remove page-resource wording and usage. Keep unrelated secondary metrics in Reported details. Never infer a safety test or certification that is not explicitly present, and describe completion without converting it into a universal safety guarantee.",
      "For Product.description and content.sections.description in every locale, reject dense CEP noun stacks and rebuild them from productEvidence: target customer/concern + product type as one clause, then ingredient/formula + supported benefit as the next clause. Avoid patent/formula possessive product identities in Korean, English, and Japanese.",
      "When currentCopy contains stiff fallback wording, rewrite the meaning from productEvidence instead of paraphrasing the fallback template.",
      "For English as well as Korean, generate the final sentence through evidence-based reasoning rather than inserting a stock phrase.",
      "For WebPage.description, make the first sentence a natural product-page introduction that names the product and source-backed brand; when evidence is rich, follow with one sentence naming concrete supported target/formula/benefit information and one sentence summarizing the remaining decision-support scope.",
      "For WebPage.description in every locale, use high-level page-scope nouns instead of copying detailed product claims, review language, or measured values.",
      "For Korean WebPage.description, prefer '[브랜드]의 [상품명] 상품 페이지는...' followed by a natural list of supported page sections.",
      "For WebPage.description, neutral verbs such as covers, provides, includes, introduces, 다룹니다, 제공합니다, and 소개합니다 are appropriate because the entity is the page.",
      "For WebPage.description, do not restate the Product.description buyer path or close with a recommendation claim.",
      "For WebPage.description, supported skin concern, ingredient/technology names, and benefit categories may identify concrete page information, but keep them parallel and page-scoped. Do not copy usage actions, mechanisms, review prose, or raw test results merely to make the page summary more detailed.",
      "For WebPage.description, include extra brand science or heritage only when separate source-backed brand evidence supports that exact statement.",
      "For WebPage.description, summarize usage only as directions or usage information; never copy the action text.",
      "For WebPage.description in every locale, use natural page-scope terms and do not expose internal analysis labels.",
      "For Korean metric sentences, do not translate scientific method labels unless the source provides the translation; preserve the label and make it grammatically function as the test method.",
      "For WebPage.description in every locale, prefer omitting concrete HowTo steps entirely; rely on FAQ/HowTo schema for detailed application directions."
    ],
    publicCopyQualityGate: [
      "Reject meta-narration where the grammatical subject is source material, evidence, product details, page information, usage guidance, context, or the generation process.",
      "Reject WebPage.description if it does not begin by introducing the product page or if the page introduction is not grounded in concrete product information.",
      "Reject WebPage.description if it repeats detailed Product.description claims instead of summarizing page scope and brand context.",
      "Reject Korean WebPage.description openings where the target skin/customer phrase becomes an awkward possessive modifier such as \"피부의 세안 후\" or \"피부의 첫 단계\".",
      "Accept neutral page verbs such as covers, includes, provides, introduces, 다룹니다, 제공합니다, and 소개합니다 when WebPage is the subject.",
      "Reject WebPage.description when page coverage is strengthened into a new recommendation, suitability, efficacy, or superiority claim.",
      "Reject WebPage.description openings where a skin type or concern itself acts as the subject of comparing, selecting, checking, or referencing product information.",
      "Reject WebPage.description openings where a target customer phrase directly performs a concrete usage action.",
      "Reject Product.description when a full usage step is appended after benefit, ingredient, or metric claims.",
      "Reject content.sections.description when a full usage step is appended after benefit, ingredient, or metric claims.",
      "Reject Product.description or content.sections.description in every locale when the first product sentence is a dense target-customer + formula possessive noun stack, such as \"건조하거나 민감한 피부 고객을 위한 [product]은 ... 포뮬러의 ... 토너입니다\", \"[product] is a [benefit product type] of patent-pending [formula]\", or \"[target]向けの[product]は[処方]の[商品]です\".",
      "Reject Product.description or content.sections.description when it describes the product page/PDP/page coverage instead of the product entity itself.",
      "Reject WebPage.description when it repeats Product.description verbatim or near-verbatim instead of describing page-level coverage.",
      "Reject Product.description or content.sections.description when the final sentence is only FAQ navigation, purchase guidance, patent identifiers, or a report-style note about available information.",
      "Reject WebPage.description sentences where ingredient/technology names and usage directions are merged into one comma-separated object list.",
      "Reject WebPage.description sentences where a full usage step and FAQ topics are merged into one sentence with \"FAQ와 HowTo\".",
      "Reject WebPage.description sentences that only route the reader to FAQ, HowTo, usage guidance, or purchase information.",
      "Reject WebPage.description only when its scope list is unsupported by the final page; a concise supported coverage list is valid.",
      "Reject WebPage.description sentences in every locale that use analysis labels such as \"핵심 성분/기술\", \"key ingredients and technologies\", or \"主な成分・技術\" as the product-introduction predicate, or that chain patent-application qualifiers directly into a formula possessive phrase such as \"특허 출원 ... 포뮬러의\", \"patent-pending ... formula's\", or \"特許出願...処方の\".",
      "Reject WebPage.description sentences where the main product-fact sentence centers on a patent number or patent-application identifier.",
      "Reject WebPage.description sentences that route to FAQ-like topics instead of stating product facts.",
      "Reject Korean FAQ answers for same/different comparison questions when they append patent numbers or formula-technology dumps after the direct answer.",
      "Reject WebPage.description when it copies ingredient lists or numeric test results instead of naming those sections at a high level.",
      "Reject WebPage.description wording that uses a stock helper phrase such as \"The page helps answer\" instead of identifying the product, brand, and page scope.",
      "Reject Product.description that reads like a report about available page information; that framing is reserved for WebPage.description.",
      "Accept only sentences that remain natural when quoted by ChatGPT, Gemini, Google AI, or another answer engine.",
      "Accept fewer FAQ answers when only fewer distinct source-backed search intents are available.",
      "Reject WebPage.description or Product.description sentences that contain raw volume/size strings such as fl. oz. or mL values.",
      "Reject WebPage.description or Product.description sentences that expose analysis labels such as 평가 지표: or Reported result: instead of natural predicates.",
      "Reject WebPage.description or Product.description sentences that use stiff context-verification wording such as \"민감 피부 사용 맥락은 ...로 보완됩니다\" or paste report/disclosure endings such as \"해당 결과는 ... 표기되어 있다\".",
      "Accept a concise, natural list of actual page-coverage categories in WebPage.description."
    ],
    strategicExposureGuidance: strategicChunks.map(formatRagGuidanceChunk),
    strategicFullDocuments: (request.hydratedRagDocuments ?? []).map(formatHydratedRagDocument),
    hydrationPolicy: [
      "Selected chunks are the highest-priority task guidance.",
      "Hydrated full documents are included to prevent missing policy context and to resolve overlaps.",
      "Do not apply any hydrated document example or claim unless the productEvidence supports it.",
      "For hydrated brand identity documents, use keywords, mood, vocabulary, and brand personality as positioning context only; do not transfer brand-only patents, papers, research counts, or official articles into product facts.",
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
    } : undefined,
    complianceRecap: formatPolicyComplianceRecap(request.policyRules ?? []),
    generativeQueryIntents: (request.inferredSearchQueries ?? []).slice(0, 8).map((query) => ({
      kind: query.kind,
      question: query.question,
      keywords: query.keywords,
      mentionsProductOrBrand: query.mentionsProductOrBrand,
      evidenceStatus: "query-hypothesis-only",
      allowedUse: "Intent discovery only; every context and answer fact used publicly must be independently supported by productEvidence."
    })),
    refinementFeedback: request.refinementFeedback?.map((item) => ({
      field: item.field,
      reason: item.reason,
      rejectedText: item.rejectedText ? truncate(cleanText(item.rejectedText), maxEvidenceTextChars) : undefined,
      currentText: item.currentText ? truncate(cleanText(item.currentText), maxEvidenceTextChars) : undefined
    }))
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

function collectRetryTargets(
  applied: Pick<CopyRefinementApplication, "schemaMarkup" | "content" | "rejections">
): PdpGeoCopyRefinementFeedback[] {
  const feedback: PdpGeoCopyRefinementFeedback[] = [...applied.rejections];
  const descriptions = readSchemaDescriptions(applied.schemaMarkup.jsonLd);
  const finalTexts: Array<{ field: string; text?: string }> = [
    { field: "Product.description", text: descriptions.product },
    { field: "WebPage.description", text: descriptions.webPage },
    { field: "content.sections.description", text: applied.content.sections.description }
  ];
  for (const item of finalTexts) {
    if (!item.text) {
      continue;
    }
    if (containsAnalysisLabelArtifact(item.text)) {
      feedback.push({
        field: item.field,
        reason: "the current adopted text still exposes an internal analysis label such as 평가 지표:; rewrite the measured result as a natural product sentence with a supported predicate.",
        currentText: item.text
      });
    } else if (containsRawVolumeFragment(item.text)) {
      feedback.push({
        field: item.field,
        reason: "the current adopted text still lists a raw volume/size string; keep volume in quickFacts or Product.additionalProperty and restore a natural CEP sentence flow.",
        currentText: item.text
      });
    }
  }
  const seen = new Set<string>();
  return feedback.filter((item) => {
    if (seen.has(item.field)) {
      return false;
    }
    seen.add(item.field);
    return true;
  });
}

function mergeTokenUsage(
  first: PdpGeoTokenUsage | undefined,
  second: PdpGeoTokenUsage | undefined
): PdpGeoTokenUsage | undefined {
  if (!first) {
    return second;
  }
  if (!second) {
    return first;
  }
  const sum = (a?: number, b?: number): number | undefined =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
  return {
    inputTokens: sum(first.inputTokens, second.inputTokens),
    outputTokens: sum(first.outputTokens, second.outputTokens),
    totalTokens: sum(first.totalTokens, second.totalTokens)
  };
}

function applyCopyRefinement(
  request: PdpGeoCopyRefinementRequest,
  result: PdpGeoCopyRefinementResult
): Pick<CopyRefinementApplication, "schemaMarkup" | "content" | "evidence" | "warnings" | "applied" | "rejections"> {
  const warnings: string[] = [];
  const evidence: PdpGeoEvidence[] = [];
  const rejections: PdpGeoCopyRefinementFeedback[] = [];
  const descriptions = readSchemaDescriptions(request.schemaMarkup.jsonLd);
  const claimEvidenceCorpus = createClaimEvidenceCorpus(request);
  const sourceContextEvidenceCorpus = createSourceContextEvidenceCorpus(request);
  const productDescription = acceptRefinedText(
    result.schemaDescriptions?.product ?? result.contentSections?.description,
    descriptions.product ?? request.content.sections.description,
    "Product.description",
    warnings,
    {
      evidenceCorpus: claimEvidenceCorpus,
      contextEvidenceCorpus: sourceContextEvidenceCorpus,
      requireSupportedClaimTokens: true,
      rejections,
      contract: { kind: "product-description", request }
    }
  );
  let webPageDescription = acceptRefinedText(
    result.schemaDescriptions?.webPage,
    descriptions.webPage,
    "WebPage.description",
    warnings,
    {
      evidenceCorpus: claimEvidenceCorpus,
      contextEvidenceCorpus: sourceContextEvidenceCorpus,
      requireSupportedClaimTokens: true,
      rejections,
      contract: { kind: "web-page-description", request }
    }
  );
  const contentDescription = acceptRefinedText(
    result.contentSections?.description ?? productDescription,
    request.content.sections.description,
    "content.sections.description",
    warnings,
    {
      evidenceCorpus: claimEvidenceCorpus,
      contextEvidenceCorpus: sourceContextEvidenceCorpus,
      requireSupportedClaimTokens: true,
      rejections,
      contract: { kind: "product-description", request }
    }
  );
  const contentQuickFacts = acceptRefinedText(
    result.contentSections?.quickFacts,
    request.content.sections.quickFacts,
    "content.sections.quickFacts",
    warnings,
    { minLength: 20, maxLength: 2200, evidenceCorpus: claimEvidenceCorpus, contextEvidenceCorpus: sourceContextEvidenceCorpus, requireSupportedClaimTokens: true, rejections }
  );
  // FAQ schema entries are the canonical public source. Free-form FAQ-section rewrites
  // cannot be verified item by item, so retain the approved base unless the same items
  // pass acceptedFaqRefinements below and are rendered back from FAQPage.
  const contentFaq = typeof result.contentSections?.faq === "string"
    && cleanText(result.contentSections.faq) !== cleanText(request.content.sections.faq)
    ? rejectUnverifiableContentFaqRefinement(result.contentSections.faq, warnings, rejections)
    : undefined;

  const nextProductDescription = productDescription ?? contentDescription;
  const nextContentDescription = contentDescription ?? productDescription;
  if (webPageDescription && nextProductDescription && areSchemaDescriptionsTooSimilar(webPageDescription, nextProductDescription)) {
    warnings.push("WebPage.description refinement rejected because it repeats Product.description instead of describing page-level coverage.");
    webPageDescription = undefined;
  }
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
    claimEvidenceCorpus,
    sourceContextEvidenceCorpus,
    rejections
  );
  for (const refinement of propertyRefinements) {
    schemaMarkup = writeProductAdditionalProperty(schemaMarkup, refinement.name, refinement.value);
    evidence.push({ field: `schema.Product.additionalProperty.${refinement.name}`, source: "llm", value: summarizeRefinement(refinement.before, refinement.value) });
    applied = true;
  }

  const isCorrectivePass = Boolean(request.refinementFeedback && request.refinementFeedback.length > 0);
  const faqRefinement = acceptedFaqRefinements(request, result.faqAnswers, warnings, claimEvidenceCorpus, sourceContextEvidenceCorpus, rejections, isCorrectivePass);
  if (faqRefinement) {
    schemaMarkup = writeFaqEntries(schemaMarkup, faqRefinement.entries, faqRefinement.order);
    for (const entry of faqRefinement.entries) {
      if (entry.answer !== entry.beforeAnswer) {
        evidence.push({ field: `schema.FAQPage.mainEntity.${entry.index + 1}.acceptedAnswer`, source: "llm", value: summarizeRefinement(entry.beforeAnswer, entry.answer) });
      }
      if (entry.question !== entry.beforeQuestion) {
        evidence.push({ field: `schema.FAQPage.mainEntity.${entry.index + 1}.name`, source: "llm", value: summarizeRefinement(entry.beforeQuestion, entry.question) });
      }
    }
    if (faqRefinement.order) {
      evidence.push({ field: "schema.FAQPage.mainEntity", source: "llm", value: "FAQ items were reordered by inferred generative-search question intent." });
    }
    applied = true;
  }

  const nextQuickFacts = contentQuickFacts;
  const nextFaq = faqRefinement ? createFaqSectionFromSchema(schemaMarkup.jsonLd) : contentFaq;
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
    applied,
    rejections
  };
}

interface AcceptRefinedTextOptions {
  minLength?: number;
  maxLength?: number;
  evidenceCorpus?: string;
  contextEvidenceCorpus?: string;
  requireSupportedClaimTokens?: boolean;
  rejections?: PdpGeoCopyRefinementFeedback[];
  contract?: {
    kind: "product-description" | "web-page-description" | "faq-answer";
    request: PdpGeoCopyRefinementRequest;
    question?: string;
  };
}

const analysisLabelArtifactPattern = /(?:평가\s*지표|측정\/평가\s*결과|측정\s*결과|확인\s*지표|확인\s*근거|reported\s+results?|consumer\s+assessment|試験結果|確認指標)\s*[:：]/iu;

function containsAnalysisLabelArtifact(text: string): boolean {
  return analysisLabelArtifactPattern.test(text);
}

const rawVolumeFragmentPattern = /\d+(?:\.\d+)?\s*fl\.?\s*oz\.?|\/\s*\d+(?:\.\d+)?\s*m[lL]\b|\d+(?:\.\d+)?\s*m[lL]\s*용량/i;

function containsRawVolumeFragment(text: string): boolean {
  return rawVolumeFragmentPattern.test(text);
}

function containsStiffDescriptionEvidenceNarration(text: string): boolean {
  return /(?:민감\s*피부\s*사용\s*맥락은[^.!?。！？]{0,120}?(?:보완|뒷받침)(?:됩니다|합니다)|해당\s*결과(?:는|가)[^.!?。！？]{0,180}?(?:표기되어\s*있|제시되어\s*있)|원료적\s*특성에\s*한한[^.!?。！？]{0,120}?(?:결과|테스트)|\b(?:the\s+)?(?:source|evidence|reported\s+details?)\b[^.!?]{0,160}\b(?:does\s+not\s+disclose|is\s+presented|is\s+shown)\b)/iu.test(text);
}

export function isVolumeOrLabelOnlyReviewText(value: string): boolean {
  const text = cleanText(value);
  if (!/[0-9０-９]/.test(text)) {
    return false;
  }
  const stripped = text
    .replace(/\d+(?:\.\d+)?\s*(?:fl\.?\s*oz\.?|m[lL]|g|kg|ea|매|개입|정|호)(?![A-Za-z0-9가-힣])/gi, " ")
    .replace(/[\d\s.,/×xX*+·-]+/g, " ")
    .replace(/\b(?:oz|ml)\b/gi, " ")
    .trim();
  return stripped.length < 4;
}

function isDescriptionField(field: string): boolean {
  return field === "Product.description" || field === "WebPage.description" || field === "content.sections.description";
}

function containsRepeatedDescriptionSentence(value: string): boolean {
  const seen = new Set<string>();
  return splitPublicSentences(value).some((sentence) => {
    const key = sentence
      .replace(/^㈜/u, "(주)")
      .toLocaleLowerCase()
      .replace(/[.!?。！？]+$/u, "")
      .replace(/\s+/gu, " ")
      .trim();
    if (key.length < 20) {
      return false;
    }
    if (seen.has(key)) {
      return true;
    }
    seen.add(key);
    return false;
  });
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

  const reject = (reason: string): undefined => {
    warnings.push(`${field} refinement rejected because ${reason}`);
    options.rejections?.push({ field, reason, rejectedText: text });
    return undefined;
  };

  const minLength = options.minLength ?? 40;
  const maxLength = options.maxLength ?? 1800;
  if (text.length < minLength) {
    return reject("it is too short.");
  }
  if (text.length > maxLength) {
    return reject("it is too long.");
  }
  if (isDescriptionField(field) && containsRepeatedDescriptionSentence(text)) {
    return reject("it repeats the same substantive sentence.");
  }
  if (containsInternalOrVisualArtifact(text)) {
    return reject("it contains internal labels or visual-caption artifacts.");
  }
  if (field !== "WebPage.description" && containsPublicMetaNarrationArtifact(text)) {
    return reject("it uses meta-narration instead of customer-facing product copy.");
  }
  if (field === "WebPage.description" && !startsWithProductPageIntroduction(text)) {
    return reject("it does not start with a product-page introduction grounded in product information.");
  }
  if (field === "WebPage.description" && containsAwkwardKoreanWebPageOpening(text)) {
    return reject("its Korean opening compresses the target customer into an awkward possessive noun stack.");
  }
  if (field === "WebPage.description" && containsKoreanSkinTypeAsActorOpening(text)) {
    return reject("its Korean opening makes a skin type the actor instead of a customer or concern.");
  }
  if (field === "WebPage.description" && containsMisroutedUsageTechnologySentence(text)) {
    return reject("it routes ingredient/technology explanation through a usage-area sentence.");
  }
  if (field === "WebPage.description" && containsMixedFaqHowToUsageSentence(text)) {
    return reject("it merges full usage steps with FAQ topics in the same WebPage sentence.");
  }
  if (field === "WebPage.description" && containsWebPagePatentIdentifierCoreSentence(text)) {
    return reject("it uses patent identifiers in a page-level summary.");
  }
  if (field === "WebPage.description" && containsWebPageQuestionNavigationSentence(text)) {
    return reject("FAQ-topic navigation belongs in FAQPage rather than WebPage.description.");
  }
  if (field === "WebPage.description" && containsWebPageMixedIngredientMetricEvidenceSentence(text)) {
    return reject("it merges ingredient/technology lists and numeric test results into one awkward selection-evidence sentence.");
  }
  if (field === "WebPage.description" && containsWebPageIngredientTechnologyAnalysisLabelSentence(text)) {
    return reject("it uses ingredient/technology analysis labels instead of a natural product-introduction sentence.");
  }
  if ((field === "Product.description" || field === "content.sections.description") && containsConcreteProductDescriptionUsageStep(text)) {
    return reject("it appends concrete usage directions that belong in Usage or HowTo.");
  }
  if ((field === "Product.description" || field === "content.sections.description") && containsProductDescriptionDenseCepFormulaSentence(text)) {
    return reject("it compresses CEP, formula, and product identity into an awkward noun-stack sentence.");
  }
  if ((field === "Product.description" || field === "content.sections.description") && containsProductDescriptionPageEntityLanguage(text)) {
    return reject("Product descriptions must describe the product entity, not the product page or page coverage.");
  }
  if ((field === "Product.description" || field === "content.sections.description") && containsMisroutedProductDescriptionTail(text)) {
    return reject("it ends with FAQ, purchase, patent-identifier, or field-navigation content instead of product-facing context.");
  }
  if (isDescriptionField(field) && containsAnalysisLabelArtifact(text)) {
    return reject("it exposes an internal analysis label such as 평가 지표: instead of a natural product sentence.");
  }
  if (isDescriptionField(field) && containsStiffDescriptionEvidenceNarration(text)) {
    return reject("it uses stiff context-verification or source-report wording instead of a natural CEP product narrative.");
  }
  if (isDescriptionField(field) && containsRawVolumeFragment(text)) {
    return reject("it lists raw volume/size strings that belong in quickFacts or Product.additionalProperty.");
  }
  if (containsBrokenKoreanCopyFragment(text)) {
    return reject("it contains a broken Korean sentence fragment.");
  }
  if (introducesUnsupportedContextAssociation(text, options.contextEvidenceCorpus ?? "")) {
    return reject("it promoted a non-evidentiary seasonal, occasion, timing, general-association, or causal query hypothesis into public copy.");
  }
  if (options.requireSupportedClaimTokens && hasUnsupportedClaimTokens(text, options.evidenceCorpus ?? "")) {
    return reject("it introduced unsupported numeric or study claim details.");
  }
  const contractRejection = refinedCopyContractRejection(text, fallbackValue, options.contract);
  if (contractRejection) {
    return reject(contractRejection);
  }

  return text;
}

function rejectUnverifiableContentFaqRefinement(
  value: string,
  warnings: string[],
  rejections: PdpGeoCopyRefinementFeedback[]
): undefined {
  const field = "content.sections.faq";
  const reason = "free-form FAQ section copy cannot be verified item by item; refine matching FAQPage questions and answers instead.";
  warnings.push(`${field} refinement rejected because ${reason}`);
  rejections.push({ field, reason, rejectedText: cleanText(value) });
  return undefined;
}

function refinedCopyContractRejection(
  text: string,
  fallbackValue: string | undefined,
  contract: AcceptRefinedTextOptions["contract"]
): string | undefined {
  if (!contract || !fallbackValue || cleanText(text) === cleanText(fallbackValue)) {
    return undefined;
  }

  switch (contract.kind) {
    case "product-description":
      return productDescriptionContractRejection(text, fallbackValue, contract.request);
    case "web-page-description":
      return webPageDescriptionContractRejection(text, fallbackValue, contract.request);
    case "faq-answer":
      return faqAnswerContractRejection(text, fallbackValue, contract.question ?? "", contract.request);
    default:
      return undefined;
  }
}

type ProductDescriptionRole = "introduction" | "target customer/concern" | "ingredient/formula" | "benefit/effect" | "attributed review";

interface ProductDescriptionRoleRequirement {
  role: ProductDescriptionRole;
  facts: string[];
}

function productDescriptionContractRejection(
  text: string,
  base: string,
  request: PdpGeoCopyRefinementRequest
): string | undefined {
  if (findProductIdentityPosition(base, request) >= 0 && findProductIdentityPosition(text, request) < 0) {
    return "it no longer identifies the product entity present in the approved base description.";
  }

  const relationRejection = unsupportedIngredientBenefitRelationRejection(text, base, request);
  if (relationRejection) {
    return relationRejection;
  }

  const requirements = productDescriptionRoleRequirements(base, request);
  let cursor = -1;
  for (const requirement of requirements) {
    const position = requirement.role === "introduction"
      ? findProductIdentityPosition(text, request, cursor)
      : requirement.role === "attributed review"
        ? findReviewAttributionPosition(text, cursor)
        : findFactPositionAfter(text, requirement.facts, cursor);
    if (position < 0) {
      return `it dropped or reordered the approved ${requirement.role} role.`;
    }
    cursor = position;
  }

  if (requirements.some((item) => item.role === "attributed review") && !reviewAttributionIsLast(text)) {
    return "the source-backed customer-review summary is not the final Product.description role.";
  }
  return undefined;
}

function productDescriptionRoleRequirements(
  base: string,
  request: PdpGeoCopyRefinementRequest
): ProductDescriptionRoleRequirement[] {
  const properties = readProductAdditionalProperties(request.schemaMarkup.jsonLd);
  const targetFacts = unique([
    ...(request.product.semanticFacts?.skinTypes ?? []),
    properties["Target customer"] ?? "",
    ...extractTargetRoleFragments(base)
  ]);
  const ingredientFacts = unique([
    ...request.product.ingredients,
    ...(request.product.semanticFacts?.ingredients ?? []),
    ...(request.product.semanticFacts?.ingredientBenefitLinks ?? []).map((link) => link.ingredient ?? "")
  ]);
  const benefitFacts = unique([
    ...request.product.benefits,
    ...request.product.effects,
    ...(request.product.semanticFacts?.benefits ?? []),
    ...(request.product.semanticFacts?.effects ?? []),
    ...(request.product.semanticFacts?.ingredientBenefitLinks ?? []).flatMap((link) => [link.benefit ?? "", link.effect ?? ""]),
    ...(request.product.semanticFacts?.metricClaims ?? []).flatMap((claim) => [claim.label ?? "", claim.metric ?? "", claim.subject ?? "", claim.sentence ?? ""])
  ]);
  const reviewFacts = sourceBackedReviewFacts(request);
  const requirements: ProductDescriptionRoleRequirement[] = [];

  if (findProductIdentityPosition(base, request) >= 0) {
    requirements.push({ role: "introduction", facts: [] });
  }
  if (findFactPositionAfter(base, targetFacts, -1) >= 0) {
    requirements.push({ role: "target customer/concern", facts: targetFacts });
  }
  if (findFactPositionAfter(base, ingredientFacts, -1) >= 0) {
    requirements.push({ role: "ingredient/formula", facts: ingredientFacts });
  }
  if (findFactPositionAfter(base, benefitFacts, -1) >= 0) {
    requirements.push({ role: "benefit/effect", facts: benefitFacts });
  }
  if (findReviewAttributionPosition(base, -1) >= 0 && findFactPositionAfter(base, reviewFacts, -1) >= 0) {
    requirements.push({ role: "attributed review", facts: reviewFacts });
  }
  return requirements;
}

function webPageDescriptionContractRejection(
  text: string,
  base: string,
  request: PdpGeoCopyRefinementRequest
): string | undefined {
  if (!startsWithProductPageIntroduction(text)) {
    return "it no longer describes the WebPage entity as a product page.";
  }
  if (request.product.brand && factAppearsInText(base, request.product.brand) && !factAppearsInText(text, request.product.brand)) {
    return "it dropped the source-backed brand context present in the approved WebPage.description.";
  }
  if (findProductIdentityPosition(base, request) >= 0 && findProductIdentityPosition(text, request) < 0) {
    return "it dropped the product identity from the page-level introduction.";
  }

  const baseProductDescription = readSchemaDescriptions(request.schemaMarkup.jsonLd).product
    ?? request.content.sections.description;
  if (baseProductDescription && areSchemaDescriptionsTooSimilar(text, baseProductDescription)) {
    return "it is a detailed Product.description clone rather than a page/brand/scope summary.";
  }

  const detailedRoleCount = detailedProductRoleCount(text, baseProductDescription, request);
  const reproducesConnectedBuyerNarrative = /(?:함유|포함|적용|구성)[^.。！？]{0,140}(?:도움|돕|개선|강화|효능|효과)|(?:고객\s*)?(?:리뷰|후기)에서는[^.。！？]{0,120}(?:언급|평가)|\b(?:contains?|includes?|uses?|formulated\s+with)\b[^.!?]{0,140}\b(?:helps?|supports?|improves?|benefits?)\b|\bcustomer reviews?\b[^.!?]{0,120}\b(?:mention|report|highlight)/iu.test(text);
  if (detailedRoleCount >= 4 || detailedRoleCount >= 3 && reproducesConnectedBuyerNarrative) {
    return "it reproduces the detailed Product target, ingredient, benefit, and review narrative instead of page-scoped decision information.";
  }

  const unavailableScope = unavailableWebPageScope(text, request);
  if (unavailableScope) {
    return `it claims ${unavailableScope} page coverage that is not present in the approved schema or product evidence.`;
  }
  return undefined;
}

function faqAnswerContractRejection(
  text: string,
  base: string,
  question: string,
  request: PdpGeoCopyRefinementRequest
): string | undefined {
  if (findProductIdentityPosition(text, request) < 0) {
    return "the answer is no longer product-specific.";
  }
  const relationRejection = unsupportedIngredientBenefitRelationRejection(text, base, request);
  if (relationRejection) {
    return relationRejection;
  }

  const targetFacts = extractTargetRoleFragments(`${question} ${base}`);
  const ingredientFacts = unique([
    ...request.product.ingredients,
    ...(request.product.semanticFacts?.ingredients ?? [])
  ]);
  const benefitFacts = unique([
    ...request.product.benefits,
    ...request.product.effects,
    ...(request.product.semanticFacts?.benefits ?? []),
    ...(request.product.semanticFacts?.effects ?? [])
  ]);
  const retainedRoles: Array<[string, string[]]> = [
    ["target customer/concern", targetFacts],
    ["ingredient/formula", ingredientFacts],
    ["benefit/effect", benefitFacts]
  ];
  for (const [role, facts] of retainedRoles) {
    if (findFactPositionAfter(base, facts, -1) >= 0 && findFactPositionAfter(text, facts, -1) < 0) {
      return `the answer dropped the source-backed ${role} needed for its matched FAQ intent.`;
    }
  }
  return undefined;
}

function detailedProductRoleCount(
  value: string,
  baseProductDescription: string,
  request: PdpGeoCopyRefinementRequest
): number {
  const requirements = productDescriptionRoleRequirements(baseProductDescription, request);
  return requirements.filter((requirement) => {
    if (requirement.role === "introduction") {
      return false;
    }
    if (requirement.role === "attributed review") {
      return findReviewAttributionPosition(value, -1) >= 0
        && findFactPositionAfter(value, requirement.facts, -1) >= 0;
    }
    return findFactPositionAfter(value, requirement.facts, -1) >= 0;
  }).length;
}

function unavailableWebPageScope(value: string, request: PdpGeoCopyRefinementRequest): string | undefined {
  if (/(?:\bHowTo\b|how\s+to\s+use|사용법|사용\s*방법|使い方|使用方法)/iu.test(value)
    && !hasSchemaNode(request.schemaMarkup.jsonLd, "HowTo")) {
    return "HowTo/usage-direction";
  }
  if (/(?:\bFAQ(?:s)?\b|자주\s*묻는\s*질문|よくある質問)/iu.test(value)
    && !hasSchemaNode(request.schemaMarkup.jsonLd, "FAQPage")) {
    return "FAQ";
  }
  if (/(?:customer\s+reviews?|reviews?|고객\s*리뷰|후기|カスタマーレビュー|口コミ)/iu.test(value)
    && request.product.reviews.items.length === 0
    && !request.product.reviews.reviewCount) {
    return "customer-review";
  }
  return undefined;
}

function sourceBackedReviewFacts(request: PdpGeoCopyRefinementRequest): string[] {
  return unique([
    ...request.product.reviews.keywords,
    ...request.product.reviews.items
      .map((item) => item.body)
      .filter((body) => !isVolumeOrLabelOnlyReviewText(body))
  ]);
}

function findReviewAttributionPosition(value: string, after: number): number {
  const comparable = normalizeComparableText(value);
  const matches = Array.from(comparable.matchAll(/customer reviews?|customers? (?:say|mention|report|describe)|user reviews?|reviewers?|고객 리뷰|고객들은|사용자들은|리뷰에서는|리뷰에 따르면|후기에서는|후기에는|口コミ|レビューでは/giu));
  return matches.map((match) => match.index ?? -1).find((index) => index > after) ?? -1;
}

function reviewAttributionIsLast(value: string): boolean {
  const sentences = splitPublicSentences(value);
  if (sentences.length === 0) {
    return false;
  }
  return findReviewAttributionPosition(sentences.at(-1) ?? "", -1) >= 0;
}

function extractTargetRoleFragments(value: string): string[] {
  const fragments: string[] = [];
  for (const sentence of splitPublicSentences(value)) {
    const koreanFor = sentence.match(/(.{2,90}?)(?:을|를)\s*위한/u);
    if (koreanFor?.[1]) {
      fragments.push(koreanFor[1].split(/(?:은|는|,|;)/u).at(-1) ?? "");
    }
    const koreanFit = sentence.match(/(.{2,90}?)(?:에게|에)\s*(?:적합|추천|권장)/u);
    if (koreanFit?.[1]) {
      fragments.push(koreanFit[1].split(/(?:은|는|,|;)/u).at(-1) ?? "");
    }
    const english = sentence.match(/\bfor\s+([^,.!?;]{2,100})/iu);
    if (english?.[1]) {
      fragments.push(english[1].split(/\b(?:with|who|that|seeking)\b/iu)[0] ?? "");
    }
    const japanese = sentence.match(/([^。！？、]{2,90})(?:向け|のため)/u);
    if (japanese?.[1]) {
      fragments.push(japanese[1].split(/(?:は|、)/u).at(-1) ?? "");
    }
  }
  return unique(fragments.map((fragment) => fragment.replace(/^(?:and|or|또는|및)\s+/iu, "").trim()).filter((fragment) => fragment.length >= 3));
}

function findProductIdentityPosition(value: string, request: PdpGeoCopyRefinementRequest, after = -1): number {
  const comparable = compactComparableText(value);
  const fullNames = unique([request.product.name, request.product.originalName ?? ""])
    .map(compactComparableText)
    .filter((name) => name.length >= 3);
  const exact = fullNames
    .map((name) => comparable.indexOf(name, after + 1))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  if (exact !== undefined) {
    return exact;
  }

  const tokens = distinctiveProductIdentityTokens(request);
  return tokens
    .map((token) => comparable.indexOf(token, after + 1))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0] ?? -1;
}

function distinctiveProductIdentityTokens(request: PdpGeoCopyRefinementRequest): string[] {
  const brand = compactComparableText(request.product.brand ?? "");
  const tokens = normalizeComparableText(`${request.product.name} ${request.product.originalName ?? ""}`)
    .split(/\s+/u)
    .map(compactComparableText)
    .filter((token) => token.length >= 3 && token !== brand);
  return unique(tokens.sort((left, right) => right.length - left.length).slice(0, 4));
}

function findFactPositionAfter(value: string, facts: string[], after: number): number {
  const comparable = compactComparableText(value);
  const positions = facts
    .map(compactComparableText)
    .filter((fact) => fact.length >= 2)
    .map((fact) => comparable.indexOf(fact, after + 1))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right);
  return positions[0] ?? -1;
}

function factAppearsInText(value: string, fact: string): boolean {
  const anchor = compactComparableText(fact);
  return anchor.length >= 2 && compactComparableText(value).includes(anchor);
}

function compactComparableText(value: string): string {
  return normalizeComparableText(value).replace(/\s+/gu, "");
}

function unsupportedIngredientBenefitRelationRejection(
  value: string,
  approvedBase: string,
  request: PdpGeoCopyRefinementRequest
): string | undefined {
  const ingredientFacts = unique([
    ...request.product.ingredients,
    ...(request.product.semanticFacts?.ingredients ?? []),
    ...(request.product.semanticFacts?.ingredientBenefitLinks ?? []).map((link) => link.ingredient ?? "")
  ]).filter((ingredient) => compactComparableText(ingredient).length >= 2);

  for (const sentence of splitPublicSentences(value)) {
    for (const ingredient of ingredientFacts) {
      if (!ingredientActsAsBenefitCause(sentence, ingredient)) {
        continue;
      }
      if (!hasExplicitIngredientRelationSupport(sentence, ingredient, approvedBase, request)) {
        return `it added an unsupported causal ingredient-to-benefit relation for "${truncate(ingredient, 80)}".`;
      }
    }
  }
  return undefined;
}

function ingredientActsAsBenefitCause(sentence: string, ingredient: string): boolean {
  const anchor = flexibleLiteralPattern(ingredient);
  if (!anchor) {
    return false;
  }
  const outcomePredicate = "(?:돕|도움|개선|강화|회복|진정|완화|보습|수분|탄력|주름|보호|기여|제공|helps?|supports?|improves?|strengthens?|restores?|soothes?|hydrates?|moisturi[sz]es?|protects?|reduces?|delivers?|provides?|contributes?|改善|強化|回復|整え|支え|助け|保湿|うるお|鎮静|保護|寄与|提供)";
  return new RegExp(`${anchor}\\s*(?:이|가|은|는)\\s*[^.!?。！？]{0,120}${outcomePredicate}`, "iu").test(sentence)
    || new RegExp(`${anchor}\\s*(?:itself\\s+)?[^.!?]{0,32}\\b${outcomePredicate}`, "iu").test(sentence)
    || new RegExp(`${anchor}\\s*(?:が|は)\\s*[^。！？]{0,120}${outcomePredicate}`, "iu").test(sentence)
    || new RegExp(`(?:because\\s+of|due\\s+to|powered\\s+by|thanks\\s+to|덕분에|때문에|により|によって)\\s*${anchor}`, "iu").test(sentence);
}

function hasExplicitIngredientRelationSupport(
  candidateSentence: string,
  ingredient: string,
  approvedBase: string,
  request: PdpGeoCopyRefinementRequest
): boolean {
  const structuredLinks = request.product.semanticFacts?.ingredientBenefitLinks ?? [];
  for (const link of structuredLinks) {
    if (!link.ingredient || !sameFactAnchor(link.ingredient, ingredient)) {
      continue;
    }
    const supportedOutcome = [link.benefit, link.effect, link.sentence, link.sourceText].filter((item): item is string => Boolean(item)).join(" ");
    if (hasMeaningfulClaimOverlap(candidateSentence, supportedOutcome, ingredient)) {
      return true;
    }
  }

  const evidenceSentences = unique([
    approvedBase,
    request.product.description ?? "",
    ...request.product.sourceTexts,
    ...(request.product.semanticFacts?.evidenceSentences ?? []),
    ...request.product.faq.flatMap((item) => [item.question, item.answer]),
    ...(request.product.semanticFacts?.ingredientBenefitLinks ?? []).flatMap((link) => [link.sentence ?? "", link.sourceText ?? ""])
  ]).flatMap(splitPublicSentences);
  return evidenceSentences.some((evidenceSentence) =>
    factAppearsInText(evidenceSentence, ingredient)
    && ingredientActsAsBenefitCause(evidenceSentence, ingredient)
    && hasMeaningfulClaimOverlap(candidateSentence, evidenceSentence, ingredient));
}

function hasMeaningfulClaimOverlap(candidate: string, evidence: string, ingredient: string): boolean {
  const ingredientTokens = new Set(semanticTokens(ingredient));
  const candidateTokens = semanticTokens(candidate).filter((token) => !ingredientTokens.has(token) && !relationFunctionToken(token));
  const evidenceTokens = semanticTokens(evidence).filter((token) => !ingredientTokens.has(token) && !relationFunctionToken(token));
  return candidateTokens.some((candidateToken) =>
    evidenceTokens.some((evidenceToken) => candidateToken === evidenceToken
      || (candidateToken.length >= 3 && evidenceToken.length >= 3
        && (candidateToken.startsWith(evidenceToken) || evidenceToken.startsWith(candidateToken)))));
}

function semanticTokens(value: string): string[] {
  return normalizeComparableText(value)
    .split(/\s+/u)
    .map((token) => token
      .replace(/(?:에게|에서|으로|에는|부터|까지|하며|하고|하여|되는|합니다|됩니다|입니다|이다|을|를|이|가|은|는|의|에|와|과|도)$/u, "")
      .trim())
    .filter((token) => token.length >= 2);
}

function relationFunctionToken(value: string): boolean {
  return /^(?:도움|돕|개선|강화|회복|기여|제공|help|helps|support|supports|improve|improves|strengthen|strengthens|provide|provides|product|제품|상품|ingredient|성분|配合|支え|改善|強化)$/iu.test(value);
}

function sameFactAnchor(left: string, right: string): boolean {
  const leftComparable = compactComparableText(left);
  const rightComparable = compactComparableText(right);
  return leftComparable === rightComparable
    || leftComparable.includes(rightComparable)
    || rightComparable.includes(leftComparable);
}

function flexibleLiteralPattern(value: string): string {
  return cleanText(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\s\\-_/·]*");
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
  evidenceCorpus: string,
  contextEvidenceCorpus: string,
  rejections: PdpGeoCopyRefinementFeedback[]
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
      { minLength: 12, maxLength: 900, evidenceCorpus, contextEvidenceCorpus, requireSupportedClaimTokens: true, rejections }
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
  if (/^(?:Brand science|Key ingredients and technologies|Ingredient\/effect detail)$/i.test(name)
    && containsBrandIdentityAuthoritySignal(value)
    && !isSupportedByProductAuthorityEvidence(value, request)) {
    warnings.push(`Product.additionalProperty.${name} refinement rejected because brand identity papers, patents, or research-center signals cannot be used as product evidence unless the current product source supports them.`);
    return false;
  }
  if (/^Key ingredients and technologies$/i.test(name) && !hasIngredientTechnologyEvidence(value)) {
    warnings.push(`Product.additionalProperty.${name} refinement rejected because it does not contain ingredient or technology evidence.`);
    return false;
  }
  return true;
}

function containsBrandIdentityAuthoritySignal(value: string): boolean {
  return /(?:research\s+(?:papers?|articles?)|official\s+(?:articles?|papers?)|peer[-\s]?reviewed|published\s+(?:paper|study|article)|research\s+center|research\s+institute|Derma\s*Lab|NBRI|Johns\s*Hopkins|PubMed|PMID|patents?|특허|논문|공식\s*(?:논문|문서|기사)|연구소|연구\s*센터|학술지|저널)/i.test(value);
}

function isSupportedByProductAuthorityEvidence(value: string, request: PdpGeoCopyRefinementRequest): boolean {
  const productEvidence = normalizeComparableText(JSON.stringify({
    description: request.product.description,
    benefits: request.product.benefits,
    effects: request.product.effects,
    ingredients: request.product.ingredients,
    metrics: request.product.metrics,
    sourceTexts: request.product.sourceTexts,
    semanticFacts: request.product.semanticFacts
  }));
  return extractBrandIdentityAuthorityTokens(value).some((token) => productEvidence.includes(token));
}

function extractBrandIdentityAuthorityTokens(value: string): string[] {
  const normalized = normalizeComparableText(value);
  return [
    "patent",
    "published paper",
    "peer reviewed",
    "research paper",
    "official article",
    "research center",
    "research institute",
    "derma lab",
    "nbri",
    "johns hopkins",
    "pubmed",
    "pmid",
    "특허",
    "논문",
    "공식 논문",
    "공식 기사",
    "연구소",
    "연구 센터",
    "학술지",
    "저널"
  ].map(normalizeComparableText).filter((token) => normalized.includes(token));
}

interface AcceptedFaqRefinement {
  entries: Array<{ index: number; question: string; answer: string; beforeQuestion: string; beforeAnswer: string }>;
  order?: number[];
}

function acceptedFaqRefinements(
  request: PdpGeoCopyRefinementRequest,
  values: PdpGeoCopyRefinementResult["faqAnswers"],
  warnings: string[],
  evidenceCorpus: string,
  contextEvidenceCorpus: string,
  rejections: PdpGeoCopyRefinementFeedback[],
  correctivePass: boolean
): AcceptedFaqRefinement | undefined {
  if (!Array.isArray(values) || values.length === 0) {
    return undefined;
  }

  const currentFaq = readSchemaFaqItems(request.schemaMarkup.jsonLd);
  const matchedOrder: number[] = [];
  const entries: AcceptedFaqRefinement["entries"] = [];

  for (const [itemIndex, item] of values.entries()) {
    if (!isRecord(item)) {
      continue;
    }
    const matchKey = typeof item.sourceQuestion === "string" && item.sourceQuestion.trim().length > 0
      ? item.sourceQuestion
      : typeof item.question === "string" ? item.question : "";
    const faqIndex = matchKey
      ? currentFaq.findIndex((faq) => normalizeComparableText(faq.question) === normalizeComparableText(matchKey))
      : (itemIndex < currentFaq.length ? itemIndex : -1);
    if (faqIndex < 0) {
      if (!correctivePass) {
        warnings.push(`FAQPage.mainEntity refinement item "${truncate(cleanText(matchKey), 80)}" dropped because it does not match an existing FAQ question.`);
      }
      continue;
    }
    if (matchedOrder.includes(faqIndex)) {
      continue;
    }
    matchedOrder.push(faqIndex);

    const beforeQuestion = currentFaq[faqIndex]!.question;
    const beforeAnswer = currentFaq[faqIndex]!.answer;
    const question = acceptRefinedFaqQuestion(item.question, beforeQuestion, faqIndex, warnings, evidenceCorpus, contextEvidenceCorpus, request);
    const answer = acceptRefinedText(
      item.answer,
      beforeAnswer,
      `FAQPage.mainEntity.${faqIndex + 1}.acceptedAnswer`,
      warnings,
      {
        minLength: 24,
        maxLength: 900,
        evidenceCorpus,
        contextEvidenceCorpus,
        requireSupportedClaimTokens: true,
        rejections,
        contract: {
          kind: "faq-answer",
          request,
          question: question ?? beforeQuestion
        }
      }
    );
    const acceptedAnswer = answer && isAcceptedFaqAnswerValue(question ?? beforeQuestion, answer, warnings, faqIndex) ? answer : beforeAnswer;
    entries.push({
      index: faqIndex,
      question: question ?? beforeQuestion,
      answer: acceptedAnswer,
      beforeQuestion,
      beforeAnswer
    });
  }

  if (entries.length === 0) {
    return undefined;
  }

  if (correctivePass) {
    // A corrective pass regenerates only the fields listed in refinementFeedback, so the
    // returned faqAnswers list is intentionally partial. Apply text replacements only and
    // never recompute FAQ order from a partial list, which would otherwise promote whichever
    // item happened to be retried to the front and destroy pass 1's recommendation-first order.
    const isChanged = entries.some((entry) => entry.question !== entry.beforeQuestion || entry.answer !== entry.beforeAnswer);
    return isChanged ? { entries, order: undefined } : undefined;
  }

  const remaining = currentFaq.map((_, index) => index).filter((index) => !matchedOrder.includes(index));
  const order = [...matchedOrder, ...remaining];
  const isReordered = order.some((value, index) => value !== index);
  const isChanged = isReordered || entries.some((entry) => entry.question !== entry.beforeQuestion || entry.answer !== entry.beforeAnswer);
  return isChanged ? { entries, order: isReordered ? order : undefined } : undefined;
}

function acceptRefinedFaqQuestion(
  value: unknown,
  beforeQuestion: string,
  index: number,
  warnings: string[],
  evidenceCorpus: string,
  contextEvidenceCorpus: string,
  request: PdpGeoCopyRefinementRequest
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = cleanText(value);
  if (!text || text === beforeQuestion) {
    return text || undefined;
  }
  if (text.length < 8 || text.length > 200) {
    warnings.push(`FAQPage.mainEntity.${index + 1}.name refinement rejected because the rewritten question length is out of range.`);
    return undefined;
  }
  if (containsInternalOrVisualArtifact(text)) {
    warnings.push(`FAQPage.mainEntity.${index + 1}.name refinement rejected because it contains internal labels or visual-caption artifacts.`);
    return undefined;
  }
  if (hasUnsupportedClaimTokens(text, evidenceCorpus)) {
    warnings.push(`FAQPage.mainEntity.${index + 1}.name refinement rejected because it introduced unsupported numeric or study claim details.`);
    return undefined;
  }
  if (introducesUnsupportedContextAssociation(text, contextEvidenceCorpus)) {
    warnings.push(`FAQPage.mainEntity.${index + 1}.name refinement rejected because it promoted a non-evidentiary seasonal, occasion, timing, general-association, or causal query hypothesis into public copy.`);
    return undefined;
  }
  if (findProductIdentityPosition(text, request) < 0
    && (!request.product.brand || !factAppearsInText(text, request.product.brand))) {
    warnings.push(`FAQPage.mainEntity.${index + 1}.name refinement rejected because the rewritten question is no longer specific to this product or brand.`);
    return undefined;
  }
  return text;
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

function areSchemaDescriptionsTooSimilar(webPageDescription: string, productDescription: string): boolean {
  const webPageOpening = splitPublicSentences(webPageDescription)[0] ?? "";
  const productOpening = splitPublicSentences(productDescription)[0] ?? "";
  const hasDistinctPageOpening = /(?:상품\s*페이지|제품\s*페이지|상세\s*페이지|product\s+(?:detail\s+)?page|\bPDP\b|商品ページ|製品ページ)/iu.test(webPageOpening)
    && normalizeDescriptionForRoleComparison(webPageOpening) !== normalizeDescriptionForRoleComparison(productOpening);
  const webPage = normalizeDescriptionForRoleComparison(webPageDescription);
  const product = normalizeDescriptionForRoleComparison(productDescription);
  if (!webPage || !product) {
    return false;
  }
  if (webPage === product) {
    return true;
  }
  if (product.length >= 72 && webPage.includes(product)) {
    return true;
  }
  if (webPage.length >= 72 && product.includes(webPage)) {
    return true;
  }
  if (hasDistinctPageOpening) {
    return false;
  }

  const webPageSentences = splitPublicSentences(webPageDescription).map(normalizeDescriptionForRoleComparison).filter((sentence) => sentence.length >= 72);
  const productSentences = splitPublicSentences(productDescription).map(normalizeDescriptionForRoleComparison).filter((sentence) => sentence.length >= 72);
  return productSentences.some((productSentence) =>
    webPageSentences.some((webPageSentence) =>
      webPageSentence === productSentence
      || webPageSentence.includes(productSentence)
      || productSentence.includes(webPageSentence)
    )
  );
}

function normalizeDescriptionForRoleComparison(value: string): string {
  return normalizeComparableText(value)
    .replace(/\b(?:this|the)\b/g, " ")
    .replace(/\b(?:product\s+detail\s+page|product\s+page|pdp|page)\b/g, " ")
    .replace(/\b(?:introduces?|summari[sz]es?|covers?|presents?|describes?|includes?|explains?|helps?|lets?)\b/g, " ")
    .replace(/(?:상품\s*페이지|제품\s*페이지|상세\s*페이지|페이지에서는|페이지에는|페이지는|페이지|소개합니다|추천합니다|다룹니다|안내합니다|설명합니다|제공합니다|확인할\s*수\s*있습니다)/g, " ")
    .replace(/(?:商品ページ|製品ページ|ページでは|ページは|ページ)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function createSourceContextEvidenceCorpus(request: PdpGeoCopyRefinementRequest): string {
  // Deliberately exclude currentCopy and inferred search queries. They are
  // generated artifacts/hypotheses and cannot substantiate a new public CEP.
  return JSON.stringify(request.product);
}

const sourceRequiredContextPatterns: RegExp[] = [
  /\b(?:spring|springtime)\b|(?:봄철?|춘계)|(?:春|春季)/iu,
  /\b(?:summer|summertime|hot\s+weather)\b|(?:여름철?|하절기|더운\s*날씨)|(?:夏|夏季|暑い\s*時期)/iu,
  /\b(?:autumn|autumnal)\b|(?:가을철?|추계)|(?:秋|秋季)/iu,
  /\b(?:winter|wintertime|cold\s+weather)\b|(?:겨울철?|동절기|추운\s*날씨)|(?:冬|冬季|寒い\s*時期)/iu,
  /\b(?:seasonal\s+transition|change\s+of\s+seasons?|dry\s+season|rainy\s+season)\b|(?:환절기|건기|우기|장마철)|(?:季節の変わり目|乾季|雨季|梅雨)/iu,
  /\b(?:morning|a\.m\.)\b|(?:아침|오전)|(?:朝|午前)/iu,
  /\b(?:night|nighttime|evening|bedtime|overnight|p\.m\.)\b|(?:밤|야간|저녁|취침\s*전|밤사이)|(?:夜|夜間|夕方|就寝前|一晩)/iu,
  /\b(?:after\s+cleansing|post[-\s]?cleanse|after\s+washing)\b|(?:세안\s*후|클렌징\s*후)|(?:洗顔後|クレンジング後)/iu,
  /\b(?:before\s+makeup|pre[-\s]?makeup|under\s+makeup)\b|(?:메이크업\s*전|화장\s*전)|(?:メイク前|化粧前)/iu,
  /\b(?:gift|gifting|holiday|celebration)\b|(?:선물|기프트|명절|기념일)|(?:ギフト|贈り物|祝日|記念日)/iu,
  /\b(?:travel|travelling|traveling|on[-\s]?the[-\s]?go)\b|(?:여행|휴대용|외출)|(?:旅行|持ち運び|外出)/iu,
  /\b(?:exercise|workout|sport|outdoor)\b|(?:운동|스포츠|야외\s*활동)|(?:運動|スポーツ|屋外)/iu,
  /\b(?:after\s+(?:a\s+)?procedure|post[-\s]?procedure|post[-\s]?treatment)\b|(?:시술\s*후|치료\s*후)|(?:施術後|治療後)/iu,
  /\b(?:pregnan(?:t|cy)|postpartum|baby|infant|child|teen)\b|(?:임신|산후|아기|영유아|어린이|청소년)|(?:妊娠|産後|赤ちゃん|乳幼児|子ども|十代)/iu
];

const sourceRequiredGeneralizationPattern = /\b(?:generally|typically|usually|commonly|as\s+a\s+rule|in\s+general)\b|(?:일반적으로|대체로|통상적으로|보통은)|(?:一般的に|通常は|概して)/iu;
const sourceRequiredCausalPattern = /\b(?:because|because\s+of|due\s+to|caused\s+by|as\s+a\s+result\s+of)\b|(?:때문에|로\s*인해|에서\s*비롯|결과로)|(?:ために|によって|が原因で)/iu;

function introducesUnsupportedContextAssociation(value: string, sourceEvidenceCorpus: string): boolean {
  if (!value) return false;
  for (const pattern of sourceRequiredContextPatterns) {
    if (pattern.test(value) && !pattern.test(sourceEvidenceCorpus)) return true;
  }
  return sourceRequiredGeneralizationPattern.test(value) && !sourceRequiredGeneralizationPattern.test(sourceEvidenceCorpus)
    || sourceRequiredCausalPattern.test(value) && !sourceRequiredCausalPattern.test(sourceEvidenceCorpus);
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

function writeFaqEntries(
  schemaMarkup: PdpGeoSchemaMarkup,
  entries: AcceptedFaqRefinement["entries"],
  order?: number[]
): PdpGeoSchemaMarkup {
  const jsonLd = cloneJsonObject(schemaMarkup.jsonLd);
  const graph = Array.isArray(jsonLd["@graph"]) ? jsonLd["@graph"] : [];
  const faqPage = graph.find((node) => isSchemaNodeOfType(node, "FAQPage"));
  if (!isRecord(faqPage) || !Array.isArray(faqPage.mainEntity)) {
    return schemaMarkupFromJsonLd(jsonLd);
  }
  const mainEntity = faqPage.mainEntity;
  for (const entry of entries) {
    const item = mainEntity[entry.index];
    if (!isRecord(item)) {
      continue;
    }
    item.name = entry.question;
    if (isRecord(item.acceptedAnswer)) {
      item.acceptedAnswer.text = entry.answer;
    }
  }
  if (order) {
    faqPage.mainEntity = order
      .map((index) => mainEntity[index])
      .filter((item): item is JsonObject => isRecord(item));
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
          sourceQuestion: typeof item.sourceQuestion === "string" ? item.sourceQuestion : undefined,
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
    ruleCompliance: isRecord(payload.ruleCompliance)
      ? {
          violatedRuleIds: Array.isArray(payload.ruleCompliance.violatedRuleIds)
            ? payload.ruleCompliance.violatedRuleIds.map(String).filter(Boolean)
            : [],
          notes: Array.isArray(payload.ruleCompliance.notes)
            ? payload.ruleCompliance.notes.map(String).filter(Boolean)
            : []
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
    if (/[가-힣]/.test(text) && /(?:FAQ\s*(?:와|및|\/|과)\s*HowTo|HowTo\s*(?:와|및|\/|과)\s*FAQ)/i.test(text)) {
      return /(?:손바닥|적당량|얼굴\s*전체|피부결|펴\s*바른|펴\s*발라|흡수|두드려|도포|바르는\s*방법|사용\s*방법|사용법)[^.!?。！？]{0,120}(?:이유|동일\s*여부|차이|문의|질문|FAQ|캡슐|워터)/i.test(text)
        || /(?:방법|사용법)(?:과|와)[^.!?。！？]{0,120}(?:이유|동일\s*여부|차이|FAQ|캡슐|워터)/i.test(text);
    }
    if (/[A-Za-z]/.test(text) && /(?:FAQ|FAQs?|frequently asked questions?)[^.!?]{0,80}(?:HowTo|how-to|how\s+to\s+use|usage|directions?)|(?:HowTo|how-to|how\s+to\s+use|usage|directions?)[^.!?]{0,80}(?:FAQ|FAQs?|frequently asked questions?)/i.test(text)) {
      return /(?:apply|dispense|spread|pat|rinse|massage|lather|absorb|use\s+method|application\s+method|directions?)[^.!?]{0,140}(?:why|same|identical|difference|questions?|FAQ|capsule|water|cream)/i.test(text)
        || /(?:method|directions?|usage)[^.!?]{0,48}(?:and|with)[^.!?]{0,140}(?:why|same|identical|difference|FAQ|capsule|water|cream)/i.test(text);
    }
    if (/[ぁ-んァ-ン一-龯]/.test(text) && /(?:FAQ|よくある質問)[^。！？]{0,80}(?:HowTo|使い方|使用方法)|(?:HowTo|使い方|使用方法)[^。！？]{0,80}(?:FAQ|よくある質問)/i.test(text)) {
      return /(?:適量|手のひら|顔全体|肌になじませ|塗布|すすぎ|マッサージ|使用方法|使い方)[^。！？]{0,120}(?:理由|同じ|違い|質問|FAQ|カプセル|水|クリーム)/.test(text);
    }
    return false;
  });
}

function containsRedundantFaqHowToNavigationSentence(value: string): boolean {
  return splitPublicSentences(value).some((sentence) => {
    const text = cleanText(sentence);
    if (containsRedundantKoreanFaqHowToNavigationSentence(text)) {
      return true;
    }
    if (/[A-Za-z]/.test(text)
      && /(?:FAQ|FAQs?|frequently asked questions?|HowTo|how-to|how\s+to\s+use|usage\s+(?:guidance|section|steps?)|directions?|purchase\s+(?:information|details?)|buying\s+(?:information|details?))/i.test(text)) {
      return /(?:can\s+be\s+(?:checked|confirmed|found|viewed|reviewed)|is\s+provided|are\s+provided|is\s+included|are\s+included|covers?|summari[sz]es?|answers?|addresses?|includes?)/i.test(text);
    }
    if (/[ぁ-んァ-ン一-龯]/.test(text)
      && /(?:FAQ|よくある質問|HowTo|使い方|使用方法|購入情報|購入詳細)/i.test(text)) {
      return /(?:確認できます|確認できる|見られます|参照できます|扱います|提供されます|含まれます|まとめています)/.test(text);
    }
    return false;
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

function containsWebPageFactNavigationSentence(value: string): boolean {
  return splitPublicSentences(value).some((sentence) => {
    const text = cleanText(sentence);
    if (containsKoreanWebPageFactNavigationSentence(text)) {
      return true;
    }
    if (/[A-Za-z]/.test(text)
      && /(?:formula|ingredient|technology|measurement|metric|figure|result|clinical|test|study|efficacy|benefit)\s*(?:details?|information|results?|figures?)?/i.test(text)
      && /(?:can\s+be\s+(?:checked|confirmed|viewed|found|reviewed)|may\s+be\s+(?:checked|viewed|found|reviewed)|is\s+available|are\s+available|can\s+be\s+compared)/i.test(text)) {
      return true;
    }
    if (/[ぁ-んァ-ン一-龯]/.test(text)
      && /(?:成分|技術|処方|測定|評価|数値|結果|効果|効能)/.test(text)
      && /(?:確認できます|確認できる|見られます|参照できます|比較できます)/.test(text)) {
      return true;
    }
    return false;
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

function containsWebPageMixedIngredientMetricEvidenceSentence(value: string): boolean {
  return splitPublicSentences(value).some((sentence) => {
    const text = cleanText(sentence);
    if (containsKoreanWebPageMixedIngredientMetricEvidenceSentence(text)) {
      return true;
    }
    if (!hasIngredientTechnologyEvidence(text) || !/%/.test(text)) {
      return false;
    }
    return /(?:key\s+)?(?:basis|evidence|reason|grounds?)\s+(?:for|of)\s+(?:selection|choice|decision)|(?:ingredients?|technolog(?:y|ies)|formula|metrics?|figures?|results?)[^.!?]{0,160}(?:provide|provides|serve\s+as|serves\s+as|act\s+as|acts\s+as)[^.!?]{0,80}(?:basis|evidence|reason|grounds?)/i.test(text)
      || /(?:選択|判断)[^。！？]{0,40}(?:根拠|理由)/.test(text);
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

function containsWebPageIngredientTechnologyAnalysisLabelSentence(value: string): boolean {
  return splitPublicSentences(value).some((sentence) => {
    const text = cleanText(sentence);
    if (containsKoreanWebPageIngredientTechnologyAnalysisLabelSentence(text)) {
      return true;
    }
    if (/[A-Za-z]/.test(text)) {
      return /(?:key|core|main|primary)\s+(?:ingredients?\s*(?:and|\/)\s*technolog(?:y|ies)|ingredient\/technology|formula(?:\s+technology)?)[^.!?]{0,100}(?:explained|described|introduced|presented|covered|highlighted|used\s+to\s+introduce)/i.test(text)
        || /(?:ingredients?|technolog(?:y|ies)|formula|capsules?|water)[^.!?]{0,140}(?:as|as\s+the)?[^.!?]{0,50}(?:key|core|main|primary)\s+(?:ingredients?|technolog(?:y|ies)|formula|product\s+facts?)/i.test(text)
        || /(?:patent[-\s]?(?:pending|application)|patent\s+application)[^.!?]{0,80}(?:formula|technology|process)(?:'s|\s+of)\s/i.test(text);
    }
    if (/[ぁ-んァ-ン一-龯]/.test(text)) {
      return /(?:主な|主要な|核心)?(?:成分|技術|処方|フォーミュラ)(?:\/|・|と)?(?:成分|技術)?[^。！？]{0,80}(?:中心|説明|紹介|提示|扱います)/.test(text)
        || /(?:成分|技術|処方|フォーミュラ|カプセル|水)[^。！？]{0,140}を中心に(?:商品|製品)を?(?:紹介|説明|提示)/.test(text)
        || /特許\s*出願[^。！？]{0,80}(?:処方|フォーミュラ|技術)の\s/.test(text);
    }
    return false;
  });
}

function containsKoreanWebPageIngredientTechnologyAnalysisLabelSentence(value: string): boolean {
  return splitPublicSentences(value).some((sentence) => {
    const text = cleanText(sentence);
    if (!/[가-힣]/.test(text)) {
      return false;
    }
    if (/(?:핵심\s*)?성분\s*\/\s*(?:기술|포뮬러)(?:을|를|로|으로)?[^.!?。！？]{0,80}(?:중심|설명|소개|제시|다룹니다)/u.test(text)) {
      return true;
    }
    if (/(?:성분|기술|포뮬러|캡슐|워터)[^.!?。！？]{0,140}(?:을|를)\s*중심으로\s*(?:제품|상품)(?:을|를)?\s*(?:소개|설명|제시)/u.test(text)) {
      return true;
    }
    return /특허\s*출원[^.!?。！？]{0,80}(?:포뮬러|공법|기술)의\s/u.test(text);
  });
}

function containsWebPagePatentIdentifierCoreSentence(value: string): boolean {
  return splitPublicSentences(value).some((sentence) => {
    const text = cleanText(sentence);
    if (containsKoreanWebPagePatentNumberSentence(text)) {
      return true;
    }
    const patentIdentifier = "(?:patent(?:\\s+application)?\\s+(?:number|identifier)|patent\\s+no\\.?|KR\\d{6,}|US\\d{6,}|JP\\d{6,})";
    const coreFact = "(?:key|core|main|primary)?\\s*(?:technology|formula|ingredient|science)";
    if (/[A-Za-z]/.test(text)
      && (new RegExp(`${coreFact}[^.!?]{0,120}${patentIdentifier}`, "i").test(text)
        || new RegExp(`${patentIdentifier}[^.!?]{0,120}${coreFact}`, "i").test(text))) {
      return true;
    }
    return /(?:核心|主要)?(?:技術|処方|成分)[^。！？]{0,120}(?:特許(?:出願)?(?:番号|識別子)?|KR\d{6,}|US\d{6,}|JP\d{6,})/i.test(text)
      || /(?:特許(?:出願)?(?:番号|識別子)?|KR\d{6,}|US\d{6,}|JP\d{6,})[^。！？]{0,120}(?:核心|主要)?(?:技術|処方|成分)/i.test(text);
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

function containsWebPageQuestionNavigationSentence(value: string): boolean {
  return splitPublicSentences(value).some((sentence) => {
    const text = cleanText(sentence);
    if (containsKoreanWebPageQuestionNavigationSentence(text)) {
      return true;
    }
    if (/[A-Za-z]/.test(text)
      && /(?:questions?|FAQs?|frequently asked questions?)/i.test(text)
      && /(?:why|same|identical|difference|capsule|water|cream|variant|related|purchase|ingredient|formula|technology)/i.test(text)
      && /(?:covered|addressed|answered|included|provided|can\s+be\s+checked|can\s+be\s+found|can\s+be\s+viewed)/i.test(text)) {
      return true;
    }
    return /[ぁ-んァ-ン一-龯]/.test(text)
      && /(?:質問|FAQ|よくある質問)/.test(text)
      && /(?:理由|同じ|違い|関連|カプセル|水|クリーム|購入|成分|処方|技術)/.test(text)
      && /(?:扱います|確認できます|含まれます|提供されます|答えます)/.test(text);
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

function containsProductDescriptionDenseCepFormulaSentence(value: string): boolean {
  return splitPublicSentences(value).some((sentence, index) => {
    const text = cleanText(sentence);
    if (containsKoreanProductDescriptionDenseCepFormulaSentence(text)) {
      return true;
    }
    if (/[A-Za-z]/.test(text)) {
      if (/(?:patent[-\s]?(?:pending|application)|patent\s+application)[^.!?]{0,90}(?:formula|technology|process)(?:'s|\s+of)\s+(?:barrier|moisturizing|moisture|hydrating|hydration|soothing|sensitive|skin|capsule|toner|cream|serum|mist|lotion|product)/i.test(text)) {
        return true;
      }
      if (/(?:formula|technology|process)(?:'s|\s+of)\s+(?:barrier|moisturizing|moisture|hydrating|hydration|soothing|sensitive|skin|capsule|toner|cream|serum|mist|lotion|product)/i.test(text)
        && /\bfor\b[^.!?]{0,100}(?:customers?|skin|concerns?|dry|sensitive|barrier|hydration|moisture)/i.test(text)) {
        return true;
      }
      return index === 0
        && /\bfor\b[^.!?]{0,100}(?:customers?|skin|concerns?|dry|sensitive|barrier|hydration|moisture)/i.test(text)
        && /(?:PHA|ceramide|capsules?|water|formula|technology|process)[^.!?]{0,160}(?:'s|\s+of)?\s*(?:barrier|moisturizing|moisture|hydrating|hydration|soothing|capsule|toner|cream|serum|mist|lotion|product)/i.test(text)
        && /\bis\b/i.test(text);
    }
    if (/[ぁ-んァ-ン一-龯]/.test(text)) {
      if (/特許\s*出願[^。！？]{0,90}(?:処方|フォーミュラ|技術)の\s*(?:バリア|保湿|水分|うるおい|敏感|肌|カプセル|化粧水|トナー|クリーム|美容液|ミスト|ローション|商品|製品)/.test(text)) {
        return true;
      }
      if (/(?:処方|フォーミュラ|技術)の\s*(?:バリア|保湿|水分|うるおい|敏感|肌|カプセル|化粧水|トナー|クリーム|美容液|ミスト|ローション|商品|製品)/.test(text)
        && /(?:顧客|肌|悩み|乾燥|敏感)[^。！？]{0,80}(?:向け|ための)/.test(text)) {
        return true;
      }
      return index === 0
        && /(?:乾燥|敏感|バリア|保湿|水分|うるおい|肌)[^。！？]{0,80}(?:顧客|肌|悩み|方)[^。！？]{0,40}(?:向け|ための)/.test(text)
        && /(?:PHA|セラミド|カプセル|ウォーター|水|処方|フォーミュラ|技術)[^。！？]{0,160}の?\s*(?:バリア|保湿|水分|うるおい|敏感|肌|カプセル|化粧水|トナー|クリーム|美容液|ミスト|ローション|商品|製品)です/.test(text);
    }
    return false;
  });
}

function containsKoreanProductDescriptionDenseCepFormulaSentence(value: string): boolean {
  return splitPublicSentences(value).some((sentence, index) => {
    const text = cleanText(sentence);
    if (!/[가-힣]/.test(text)) {
      return false;
    }
    if (/특허\s*출원[^.!?。！？]{0,90}(?:포뮬러|공법|기술)의\s*(?:장벽|보습|수분|진정|피부|탄력|주름|캡슐|토너|크림|세럼|미스트|로션|제품)/u.test(text)) {
      return true;
    }
    if (/(?:포뮬러|공법|기술)의\s*(?:장벽|보습|수분|진정|피부|탄력|주름|캡슐|토너|크림|세럼|미스트|로션|제품)/u.test(text)
      && /(?:고객|피부|고민)[^.!?。！？]{0,80}(?:을|를)\s*위한/u.test(text)) {
      return true;
    }
    if (index === 0
      && /(?:건조|민감|장벽|수분|보습|피부)[^.!?。！？]{0,70}(?:고객|피부|고민)[^.!?。！？]{0,40}(?:을|를)\s*위한/u.test(text)
      && /(?:PHA|세라마이드|캡슐|워터|포뮬러|공법|기술)[^.!?。！？]{0,140}(?:의\s*)?(?:장벽|보습|수분|진정|피부|캡슐|토너|크림|세럼|미스트|제품)입니다/u.test(text)) {
      return true;
    }
    return false;
  });
}

function containsProductDescriptionPageEntityLanguage(value: string): boolean {
  return splitPublicSentences(value).some((sentence) => {
    const text = cleanText(sentence);
    if (/[가-힣]/.test(text)
      && /(?:상품\s*페이지|제품\s*페이지|상세\s*페이지|페이지(?:에서는|에는|는)?)/u.test(text)
      && /(?:상품|제품|고객|피부|성분|기술|효능|효과|사용|리뷰|FAQ|HowTo|구매|정보|다룹니다|소개|추천|안내|확인|제공)/iu.test(text)) {
      return true;
    }
    if (/[A-Za-z]/.test(text)
      && /(?:\bproduct\s+page\b|\bproduct-detail\s+page\b|\bPDP\b|\bthis\s+page\b|\bthe\s+page\b|\bpage\s+(?:covers?|introduces?|summari[sz]es?|presents?|describes?|includes?|helps?))/i.test(text)) {
      return true;
    }
    return /[ぁ-んァ-ン一-龯]/.test(text)
      && /(?:商品ページ|製品ページ|ページでは|ページは)/.test(text);
  });
}

function containsMisroutedProductDescriptionTail(value: string): boolean {
  const tail = splitPublicSentences(value).map(cleanText).filter(Boolean).at(-1) ?? "";
  if (!tail) {
    return false;
  }
  if (/(?:FAQ|HowTo|자주\s*묻는\s*질문|질문|문의|구매|가격|쿠폰|배송|장바구니|리뷰\s*작성|구입)/i.test(tail)
    && /(?:다룹니다|포함합니다|확인할\s*수\s*있습니다|안내합니다|제공합니다|살펴볼\s*수\s*있습니다|covered|included|provided|available|check|view)/i.test(tail)) {
    return true;
  }
  if (/(?:특허\s*출원\s*번호|특허\s*번호|patent\s*(?:application\s*)?(?:number|no\.?)|KR\d{6,})/i.test(tail)) {
    return true;
  }
  return /(?:사용법|FAQ|HowTo|구매\s*정보|질문)(?:도)?\s*(?:함께\s*)?(?:다룹니다|확인할\s*수\s*있습니다|안내합니다)[.!?。！？]?$/iu.test(tail);
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

function containsStandaloneKoreanComparisonBridge(value: string): boolean {
  return splitPublicSentences(value).some((sentence, index) => {
    const text = cleanText(sentence);
    if (index === 0 || !/[가-힣]/u.test(text)) {
      return false;
    }
    const hasAbstractDecisionPredicate = /(?:필요|고민|효능|효과|케어|관리|보습|진정|장벽|수분|루틴|사용\s*단계|선택\s*기준)[^.!?。！？]{0,90}(?:비교|확인|살펴|고려)할\s*수\s*있습니다/u.test(text)
      || /제품을\s*비교할\s*때[^.!?。！？]{0,70}(?:함께\s*)?고려할\s*수\s*있습니다/u.test(text);
    const statesConcreteEvidence = hasIngredientTechnologyEvidence(text)
      || /(?:고객\s*리뷰|리뷰에서는|용량|옵션|제형|임상|시험|테스트|\d+(?:\.\d+)?%)/u.test(text);
    return hasAbstractDecisionPredicate && !statesConcreteEvidence;
  });
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
  return parts.length > 0
    && parts.every((part) => isProceduralUsageInstruction(part)
      && !isIngredientTechnologyUsageLeak(part)
      && !isNonProceduralUsageCandidate(part));
}

function hasIngredientTechnologyEvidence(value: string): boolean {
  return /(?:성분|기술|포뮬러|복합체|캡슐|세라마이드|히알루론산|레티놀|나이아신아마이드|펩타이드|특허|독자|연구|formula|technology|complex|capsule|ceramide|hyaluronic|retinol|niacinamide|peptide|patent|proprietary|research|成分|技術|処方|フォーミュラ|複合体|カプセル|セラミド|ヒアルロン酸|レチノール|ナイアシンアミド|ペプチド|特許|独自|研究)/i.test(value);
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
  const hasInstructionCue = /(?:사용\s*방법|사용법|\bhow\s+to\s+use\b|\bdirections?\b|使い方|使用方法|適量|手のひら|顔全体|肌になじませ|塗布|すすぎ|マッサージ|적당량|손에|얼굴에|피부결|펴\s*바르|발라|흡수|도포|massage|apply|dispense|pat|press|spread|smooth|rinse|lather)/i.test(text);
  const hasOnlyDescriptiveUse = /(?:사용할\s*때마다|사용\s*시|when\s+used|with\s+each\s+use|使用時|使うたび)/i.test(text) && !hasInstructionCue;
  const hasTechnologyUseFrame = /(?:성분|기술|포뮬러|복합체|캡슐)[^.!?。！？]{0,60}(?:사용|적용|쓰(?:인|이는)|활용)|(?:uses?|using|applies?)[^.!?]{0,60}(?:ingredient|formula|technology|complex|capsule)|(?:成分|技術|処方|フォーミュラ|複合体|カプセル)[^.!?。！？]{0,60}(?:使用|採用|配合|活用)/i.test(text);
  const hasReportingFrame = /(?:적용|설계|제공|도출|방출|설명|특징|구성|함유|담(?:긴|은)|녹지\s*않|patent|proprietary|designed|delivers?|provides?|contains?|features?|採用|設計|提供|説明|特徴|構成|配合|含有|特許|独自)/i.test(text);
  return hasFormulaOrTechnology && (hasOnlyDescriptiveUse || hasTechnologyUseFrame || hasReportingFrame) && !hasActionableApplicationVerb(text);
}

function isProceduralUsageInstruction(value: string): boolean {
  const text = cleanText(value);
  if (!text) {
    return false;
  }
  const proceduralScore = usageProcedureSignalScore(text);
  const descriptiveScore = usageDescriptionSignalScore(text);
  if ((hasDescriptiveApplicationFrame(text) || hasSensoryEvaluationFrame(text)) && proceduralScore < 3) {
    return false;
  }
  return (hasProcedureActionCue(text) || hasRoutinePlacementCue(text))
    && proceduralScore >= 2
    && proceduralScore >= descriptiveScore;
}

function isNonProceduralUsageCandidate(value: string): boolean {
  const text = cleanText(value);
  if (!text || (!hasProcedureActionCue(text) && !hasRoutinePlacementCue(text))) {
    return false;
  }
  return !isProceduralUsageInstruction(text) && usageDescriptionSignalScore(text) > 0;
}

function usageProcedureSignalScore(value: string): number {
  const text = cleanText(value);
  return [
    /(?:적당량|소량|충분량|손바닥|손에|화장솜|얼굴|피부결|미온수|물과\s*함께|appropriate amount|small amount|palm|hands?|cotton pad|face|skin|neck|water|適量|手のひら|顔|肌|コットン)/i.test(text) ? 1 : 0,
    hasProcedureActionCue(text) ? 1 : 0,
    /(?:후|뒤|다음|먼저|마지막|단계|순서|때는|then|after|before|next|finally|step|when|後|次|最後)/i.test(text) ? 1 : 0,
    /(?:주세요|줍니다|합니다|하세요|하십시오|바릅니다|흡수시킵니다|헹굽니다|사용할\s*수\s*있|\buse\b|\bapply\b|\bdispense\b|ます|してください)/i.test(text) ? 1 : 0,
    /(?:아침|저녁|매일|데일리|morning|night|daily|twice|once|朝|夜|毎日)/i.test(text) ? 1 : 0
  ].reduce((sum, score) => sum + score, 0);
}

function usageDescriptionSignalScore(value: string): number {
  const text = cleanText(value);
  return [
    hasDescriptiveApplicationFrame(text) ? 2 : 0,
    hasSensoryEvaluationFrame(text) ? 2 : 0,
    /(?:케어|개선|도움|효과|효능|추천|위한|민감|건조|보습|수분|장벽|care|benefit|helps?|supports?|improves?|recommended|for\s+\w+|効果|ケア|改善|おすすめ|向け)/i.test(text) ? 1 : 0,
    /(?:성분|원료|캡슐|포뮬러|기술|ingredient|formula|technology|capsule|成分|処方|技術|カプセル)/i.test(text) ? 1 : 0,
    /(?:제품|상품|토너|크림|세럼|로션|클렌저|product|toner|cream|serum|lotion|cleanser|商品|製品|化粧水|クリーム|美容液)/i.test(text) ? 1 : 0
  ].reduce((sum, score) => sum + score, 0);
}

function hasDescriptiveApplicationFrame(value: string): boolean {
  return /(?:바르는\s*순간|사용(?:할\s*때마다|하는\s*순간)|도포\s*직후|on\s+application|upon\s+application|when\s+(?:used|applied)|with\s+each\s+use|塗った瞬間|使用(?:時|する瞬間)|使うたび)/i.test(value);
}

function hasSensoryEvaluationFrame(value: string): boolean {
  return /(?:테스트|시험|사용감|마무리감|수분감|보습감|흡수감|끈적임|산뜻|촉촉|느껴지는|진정되는|피부가\s*진정|부드러운|피부결이\s*부드러운|use[-\s]?feel|finish(?:es)?|non[-\s]?sticky|stickiness|fresh\s+feel|dewy|soothing|skin\s+feels?\s+smooth|tested?|sensory|使用感|仕上がり|べたつき|さっぱり|しっとり|うるおい感|なめらか|落ち着|テスト|試験|感じられる)/i.test(value);
}

function hasProcedureActionCue(value: string): boolean {
  return /(?:덜어|적셔|올려두|펴\s*바르|펴\s*발라|두드려|흡수(?!감)|마사지|문지르|헹구|헹굽|거품|도포(?!감)|마무리(?:해|하세요|합니다|하십시오)|사용(?:해|하세요|합니다|하십시오|할\s*수\s*있)|apply|dispense|spread|smooth|pat|press|absorb|massage|lather|rinse|pump|take|use\s+as|なじませ|塗布|すすぎ|マッサージ)/i.test(value);
}

function hasRoutinePlacementCue(value: string): boolean {
  return /(?:아침|저녁|매일|데일리|스킨케어|샤워\s*후|세안\s*후|마지막\s*단계|첫\s*단계|루틴|morning|night|daily|routine|after\s+(?:cleansing|shower)|last\s+step|first\s+step|朝|夜|毎日|スキンケア|洗顔後|最後のステップ)/i.test(value);
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
