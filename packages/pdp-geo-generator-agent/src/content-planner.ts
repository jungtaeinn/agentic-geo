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
  PdpProductSignal,
  PdpSemanticMetricClaim
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
  product.semanticFacts?.benefits.forEach((value, index) => add("benefit", value, `product.semanticFacts.benefits[${index}]`, 0.95));
  product.semanticFacts?.effects.forEach((value, index) => add("effect", value, `product.semanticFacts.effects[${index}]`, 0.95));
  product.semanticFacts?.ingredients.forEach((value, index) => add("ingredient", value, `product.semanticFacts.ingredients[${index}]`, 0.95));
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
  product.semanticFacts?.safetyTests?.forEach((value, index) => add("source", value, `product.semanticFacts.safetyTests[${index}]`, 0.98));
  product.semanticFacts?.evidenceSentences.forEach((value, index) => add("source", value, `product.semanticFacts.evidenceSentences[${index}]`, 0.9));
  product.semanticFacts?.metricClaims.forEach((claim, index) => {
    const structuredMetric = formatMetricClaimEvidenceAtom(claim);
    add("metric", structuredMetric, `product.semanticFacts.metricClaims[${index}]`, 0.98);
    const provenance = claim.sourceText || claim.sentence;
    if (provenance && cleanText(provenance) !== cleanText(structuredMetric)) {
      add("source", provenance, `product.semanticFacts.metricClaims[${index}].sourceText`, 0.9);
    }
  });
  product.semanticFacts?.ingredientBenefitLinks.forEach((link, index) => {
    add("ingredient", link.ingredient, `product.semanticFacts.ingredientBenefitLinks[${index}].ingredient`, 0.94);
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

function formatMetricClaimEvidenceAtom(claim: PdpSemanticMetricClaim): string {
  const outcome = [claim.label, claim.subject, claim.metric].find((value) => typeof value === "string" && value.trim())?.trim();
  const measuredValue = [claim.value, claim.unit].filter((value): value is string => typeof value === "string" && value.trim().length > 0).join("");
  if (!outcome || !measuredValue) {
    return claim.sentence || claim.sourceText || Object.values(claim).filter(Boolean).join("; ");
  }
  const context = [
    ["direction", claim.direction],
    ["timing", claim.timing],
    ["baseline", claim.baseline],
    ["comparator", claim.comparator],
    ["sample", claim.sample],
    ["period", claim.period],
    ["method", claim.method],
    ["institution", claim.institution],
    ["evidenceGroup", claim.evidenceGroup],
    ["caveat", claim.caveat]
  ].flatMap(([label, value]) => typeof value === "string" && value.trim() ? [`${label}=${value.trim()}`] : []);
  return [`${outcome}: ${measuredValue}`, ...context].join("; ");
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
  const directUsageSteps = uniqueText(request.product.usage).filter(isConcreteUsageAction);
  const sourceTextUsageSteps = uniqueText(request.product.sourceTexts).filter(isConcreteUsageAction);
  const explicitDirectSequence = extractExplicitUsageSequence(request.product.usage);
  const explicitSourceTextSequence = extractExplicitUsageSequence(request.product.sourceTexts);
  const explicitSemanticSequence = extractExplicitUsageSequence(semanticUsageSteps);
  const explicitSourceSequenceExtendsDirectUsage = directUsageSteps.length === 1
    && explicitSourceTextSequence.length >= 2
    && explicitSourceTextSequence.some((sourceStep) => usageActionsAreSemanticallyEquivalent(sourceStep, directUsageSteps[0] ?? ""));
  const longestDirectUsageLength = Math.max(0, ...directUsageSteps.map((step) => cleanText(step).length));
  const compositeSourceInstructions = sourceTextUsageSteps.filter((sourceStep) =>
    cleanText(sourceStep).length > longestDirectUsageLength
    && directUsageSteps.some((directStep) => usageActionsAreSemanticallyEquivalent(sourceStep, directStep))
    && !directUsageSteps.some((directStep) => normalizeForMatch(directStep) === normalizeForMatch(sourceStep))
  );
  const singleCompositeSourceInstruction = compositeSourceInstructions.length === 1
    ? compositeSourceInstructions
    : [];
  const hasDirectUsageEvidence = directUsageSteps.length > 0;
  // The normalized product usage field is closest to the source contract and
  // therefore wins over model-classified semanticFacts. A semantic model must
  // not split one direct source instruction into synthetic steps, infer order
  // from action stages, or replace an explicit source sequence with a different
  // cardinality. Source text can restore explicit markers that normalization
  // removed, but multiple unmarked notes are never promoted into a procedure.
  const usageSteps = (explicitDirectSequence.length >= 2
    ? explicitDirectSequence
    : explicitSourceSequenceExtendsDirectUsage
      ? explicitSourceTextSequence
    : directUsageSteps.length === 1
      ? directUsageSteps
      : explicitSourceTextSequence.length >= 2
        ? explicitSourceTextSequence
      : singleCompositeSourceInstruction.length === 1
        ? singleCompositeSourceInstruction
        : hasDirectUsageEvidence
          ? []
          : sourceTextUsageSteps.length === 1
            ? sourceTextUsageSteps
            : sourceTextUsageSteps.length > 1
              ? []
              : explicitSemanticSequence.length >= 2
                ? explicitSemanticSequence
                : []).slice(0, 6);
  const sourceStructureSupported = usageSteps.length >= 2 && (
    explicitDirectSequence.length >= 2
    || explicitSourceTextSequence.length >= 2
    || (!hasDirectUsageEvidence && sourceTextUsageSteps.length === 0 && explicitSemanticSequence.length >= 2)
  );
  const steps = sourceStructureSupported
    ? usageSteps.map((text, index): PdpGeoPlannedHowToStep => ({
        position: index + 1,
        name: truncate(text, 80),
        text,
        evidenceIds: matchingEvidenceIds(text, usageEvidence)
      })).filter((step) => step.evidenceIds.length > 0)
    : [];
  const eligible = sourceStructureSupported && steps.length === usageSteps.length && steps.length >= 2;
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
      ordered: eligible,
      goal: eligible ? createHowToGoal(request.product.name, request.locale) : "",
      steps: eligible ? steps : [],
      evidenceIds: eligible ? uniqueText(steps.flatMap((step) => step.evidenceIds)) : [],
      confidence: eligible ? 0.75 : 0.85,
      omitReason: eligible ? "" : "The source does not contain a goal and at least two source-backed ordered usage actions."
    },
    cep: [],
    warnings: []
  };
}

function createHowToGoal(productName: string, locale: PdpGeoLocale): string {
  if (locale === "ko-KR") return `${productName} 사용 방법`;
  if (locale === "ja-JP") return `${productName}の使い方`;
  return `How to use ${productName}`;
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
  const sourceFaithfulHowTo = createConservativeContentPlan(request).howTo;
  const gateWarnings: string[] = [];
  const sanitizeIds = (ids: string[]) => uniqueText(ids).filter((id) => evidenceById.has(id));
  const sanitizeField = (field: PdpGeoPlannedField, name: string): PdpGeoPlannedField => {
    const evidenceIds = sanitizeIds(field.evidenceIds);
    const text = cleanText(field.text);
    const citedEvidenceText = evidenceIds.map((id) => evidenceById.get(id)?.text ?? "").join(" ");
    const contextSupported = contextAssociationsAreSupported(text, citedEvidenceText);
    const entityRepetitionSupported = descriptionEntityRepetitionWithinBudget(text, request.product, name);
    const supported = text.length > 0
      && evidenceIds.length > 0
      && numbersAreSupported(text, evidenceIds, evidenceById)
      && isTargetLocaleCopy(text, request.locale)
      && isCoherentPublicCopy(text, "statement")
      && contextSupported
      && entityRepetitionSupported
      && evidenceSemanticallySupportsText(text, evidenceIds, evidenceById, request.product, semanticAuditPassed);
    if (field.include && !supported) gateWarnings.push(`${name} was omitted because its text, locale, or cited evidence did not pass the evidence gate.`);
    if (field.include && text && !contextSupported) {
      gateWarnings.push(`QUERY_HYPOTHESIS_ONLY: ${name} context "${truncate(text, 160)}" was omitted from public copy because its seasonal, occasion, timing, general-association, or causal context was not explicit in the cited product evidence.`);
    }
    if (field.include && text && !entityRepetitionSupported) {
      gateWarnings.push(`${name} was omitted because it mechanically repeats the full product entity instead of maintaining one connected buyer narrative.`);
    }
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
      const cep = cleanText(item.cep);
      const citedEvidenceText = evidenceIds.map((id) => evidenceById.get(id)?.text ?? "").join(" ");
      const cepContextSupported = !cep || contextAssociationsAreSupported(cep, citedEvidenceText);
      const publicContextSupported = contextAssociationsAreSupported(`${question} ${answer}`, citedEvidenceText);
      const gateChecks: Array<[string, boolean]> = [
        ["question-length", question.length >= 6],
        ["answer-length", answer.length >= 12],
        ["known-evidence-ids", evidenceIds.length > 0],
        // A buyer question may name a duration, size, or other selector whose
        // factual relationship is stated only in the answer. Validate the
        // answer as the public claim unit so joining Q+A cannot create a false
        // numeric relationship across sentence boundaries.
        ["numeric-relationship", numbersAreSupported(answer, evidenceIds, evidenceById)],
        ["question-locale", isTargetLocaleCopy(question, request.locale)],
        ["answer-locale", isTargetLocaleCopy(answer, request.locale)],
        ["question-coherence", isCoherentPublicCopy(question, "question")],
        ["answer-coherence", isCoherentPublicCopy(answer, "statement")],
        ["context-support", publicContextSupported],
        ["question-risk-support", claimRiskIsSupported(question, citedEvidenceText)],
        ["question-role-support", evidenceRolesSupportClaimTopics(question, evidenceIds.map((id) => evidenceById.get(id)).filter((value): value is PdpGeoAtomicEvidence => Boolean(value)))],
        ["question-entailment", faqQuestionIsSupported(question, evidenceIds, evidenceById, request.product, semanticAuditPassed)],
        ["answer-entailment", faqAnswerIsSupported(answer, evidenceIds, evidenceById, request.product, semanticAuditPassed)]
      ];
      const failedChecks = gateChecks.filter(([, passed]) => !passed).map(([name]) => name);
      const include = item.include && failedChecks.length === 0;
      if (item.include && !include) {
        gateWarnings.push(
          `FAQ intent "${item.intent || "unknown"}" was omitted by the evidence/locale gate; failed checks: ${failedChecks.join(", ") || "unknown"}; question: "${truncate(question, 120)}"; retained evidence IDs: ${evidenceIds.join(", ") || "none"}.`
        );
      }
      if (item.include && !publicContextSupported) {
        gateWarnings.push(`QUERY_HYPOTHESIS_ONLY: FAQ intent "${item.intent || "unknown"}" was omitted from public copy because its seasonal, occasion, timing, general-association, or causal context was not explicit in the cited product evidence.`);
      }
      if (item.include && cep && !cepContextSupported) {
        gateWarnings.push(`QUERY_HYPOTHESIS_ONLY: FAQ CEP "${truncate(cep, 120)}" was removed because its seasonal, occasion, timing, general-association, or causal context was not explicit in the cited product evidence.`);
      }
      return { ...item, include, question, answer, cep: cepContextSupported ? cep : "", evidenceIds };
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
    .filter((step, index, items) => items.findIndex((candidate) => usageActionsAreSemanticallyEquivalent(candidate.text, step.text)) === index)
    .map(({ supported: _supported, ...step }) => step)
    .slice(0, 8);
  const howToEligible = raw.howTo.eligible
    && raw.howTo.ordered
    && cleanText(raw.howTo.goal).length > 0
    && steps.length >= 2
    && hasSourceOrderProvenance(steps, evidenceById);
  if (raw.howTo.eligible && !howToEligible) gateWarnings.push("HowTo was omitted because it did not have a goal and at least two source-backed ordered usage actions.");

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
      const citedEvidenceText = candidate.evidenceIds.map((id) => evidenceById.get(id)?.text ?? "").join(" ");
      const contextSupported = contextAssociationsAreSupported(text, citedEvidenceText);
      const supported = candidate.evidenceIds.length > 0
        && text.length > 0
        && isTargetLocaleCopy(text, request.locale)
        && numbersAreSupported(text, candidate.evidenceIds, evidenceById)
        && contextSupported
        && evidenceSemanticallySupportsText(text, candidate.evidenceIds, evidenceById, request.product, semanticAuditPassed);
      if (!supported) {
        gateWarnings.push(contextSupported
          ? "A CEP candidate was omitted because its situation, need, constraint, locale, or cited evidence was not supported."
          : `QUERY_HYPOTHESIS_ONLY: CEP "${truncate(text, 160)}" was omitted from factual planning because its seasonal, occasion, timing, general-association, or causal context was not explicit in the cited product evidence.`);
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
    // Usage structure is deterministic and source-faithful. The model may
    // reason about applicability, but it cannot split, merge, omit, or invent
    // HowTo steps after product usage has been normalized.
    howTo: sourceFaithfulHowTo,
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
  const mayInheritProviderSettings = settings?.provider === undefined || settings.provider === options.provider;
  const apiKey = settings?.apiKey ?? (mayInheritProviderSettings ? options.apiKey : undefined);
  const enabled = settings?.enabled ?? (provider !== "mock" && provider !== "custom" && Boolean(apiKey));
  if (!enabled) return {};
  if (provider === "mock" || provider === "custom") return { warning: `${provider} content planning requires customContentPlanner.` };
  return {
    planner: new ModelBackedContentPlanner({
      provider,
      apiKey,
      model: settings?.model ?? (mayInheritProviderSettings ? options.model : undefined),
      endpoint: settings?.endpoint ?? (mayInheritProviderSettings ? options.endpoint : undefined),
      deployment: settings?.deployment ?? (mayInheritProviderSettings ? options.deployments?.reasoning ?? options.deployment : undefined),
      apiVersion: settings?.apiVersion ?? (mayInheritProviderSettings ? options.apiVersion : undefined),
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
      "Before drafting, classify every cited atom by evidence role and relationship scope. Identity identifies the product; audience names an explicitly supported customer; ingredient names composition; benefit/effect names an outcome; usage names a customer action; metric names a measured result; review names attributed experience; commerce names offer/variant facts; source is supporting text whose role must still be inferred from the sentence itself. A valid evidence ID is not permission to use that atom for an unrelated role.",
      "Separate source assertions, source-backed synthesis, and query hypotheses. Public descriptions, FAQ questions/answers, HowTo, and cep entries may contain only source assertions or synthesis whose every component is supported by cited product evidence. General category knowledge and plausible search associations are not product facts.",
      "Product.description is the primary answer-ready GEO entity summary and may be materially more detailed than WebPage.description. When evidence exists, compose a connected buyer-answer narrative in this order: product identity and type -> target customer and concrete concern/CEP -> multiple high-value formula atoms (main ingredients, named technology, and supported subcomponent structure) -> each explicit ingredient/technology-to-benefit relation -> one compact officially reported efficacy-evidence block -> why those outcomes make the product suitable for the supported target customer -> atomic completed safety/test evidence -> one concise positive or neutral customer-review pattern. Select formula atoms by evidence role and relation strength, not by a product/ingredient allowlist, and do not promote educational category facts or FAQ definitions into the current product's composition. An efficacy-evidence block may include multiple outcomes only when the product source shows that they belong to the same study, footnote group, evidenceGroup, or explicitly grouped product claim; render each evidence group once even when the same sourceText appears in multiple metricClaims, and retain a distinct supported duration claim alongside that block when useful. Cite the available institution, study dates, population/sample, method, baseline, timing, and caveat in natural target-locale prose. Safety tests may be summarized only when their exact completed test names are source-backed; completion is not proof of universal safety and an unlisted certification must not be inferred. Exclude ingredient concentration, package size, price/discount, award percentage, rating, and review count from efficacy measurements, and never attach a study context to unrelated outcomes. Omit unsupported components; do not collapse a well-evidenced product into a surface-level category sentence.",
      "WebPage.description is a compact but sufficiently specific page-level summary, not a second Product.description. Use two to four natural sentences when evidence is rich: introduce the official product page and source-backed brand; name the supported target-customer, ingredient/technology, and benefit information available on the page as parallel facts without inventing causality; then summarize the remaining decision-support scope such as directions, official tests or measurements, completed safety-test listings, recurring review themes, product-specific FAQs, variants, or offers. Do not collapse rich evidence into a generic section-name list. Include additional brand history, expertise, science, or manufacturing information only when separately cited brand evidence states it. Do not copy the Product.description buyer narrative, detailed efficacy block, exact HowTo actions, raw metric block, or review summary.",
      "Keep product references cohesive rather than repetitive. Product.description may use the full product entity once; continue with an omitted subject, pronoun, or formula/ingredient subject. WebPage.description may use it once in the page introduction and once in the connected product sentence, but must not restart every fact with the full product name.",
      "FAQ must be about this specific product. Exclude category education, definitions, and general-knowledge questions whose answer would remain essentially unchanged for another product, such as what the skin barrier is or does. Natural interrogative wrappers and target-locale inflection do not need to appear verbatim in evidence, but every factual premise in the question and every answer clause must be supported by the cited product evidence.",
      "Build FAQ questions backwards from natural recommendation and comparison intents, then build each answer forwards from cited product evidence. Prioritize reverse-query surfaces such as '[concern A] and [concern B] product recommendation', '[skin type] [category] recommendation', '[ingredient] product for [benefit]', '[supported use situation/CEP] recommendation', and '[low-stickiness or other review-backed use feel] product recommendation', rewritten as a specific question about this product. Do not claim that these are verified high-volume queries unless query-log evidence is supplied. FAQ has no minimum count. Include only distinct questions that the supplied evidence can answer directly and self-containedly. Start every answer with the product and the direct answer—never with source narration. For suitability answers use this evidence ladder in order when available: (1) explicit concern and target-customer evidence; (2) supported finished-product benefit/effect; (3) finished-product study result with timing and scope; (4) each ingredient's explicitly stated role; (5) a recommendation bounded to the supported customer/concern; (6) an individual-results-may-vary qualifier when reporting a study. Each rung must cite matching evidence and unsupported rungs must be omitted. Use 'effective/improves/개선/효과적' only when finished-product evidence supports that exact outcome. If ingredients and finished-product effects are supported separately, put them in separate sentences and explicitly avoid attributing the finished-product result to an individual ingredient. Reviews may support only attributed use-feel wording such as 'some customers mention'; they never prove efficacy or suitability. Empty FAQ is valid when product evidence cannot support these intents.",
      "Order the FAQ array by buyer priority whenever the corresponding product evidence exists. Item 1 must be a target-customer recommendation or suitability question, answered with the supported concerns/skin type, finished-product benefits, explicitly linked ingredient roles, and an attributed positive/neutral review summary when reviews exist. Gift suitability may replace or extend this intent only when the product source explicitly supports gifting. Item 2 must combine formula composition with supported benefits/effects in one product-specific question and answer; state ingredient presence and finished-product benefits separately unless an explicit ingredient-benefit relation supports the connection. After those two anchors, add every distinct BestPractice-style question that the product can directly answer, such as usage/routine, texture, measurements/tests, variants, comparison, renewal, or review experience. These are evidence-conditional requirements, not permission to invent missing facts.",
      "A CEP is a source-backed buying/use situation, need, or constraint—not a keyword slogan. In each cep item, use situation for the supported target customer/occasion, need for the concrete concern and desired outcome, and constraint for a supported selection condition or an explicit ingredient/technology-to-outcome reason. Leave constraint empty when the source does not explicitly support that relation. Cite evidence for every component, and never infer a causal, suitability, ingredient-benefit, or routine relationship merely because two facts co-occur. Seasonal/weather contexts, time-of-day, events, gifting, travel, life stage, and other general category associations require explicit current-product evidence for that same context. If such an association is useful for later search research but not evidenced, omit it from cep and all public fields and add a warning prefixed QUERY_HYPOTHESIS_ONLY; the warning is diagnostic and must not be copied into public content.",
      "Use FAQ to express a small set of semantically distinct generative-search surfaces from the strongest supported CEP paths: suitability/target customer, concern-to-effect, ingredient or technology role, official measurement, routine, and review experience. Vary natural target-locale wording and keywords across distinct intents, but do not create synonymous questions that lead to the same answer or use query variety to add unsupported facts.",
      "HowTo is eligible only when the source supports a concrete goal and at least two explicitly ordered customer actions. Preserve the original action count and order. Keep a single application instruction or unordered usage notes as ordinary visible usage guidance without HowTo structured data. Do not split one source instruction into synthetic steps or combine unordered notes into a procedure. A warning, test condition, formula technology, measured outcome, or vague suitability/frequency note without a concrete customer action is not a HowTo step.",
      "Preserve product names, ingredient names, numbers, units, populations, time frames, and caveats exactly when those facts are used. Use complete, natural, consistently polite target-locale sentences; do not mix language or speech-level frames. Resolve synonymous skin-type and concern terms into one target-locale expression instead of emitting duplicates in multiple languages. Keep ingredient, benefit/effect, usage, review, certification, and measured-result evidence in their matching public fields. In Korean descriptions, never copy a source ending such as '~표기되어 있다' into otherwise polite '~합니다/~됩니다' copy.",
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
      taskGuidance: selectPlanningRagChunks(request.ragChunks, maxRagChunks).map((chunk) => ({
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

function selectPlanningRagChunks(
  chunks: PdpGeoContentPlanningRequest["ragChunks"],
  limit: number
): PdpGeoContentPlanningRequest["ragChunks"] {
  const cappedLimit = Math.max(0, limit);
  if (cappedLimit === 0) {
    return [];
  }
  const selected: PdpGeoContentPlanningRequest["ragChunks"] = [];
  const selectedIds = new Set<string>();
  const add = (chunk: PdpGeoContentPlanningRequest["ragChunks"][number] | undefined) => {
    if (!chunk || selected.length >= cappedLimit || selectedIds.has(chunk.id)) {
      return;
    }
    selected.push(chunk);
    selectedIds.add(chunk.id);
  };

  // These three documents are the cross-cutting strategy requested by the
  // generator contract. Keep one of each in the small planner context, then
  // fill the remaining slots in retrieval-score order.
  for (const kind of ["geo-research", "cep", "eeat"] as const) {
    add(chunks.find((chunk) => chunk.kind === kind));
  }
  for (const chunk of chunks) {
    add(chunk);
  }
  return selected;
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

function hasSourceOrderProvenance(
  steps: PdpGeoPlannedHowToStep[],
  evidenceById: Map<string, PdpGeoAtomicEvidence>
): boolean {
  if (steps.length < 2) return false;
  const cited = uniqueText(steps.flatMap((step) => step.evidenceIds))
    .map((id) => evidenceById.get(id))
    .filter((item): item is PdpGeoAtomicEvidence => Boolean(item));
  const explicitSourceSequence = extractExplicitUsageSequence(cited
    .filter((item) => item.role === "usage")
    .map((item) => item.text));
  if (explicitSourceSequence.length !== steps.length) return false;
  return steps.every((step, index) => usageActionsAreSemanticallyEquivalent(
    step.text,
    explicitSourceSequence[index] ?? ""
  ));
}

function extractOrderedUsageSegments(value: string): string[] {
  const matches = Array.from(value.matchAll(/(?:^|\s)(?:step\s*)?(\d+)\s*(?:단계|段階)?[.):、]?\s+([\s\S]*?)(?=\s+(?:step\s*)?\d+\s*(?:단계|段階)?[.):、]?\s+|$)/giu));
  if (matches.length >= 2) {
    return matches.map((match) => cleanText(match[2] ?? "")).filter(isConcreteUsageAction);
  }
  const clauses = cleanText(value).split(/(?<=[.!?。！？;；])\s+/u).map(cleanText).filter(Boolean);
  return extractLexicallyMarkedUsageSequence(clauses);
}

function extractIndividuallyNumberedUsageSequence(values: string[]): string[] {
  const numbered = values.flatMap((value, sourceIndex) => {
    const match = cleanText(value).match(/^(?:(?:사용\s*방법|사용법|how\s*to\s*use|directions?)\s*[.:：]?\s*)?(?:step\s*)?(\d+)\s*(?:단계|段階)?(?:[.):、]\s*|\s+)(.+)$/iu);
    const position = match?.[1] ? Number(match[1]) : undefined;
    const text = cleanText(match?.[2] ?? "");
    return position && text && isConcreteUsageAction(text)
      ? [{ position, text, sourceIndex }]
      : [];
  }).sort((left, right) => left.position - right.position || left.sourceIndex - right.sourceIndex);
  if (numbered.length < 2
    || numbered[0]?.position !== 1
    || !numbered.every((item, index) => item.position === index + 1)) {
    return [];
  }
  return uniqueText(numbered.map((item) => item.text));
}

function extractExplicitUsageSequence(values: string[]): string[] {
  const candidates = uniqueText(values).map(cleanText).filter(Boolean);
  const individuallyNumbered = extractIndividuallyNumberedUsageSequence(candidates);
  if (individuallyNumbered.length >= 2) return individuallyNumbered;

  for (const value of candidates) {
    const embeddedSequence = extractOrderedUsageSegments(value);
    if (embeddedSequence.length >= 2) return embeddedSequence;
  }

  return extractLexicallyMarkedUsageSequence(candidates);
}

function extractLexicallyMarkedUsageSequence(values: string[]): string[] {
  const candidates = uniqueText(values).map(cleanText).filter(isConcreteUsageAction);
  if (candidates.length < 2) return [];
  const markers = candidates.map(explicitUsageSequenceMarker);
  if (markers[0] !== "start") return [];
  if (markers.slice(1).some((marker) => marker !== "continue" && marker !== "end")) return [];
  if (markers.slice(0, -1).includes("end")) return [];
  return candidates;
}

function explicitUsageSequenceMarker(value: string): "start" | "continue" | "end" | undefined {
  const text = cleanText(value).replace(
    /^(?:사용\s*방법|사용법|how\s*to\s*use|directions?|使用方法)\s*[.:：]?\s*/iu,
    ""
  );
  if (/^(?:first(?:ly)?\b|(?:먼저|우선|まず)(?:\s|[,，、:]|$))/iu.test(text)) return "start";
  if (/^(?:finally\b|(?:마지막으로|最後に)(?:\s|[,，、:]|$))/iu.test(text)) return "end";
  if (/^(?:then\b|next\b|after(?:wards?)?\b|(?:그\s*다음|다음으로|이후|次に|その後)(?:\s|[,，、:]|$))/iu.test(text)) return "continue";
  return undefined;
}

function isConcreteUsageAction(value: string): boolean {
  const text = cleanText(value);
  if (!text || text.length < 8 || !/\s/u.test(text)
    || /(?:suitable\s+for|for\s+external\s+use|can\s+be\s+used|daily\s+use|사용할\s*수|사용\s*가능|외용|적합|おすすめ|使用できます)/iu.test(text)) {
    return false;
  }
  if (/(?:%|％|\d+(?:\.\d+)?\s*배|임상|인체\s*적용|자가\s*평가|실험|시험|테스트|측정|평가|결과|대비|\bvs\.?\b|clinical|instrumental|study|test(?:ed)?|result|versus)/iu.test(text)
    && /(?:개선|증가|감소|높|낮|잔존|효과|효능|improv|increase|decrease|higher|lower|retention|effect)/iu.test(text)) {
    return false;
  }
  return /\b(?:apply|spread|massage|rinse|press|pat|dispense|mix|remove|leave|wash\s+(?:off|with|the|your|face|skin|hands?|product))\b|(?:바르|바릅|발라|도포|펴\s*바르|마사지|헹구|씻|세안|닦|두드|흡수|덜어|섞|제거)|(?:塗|なじませ|洗|すす|押さえ|取って|混ぜ|落と)/iu.test(text)
    || /(?:after\s+(?:cleansing|shower|toner)[^.!?]{0,50}\buse|(?:샤워|세안|토너)\s*후[^.!?。！？]{0,50}사용|(?:洗顔|シャワー|化粧水)後[^.!?。！？]{0,50}使用)/iu.test(text);
}

function usageActionsAreSemanticallyEquivalent(left: string, right: string): boolean {
  const leftKey = usageActionSemanticKey(left);
  const rightKey = usageActionSemanticKey(right);
  return Boolean(leftKey) && (leftKey === rightKey || leftKey.includes(rightKey) || rightKey.includes(leftKey));
}

function usageActionSemanticKey(value: string): string {
  return normalizeForMatch(value)
    .replace(/아침\s*(?:과|와|또는)?\s*저녁|morning\s*(?:and|or)?\s*(?:evening|night)/giu, "morning night")
    .replace(/피부\s*결/gu, "피부결")
    .replace(/펴\s*(?:바르는\s*것이다|바릅니다|발라\s*주세요|바르세요|바르십시오|바른다)/gu, "펴바르")
    .replace(/(?:적당량|소량)(?:을|를)?\s*(?:덜어|취해)?/gu, " ")
    .replace(/\b(?:an?\s+)?(?:appropriate|small)\s+amount\b/giu, " ")
    .replace(/(?:부드럽게|고르게|충분히|gently|evenly|thoroughly)/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
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
  // Preserve atomic-evidence boundaries. Joining atoms with plain whitespace
  // creates one artificial numeric clause and makes valid FAQ answers fail
  // when a cited atom also contains sample dates or other scoped numbers.
  const evidenceText = evidenceIds.map((id) => evidenceById.get(id)?.text ?? "").filter(Boolean).join(". ");
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
    group.every((token) => candidate.includes(token))
  ));
}

function numericClaimGroups(value: string): string[][] {
  return value
    .split(/(?:[;。！？!?]|\.(?=\s|$)|,(?=\s*[^\d\s])|\b(?:and|also|while|whereas)\b|(?:그리고|또한|반면|이며)|(?:および|また|一方))/giu)
    .map((clause) => numericClaimTokens(clause))
    .filter((tokens) => tokens.length > 0);
}

function numericClaimTokens(text: string): string[] {
  return Array.from(text.matchAll(/(?<![\p{L}\p{N}])\d+(?:[.,]\d+)?\s*(?:%|％|ppm|ml|mg|kg|g|oz|hours?|hrs?|days?|weeks?|months?|minutes?|seconds?|participants?|subjects?|users?|people|times?|시간|일|주|개월|분|초|명|회|배|개|人|時間|日|週間|か月|分|秒)?(?![\p{L}\p{N}])/giu))
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
  if (kind === "statement" && /^(?:(?:제품|상품)(?:\s*(?:페이지|정보))?\s*)?FAQ(?:에서는|에\s*따르면)|^(?:제품|상품)\s*(?:정보|자료|페이지)(?:에서는|에\s*따르면)|^(?:according\s+to\s+)?(?:the\s+)?(?:product\s+)?FAQ\b|^(?:the\s+)?product\s+(?:page|information|materials?)\s+(?:says|states|explains)\b/iu.test(text)) {
    return false;
  }
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

// These are generic context classes, not product/category rules. Surface
// variants across supported languages resolve to the same concept so a model
// cannot evade evidence binding by paraphrasing an unsupported occasion.
const contextConceptPatterns: ReadonlyArray<readonly [string, RegExp]> = [
  ["season:spring", /\b(?:spring|springtime|spring\s+months?)\b|(?:봄철?|춘계)|(?:春|春季)/iu],
  ["season:summer", /\b(?:summer|summertime|summer\s+months?|hot\s+(?:weather|months?|season|air))\b|(?:여름철?|하절기|더운\s*(?:날씨|시기|계절|바람))|(?:夏|夏季|暑い\s*(?:時期|季節|風))/iu],
  ["season:autumn", /\b(?:autumn|autumnal|fall\s+season|autumn\s+months?)\b|(?:가을철?|추계)|(?:秋|秋季)/iu],
  ["season:winter-cold", /\b(?:winter|wintertime|winter\s+months?|cold\s+(?:weather|months?|season|air|wind)|chilly\s+(?:weather|air|wind)|indoor\s+heating)\b|(?:겨울철?|동절기|추운\s*(?:날씨|시기|계절)|찬\s*바람|차가운\s*바람|추위|난방)|(?:冬|冬季|寒い\s*(?:時期|季節)|冷たい\s*風|寒さ|暖房)/iu],
  ["season:transition", /\b(?:seasonal\s+transition|change\s+of\s+seasons?|dry\s+season|rainy\s+season)\b|(?:환절기|건기|우기|장마철)|(?:季節の変わり目|乾季|雨季|梅雨)/iu],
  ["routine:morning", /\b(?:morning|a\.m\.)\b|(?:아침|오전)|(?:朝|午前)/iu],
  ["routine:night", /\b(?:night|nighttime|evening|bedtime|overnight|p\.m\.)\b|(?:밤|야간|저녁|취침\s*전|밤사이)|(?:夜|夜間|夕方|就寝前|一晩)/iu],
  ["routine:after-cleansing", /\b(?:after\s+cleansing|post[-\s]?cleanse|after\s+washing)\b|(?:세안\s*후|클렌징\s*후)|(?:洗顔後|クレンジング後)/iu],
  ["routine:before-makeup", /\b(?:before\s+makeup|pre[-\s]?makeup|under\s+makeup)\b|(?:메이크업\s*전|화장\s*전)|(?:メイク前|化粧前)/iu],
  ["occasion:gifting", /\b(?:gift|gifting|holiday|celebration)\b|(?:선물|기프트|명절|기념일)|(?:ギフト|贈り物|祝日|記念日)/iu],
  ["occasion:travel", /\b(?:travel|travelling|traveling|on[-\s]?the[-\s]?go)\b|(?:여행|휴대용|외출)|(?:旅行|持ち運び|外出)/iu],
  ["occasion:activity", /\b(?:exercise|workout|sport|outdoor)\b|(?:운동|스포츠|야외\s*활동)|(?:運動|スポーツ|屋外)/iu],
  ["occasion:post-procedure", /\b(?:after\s+(?:a\s+)?procedure|post[-\s]?procedure|post[-\s]?treatment)\b|(?:시술\s*후|치료\s*후)|(?:施術後|治療後)/iu],
  ["audience:life-stage", /\b(?:pregnan(?:t|cy)|postpartum|baby|infant|child|teen)\b|(?:임신|산후|아기|영유아|어린이|청소년)|(?:妊娠|産後|赤ちゃん|乳幼児|子ども|十代)/iu]
];

const generalizedAssociationPattern = /\b(?:generally|typically|usually|commonly|as\s+a\s+rule|in\s+general)\b|(?:일반적으로|대체로|통상적으로|보통은)|(?:一般的に|通常は|概して)/iu;
const explicitCausalAssociationPattern = /\b(?:because|because\s+of|due\s+to|caused\s+by|as\s+a\s+result\s+of)\b|(?:때문에|로\s*인해|에서\s*비롯|결과로)|(?:ために|によって|が原因で)/iu;

function contextAssociationsAreSupported(text: string, evidenceText: string): boolean {
  if (!text) return true;
  const outputConcepts = contextConcepts(text);
  const evidenceConcepts = contextConcepts(evidenceText);
  if (![...outputConcepts].every((concept) => evidenceConcepts.has(concept))) return false;
  if (generalizedAssociationPattern.test(text) && !generalizedAssociationPattern.test(evidenceText)) return false;
  if (explicitCausalAssociationPattern.test(text) && !explicitCausalAssociationPattern.test(evidenceText)) return false;
  return true;
}

function contextConcepts(value: string): Set<string> {
  return new Set(contextConceptPatterns
    .filter(([, pattern]) => pattern.test(value))
    .map(([concept]) => concept));
}

function descriptionEntityRepetitionWithinBudget(
  text: string,
  product: PdpProductSignal,
  field: string
): boolean {
  if (!/^(?:Product|WebPage)\.description$/u.test(field)) {
    return true;
  }
  const entity = normalizeEntityMention(product.name);
  const narrative = normalizeEntityMention(text);
  if (!entity || entity.length < 3 || !narrative.includes(entity)) {
    return true;
  }
  let mentions = 0;
  let offset = 0;
  while (offset <= narrative.length - entity.length) {
    const index = narrative.indexOf(entity, offset);
    if (index < 0) break;
    mentions += 1;
    offset = index + entity.length;
  }
  return mentions <= (field === "Product.description" ? 1 : 2);
}

function normalizeEntityMention(value: string): string {
  return value.toLocaleLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "");
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
  if (!contextAssociationsAreSupported(question, evidenceText)
    || !claimRiskIsSupported(question, evidenceText)
    || !evidenceRolesSupportClaimTopics(question, cited)) return false;
  if (faqEvidenceSelectorQuestionIsSupported(question, cited, evidenceText)) {
    return true;
  }
  const questionConcepts = semanticConcepts(question);
  const evidenceConcepts = semanticConcepts(evidenceText);
  const hasUsageEvidence = cited.some((item) => item.role === "usage");
  if (hasUsageEvidence
    && /(?:언제|어떻게|루틴|사용|바르|도포|when|how|routine|use|apply|いつ|どのよう|ルーティン|使|塗)/iu.test(question)) {
    return true;
  }
  if (usesDifferentPrimaryScript(question, evidenceText)) {
    return semanticAuditPassed && crossLanguageConceptsAreSupported(question, evidenceText);
  }

  const identityTokens = meaningfulEvidenceTokens([product.name, product.originalName ?? "", product.brand ?? "", product.category ?? ""].join(" "));
  const genericQuestionTokens = /^(?:skin|concern|customer|audience|suitable|suitability|support|use|used|using|fit|right|피부|고민|고객|대상|추천.*|적합.*|사용.*|쓰.*|바르.*|언제|어떻게|가능.*|도움.*|근거|되.*|있.*|무엇인가요|어떤가요|안전성|표기|완료|肌|悩み|顧客|対象|適し.*|使え.*|役立.*|何ですか|どんな)$/u;
  const questionTokens = meaningfulEvidenceTokens(question)
    .filter((token) => !genericQuestionTokens.test(token))
    .filter((token) => !identityTokens.some((identity) => evidenceTokensMatch(token, identity)));
  if (questionTokens.length === 0) return true;
  const evidenceTokens = meaningfulEvidenceTokens(evidenceText);
  const matched = questionTokens.filter((token) => evidenceTokens.some((source) => evidenceTokensMatch(token, source))).length;
  if (!semanticAuditPassed) return matched === questionTokens.length;
  return [...questionConcepts].every((concept) => evidenceConcepts.has(concept))
    // Questions are evidence selectors, not answer claims. After the audited
    // corrective pass, one supported factual anchor or a fully supported
    // semantic concept is sufficient; answer clauses remain strictly gated.
    && (matched >= Math.min(1, questionTokens.length) || questionConcepts.size > 0);
}

function faqEvidenceSelectorQuestionIsSupported(
  question: string,
  cited: PdpGeoAtomicEvidence[],
  evidenceText: string
): boolean {
  const asksForEvidence = /\b(?:evidence|proof|results?|measurements?|tests?|tested)\b|(?:근거|결과|측정|시험|테스트|완료\s*표기)|(?:根拠|結果|測定|試験|テスト)/iu.test(question);
  if (!asksForEvidence) return false;
  const roleSet = new Set(cited.map((item) => item.role));
  if (!["metric", "source", "faq", "description", "benefit", "effect"].some((role) => roleSet.has(role as PdpGeoEvidenceRole))) {
    return false;
  }
  const questionConcepts = semanticConcepts(question);
  const evidenceConcepts = semanticConcepts(evidenceText);
  if (![...questionConcepts].every((concept) => evidenceConcepts.has(concept))) {
    return false;
  }
  if (questionConcepts.size > 0) return true;
  const questionTokens = meaningfulEvidenceTokens(question);
  const evidenceTokens = meaningfulEvidenceTokens(evidenceText);
  return questionTokens.some((token) => evidenceTokens.some((source) => evidenceTokensMatch(token, source)));
}

/**
 * The general public-copy gate deliberately requires near-verbatim lexical
 * support. FAQ answers need one narrower exception after the model-backed
 * corrective audit because natural Korean/English buyer answers add harmless
 * connective wording and inflection. All semantic safety invariants remain
 * mandatory; only the final lexical-overlap threshold is relaxed.
 */
function faqAnswerIsSupported(
  text: string,
  evidenceIds: string[],
  evidenceById: Map<string, PdpGeoAtomicEvidence>,
  product: PdpProductSignal,
  semanticAuditPassed: boolean
): boolean {
  if (evidenceSemanticallySupportsText(text, evidenceIds, evidenceById, product, semanticAuditPassed)) {
    return true;
  }
  if (!semanticAuditPassed) {
    return false;
  }

  const cited = evidenceIds.map((id) => evidenceById.get(id)).filter((item): item is PdpGeoAtomicEvidence => Boolean(item));
  const substantive = cited.filter((item) => item.role !== "identity");
  if (substantive.length === 0) return false;
  if (substantive.every((item) => item.role === "review") && !hasReviewAttribution(text)) return false;
  if (!evidenceRolesSupportClaimTopics(text, cited)) return false;

  const evidenceText = substantive.map((item) => item.text).join(" ");
  if (!contextAssociationsAreSupported(text, evidenceText)
    || !claimRiskIsSupported(text, evidenceText)
    || !claimPolarityAndModalityArePreserved(text, evidenceText)
    || !causalIngredientBenefitLinkIsSupported(text, cited, product)) {
    return false;
  }
  if (usesDifferentPrimaryScript(text, evidenceText)) {
    return crossLanguageConceptsAreSupported(text, evidenceText);
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
  const claimConcepts = semanticConcepts(text);
  // Product/entity words in a natural direct answer are supported by the
  // cited identity atoms even though substantive claim checking intentionally
  // excludes those atoms. Include identity/category only for concept parity.
  const evidenceConcepts = semanticConcepts(`${evidenceText} ${product.name} ${product.originalName ?? ""} ${product.brand ?? ""} ${product.category ?? ""}`);
  return [...claimConcepts].every((concept) => evidenceConcepts.has(concept))
    && matched >= Math.min(2, claimTokens.length)
    // The model-backed corrective pass has already audited entailment and the
    // invariant checks above still enforce role, risk, polarity, context and
    // causal scope. Korean inflection and connective wording can otherwise
    // make a fully grounded multi-atom answer miss the old 40% lexical quota.
    && matched / claimTokens.length >= 0.25;
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
  if (!contextAssociationsAreSupported(text, evidenceText)) {
    return false;
  }
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
  if (semanticAuditPassed) {
    const claimConcepts = semanticConcepts(text);
    const evidenceConcepts = semanticConcepts(evidenceText);
    return [...claimConcepts].every((concept) => evidenceConcepts.has(concept))
      && matched >= Math.min(3, claimTokens.length)
      && matched / claimTokens.length >= 0.55;
  }
  return matched === claimTokens.length;
}

function claimPolarityAndModalityArePreserved(text: string, evidenceText: string): boolean {
  const negative = /\b(?:no|not|never|neither|without|cannot|can't|doesn't|does\s+not|do\s+not|isn't|is\s+not|aren't|are\s+not)\b|(?:않|없|아니|못하|무첨가)|(?:ない|ません|ではない|無し|なし)/iu;
  const weak = /\b(?:may|might|could|can|potentially|appears?|suggests?|helps?|supports?|designed\s+to|aims?\s+to)\b|(?:수\s*있|가능성|도움을?\s*줄|도와|돕|지원|설계)|(?:可能性|ことがある|場合がある|助け|支え|目指|設計)/iu;
  const outputIsNegative = negative.test(text);
  const outputIsWeak = weak.test(text);
  const outputMakesAssertiveClaim = /\b(?:improves?|boosts?|strengthens?|provides?|increases?|decreases?|cures?|treats?)\b|(?:개선|강화|제공|증가|감소|완화|치료|치유)(?:하|합|됩|시켜|된다고)|(?:改善|強化|提供|増加|減少|治療)(?:する|します|できる)/iu.test(text);
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
    if (sourceIsWeak && outputMakesAssertiveClaim && !outputIsWeak) return false;
  }
  return true;
}

function meaningfulEvidenceTokens(value: string): string[] {
  const stopWordValues = [
    "a", "an", "and", "are", "as", "at", "be", "by", "can", "could", "did", "do", "does", "for", "from", "has", "have", "helps", "in", "is", "it", "its", "may", "might", "of", "on", "or", "should", "that", "the", "this", "to", "will", "with", "what", "which", "when", "who", "would", "how",
    "product", "page", "pdp", "serum", "cream", "toner", "formula", "item", "information", "details", "includes", "shows", "explains", "check", "find", "main", "key", "benefit", "feature", "features", "ingredient", "ingredients",
    "제품", "상품", "페이지", "정보", "확인", "확인할", "있습니다", "합니다", "어떤", "무엇", "어떻게", "위한", "통해", "대한", "그리고", "또는", "핵심", "장점", "주요", "소개", "소개됩니다", "특징", "성분", "공식", "관련", "해당", "함께", "각각", "내용", "설명", "설명됩니다", "제시", "제시됩니다", "표기", "표기됩니다", "완료",
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
  return cited.some((item) => item.text
    .split(/[.!?。！？;；\n]+/u)
    .map(cleanText)
    .filter(Boolean)
    .some((clause) => {
      const sourceTokens = meaningfulEvidenceTokens(clause);
      const clauseMentionsIngredient = ingredientTokens.some((token) => sourceTokens.some((candidate) => evidenceTokensMatch(token, candidate)));
      const clauseMentionsBenefit = benefitTokens.some((token) => sourceTokens.some((candidate) => evidenceTokensMatch(token, candidate)));
      return clauseMentionsIngredient
        && clauseMentionsBenefit
        && explicitIngredientBenefitRelationPattern.test(clause);
    }));
}

const explicitIngredientBenefitRelationPattern = /\b(?:helps?|supports?|improves?|boosts?|strengthens?|provides?|delivers?|contributes?\s+to|based\s+on|powered\s+by|through|via)\b|\bwith\b[^.!?。！？;；\n]{0,100}\bfor\b|\bfor\b[^.!?。！？;；\n]{0,100}\bwith\b|(?:도와|돕|지원|개선|강화|높여|제공|기여|기반|통해|(?:으)?로\s+[^.!?。！？;；\n]{0,80}(?:보습|수분|장벽|탄력|진정|개선|효과|효능))|(?:助け|支え|改善|高め|与え|寄与|による|を通じ|配合で)/iu;

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
      .replace(/(?:인가요|한가요|일까요|나요|까요|습니까|입니까)$/u, "")
      .replace(/(?:입니다|됩니다|합니다|드립니다|있습니다|없습니다|했습니다|되었습니다|줍니다)$/u, "")
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
