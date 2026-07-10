import { z } from "zod";
import type {
  PdpGeoAtomicEvidence,
  PdpGeoContentPlan,
  PdpGeoContentPlanner,
  PdpGeoContentPlanningRequest,
  PdpGeoContentPlanningResult,
  PdpGeoEvidence,
  PdpGeoEvidenceRole,
  PdpGeoGeneratorOptions,
  PdpGeoLocale,
  PdpGeoPlannedField,
  PdpGeoPlannedHowToStep,
  PdpGeoTokenUsage,
  PdpProductSignal
} from "./types";

const PLANNING_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_EVIDENCE_ITEMS = 120;
const DEFAULT_MAX_RAG_CHUNKS = 5;

const plannedFieldSchema = z.object({
  include: z.boolean(),
  text: z.string(),
  intent: z.string(),
  evidenceIds: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  omitReason: z.string()
}).strict();

const plannedFaqSchema = z.object({
  include: z.boolean(),
  question: z.string(),
  answer: z.string(),
  intent: z.string(),
  cep: z.string(),
  evidenceIds: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  omitReason: z.string()
}).strict();

const plannedHowToStepSchema = z.object({
  position: z.number().int().positive(),
  name: z.string(),
  text: z.string(),
  evidenceIds: z.array(z.string())
}).strict();

const plannedHowToSchema = z.object({
  eligible: z.boolean(),
  ordered: z.boolean(),
  goal: z.string(),
  steps: z.array(plannedHowToStepSchema),
  evidenceIds: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  omitReason: z.string()
}).strict();

const plannedCepSchema = z.object({
  situation: z.string(),
  need: z.string(),
  constraint: z.string(),
  evidenceIds: z.array(z.string()),
  confidence: z.number().min(0).max(1)
}).strict();

const contentPlanPayloadSchema = z.object({
  locale: z.enum(["ko-KR", "ja-JP", "en-US", "en-GB"]),
  productDescription: plannedFieldSchema,
  webPageDescription: plannedFieldSchema,
  faq: z.array(plannedFaqSchema),
  howTo: plannedHowToSchema,
  cep: z.array(plannedCepSchema),
  warnings: z.array(z.string())
}).strict();

const jsonField = {
  type: "object",
  additionalProperties: false,
  properties: {
    include: { type: "boolean" },
    text: { type: "string" },
    intent: { type: "string" },
    evidenceIds: { type: "array", items: { type: "string" } },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    omitReason: { type: "string" }
  },
  required: ["include", "text", "intent", "evidenceIds", "confidence", "omitReason"]
} as const;

const jsonFaq = {
  type: "object",
  additionalProperties: false,
  properties: {
    include: { type: "boolean" },
    question: { type: "string" },
    answer: { type: "string" },
    intent: { type: "string" },
    cep: { type: "string" },
    evidenceIds: { type: "array", items: { type: "string" } },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    omitReason: { type: "string" }
  },
  required: ["include", "question", "answer", "intent", "cep", "evidenceIds", "confidence", "omitReason"]
} as const;

const jsonHowToStep = {
  type: "object",
  additionalProperties: false,
  properties: {
    position: { type: "integer", minimum: 1 },
    name: { type: "string" },
    text: { type: "string" },
    evidenceIds: { type: "array", items: { type: "string" } }
  },
  required: ["position", "name", "text", "evidenceIds"]
} as const;

/** Provider-neutral strict JSON Schema for the semantic planning call. */
export const pdpGeoContentPlanJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    locale: { type: "string", enum: ["ko-KR", "ja-JP", "en-US", "en-GB"] },
    productDescription: jsonField,
    webPageDescription: jsonField,
    faq: { type: "array", items: jsonFaq },
    howTo: {
      type: "object",
      additionalProperties: false,
      properties: {
        eligible: { type: "boolean" },
        ordered: { type: "boolean" },
        goal: { type: "string" },
        steps: { type: "array", items: jsonHowToStep },
        evidenceIds: { type: "array", items: { type: "string" } },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        omitReason: { type: "string" }
      },
      required: ["eligible", "ordered", "goal", "steps", "evidenceIds", "confidence", "omitReason"]
    },
    cep: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          situation: { type: "string" },
          need: { type: "string" },
          constraint: { type: "string" },
          evidenceIds: { type: "array", items: { type: "string" } },
          confidence: { type: "number", minimum: 0, maximum: 1 }
        },
        required: ["situation", "need", "constraint", "evidenceIds", "confidence"]
      }
    },
    warnings: { type: "array", items: { type: "string" } }
  },
  required: ["locale", "productDescription", "webPageDescription", "faq", "howTo", "cep", "warnings"]
} as const;

interface ContentPlanningApplication {
  plan: PdpGeoContentPlan;
  evidence: PdpGeoEvidence[];
  warnings: string[];
  usage?: PdpGeoTokenUsage;
  called: boolean;
  applied: boolean;
}

interface ModelPlannerConfig {
  provider: Exclude<PdpGeoGeneratorOptions["provider"], undefined>;
  apiKey?: string;
  model?: string;
  endpoint?: string;
  deployment?: string;
  apiVersion?: string;
  temperature?: number;
  maxEvidenceItems: number;
  maxRagChunks: number;
}

/** Converts the normalized product into traceable, stable atomic evidence. */
export function createPdpGeoEvidenceLedger(product: PdpProductSignal, locale: PdpGeoLocale): PdpGeoAtomicEvidence[] {
  const items: PdpGeoAtomicEvidence[] = [];
  const seen = new Set<string>();
  const add = (role: PdpGeoEvidenceRole, text: unknown, sourcePath: string, confidence: number) => {
    const value = cleanText(typeof text === "string" || typeof text === "number" ? String(text) : "");
    if (!value) return;
    const key = `${role}\u0000${value.toLocaleLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({
      id: `ev-${role}-${stableHash(`${sourcePath}\u0000${value}`)}`,
      role,
      text: value,
      sourcePath,
      locale,
      productScope: "product",
      confidence
    });
  };

  add("identity", product.name, "product.name", 1);
  add("identity", product.originalName, "product.originalName", 1);
  add("identity", product.brand, "product.brand", 1);
  add("identity", product.category, "product.category", 0.95);
  add("description", product.description, "product.description", 0.95);
  product.benefits.forEach((value, index) => add("benefit", value, `product.benefits[${index}]`, 0.95));
  product.effects.forEach((value, index) => add("effect", value, `product.effects[${index}]`, 0.95));
  product.ingredients.forEach((value, index) => add("ingredient", value, `product.ingredients[${index}]`, 0.95));
  product.semanticFacts?.skinTypes.forEach((value, index) => add("audience", value, `product.semanticFacts.skinTypes[${index}]`, 0.95));
  product.usage.forEach((value, index) => add("usage", value, `product.usage[${index}]`, 0.98));
  product.metrics.forEach((value, index) => add("metric", value, `product.metrics[${index}]`, 0.98));
  product.options.forEach((value, index) => add("commerce", value, `product.options[${index}]`, 0.9));
  if (product.price?.raw) add("commerce", product.price.raw, "product.price.raw", 1);
  product.faq.forEach((item, index) => add("faq", `${item.question}\n${item.answer}`, `product.faq[${index}]`, 1));
  product.reviews.items.forEach((item, index) => add("review", item.body, `product.reviews.items[${index}].body`, 0.85));
  product.reviews.keywords.forEach((value, index) => add("review", value, `product.reviews.keywords[${index}]`, 0.75));
  if (product.reviews.rating !== undefined || product.reviews.reviewCount !== undefined) {
    add("review", `rating=${product.reviews.rating ?? "unknown"}; reviewCount=${product.reviews.reviewCount ?? "unknown"}`, "product.reviews.summary", 1);
  }
  product.semanticFacts?.usageSteps.forEach((value, index) => add("usage", value, `product.semanticFacts.usageSteps[${index}]`, 0.95));
  product.semanticFacts?.evidenceSentences.forEach((value, index) => add("source", value, `product.semanticFacts.evidenceSentences[${index}]`, 0.9));
  product.semanticFacts?.metricClaims.forEach((claim, index) => {
    add("metric", claim.sourceText || claim.sentence || Object.values(claim).filter(Boolean).join("; "), `product.semanticFacts.metricClaims[${index}]`, 0.98);
  });
  product.semanticFacts?.ingredientBenefitLinks.forEach((link, index) => {
    add("source", link.sourceText || link.sentence || [link.ingredient, link.benefit, link.effect].filter(Boolean).join("; "), `product.semanticFacts.ingredientBenefitLinks[${index}]`, 0.92);
  });
  product.sourceTexts.forEach((value, index) => add(
    isConcreteUsageAction(value) ? "usage" : "source",
    value,
    `product.sourceTexts[${index}]`,
    isConcreteUsageAction(value) ? 0.86 : 0.72
  ));

  return items;
}

/** Runs the evidence-bound planning call, falling back to conservative schema eligibility. */
export async function planPdpGeoContent(
  request: PdpGeoContentPlanningRequest,
  options: PdpGeoGeneratorOptions
): Promise<ContentPlanningApplication> {
  const conservative = createConservativeContentPlan(request);
  const resolved = resolvePlanner(options);
  if (!resolved.planner) {
    const warnings = resolved.warning ? [resolved.warning] : [];
    return {
      plan: { ...conservative, warnings: [...conservative.warnings, ...warnings] },
      evidence: resolved.warning ? [{ field: "content.plan", source: "llm", value: `Semantic planning skipped: ${resolved.warning}` }] : [],
      warnings,
      called: false,
      applied: false
    };
  }

  try {
    const initialResult = await resolved.planner.planContent(request);
    let usage = initialResult.usage;
    let plannerWarnings = [...(initialResult.warnings ?? [])];
    const modelBackedAudit = resolved.planner instanceof ModelBackedContentPlanner;
    let sanitized = initialResult.plan ? sanitizeModelPlan(initialResult.plan, request, false) : undefined;
    const correctionReasons = sanitized?.gateWarnings.length
      ? sanitized.gateWarnings
      : initialResult.plan
        ? modelBackedAudit
          ? ["Audit every candidatePlan clause for semantic entailment, claim modality, locale, and evidence-ID relevance; return a corrected full plan."]
          : []
        : plannerWarnings.length > 0
          ? plannerWarnings
          : ["The provider returned no parseable plan matching the required JSON schema."];
    const retryWarnings: string[] = [];
    if (correctionReasons.length > 0) {
      try {
        const retryResult = await resolved.planner.planContent({
          ...request,
          candidatePlan: modelBackedAudit ? initialResult.plan : undefined,
          planningFeedback: correctionReasons.map((reason) => ({ field: planningWarningField(reason), reason }))
        });
        usage = mergeTokenUsage(usage, retryResult.usage);
        plannerWarnings = [...plannerWarnings, ...(retryResult.warnings ?? [])];
        if (retryResult.plan) {
          const auditedRetry = modelBackedAudit && Boolean(initialResult.plan);
          const retryPlan = sanitizeModelPlan(retryResult.plan, request, auditedRetry);
          if (!sanitized
            || retryPlan.gateWarnings.length < sanitized.gateWarnings.length
            || auditedRetry && retryPlan.gateWarnings.length === sanitized.gateWarnings.length) {
            sanitized = retryPlan;
          } else {
            retryWarnings.push("Corrective content-planning pass did not reduce evidence or locale gate failures; the safer first-pass plan was kept.");
          }
        } else {
          retryWarnings.push(...(retryResult.warnings ?? []), "Corrective content-planning pass returned no valid plan.");
        }
      } catch (error) {
        retryWarnings.push(`Corrective content-planning pass failed: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }
    if (!sanitized) {
      const warnings = uniqueText([
        ...plannerWarnings,
        ...retryWarnings,
        "Semantic planner returned no valid content plan after one corrective pass; conservative applicability was used."
      ]);
      return {
        plan: { ...conservative, warnings: [...conservative.warnings, ...warnings] },
        evidence: [{ field: "content.plan", source: "llm", value: warnings.join(" ") }],
        warnings,
        usage,
        called: true,
        applied: false
      };
    }
    const warnings = uniqueText([...plannerWarnings, ...sanitized.plan.warnings, ...retryWarnings]);
    return {
      plan: { ...sanitized.plan, warnings },
      evidence: [{
        field: "content.plan",
        source: "llm",
        value: `Evidence-bound content plan accepted with ${sanitized.plan.faq.length} FAQ item(s), ${sanitized.plan.howTo.eligible ? sanitized.plan.howTo.steps.length : 0} HowTo step(s), and ${sanitized.plan.cep.length} CEP candidate(s).`
      }],
      warnings,
      usage,
      called: true,
      applied: true
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Semantic content planning failed.";
    return {
      plan: { ...conservative, warnings: [...conservative.warnings, message] },
      evidence: [{ field: "content.plan", source: "llm", value: `Semantic planning failed closed: ${message}` }],
      warnings: [message],
      called: true,
      applied: false
    };
  }
}

export class ModelBackedContentPlanner implements PdpGeoContentPlanner {
  constructor(private readonly config: ModelPlannerConfig) {}

  async planContent(request: PdpGeoContentPlanningRequest): Promise<PdpGeoContentPlanningResult> {
    const prompt = createPlanningPrompt(request, this.config.maxEvidenceItems, this.config.maxRagChunks);
    switch (this.config.provider) {
      case "openai":
        return this.openAi(prompt);
      case "gemini":
        return this.gemini(prompt);
      case "azure-openai":
        return this.chatCompletions(prompt, "azure-openai");
      case "aistudio":
        return this.chatCompletions(prompt, "aistudio");
      default:
        return { warnings: [`${this.config.provider} content planning requires a customContentPlanner.`] };
    }
  }

  private async openAi(prompt: { system: string; user: string }): Promise<PdpGeoContentPlanningResult> {
    if (!this.config.apiKey || !this.config.model) throw new Error("OpenAI API key and model are required for content planning.");
    const payload = await requestJsonWithTemperatureFallback(
      "https://api.openai.com/v1/responses",
      { Authorization: `Bearer ${this.config.apiKey}` },
      {
        model: this.config.model,
        instructions: prompt.system,
        input: prompt.user,
        ...temperatureBody(this.config.temperature),
        text: { format: { type: "json_schema", name: "pdp_geo_content_plan", strict: true, schema: pdpGeoContentPlanJsonSchema } }
      },
      "OpenAI content planning"
    );
    return { ...parsePlanningPayload(providerText(payload)), usage: tokenUsageFromOpenAi(payload.usage) };
  }

  private async gemini(prompt: { system: string; user: string }): Promise<PdpGeoContentPlanningResult> {
    if (!this.config.apiKey || !this.config.model) throw new Error("Gemini API key and model are required for content planning.");
    const response = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${this.config.model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": this.config.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: prompt.system }] },
        contents: [{ role: "user", parts: [{ text: prompt.user }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: toGeminiSchema(pdpGeoContentPlanJsonSchema),
          ...temperatureBody(this.config.temperature)
        }
      })
    }, "Gemini content planning");
    if (!response.ok) throw new Error(`Gemini content planning failed: ${response.status}${await errorSuffix(response)}`);
    const payload = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; usageMetadata?: unknown };
    const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("\n") ?? "";
    return { ...parsePlanningPayload(text), usage: tokenUsageFromGemini(payload.usageMetadata) };
  }

  private async chatCompletions(prompt: { system: string; user: string }, provider: "azure-openai" | "aistudio"): Promise<PdpGeoContentPlanningResult> {
    if (!this.config.apiKey || !this.config.endpoint || !this.config.deployment) {
      throw new Error(`${provider} API key, endpoint, and reasoning deployment are required for content planning.`);
    }
    const endpoint = this.config.endpoint.replace(/\/$/, "");
    const apiVersion = this.config.apiVersion ?? (provider === "azure-openai" ? "2025-04-01-preview" : undefined);
    const query = apiVersion ? `?api-version=${encodeURIComponent(apiVersion)}` : "";
    const url = `${endpoint}/openai/deployments/${encodeURIComponent(this.config.deployment)}/chat/completions${query}`;
    const payload = await requestJsonWithTemperatureFallback(
      url,
      provider === "azure-openai" ? { "api-key": this.config.apiKey } : { Authorization: `Bearer ${this.config.apiKey}` },
      {
        messages: [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }],
        response_format: {
          type: "json_schema",
          json_schema: { name: "pdp_geo_content_plan", strict: true, schema: pdpGeoContentPlanJsonSchema }
        },
        ...temperatureBody(this.config.temperature)
      },
      `${provider} content planning`
    ) as { choices?: Array<{ message?: { content?: string } }>; usage?: unknown };
    return {
      ...parsePlanningPayload(payload.choices?.[0]?.message?.content ?? ""),
      usage: tokenUsageFromChatCompletions(payload.usage)
    };
  }
}

function createConservativeContentPlan(request: PdpGeoContentPlanningRequest): PdpGeoContentPlan {
  const usageEvidence = request.evidenceLedger.filter((item) => item.role === "usage");
  const semanticUsageSteps = uniqueText(request.product.semanticFacts?.usageSteps ?? []).filter(isConcreteUsageAction);
  const semanticUsageSequence = hasOrderedUsageEvidence(semanticUsageSteps)
    ? semanticUsageSteps
    : selectProceduralUsageSequence(semanticUsageSteps);
  const semanticOrderProvenance = semanticUsageSequence.length >= 2;
  const sourceUsageSteps = request.product.sourceTexts.flatMap(extractOrderedUsageSegments);
  const directUsageSteps = uniqueText(request.product.usage).filter(isConcreteUsageAction);
  const usageCandidates = semanticOrderProvenance
    ? semanticUsageSequence
    : directUsageSteps.length >= 2
      ? directUsageSteps
      : sourceUsageSteps;
  const usageSteps = (semanticOrderProvenance ? usageCandidates : selectProceduralUsageSequence(usageCandidates)).slice(0, 6);
  const explicitlyOrdered = semanticOrderProvenance
    || hasOrderedUsageEvidence(usageSteps)
    || hasProceduralActionProgression(usageSteps);
  const steps = explicitlyOrdered
    ? usageSteps.map((text, index): PdpGeoPlannedHowToStep => ({
        position: index + 1,
        name: truncate(text, 80),
        text,
        evidenceIds: matchingEvidenceIds(text, usageEvidence)
      })).filter((step) => step.evidenceIds.length > 0)
    : [];
  const eligible = explicitlyOrdered && steps.length >= 2;
  const emptyField = (intent: string): PdpGeoPlannedField => ({
    include: false,
    text: "",
    intent,
    evidenceIds: [],
    confidence: 0,
    omitReason: "No model-backed field plan was available; the source-backed renderer fallback is used."
  });

  return {
    mode: "conservative",
    locale: request.locale,
    productDescription: emptyField("product-entity-summary"),
    webPageDescription: emptyField("page-coverage-summary"),
    faq: [],
    howTo: {
      eligible,
      ordered: explicitlyOrdered,
      goal: eligible ? request.product.name : "",
      steps: eligible ? steps : [],
      evidenceIds: eligible ? uniqueText(steps.flatMap((step) => step.evidenceIds)) : [],
      confidence: eligible ? 0.75 : 0.85,
      omitReason: eligible ? "" : "The source does not contain a supported ordered multi-step procedure."
    },
    cep: [],
    warnings: []
  };
}

interface SanitizedContentPlan {
  plan: PdpGeoContentPlan;
  gateWarnings: string[];
}

function sanitizeModelPlan(
  raw: Omit<PdpGeoContentPlan, "mode">,
  request: PdpGeoContentPlanningRequest,
  semanticAuditPassed: boolean
): SanitizedContentPlan {
  const evidenceById = new Map(request.evidenceLedger.map((item) => [item.id, item]));
  const gateWarnings: string[] = [];
  const sanitizeIds = (ids: string[]) => uniqueText(ids).filter((id) => evidenceById.has(id));
  const sanitizeField = (field: PdpGeoPlannedField, name: string): PdpGeoPlannedField => {
    const evidenceIds = sanitizeIds(field.evidenceIds);
    const text = cleanText(field.text);
    const supported = text.length > 0
      && evidenceIds.length > 0
      && numbersAreSupported(text, evidenceIds, evidenceById)
      && isTargetLocaleCopy(text, request.locale)
      && isCoherentPublicCopy(text, "statement")
      && evidenceSemanticallySupportsText(text, evidenceIds, evidenceById, request.product, semanticAuditPassed);
    if (field.include && !supported) gateWarnings.push(`${name} was omitted because its text, locale, or cited evidence did not pass the evidence gate.`);
    return {
      ...field,
      include: field.include && supported,
      text: field.include && supported ? text : "",
      evidenceIds,
      omitReason: field.include && supported ? "" : cleanText(field.omitReason) || "Evidence or locale validation failed."
    };
  };

  const faq = raw.faq
    .map((item) => {
      const evidenceIds = sanitizeIds(item.evidenceIds);
      const question = cleanText(item.question);
      const answer = cleanText(item.answer);
      const include = item.include
        && question.length >= 6
        && answer.length >= 12
        && evidenceIds.length > 0
        && numbersAreSupported(`${question} ${answer}`, evidenceIds, evidenceById)
        && isTargetLocaleCopy(question, request.locale)
        && isTargetLocaleCopy(answer, request.locale)
        && isCoherentPublicCopy(question, "question")
        && isCoherentPublicCopy(answer, "statement")
        && faqQuestionIsSupported(question, evidenceIds, evidenceById, request.product, semanticAuditPassed)
        && evidenceSemanticallySupportsText(answer, evidenceIds, evidenceById, request.product, semanticAuditPassed);
      if (item.include && !include) gateWarnings.push(`FAQ intent "${item.intent || "unknown"}" was omitted by the evidence/locale gate.`);
      return { ...item, include, question, answer, evidenceIds };
    })
    .filter((item) => item.include)
    .filter((item, index, items) => items.findIndex((candidate) => faqEquivalent(candidate, item)) === index)
    .slice(0, 8);

  const usageEvidenceIds = new Set(request.evidenceLedger.filter((item) => item.role === "usage").map((item) => item.id));
  const steps = raw.howTo.steps
    .map((step) => {
      const candidate = {
      ...step,
      name: cleanText(step.name),
      text: cleanText(step.text),
      evidenceIds: sanitizeIds(step.evidenceIds).filter((id) => usageEvidenceIds.has(id))
      };
      const supported = candidate.text.length >= 4
        && candidate.evidenceIds.length > 0
        && isConcreteUsageAction(candidate.text)
        && isTargetLocaleCopy(`${candidate.name} ${candidate.text}`, request.locale)
        && isCoherentPublicCopy(candidate.text, "action")
        && numbersAreSupported(candidate.text, candidate.evidenceIds, evidenceById)
        && evidenceSemanticallySupportsText(candidate.text, candidate.evidenceIds, evidenceById, request.product, semanticAuditPassed);
      if (raw.howTo.eligible && !supported) {
        gateWarnings.push(`HowTo step ${step.position} was omitted because it was not an actionable, locale-compatible usage step supported by its cited evidence.`);
      }
      return { ...candidate, supported };
    })
    .filter((step) => step.supported)
    .map((step, index) => ({ ...step, position: index + 1, name: step.name || truncate(step.text, 80) }))
    .filter((step, index, items) => items.findIndex((candidate) => normalizeForMatch(candidate.text) === normalizeForMatch(step.text)) === index)
    .map(({ supported: _supported, ...step }) => step)
    .slice(0, 8);
  const howToEligible = raw.howTo.eligible
    && raw.howTo.ordered
    && steps.length >= 2
    && hasSourceOrderProvenance(steps, evidenceById);
  if (raw.howTo.eligible && !howToEligible) gateWarnings.push("HowTo was omitted because it was not an ordered, evidence-backed multi-step procedure.");

  const cep = raw.cep
    .flatMap((item) => {
      const candidate = {
        ...item,
        situation: cleanText(item.situation),
        need: cleanText(item.need),
        constraint: cleanText(item.constraint),
        evidenceIds: sanitizeIds(item.evidenceIds)
      };
      const text = [candidate.situation, candidate.need, candidate.constraint].filter(Boolean).join(" ");
      const supported = candidate.evidenceIds.length > 0
        && text.length > 0
        && isTargetLocaleCopy(text, request.locale)
        && numbersAreSupported(text, candidate.evidenceIds, evidenceById)
        && evidenceSemanticallySupportsText(text, candidate.evidenceIds, evidenceById, request.product, semanticAuditPassed);
      if (!supported) {
        gateWarnings.push("A CEP candidate was omitted because its situation, need, constraint, locale, or cited evidence was not supported.");
        return [];
      }
      return [candidate];
    })
    .slice(0, 6);

  const productDescription = sanitizeField(raw.productDescription, "Product.description");
  let webPageDescription = sanitizeField(raw.webPageDescription, "WebPage.description");
  if (productDescription.include && webPageDescription.include && textsAreTooSimilar(productDescription.text, webPageDescription.text)) {
    gateWarnings.push("WebPage.description was omitted because it duplicated Product.description instead of describing page coverage.");
    webPageDescription = {
      ...webPageDescription,
      include: false,
      text: "",
      omitReason: "The page description was not distinct from the product entity description."
    };
  }

  const plan: PdpGeoContentPlan = {
    mode: "model",
    locale: request.locale,
    productDescription,
    webPageDescription,
    faq,
    howTo: {
      ...raw.howTo,
      eligible: howToEligible,
      ordered: howToEligible,
      // The public title is derived by the renderer from product identity and
      // locale. Model-written titles are not needed for applicability and can
      // otherwise introduce an unsupported claim outside step-level evidence.
      goal: "",
      steps: howToEligible ? steps : [],
      evidenceIds: howToEligible ? sanitizeIds([...raw.howTo.evidenceIds, ...steps.flatMap((step) => step.evidenceIds)]) : [],
      omitReason: howToEligible ? "" : cleanText(raw.howTo.omitReason) || "No evidence-backed ordered multi-step procedure was found."
    },
    cep,
    warnings: [...raw.warnings.map(cleanText).filter(Boolean), ...gateWarnings]
  };
  return { plan, gateWarnings };
}

function resolvePlanner(options: PdpGeoGeneratorOptions): { planner?: PdpGeoContentPlanner; warning?: string } {
  if (options.contentPlanning?.enabled === false) return {};
  if (options.customContentPlanner) return { planner: options.customContentPlanner };
  const settings = options.contentPlanning;
  const provider = settings?.provider ?? options.provider ?? "mock";
  const enabled = settings?.enabled ?? (provider !== "mock" && provider !== "custom" && Boolean(settings?.apiKey ?? options.apiKey));
  if (!enabled) return {};
  if (provider === "mock" || provider === "custom") return { warning: `${provider} content planning requires customContentPlanner.` };
  return {
    planner: new ModelBackedContentPlanner({
      provider,
      apiKey: settings?.apiKey ?? options.apiKey,
      model: settings?.model ?? options.model,
      endpoint: settings?.endpoint ?? options.endpoint,
      deployment: settings?.deployment ?? options.deployments?.reasoning ?? options.deployment,
      apiVersion: settings?.apiVersion ?? options.apiVersion,
      temperature: options.temperature,
      maxEvidenceItems: settings?.maxEvidenceItems ?? DEFAULT_MAX_EVIDENCE_ITEMS,
      maxRagChunks: settings?.maxRagChunks ?? DEFAULT_MAX_RAG_CHUNKS
    })
  };
}

function createPlanningPrompt(request: PdpGeoContentPlanningRequest, maxEvidenceItems: number, maxRagChunks: number): { system: string; user: string } {
  return {
    system: [
      "You are an evidence-bound PDP content and schema applicability planner.",
      "Return only the requested strict JSON object in the target locale.",
      "Every factual public-copy clause must cite one or more valid evidenceIds. Never invent a product fact, audience, ingredient-benefit causal link, metric, certification, comparison, or buying situation.",
      "Product.description describes the product entity. WebPage.description describes what this page lets a reader verify; do not make them paraphrases of each other.",
      "FAQ has no minimum count. Include only distinct questions that a buyer could ask and the supplied evidence can answer directly and self-containedly. Empty FAQ is valid.",
      "A CEP is a source-backed buying/use situation, need, or constraint—not a keyword slogan. Omit unsupported CEPs.",
      "HowTo is eligible only when source usage evidence gives an ordered sequence for achieving a concrete result. A single application note, warning, dosage, frequency, or unordered usage list is not HowTo. Eligible HowTo requires at least two distinct evidence-backed steps.",
      "Preserve product names, ingredient names, numbers, units, populations, time frames, and caveats exactly. Use complete, natural sentences; do not mix language frames.",
      "When support is insufficient set include/eligible=false, return empty text/steps, and explain omitReason. Confidence is evidence confidence, not stylistic confidence.",
      "RAG guidance is policy context only and can never be cited as product evidence.",
      "When candidatePlan is present, act as an evidence-entailment auditor: check every factual clause against only its cited evidence IDs, preserve claim modality and caveats, remove any added benefit/ingredient/audience/metric/CEP, and return the corrected full plan. Translation is allowed only when the cited fact has the same meaning."
    ].join("\n"),
    user: JSON.stringify({
      targetLocale: request.locale,
      market: request.market,
      productName: request.product.name,
      requestedSchemaTargets: request.hints?.schemaTargets ?? [],
      correctiveFeedback: request.planningFeedback ?? [],
      candidatePlan: request.candidatePlan,
      evidenceLedger: selectPlanningEvidence(request.evidenceLedger, Math.max(1, maxEvidenceItems)).map((item) => ({
        id: item.id,
        role: item.role,
        text: truncate(item.text, 900),
        sourcePath: item.sourcePath,
        confidence: item.confidence
      })),
      taskGuidance: request.ragChunks.slice(0, Math.max(0, maxRagChunks)).map((chunk) => ({
        source: chunk.source,
        title: chunk.title,
        kind: chunk.kind,
        intents: chunk.intents,
        fieldTargets: chunk.fieldTargets,
        text: truncate(chunk.text, 650)
      })),
      policyConstraints: selectPlanningPolicyRules(request.policyRules ?? []).map((rule) =>
        `${rule.severity === "critical" ? "C" : "G"}:${truncate(rule.text, 110)}`
      )
    })
  };
}

function selectPlanningPolicyRules(rules: NonNullable<PdpGeoContentPlanningRequest["policyRules"]>) {
  return rules
    .slice()
    .sort((left, right) =>
      Number(right.severity === "critical") - Number(left.severity === "critical")
      || right.priority - left.priority
    );
}

function selectPlanningEvidence(evidence: PdpGeoAtomicEvidence[], limit: number): PdpGeoAtomicEvidence[] {
  const rolePriority: Record<PdpGeoEvidenceRole, number> = {
    identity: 100,
    description: 98,
    metric: 96,
    benefit: 94,
    effect: 94,
    ingredient: 93,
    audience: 92,
    usage: 92,
    faq: 90,
    source: 88,
    commerce: 72,
    review: 68
  };
  return evidence
    .map((item, index) => ({ item, index }))
    .sort((left, right) =>
      rolePriority[right.item.role] - rolePriority[left.item.role]
      || right.item.confidence - left.item.confidence
      || left.index - right.index
    )
    .slice(0, limit)
    .map(({ item }) => item);
}

function parsePlanningPayload(rawText: string): PdpGeoContentPlanningResult {
  const json = extractJsonObject(rawText);
  if (!json) return { warnings: ["No parseable semantic content plan JSON was returned."], rawText };
  try {
    const parsed = contentPlanPayloadSchema.safeParse(JSON.parse(json));
    if (!parsed.success) {
      return { warnings: [`Semantic content plan failed schema validation: ${parsed.error.issues.slice(0, 4).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`], rawText };
    }
    return { plan: parsed.data, rawText };
  } catch (error) {
    return { warnings: [`Semantic content plan JSON parse failed: ${error instanceof Error ? error.message : "unknown error"}`], rawText };
  }
}

function hasOrderedUsageEvidence(steps: string[]): boolean {
  if (steps.length < 2) return false;
  const combined = steps.join(" ");
  const concreteSteps = steps.filter(isConcreteUsageAction);
  if (concreteSteps.length < 2) return false;
  return hasCoherentSequenceMarkers(combined);
}

function hasSourceOrderProvenance(
  steps: PdpGeoPlannedHowToStep[],
  evidenceById: Map<string, PdpGeoAtomicEvidence>
): boolean {
  const cited = uniqueText(steps.flatMap((step) => step.evidenceIds))
    .map((id) => evidenceById.get(id))
    .filter((item): item is PdpGeoAtomicEvidence => Boolean(item));
  const combined = cited.map((item) => item.text).join(" ");
  const hasExplicitMarkers = hasCoherentSequenceMarkers(combined);
  const semanticIndexes = steps.map((step) => uniqueText(step.evidenceIds.flatMap((id) => {
    const match = evidenceById.get(id)?.sourcePath.match(/^product\.semanticFacts\.usageSteps\[(\d+)]$/);
    return match?.[1] ? [match[1]] : [];
  })).map(Number));
  if (semanticIndexes.every((indexes) => indexes.length === 1)) {
    const ordered = semanticIndexes.map((indexes) => indexes[0]!);
    return ordered.every((value, index) => index === 0 || value > ordered[index - 1]!)
      && (hasExplicitMarkers || hasProceduralActionProgression(steps.map((step) => step.text)));
  }
  const usageIndexes = steps.map((step) => uniqueText(step.evidenceIds.flatMap((id) => {
    const match = evidenceById.get(id)?.sourcePath.match(/^product\.usage\[(\d+)]$/);
    return match?.[1] ? [match[1]] : [];
  })).map(Number));
  if (usageIndexes.every((indexes) => indexes.length === 1)) {
    const ordered = usageIndexes.map((indexes) => indexes[0]!);
    if (ordered.every((value, index) => index === 0 || value > ordered[index - 1]!)
      && hasProceduralActionProgression(steps.map((step) => step.text))) {
      return true;
    }
  }
  if (!hasExplicitMarkers) return false;
  if (cited.length === 1) return true;

  const markerRanks = steps.map((step) => {
    const text = step.evidenceIds.map((id) => evidenceById.get(id)?.text ?? "").join(" ");
    const numeric = text.match(/(?:^|\s)(?:step\s*)?(\d+)\s*(?:단계|段階)?[.)、:]?/iu)?.[1];
    if (numeric) return Number(numeric);
    if (/\bfirst\b|(?:먼저)|(?:まず)/iu.test(text)) return 1;
    if (/\bthen\b|\bnext\b|(?:그\s*다음|다음으로)|(?:次に|その後)/iu.test(text)) return 2;
    if (/\bfinally\b|(?:마지막으로)|(?:最後に)/iu.test(text)) return 99;
    return undefined;
  });
  return markerRanks.every((rank): rank is number => rank !== undefined)
    && markerRanks.every((rank, index) => index === 0 || rank > markerRanks[index - 1]!);
}

function hasProceduralActionProgression(steps: string[]): boolean {
  const stages = steps.map(primaryUsageActionStage).filter((stage): stage is number => stage !== undefined);
  if (stages.length < 2 || new Set(stages).size < 2) return false;
  const monotonic = stages.every((stage, index) => index === 0 || stage > stages[index - 1]!);
  return monotonic && (stages[0] === 1 || stages.at(-1) === 4);
}

function extractOrderedUsageSegments(value: string): string[] {
  const matches = Array.from(value.matchAll(/(?:^|\s)(?:step\s*)?(\d+)\s*(?:단계|段階)?[.):、]?\s+([\s\S]*?)(?=\s+(?:step\s*)?\d+\s*(?:단계|段階)?[.):、]?\s+|$)/giu));
  if (matches.length >= 2) {
    return matches.map((match) => cleanText(match[2] ?? "")).filter(isConcreteUsageAction);
  }
  return isConcreteUsageAction(value) ? [value] : [];
}

function selectProceduralUsageSequence(values: string[]): string[] {
  const selected: string[] = [];
  let lastStage = 0;
  for (const value of uniqueText(values).filter(isConcreteUsageAction)) {
    const stage = primaryUsageActionStage(value);
    if (stage === undefined || stage <= lastStage) continue;
    selected.push(value);
    lastStage = stage;
  }
  return hasProceduralActionProgression(selected) ? selected : [];
}

function primaryUsageActionStage(value: string): number | undefined {
  const text = cleanText(value);
  if (/\b(?:dispense|pump|take|wet|mix|lather)\b|(?:덜어|펌핑|취해|적셔|섞|거품)|(?:取って|出し|濡ら|混ぜ|泡立)/iu.test(text)) return 1;
  if (/(?:after\s+(?:cleansing|shower|toner)[^.!?]{0,50}\buse|(?:샤워|세안|토너)\s*후[^.!?。！？]{0,50}사용|(?:洗顔|シャワー|化粧水)後[^.!?。！？]{0,50}使用)/iu.test(text)) return 1;
  if (/\b(?:apply|spread|smooth|place)\b|(?:바르|도포|펴\s*바르)|(?:塗|広げ|のばし)/iu.test(text)) return 2;
  if (/\b(?:massage|rub|press|pat)\b|(?:마사지|문지르|누르|두드)|(?:マッサージ|こす|押さえ|パッティング)/iu.test(text)) return 3;
  if (/\b(?:rinse|wash\s+off|remove|absorb)\b|(?:헹구|씻어|닦아?내|흡수)|(?:すす|洗い流|拭き取|なじませ)/iu.test(text)) return 4;
  return undefined;
}

function hasCoherentSequenceMarkers(value: string): boolean {
  const numericMarkers = new Set(Array.from(value.matchAll(/(?:^|\s)(?:step\s*)?(\d+)\s*(?:단계|段階)?[.)、:]/giu))
    .map((match) => Number(match[1])));
  if (numericMarkers.has(1) && numericMarkers.has(2)) return true;
  return /\bfirst\b/iu.test(value) && /\b(?:then|next|finally)\b/iu.test(value)
    || /먼저/iu.test(value) && /(?:그\s*다음|다음으로|마지막으로)/iu.test(value)
    || /まず/iu.test(value) && /(?:次に|その後|最後に)/iu.test(value);
}

function isConcreteUsageAction(value: string): boolean {
  const text = cleanText(value);
  if (!text || /(?:suitable\s+for|for\s+external\s+use|can\s+be\s+used|daily\s+use|사용할\s*수|사용\s*가능|외용|적합|おすすめ|使用できます)/iu.test(text)) {
    return false;
  }
  return /\b(?:apply|spread|massage|rinse|wash|press|pat|dispense|mix|remove|leave)\b|(?:바르|도포|펴\s*바르|마사지|헹구|씻|세안|닦|두드|흡수|덜어|섞|제거)|(?:塗|なじませ|洗|すす|押さえ|取って|混ぜ|落と)/iu.test(text)
    || /(?:after\s+(?:cleansing|shower|toner)[^.!?]{0,50}\buse|(?:샤워|세안|토너)\s*후[^.!?。！？]{0,50}사용|(?:洗顔|シャワー|化粧水)後[^.!?。！？]{0,50}使用)/iu.test(text);
}

function matchingEvidenceIds(text: string, evidence: PdpGeoAtomicEvidence[]): string[] {
  const key = normalizeForMatch(text);
  const exact = evidence.filter((item) => {
    const candidate = normalizeForMatch(item.text);
    return candidate === key || candidate.includes(key) || key.includes(candidate);
  }).map((item) => item.id);
  return exact.length > 0 ? exact : [];
}

function numbersAreSupported(text: string, evidenceIds: string[], evidenceById: Map<string, PdpGeoAtomicEvidence>): boolean {
  const tokens = numericClaimTokens(text);
  if (tokens.length === 0) return true;
  const evidenceText = evidenceIds.map((id) => evidenceById.get(id)?.text ?? "").join(" ");
  const evidenceTokens = new Set(numericClaimTokens(evidenceText));
  if (!tokens.every((token) => evidenceTokens.has(token))) return false;
  if (!numericRelationshipsAreSupported(text, evidenceText)) return false;

  const lowerText = text.toLocaleLowerCase();
  const lowerEvidence = evidenceText.toLocaleLowerCase();
  const scopedContexts = [
    /(?:self[-\s]?assessment|consumer\s+(?:survey|test)|survey|자가\s*평가|소비자\s*(?:설문|평가)|アンケート|自己評価)/i,
    /(?:clinical|instrumental|in[-\s]?vivo|임상|기기\s*(?:평가|측정)|臨床|機器測定)/i,
    /(?:results?\s+(?:may\s+)?vary|individual\s+results|개인차|결과는\s*다를|個人差|結果には差)/i
  ];
  return scopedContexts.every((pattern) => !pattern.test(lowerEvidence) || pattern.test(lowerText));
}

function numericRelationshipsAreSupported(text: string, evidenceText: string): boolean {
  const outputGroups = numericClaimGroups(text).filter((group) => group.length >= 2);
  if (outputGroups.length === 0) return true;
  const evidenceGroups = numericClaimGroups(evidenceText);
  return outputGroups.every((group) => evidenceGroups.some((candidate) =>
    group.length === candidate.length && group.every((token) => candidate.includes(token))
  ));
}

function numericClaimGroups(value: string): string[][] {
  return value
    .split(/(?:[.;。！？!?]|\b(?:and|while|whereas)\b|(?:그리고|반면|이며)|(?:および|一方))/giu)
    .map((clause) => numericClaimTokens(clause))
    .filter((tokens) => tokens.length > 0);
}

function numericClaimTokens(text: string): string[] {
  return Array.from(text.matchAll(/\d+(?:[.,]\d+)?\s*(?:%|％|ppm|ml|mg|kg|g|oz|hours?|hrs?|days?|weeks?|months?|minutes?|seconds?|participants?|subjects?|users?|people|times?|시간|일|주|개월|분|초|명|회|배|개|人|時間|日|週間|か月|分|秒)?/giu))
    .map((match) => match[0]
      .replace(/,/g, "")
      .replace(/\s+/g, "")
      .toLocaleLowerCase()
      .replace(/hrs?$/, "hour")
      .replace(/hours$/, "hour")
      .replace(/days$/, "day")
      .replace(/weeks$/, "week")
      .replace(/months$/, "month")
      .replace(/minutes$/, "minute")
      .replace(/seconds$/, "second")
      .replace(/participants$/, "participant")
      .replace(/subjects$/, "subject")
      .replace(/users$/, "user")
      .replace(/times$/, "time"));
}

function isTargetLocaleCopy(text: string, locale: PdpGeoLocale): boolean {
  const compact = text.replace(/\s+/g, "");
  const hangul = (compact.match(/[\uac00-\ud7a3]/g) ?? []).length;
  const kana = (compact.match(/[\u3040-\u30ff]/g) ?? []).length;
  const han = (compact.match(/[\u3400-\u9fff]/g) ?? []).length;
  const japanese = kana + han;
  const latin = (compact.match(/[A-Za-z]/g) ?? []).length;
  if (locale === "ko-KR") {
    return hangul > 0
      && japanese < Math.max(3, hangul * 0.2)
      && latin <= Math.max(16, hangul * 1.5);
  }
  if (locale === "ja-JP") {
    // Han characters alone are also valid Chinese; require Japanese kana so a
    // Chinese sentence cannot be mislabeled as ja-JP.
    return kana > 0
      && hangul === 0
      && latin <= Math.max(14, japanese * 1.5);
  }
  return latin > 0 && (hangul + japanese) <= Math.max(2, Math.floor(latin * 0.08));
}

type PublicCopyKind = "statement" | "question" | "action";

function isCoherentPublicCopy(value: string, kind: PublicCopyKind): boolean {
  const text = cleanText(value);
  if (!text) return false;
  const hangul = (text.match(/[\uac00-\ud7a3]/g) ?? []).length;
  const kana = (text.match(/[\u3040-\u30ff]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;

  if (hangul >= Math.max(2, kana, latin * 0.2)) {
    if (kind === "question") return /(?:인가요|한가요|일까요|나요|까요|습니까|무엇인가요|어떤가요)[?？]?$/u.test(text);
    if (kind === "action") return isConcreteUsageAction(text) && /(?:다|요|니다|습니다)[.!?。！？]?$/u.test(text);
    return /(?:다|요|니다|습니다|입니다|합니다|됩니다|있습니다|없습니다)[.!?。！？]?$/u.test(text);
  }
  if (kana >= 1) {
    if (kind === "question") return /(?:ですか|ますか|でしょうか|ますでしょうか|か)[?？。]?$/u.test(text);
    if (kind === "action") {
      return isConcreteUsageAction(text)
        && /(?:ます|ください|する|します|なじませる|塗る|洗う|流す)[.!?。！？]?$/u.test(text);
    }
    return /(?:です|ます|ません|でした|でしょう|あります|います|できます|します|なります)[.!?。！？]?$/u.test(text);
  }
  if (latin >= 3) {
    if (kind === "question") {
      return /^(?:what|which|who|when|where|why|how|is|are|was|were|do|does|did|can|could|should|will|would|has|have)\b[^?]*\?$/iu.test(text);
    }
    if (kind === "action") return isConcreteUsageAction(text) && /[.!?]?$/u.test(text);
    return /\b(?:is|are|was|were|has|have|contains?|includes?|provides?|supports?|helps?|improves?|offers?|features?|describes?|shows?|allows?|lets?|can|could|may|might|will)\b/iu.test(text);
  }
  return false;
}

const semanticConceptPatterns: ReadonlyArray<readonly [string, RegExp]> = [
  ["dry", /\b(?:dry|dryness|dehydrated)\b|(?:건조|메마른)|(?:乾燥|かさつ)/iu],
  ["oily", /\b(?:oily|oiliness|sebum)\b|(?:지성|유분|피지)|(?:脂性|皮脂|べたつ)/iu],
  ["sensitive", /\b(?:sensitive|sensitivity)\b|(?:민감|예민)|(?:敏感|デリケート)/iu],
  ["hydration", /\b(?:hydrate|hydrates|hydrating|hydration|moisture|moisturize|moisturizing)\b|(?:수분|보습)|(?:保湿|うるおい|潤い)/iu],
  ["barrier", /\b(?:skin\s+)?barrier\b|(?:피부\s*)?장벽|(?:肌の)?バリア/iu],
  ["brightening", /\b(?:brighten|brightening|dullness|radiance)\b|(?:브라이트닝|미백|칙칙|광채)|(?:明る|くすみ|透明感)/iu],
  ["firmness", /\b(?:firmness|firming|elasticity)\b|(?:탄력|리프팅)|(?:ハリ|弾力)/iu],
  ["wrinkle", /\b(?:wrinkles?|fine\s+lines?)\b|(?:주름|잔주름)|(?:しわ|シワ)/iu],
  ["soothing", /\b(?:soothe|soothing|calm|calming|redness)\b|(?:진정|붉은기)|(?:鎮静|赤み)/iu],
  ["acne", /\b(?:acne|blemishes?|breakouts?)\b|(?:여드름|트러블)|(?:ニキビ|吹き出物)/iu],
  ["lightweight", /\b(?:lightweight|light|non[-\s]?sticky)\b|(?:산뜻|가벼운|끈적임\s*없)|(?:軽い|さっぱり|べたつかない)/iu],
  ["rich", /\b(?:rich|nourishing)\b|(?:리치|영양감|고보습)|(?:濃厚|しっとり)/iu],
  ["gentle", /\b(?:gentle|mild)\b|(?:순한|저자극)|(?:やさしい|低刺激)/iu],
  ["cleanser", /\b(?:cleanser|cleansing|cleanse)\b|(?:클렌저|클렌징|세안)|(?:クレンジング|洗顔)/iu],
  ["sunscreen", /\b(?:sunscreen|sun\s+protection|spf|uv)\b|(?:선크림|자외선|차단)|(?:日焼け止め|紫外線|UV)/iu],
  ["serum", /\bserum\b|세럼|セラム|美容液/iu],
  ["cream", /\bcream\b|크림|クリーム/iu],
  ["toner", /\btoner\b|토너|化粧水|トナー/iu],
  ["lotion", /\blotion\b|로션|ローション|乳液/iu],
  ["mask", /\bmask\b|마스크|팩|マスク|パック/iu],
  ["ceramide", /\bceramides?\b|세라마이드|セラミド/iu],
  ["hyaluronic-acid", /\bhyaluronic(?:\s+acid)?\b|히알루론산|ヒアルロン酸/iu],
  ["niacinamide", /\bniacinamide\b|나이아신아마이드|ナイアシンアミド/iu],
  ["retinol", /\bretinol\b|레티놀|レチノール/iu],
  ["ginseng", /\bginseng\b|인삼|高麗人参|ジンセン/iu],
  ["peptide", /\bpeptides?\b|펩타이드|ペプチド/iu],
  ["panthenol", /\bpanthenol\b|판테놀|パンテノール/iu],
  ["fragrance", /\b(?:fragrance|perfume|scent)\b|(?:향료|무향)|(?:香料|無香料)/iu],
  ["daily", /\b(?:daily|every\s+day)\b|(?:매일|데일리)|(?:毎日|デイリー)/iu],
  ["apply", /\b(?:apply|spread|smooth)\b|(?:바르|도포|펴\s*바르)|(?:塗|広げ|のばし)/iu],
  ["massage", /\b(?:massage|rub|press|pat)\b|(?:마사지|문지르|누르|두드)|(?:マッサージ|こす|押さえ|パッティング)/iu],
  ["rinse", /\b(?:rinse|wash\s+off|remove)\b|(?:헹구|씻어|닦아?내|제거)|(?:すす|洗い流|拭き取|落と)/iu]
];

function semanticConcepts(value: string): Set<string> {
  return new Set(semanticConceptPatterns.filter(([, pattern]) => pattern.test(value)).map(([concept]) => concept));
}

function crossLanguageConceptsAreSupported(text: string, evidenceText: string): boolean {
  const claimConcepts = semanticConcepts(text);
  if (claimConcepts.size === 0) return false;
  const evidenceConcepts = semanticConcepts(evidenceText);
  return [...claimConcepts].every((concept) => evidenceConcepts.has(concept));
}

function faqQuestionIsSupported(
  question: string,
  evidenceIds: string[],
  evidenceById: Map<string, PdpGeoAtomicEvidence>,
  product: PdpProductSignal,
  semanticAuditPassed: boolean
): boolean {
  const cited = evidenceIds.map((id) => evidenceById.get(id)).filter((item): item is PdpGeoAtomicEvidence => Boolean(item));
  const evidenceText = cited.map((item) => item.text).join(" ");
  if (!claimRiskIsSupported(question, evidenceText) || !evidenceRolesSupportClaimTopics(question, cited)) return false;
  if (usesDifferentPrimaryScript(question, evidenceText)) {
    return semanticAuditPassed && crossLanguageConceptsAreSupported(question, evidenceText);
  }

  const identityTokens = meaningfulEvidenceTokens([product.name, product.originalName ?? "", product.brand ?? "", product.category ?? ""].join(" "));
  const genericQuestionTokens = /^(?:skin|concern|suitable|suitability|support|use|used|using|fit|right|피부|고민|적합.*|사용.*|가능.*|무엇인가요|어떤가요|肌|悩み|適し.*|使え.*|何ですか|どんな)$/u;
  const questionTokens = meaningfulEvidenceTokens(question)
    .filter((token) => !genericQuestionTokens.test(token))
    .filter((token) => !identityTokens.some((identity) => evidenceTokensMatch(token, identity)));
  if (questionTokens.length === 0) return true;
  const evidenceTokens = meaningfulEvidenceTokens(evidenceText);
  return questionTokens.every((token) => evidenceTokens.some((source) => evidenceTokensMatch(token, source)));
}

function evidenceSemanticallySupportsText(
  text: string,
  evidenceIds: string[],
  evidenceById: Map<string, PdpGeoAtomicEvidence>,
  product: PdpProductSignal,
  semanticAuditPassed: boolean
): boolean {
  const cited = evidenceIds.map((id) => evidenceById.get(id)).filter((item): item is PdpGeoAtomicEvidence => Boolean(item));
  const substantive = cited.filter((item) => item.role !== "identity");
  if (substantive.length === 0) return false;

  if (substantive.every((item) => item.role === "review") && !hasReviewAttribution(text)) {
    return false;
  }
  if (!evidenceRolesSupportClaimTopics(text, cited)) {
    return false;
  }

  const evidenceText = substantive.map((item) => item.text).join(" ");
  if (!claimRiskIsSupported(text, evidenceText)) {
    return false;
  }
  if (!claimPolarityAndModalityArePreserved(text, evidenceText)) {
    return false;
  }
  if (!causalIngredientBenefitLinkIsSupported(text, cited, product)) {
    return false;
  }
  if (usesDifferentPrimaryScript(text, evidenceText)) {
    // A model audit is necessary but not sufficient: require independently
    // observable concepts to remain a subset of the cited source semantics.
    return semanticAuditPassed && crossLanguageConceptsAreSupported(text, evidenceText);
  }

  const identityTokens = meaningfulEvidenceTokens([
    product.name,
    product.originalName ?? "",
    product.brand ?? "",
    product.category ?? ""
  ].join(" "));
  const claimTokens = meaningfulEvidenceTokens(text)
    .filter((token) => !identityTokens.some((identity) => evidenceTokensMatch(token, identity)));
  if (claimTokens.length === 0) return true;

  const sourceTokens = meaningfulEvidenceTokens(evidenceText);
  const matched = claimTokens.filter((token) => sourceTokens.some((source) => evidenceTokensMatch(token, source))).length;
  const japaneseClaim = /[\u3040-\u30ff\u3400-\u9fff]/u.test(text) && !/[\uac00-\ud7a3]/u.test(text);
  if (japaneseClaim && semanticAuditPassed) {
    return matched >= Math.min(3, claimTokens.length) && matched / claimTokens.length >= 0.55;
  }
  return matched === claimTokens.length;
}

function claimPolarityAndModalityArePreserved(text: string, evidenceText: string): boolean {
  const negative = /\b(?:no|not|never|neither|without|cannot|can't|doesn't|does\s+not|do\s+not|isn't|is\s+not|aren't|are\s+not)\b|(?:않|없|아니|못하|무첨가)|(?:ない|ません|ではない|無し|なし)/iu;
  const weak = /\b(?:may|might|could|can|potentially|appears?|suggests?|helps?|supports?|designed\s+to|aims?\s+to)\b|(?:수\s*있|가능성|도움을?\s*줄|도와|돕|지원|설계)|(?:可能性|ことがある|場合がある|助け|支え|目指|設計)/iu;
  const outputIsNegative = negative.test(text);
  const outputIsWeak = weak.test(text);
  const outputTokens = meaningfulEvidenceTokens(text);
  const outputConcepts = semanticConcepts(text);
  const evidenceClauses = evidenceText.split(/[.!?。！？;；\n]+/u).map(cleanText).filter(Boolean);

  for (const clause of evidenceClauses) {
    const sourceIsNegative = negative.test(clause);
    const sourceIsWeak = weak.test(clause);
    if (!sourceIsNegative && !sourceIsWeak) continue;
    const sourceTokens = meaningfulEvidenceTokens(clause);
    const lexicalMatches = sourceTokens.filter((token) => outputTokens.some((candidate) => evidenceTokensMatch(token, candidate))).length;
    const sourceConcepts = semanticConcepts(clause);
    const conceptMatches = [...sourceConcepts].filter((concept) => outputConcepts.has(concept)).length;
    const related = usesDifferentPrimaryScript(text, clause)
      ? conceptMatches > 0
      : lexicalMatches >= Math.min(2, Math.max(1, sourceTokens.length));
    if (!related) continue;
    if (sourceIsNegative && !outputIsNegative) return false;
    if (sourceIsWeak && !outputIsWeak) return false;
  }
  return true;
}

function meaningfulEvidenceTokens(value: string): string[] {
  const stopWordValues = [
    "a", "an", "and", "are", "as", "at", "be", "by", "can", "could", "did", "do", "does", "for", "from", "has", "have", "helps", "in", "is", "it", "its", "may", "might", "of", "on", "or", "should", "that", "the", "this", "to", "will", "with", "what", "which", "when", "who", "would", "how",
    "product", "page", "pdp", "serum", "cream", "toner", "formula", "item", "information", "details", "includes", "shows", "explains", "check", "find", "main", "key", "benefit", "feature", "features", "ingredient", "ingredients",
    "제품", "상품", "페이지", "정보", "확인", "확인할", "있습니다", "합니다", "어떤", "무엇", "어떻게", "위한", "통해", "대한", "그리고", "또는", "핵심", "장점", "주요", "소개", "소개됩니다", "특징", "성분",
    "商品", "製品", "ページ", "情報", "確認", "できます", "です", "ます", "どの", "どんな", "について", "主な", "利点", "特徴", "成分"
  ];
  const stopWords = new Set(stopWordValues.flatMap((word) => [word, normalizeEvidenceToken(word)]));
  const wordTokens = normalizeForMatch(value).split(" ")
    .map(normalizeEvidenceToken)
    .filter((token) => token.length >= 2 && !stopWords.has(token));
  const japaneseText = value
    .replace(/(?:商品|製品|ページ|情報|確認|できます|です|ます|どの|どんな|について)/g, "")
    .replace(/[^\u3040-\u30ff\u3400-\u9fff]/g, "");
  const japaneseNgrams = japaneseText.length >= 3
    ? Array.from({ length: japaneseText.length - 2 }, (_, index) => japaneseText.slice(index, index + 3))
    : japaneseText.length >= 2 ? [japaneseText] : [];
  return uniqueText([...wordTokens, ...japaneseNgrams]);
}

function claimRiskIsSupported(text: string, evidenceText: string): boolean {
  const exactRiskClaims = [
    /\b(?:cures?|treats?|heals?)\b|(?:치료|치유)|(?:治療|治す)/iu,
    /\b(?:medical|medicine|therapeutic)\b|(?:의약|의학적)|(?:医薬|治療用)/iu,
    /\b(?:eczema|cancer|disease)\b|(?:습진|아토피|암|질환)|(?:湿疹|がん|疾患)/iu,
    /\bclinically\s+proven\b|(?:임상적으로\s*입증)|(?:臨床的に証明)/iu,
    /\bclinical(?:ly)?\s+tested\b|(?:임상\s*(?:시험|테스트))|(?:臨床試験済み)/iu,
    /\bdermatologist(?:ically)?\s+approved\b|(?:피부과\s*(?:승인|인정))|(?:皮膚科医承認)/iu,
    /\bcertified\b|(?:인증(?:받|된))|(?:認証済み)/iu,
    /\b(?:patented|granted\s+patent)\b|(?:특허(?:받|등록|된))|(?:特許取得)/iu,
    /\bpatent\s+pending\b|(?:특허\s*(?:출원|신청))|(?:特許出願)/iu,
    /\b(?:permanent(?:ly)?|guaranteed)\b|(?:영구적|보장)|(?:永久|保証)/iu,
    /\b(?:safe\s+for\s+everyone|works?\s+for\s+all)\b|(?:모두에게\s*안전|모든\s*피부)|(?:すべての人に安全|すべての肌)/iu,
    /\b(?:best|number\s*one|no\.?\s*1|award[-\s]?winning|better\s+than)\b|(?:최고|1위|수상|보다\s*우수)|(?:最高|第?1位|受賞|より優れ)/iu
  ];
  return exactRiskClaims.every((pattern) => !pattern.test(text) || pattern.test(evidenceText));
}

function causalIngredientBenefitLinkIsSupported(
  text: string,
  cited: PdpGeoAtomicEvidence[],
  product: PdpProductSignal
): boolean {
  if (!/\b(?:helps?|supports?|improves?|boosts?|strengthens?|provides?)\b|(?:도와|돕|지원|개선|강화|높여|제공)|(?:助け|支え|改善|高め|与え)/iu.test(text)) {
    return true;
  }
  const textTokens = meaningfulEvidenceTokens(text);
  const ingredientTokens = meaningfulEvidenceTokens([
    ...product.ingredients,
    ...(product.semanticFacts?.ingredients ?? [])
  ].join(" "));
  const benefitTokens = meaningfulEvidenceTokens([
    ...product.benefits,
    ...product.effects,
    ...(product.semanticFacts?.benefits ?? []),
    ...(product.semanticFacts?.effects ?? [])
  ].join(" "));
  const mentionsIngredient = ingredientTokens.some((token) => textTokens.some((candidate) => evidenceTokensMatch(token, candidate)));
  const mentionsBenefit = benefitTokens.some((token) => textTokens.some((candidate) => evidenceTokensMatch(token, candidate)));
  if (!mentionsIngredient || !mentionsBenefit) return true;
  const causalLanguage = /\b(?:helps?|supports?|improves?|boosts?|strengthens?|provides?|contributes?\s+to|for)\b|(?:도와|돕|지원|개선|강화|높여|제공|위한|기여)|(?:助け|支え|改善|高め|与え|ため|寄与)/iu;
  return cited.some((item) => item.text
    .split(/[.!?。！？;；\n]+/u)
    .map(cleanText)
    .filter(Boolean)
    .some((clause) => {
      if (!causalLanguage.test(clause)) return false;
      const sourceTokens = meaningfulEvidenceTokens(clause);
      return ingredientTokens.some((token) => sourceTokens.some((candidate) => evidenceTokensMatch(token, candidate)))
        && benefitTokens.some((token) => sourceTokens.some((candidate) => evidenceTokensMatch(token, candidate)));
    }));
}

function normalizeEvidenceToken(value: string): string {
  let token = value.toLocaleLowerCase();
  if (/^[a-z]+$/.test(token)) {
    token = token
      .replace(/(?:izations?|isations?)$/, "")
      .replace(/(?:ations?|ating|ated|ingly|ing|edly|ed)$/, "")
      .replace(/(?:ies)$/, "y")
      .replace(/s$/, "");
  }
  if (/[가-힣]/.test(token) && token.length >= 3) {
    token = token
      .replace(/(?:입니다|됩니다|합니다|드립니다|있습니다)$/u, "")
      .replace(/(?:으로|에서|에게|까지|부터|처럼|보다|에는|에서는|은|는|이|가|을|를|의|에|도|와|과)$/u, "");
  }
  return token;
}

function evidenceTokensMatch(left: string, right: string): boolean {
  return left === right || (Math.min(left.length, right.length) >= 3 && (left.includes(right) || right.includes(left)));
}

function usesDifferentPrimaryScript(left: string, right: string): boolean {
  const dominant = (value: string): "latin" | "hangul" | "japanese" | "none" => {
    const counts = {
      latin: (value.match(/[A-Za-z]/g) ?? []).length,
      hangul: (value.match(/[\uac00-\ud7a3]/g) ?? []).length,
      japanese: (value.match(/[\u3040-\u30ff\u3400-\u9fff]/g) ?? []).length
    };
    const [script, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] as ["latin" | "hangul" | "japanese", number];
    return count >= 3 ? script : "none";
  };
  const leftScript = dominant(left);
  const rightScript = dominant(right);
  return leftScript !== "none" && rightScript !== "none" && leftScript !== rightScript;
}

function hasReviewAttribution(value: string): boolean {
  return /\b(?:reviews?|reviewers?|customers?|users?|respondents?)\b|(?:리뷰|후기|고객|사용자|응답자)|(?:レビュー|口コミ|利用者|回答者)/iu.test(value);
}

function evidenceRolesSupportClaimTopics(text: string, cited: PdpGeoAtomicEvidence[]): boolean {
  const roleSet = new Set(cited.map((item) => item.role));
  const requirements: Array<{ pattern: RegExp; roles: PdpGeoEvidenceRole[] }> = [
    { pattern: /\b(?:ingredients?|actives?|formula)\b|(?:성분|원료|포뮬러)|(?:成分|原料|処方)/iu, roles: ["ingredient", "description", "source", "faq"] },
    { pattern: /\b(?:benefits?|effects?|results?)\b|(?:효능|효과|혜택|개선)|(?:効果|ベネフィット|改善)/iu, roles: ["benefit", "effect", "description", "metric", "source", "faq"] },
    { pattern: /\b(?:reviews?|customers?\s+(?:say|mention))\b|(?:리뷰|후기|고객이\s*언급)|(?:レビュー|口コミ)/iu, roles: ["review", "faq", "source"] },
    { pattern: /\b(?:price|cost|size|option|variant)\b|(?:가격|용량|옵션|버전)|(?:価格|容量|オプション|種類)/iu, roles: ["commerce", "faq", "source"] }
  ];
  return requirements.every(({ pattern, roles }) => !pattern.test(text) || roles.some((role) => roleSet.has(role)));
}

function textsAreTooSimilar(left: string, right: string): boolean {
  const leftNormalized = normalizeForMatch(left);
  const rightNormalized = normalizeForMatch(right);
  if (!leftNormalized || !rightNormalized) return false;
  if (leftNormalized === rightNormalized || leftNormalized.includes(rightNormalized) || rightNormalized.includes(leftNormalized)) return true;
  const leftTokens = new Set(meaningfulEvidenceTokens(left));
  const rightTokens = new Set(meaningfulEvidenceTokens(right));
  const intersection = [...leftTokens].filter((token) => [...rightTokens].some((other) => evidenceTokensMatch(token, other))).length;
  const denominator = Math.min(leftTokens.size, rightTokens.size);
  return denominator >= 3 && intersection / denominator >= 0.8;
}

function faqEquivalent(left: { question: string; intent: string; cep: string }, right: { question: string; intent: string; cep: string }): boolean {
  const leftTokens = new Set(normalizeForMatch(left.question).split(" ").filter((token) => token.length > 1));
  const rightTokens = new Set(normalizeForMatch(right.question).split(" ").filter((token) => token.length > 1));
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  const overlap = union === 0 ? 0 : intersection / union;
  const sameIntent = normalizeForMatch(left.intent) !== "" && normalizeForMatch(left.intent) === normalizeForMatch(right.intent);
  const sameCep = normalizeForMatch(left.cep) !== "" && normalizeForMatch(left.cep) === normalizeForMatch(right.cep);
  return normalizeForMatch(left.question) === normalizeForMatch(right.question)
    || (sameIntent && sameCep)
    || overlap >= 0.8;
}

function providerText(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === "string") return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  const texts: string[] = [];
  for (const item of output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (isRecord(content) && typeof content.text === "string") texts.push(content.text);
    }
  }
  return texts.join("\n");
}

function extractJsonObject(text: string): string | undefined {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : undefined;
}

function toGeminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toGeminiSchema);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => {
    if (key === "additionalProperties" || key === "description") return [];
    if (key === "type" && typeof child === "string") return [[key, child.toUpperCase()]];
    return [[key, toGeminiSchema(child)]];
  }));
}

function tokenUsageFromOpenAi(value: unknown): PdpGeoTokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  return compactUsage(value.input_tokens, value.output_tokens, value.total_tokens);
}

function tokenUsageFromGemini(value: unknown): PdpGeoTokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  return compactUsage(value.promptTokenCount, value.candidatesTokenCount, value.totalTokenCount);
}

function tokenUsageFromChatCompletions(value: unknown): PdpGeoTokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  return compactUsage(value.prompt_tokens, value.completion_tokens, value.total_tokens);
}

function compactUsage(input: unknown, output: unknown, total: unknown): PdpGeoTokenUsage | undefined {
  const usage: PdpGeoTokenUsage = {
    inputTokens: typeof input === "number" ? input : undefined,
    outputTokens: typeof output === "number" ? output : undefined,
    totalTokens: typeof total === "number" ? total : undefined
  };
  return usage.inputTokens !== undefined || usage.outputTokens !== undefined || usage.totalTokens !== undefined ? usage : undefined;
}

function mergeTokenUsage(left: PdpGeoTokenUsage | undefined, right: PdpGeoTokenUsage | undefined): PdpGeoTokenUsage | undefined {
  if (!left) return right;
  if (!right) return left;
  const add = (a: number | undefined, b: number | undefined) => a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
  return {
    inputTokens: add(left.inputTokens, right.inputTokens),
    outputTokens: add(left.outputTokens, right.outputTokens),
    totalTokens: add(left.totalTokens, right.totalTokens)
  };
}

function planningWarningField(reason: string): string {
  const field = reason.match(/^(Product\.description|WebPage\.description|FAQ|HowTo)/i)?.[1];
  return field ?? "content-plan";
}

function temperatureBody(temperature: number | undefined): { temperature?: number } {
  return typeof temperature === "number" && Number.isFinite(temperature) ? { temperature } : {};
}

async function requestJsonWithTemperatureFallback(
  url: string,
  authHeaders: Record<string, string>,
  body: Record<string, unknown>,
  label: string
): Promise<Record<string, unknown>> {
  const post = (requestBody: Record<string, unknown>) => fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(requestBody)
  }, label);
  const response = await post(body);
  if (response.ok) return response.json() as Promise<Record<string, unknown>>;

  const suffix = await errorSuffix(response);
  if (body.temperature !== undefined && /unsupported value[^]*temperature|temperature[^]*(?:unsupported|only the default)/i.test(suffix)) {
    const { temperature: _temperature, ...retryBody } = body;
    const retry = await post(retryBody);
    if (retry.ok) return retry.json() as Promise<Record<string, unknown>>;
    throw new Error(`${label} failed: ${retry.status}${await errorSuffix(retry)}`);
  }
  throw new Error(`${label} failed: ${response.status}${suffix}`);
}

async function fetchWithTimeout(url: string, init: RequestInit, label: string): Promise<Response> {
  const signal = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(PLANNING_TIMEOUT_MS) : undefined;
  try {
    return await fetch(url, { ...init, signal });
  } catch (error) {
    if (isRecord(error) && error.name === "AbortError") throw new Error(`${label} timed out.`);
    throw error;
  }
}

async function errorSuffix(response: Response): Promise<string> {
  const value = cleanText(await response.text().catch(() => ""));
  return value ? ` - ${value.slice(0, 400)}` : "";
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function uniqueText(values: string[]): string[] {
  return [...new Set(values.map(cleanText).filter(Boolean))];
}

function normalizeForMatch(value: string): string {
  return cleanText(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function cleanText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ").replace(/\s+/g, " ").trim();
}

function truncate(value: string, max: number): string {
  const text = cleanText(value);
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
