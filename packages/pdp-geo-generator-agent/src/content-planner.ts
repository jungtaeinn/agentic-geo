import {
  isConcreteUsageAction,
  isRawPageTextBlock,
} from "./contracts/usage-contract";
import { containsSerializedMetadata } from "./contracts/certification-contract";
import { z } from "zod";
import { inferPdpEvidenceRoles, isCompressedMultiClaimMetricBlock, KOREAN_COPULA_ENDING_FORMS } from "./normalize";
import { createPlanningPrompt } from "./prompts/content-planning";
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
  PdpGeoPlannedHowTo,
  PdpGeoPlannedHowToStep,
  PdpGeoTokenUsage,
  PdpProductSignal,
  PdpSemanticMetricClaim
} from "./types";
import { mergeTokenUsage } from "./token-usage";

const PLANNING_TIMEOUT_MS = 300_000;
/**
 * Evidence atoms carried into the planning prompt.
 *
 * Measured on the four live PDP fixtures: ledgers hold 86, 96, 110 and 153
 * atoms, so 120 bound on exactly one product — and there it dropped 16
 * ingredient atoms at confidence 0.95, including that product's differentiating
 * formula facts ("하이드로겔 플로팅 포뮬러 기술", "피부지질 유사구조(층판형 구조)").
 * Those are the sentences a generative engine can cite; losing them to a budget
 * is the opposite of the goal.
 *
 * Rebalancing the role quotas instead was measured and rejected: moving slots
 * from `source` to `ingredient` recovered 8 ingredient atoms but sacrificed
 * source atoms that were themselves citable ("각질량 82% 즉시 감소", "독일 더마
 * 테스트 EXCELLENT 등급"). It reshuffles rather than gains.
 *
 * The cost is paid only where the evidence exists: at 160 the three smaller
 * fixtures produce a byte-identical prompt, and the 153-atom product grows its
 * user payload by 6,518 characters (+25.9%).
 */
const DEFAULT_MAX_EVIDENCE_ITEMS = 160;
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
/**
 * 원장이 원자를 세는 키.
 *
 * `toLowerCase`로 눕힌다 — `toLocaleLowerCase`는 런타임 로케일에 따라 결과가
 * 달라져(터키어에서 `I`는 `ı`가 된다) 같은 근거가 두 키를 만들 수 있다. 키는
 * 로케일에 의존해선 안 된다.
 *
 * 구분자는 역할과 본문 사이에 본문에 나타날 수 없는 문자를 둔다.
 */
export function pdpGeoEvidenceKey(role: string, text: string): string {
  return `${role}\u0000${text.toLowerCase()}`;
}

export function createPdpGeoEvidenceLedger(product: PdpProductSignal, locale: PdpGeoLocale): PdpGeoAtomicEvidence[] {
  const items: PdpGeoAtomicEvidence[] = [];
  // Maps a dedup key to the index of its atom in `items`, so a later duplicate
  // that carries OCR image provenance can be merged into the already-recorded
  // atom instead of being silently dropped by the first-wins rule. The atom's
  // own identity (id/sourcePath/role/confidence) never changes on a merge —
  // sourcePath is a ranking key read elsewhere (planningEvidenceSpecificity,
  // selectPlanningReviewSituations' regex), not just a label.
  const seen = new Map<string, number>();
  const add = (
    role: PdpGeoEvidenceRole,
    text: unknown,
    sourcePath: string,
    confidence: number,
    provenance?: { imageUrls?: string[]; ocrConfidence?: number }
  ) => {
    const value = cleanText(typeof text === "string" || typeof text === "number" ? String(text) : "");
    if (!value) return;
    const key = pdpGeoEvidenceKey(role, value);
    const existingIndex = seen.get(key);
    const existing = existingIndex !== undefined ? items[existingIndex] : undefined;
    if (existingIndex !== undefined && existing) {
      if (!provenance || (!provenance.imageUrls && provenance.ocrConfidence === undefined)) return;
      const mergedImageUrls = mergeProvenanceImageUrls(existing.imageUrls, provenance.imageUrls);
      const mergedOcrConfidence = mergeProvenanceOcrConfidence(existing.ocrConfidence, provenance.ocrConfidence);
      items[existingIndex] = {
        ...existing,
        ...(mergedImageUrls ? { imageUrls: mergedImageUrls } : {}),
        ...(mergedOcrConfidence !== undefined ? { ocrConfidence: mergedOcrConfidence } : {})
      };
      return;
    }
    seen.set(key, items.length);
    items.push({
      id: `ev-${role}-${stableHash(`${sourcePath}\u0000${value}`)}`,
      role,
      text: value,
      sourcePath,
      locale,
      productScope: "product",
      confidence,
      ...(provenance?.imageUrls ? { imageUrls: provenance.imageUrls } : {}),
      ...(provenance?.ocrConfidence !== undefined ? { ocrConfidence: provenance.ocrConfidence } : {})
    });
  };
  const addAnalyzed = (
    text: unknown,
    sourcePath: string,
    confidence: number,
    provenance?: { imageUrls?: string[]; ocrConfidence?: number }
  ) => {
    const value = cleanText(typeof text === "string" || typeof text === "number" ? String(text) : "");
    if (!value) return;
    const inference = inferPdpEvidenceRoles(value);
    const role = evidenceRoleFromAnalysis(inference.primaryRole);
    add(role, value, sourcePath, confidenceForAnalyzedRole(confidence, role), provenance);
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
  product.semanticFacts?.evidenceSentences.forEach((value, index) => addAnalyzed(value, `product.semanticFacts.evidenceSentences[${index}]`, 0.9));
  product.semanticFacts?.metricClaims.forEach((claim, index) => {
    const structuredMetric = formatMetricClaimEvidenceAtom(claim);
    const claimProvenance = claim.imageUrls ? { imageUrls: claim.imageUrls } : undefined;
    add("metric", structuredMetric, `product.semanticFacts.metricClaims[${index}]`, 0.98, claimProvenance);
    const sourceSentence = claim.sourceText || claim.sentence;
    if (sourceSentence && cleanText(sourceSentence) !== cleanText(structuredMetric)) {
      add("source", sourceSentence, `product.semanticFacts.metricClaims[${index}].sourceText`, 0.9, claimProvenance);
    }
  });
  product.semanticFacts?.ingredientBenefitLinks.forEach((link, index) => {
    const linkProvenance = link.imageUrls ? { imageUrls: link.imageUrls } : undefined;
    add("ingredient", link.ingredient, `product.semanticFacts.ingredientBenefitLinks[${index}].ingredient`, 0.94, linkProvenance);
    add("source", link.sourceText || link.sentence || [link.ingredient, link.benefit, link.effect].filter(Boolean).join("; "), `product.semanticFacts.ingredientBenefitLinks[${index}]`, 0.92, linkProvenance);
  });
  product.semanticFacts?.citations?.forEach((citation, index) => {
    const bibliographic = [
      citation.type,
      citation.title,
      citation.publisher,
      citation.author,
      citation.publishedAt,
      citation.url,
      citation.finding
    ].filter(Boolean).join("; ");
    const citationProvenance = citation.imageUrls ? { imageUrls: citation.imageUrls } : undefined;
    add("source", citation.sourceText || bibliographic, `product.semanticFacts.citations[${index}]`, 0.98, citationProvenance);
  });
  product.sourceTexts.forEach((value, index) => {
    const sourcePath = `product.sourceTexts[${index}]`;
    const meta = product.sourceTextMeta?.[value];
    const provenance = meta?.imageUrls || meta?.ocrConfidence !== undefined
      ? { imageUrls: meta?.imageUrls, ocrConfidence: meta?.ocrConfidence }
      : undefined;
    if (isReviewDerivedUsageText(value, product)) {
      add("review", value, sourcePath, 0.82, provenance);
      return;
    }
    // A serialized key/value string is retrieval context, never a benefit or
    // effect claim; the normalizer already promoted its parsed atomic values
    // into the role-correct product fields above.
    if (containsSerializedMetadata(value)) {
      add("source", value, sourcePath, 0.72, provenance);
      return;
    }
    addAnalyzed(value, sourcePath, 0.72, provenance);
  });

  return items;
}

/** Unions two atoms' OCR image lineages, preserving order and dropping duplicates. */
function mergeProvenanceImageUrls(existing: string[] | undefined, incoming: string[] | undefined): string[] | undefined {
  if (!incoming || incoming.length === 0) return existing;
  if (!existing || existing.length === 0) return incoming;
  const merged = [...existing];
  for (const url of incoming) {
    if (!merged.includes(url)) merged.push(url);
  }
  return merged;
}

/** The transcription confidence a merged atom inherits is the weaker of its sources. */
function mergeProvenanceOcrConfidence(existing: number | undefined, incoming: number | undefined): number | undefined {
  if (existing === undefined) return incoming;
  if (incoming === undefined) return existing;
  return Math.min(existing, incoming);
}

function evidenceRoleFromAnalysis(role: ReturnType<typeof inferPdpEvidenceRoles>["primaryRole"]): PdpGeoEvidenceRole {
  // Safety is intentionally kept under source because the public evidence
  // contract distinguishes completed tests/cautions from customer outcomes.
  return role === "safety" ? "source" : role;
}

/**
 * Joins a metric value and unit without duplicating the unit — source values
 * frequently already carry it (value "100%", unit "%"), which previously
 * rendered as "100%%" in public copy and ledger atoms.
 */
function joinMetricValueAndUnit(value: string | undefined, unit: string | undefined): string {
  const trimmedValue = typeof value === "string" ? value.trim() : "";
  const trimmedUnit = typeof unit === "string" ? unit.trim() : "";
  if (!trimmedValue) {
    return trimmedUnit;
  }
  if (!trimmedUnit || trimmedValue.endsWith(trimmedUnit)) {
    return trimmedValue;
  }
  return `${trimmedValue}${trimmedUnit}`;
}

function confidenceForAnalyzedRole(base: number, role: PdpGeoEvidenceRole): number {
  // A classified atom is more useful than an undifferentiated source block,
  // but it must remain below explicitly mapped/structured product fields.
  return role === "source" ? base : Math.min(0.89, base + 0.1);
}

function formatMetricClaimEvidenceAtom(claim: PdpSemanticMetricClaim): string {
  const outcome = [claim.label, claim.subject, claim.metric].find((value) => typeof value === "string" && value.trim())?.trim();
  const measuredValue = joinMetricValueAndUnit(claim.value, claim.unit);
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

const TRANSIENT_PLANNING_RETRY_DELAY_MS = 750;

/**
 * A fast-failing transport error (fetch/socket reset, DNS, 429/5xx) is worth
 * one retry: a single network blip otherwise silently downgrades the whole
 * run to the conservative renderer. Timeouts and aborts are excluded — the
 * planning call already waits minutes, and retrying a hang doubles it.
 */
function isTransientPlanningTransportError(error: unknown): boolean {
  const causeMessage = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  const message = error instanceof Error ? `${error.name} ${error.message} ${causeMessage}` : String(error);
  if (/abort|timed?\s*out|timeout/i.test(message)) {
    return false;
  }
  return /fetch failed|network|socket|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR|too many requests|rate limit|status\s*(?:429|5\d\d)|(?:^|[^\d])(?:429|502|503|504)(?:[^\d]|$)|server error|service unavailable|bad gateway/i.test(message);
}

async function planContentWithTransientRetry(
  planner: PdpGeoContentPlanner,
  request: PdpGeoContentPlanningRequest
): Promise<{ result: PdpGeoContentPlanningResult; recoveryWarnings: string[] }> {
  try {
    return { result: await planner.planContent(request), recoveryWarnings: [] };
  } catch (error) {
    if (!isTransientPlanningTransportError(error)) {
      throw error;
    }
    const firstMessage = error instanceof Error ? error.message : String(error);
    await new Promise((resolve) => setTimeout(resolve, TRANSIENT_PLANNING_RETRY_DELAY_MS));
    return {
      result: await planner.planContent(request),
      recoveryWarnings: [`Semantic planning recovered after one transient transport retry (first attempt: ${firstMessage}).`]
    };
  }
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
    const { result: initialResult, recoveryWarnings } = await planContentWithTransientRetry(resolved.planner, request);
    let usage = initialResult.usage;
    let plannerWarnings = [...recoveryWarnings, ...(initialResult.warnings ?? [])];
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
    const degraded = `DEGRADED_MODE: Semantic content planning was unavailable (${message}); the conservative source-backed renderer produced public copy without an evidence-bound plan.`;
    return {
      plan: { ...conservative, warnings: [...conservative.warnings, message, degraded] },
      evidence: [
        { field: "content.plan", source: "llm", value: `Semantic planning failed closed: ${message}` },
        { field: "content.plan", source: "llm", value: degraded }
      ],
      warnings: [message, degraded],
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
  const directUsageSourceValues = request.product.usage
    .filter((value) => !isReviewDerivedUsageText(value, request.product));
  const semanticUsageSteps = uniqueText(request.product.semanticFacts?.usageSteps ?? [])
    .filter(isConcreteUsageAction)
    .filter((value) => !isReviewDerivedUsageText(value, request.product));
  const directUsageSteps = uniqueText(directUsageSourceValues).filter(isConcreteUsageAction);
  const sourceTextUsageSteps = uniqueText(request.product.sourceTexts)
    .filter((value) => inferPdpEvidenceRoles(value).roles.includes("usage"))
    .filter(isConcreteUsageAction)
    .filter((value) => !isRawPageTextBlock(value))
    .filter((value) => !isReviewDerivedUsageText(value, request.product));
  const explicitDirectSequence = extractExplicitUsageSequence(directUsageSourceValues);
  const explicitSourceTextSequence = extractExplicitUsageSequence(request.product.sourceTexts
    .filter((value) => inferPdpEvidenceRoles(value).roles.includes("usage"))
    .filter((value) => !isRawPageTextBlock(value))
    .filter((value) => !isReviewDerivedUsageText(value, request.product)));
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
          ? directUsageSteps
          : sourceTextUsageSteps.length === 1
            ? sourceTextUsageSteps
            : sourceTextUsageSteps.length > 1
              ? sourceTextUsageSteps
              : explicitSemanticSequence.length >= 2
                ? explicitSemanticSequence
                : []).slice(0, 6);
  const sourceOrderIsExplicit = usageSteps.length >= 2 && (
    explicitDirectSequence.length >= 2
    || explicitSourceTextSequence.length >= 2
    || (!hasDirectUsageEvidence && sourceTextUsageSteps.length === 0 && explicitSemanticSequence.length >= 2)
  );
  // Documented usage is always publishable, but only an explicitly ordered
  // source may become a multi-step procedure. Unmarked actions collapse into a
  // single step so the source order is never invented.
  const orderedStepTexts = sourceOrderIsExplicit || usageSteps.length <= 1
    ? usageSteps
    : [joinUnorderedUsageActions(usageSteps)];
  const steps = orderedStepTexts.map((text, index): PdpGeoPlannedHowToStep => ({
    position: index + 1,
    // A truncated copy of `text` is not a distinct label, it is the same
    // sentence twice under different field names. Leave name blank so the
    // schema renderer derives a real short step title instead.
    name: "",
    text,
    evidenceIds: matchingEvidenceIds(text, usageEvidence)
  })).filter((step) => step.evidenceIds.length > 0);
  const eligible = steps.length === orderedStepTexts.length && steps.length >= 1;
  const collapsedFromUnorderedNotes = !sourceOrderIsExplicit && usageSteps.length > 1;
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
      ordered: eligible && !collapsedFromUnorderedNotes,
      goal: eligible ? createHowToGoal(request.product.name, request.locale) : "",
      steps: eligible ? steps : [],
      evidenceIds: eligible ? uniqueText(steps.flatMap((step) => step.evidenceIds)) : [],
      confidence: eligible ? 0.75 : 0.85,
      omitReason: eligible ? "" : "The source does not contain a concrete source-backed customer usage action."
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
    let text = normalizePlannerCustomerCaveat(cleanText(field.text), request.locale);
    const suppliedEvidenceIds = sanitizeIds(field.evidenceIds);
    let evidenceIds = isPublicDescriptionField(name)
      ? recoverDescriptionEvidenceIds(text, suppliedEvidenceIds, request.evidenceLedger)
      : suppliedEvidenceIds;
    // Entity repetition and field role are properties of the paragraph, so a
    // failure there is not something the per-unit audit could repair. Fluency
    // is not: it is judged sentence by sentence, and the unit audit already
    // applies the same check to every unit it keeps. Requiring it of the whole
    // text first meant one unfluent closing sentence suppressed the audit and
    // dropped the entire description — including the study citation and the
    // attributed review line the contract asks for — when dropping that one
    // sentence was the available repair.
    const canApplyPartialDescriptionAudit = descriptionEntityRepetitionWithinBudget(text, request.product, name)
      && descriptionFieldRoleIsSupported(text, request.product, name);
    const originalCitedEvidenceText = evidenceIds.map((id) => evidenceById.get(id)?.text ?? "").join(" ");
    const originalDescriptionPassesAudit = evidenceIds.length > 0
      && numbersAreSupported(text, evidenceIds, evidenceById, request.product.name)
      && isTargetLocaleCopy(text, request.locale)
      && isCoherentPublicCopy(text, "statement")
      && contextAssociationsAreSupported(text, originalCitedEvidenceText)
      && descriptionEvidenceSemanticallySupportsText(text, evidenceIds, evidenceById, request.product, semanticAuditPassed);
    let unitsPassedSemanticAudit = false;
    if (field.include
      && semanticAuditPassed
      && isPublicDescriptionField(name)
      && canApplyPartialDescriptionAudit
      && !originalDescriptionPassesAudit) {
      const audited = retainAuditedDescriptionUnits({
        text,
        ledger: request.evidenceLedger,
        evidenceById,
        product: request.product,
        locale: request.locale,
        field: name
      });
      // Every sentence the audit keeps has passed the same per-unit judgement
      // on its own evidence, so how many of its neighbours failed says nothing
      // about it. A majority-drop rule read that number anyway and discarded
      // the whole field, which does not fall back to a composed paragraph: the
      // renderer then republishes the source description verbatim — one
      // marketing line, source typo included, no composition, no measurement,
      // no attributed review wording. Publishing the sentences the ledger backs
      // is the better of the two available outcomes, and the paragraph-scoped
      // checks below still reject a remnant that is not usable public copy.
      const salvageable = audited.text.length > 0;
      if (audited.droppedUnits.length > 0 && salvageable) {
        gateWarnings.push(...audited.droppedUnits.map((unit) =>
          `${name} removed unsupported claim unit "${truncate(unit, 140)}" while retaining supported sentences.`));
      }
      if (salvageable) {
        text = audited.text;
        evidenceIds = audited.evidenceIds;
      }
      unitsPassedSemanticAudit = salvageable;
    }
    const citedEvidenceText = evidenceIds.map((id) => evidenceById.get(id)?.text ?? "").join(" ");
    const numbersSupported = numbersAreSupported(text, evidenceIds, evidenceById, request.product.name);
    const localeSupported = isTargetLocaleCopy(text, request.locale);
    const coherent = isCoherentPublicCopy(text, "statement");
    const contextSupported = contextAssociationsAreSupported(text, citedEvidenceText);
    const entityRepetitionSupported = descriptionEntityRepetitionWithinBudget(text, request.product, name);
    const fieldRoleSupported = descriptionFieldRoleIsSupported(text, request.product, name);
    const fluencySupported = descriptionFluencyIsSupported(text, name);
    // The per-unit audit already judged every retained sentence against the
    // evidence covering that sentence. Re-judging the paragraph against the
    // union of those atoms answers a different question and gave a different
    // answer: a sentence supported by its own atoms could fail once pooled
    // with the rest, so the whole field was dropped even though no sentence
    // had been found unsupported. Sentence-level support stands; the checks
    // below that are genuinely paragraph-scoped still run on the kept text.
    const semanticEvidenceSupported = unitsPassedSemanticAudit
      || (isPublicDescriptionField(name)
        ? descriptionEvidenceSemanticallySupportsText(
          text,
          evidenceIds,
          evidenceById,
          request.product,
          semanticAuditPassed
        )
        : evidenceSemanticallySupportsText(
          text,
          evidenceIds,
          evidenceById,
          request.product,
          semanticAuditPassed,
          0.5
        ));
    const supported = text.length > 0
      && evidenceIds.length > 0
      && numbersSupported
      && localeSupported
      && coherent
      && contextSupported
      && entityRepetitionSupported
      && fieldRoleSupported
      && fluencySupported
      && semanticEvidenceSupported;
    if (field.include && !supported) gateWarnings.push(`${name} was omitted because its text, locale, or cited evidence did not pass the evidence gate.`);
    if (field.include && text && !contextSupported) {
      gateWarnings.push(`QUERY_HYPOTHESIS_ONLY: ${name} context "${truncate(text, 160)}" was omitted from public copy because its seasonal, occasion, timing, general-association, or causal context was not explicit in the cited product evidence.`);
    }
    if (field.include && text && !entityRepetitionSupported) {
      gateWarnings.push(`${name} was omitted because it mechanically repeats the full product entity instead of maintaining one connected buyer narrative.`);
    }
    if (field.include && text && !fieldRoleSupported) {
      gateWarnings.push(`${name} was omitted because it did not preserve the Product/WebPage entity role or used a stiff page wrapper.`);
    }
    if (field.include && text && !fluencySupported) {
      gateWarnings.push(`${name} was omitted because it retained an OCR artifact, dependent predicate fragment, report-style test note, or passive review list instead of natural public copy.`);
    }
    if (field.include && text && !numbersSupported) {
      gateWarnings.push(`${name} was omitted because ${numericSupportFailureReason(text, evidenceIds, evidenceById, request.product.name)}.`);
    }
    if (field.include && text && !localeSupported) {
      gateWarnings.push(`${name} was omitted because it did not match the requested locale.`);
    }
    if (field.include && text && !coherent) {
      gateWarnings.push(`${name} was omitted because it was not a coherent public-copy statement.`);
    }
    if (field.include && text && !semanticEvidenceSupported) {
      const reason = isPublicDescriptionField(name)
        ? descriptionSemanticEvidenceFailureReason(text, evidenceIds, evidenceById, request.product, semanticAuditPassed)
        : semanticEvidenceFailureReason(text, evidenceIds, evidenceById, request.product, semanticAuditPassed, 0.5);
      gateWarnings.push(`${name} was omitted because ${reason}.`);
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
      const answer = normalizePlannerCustomerCaveat(cleanText(item.answer), request.locale);
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
        ["numeric-relationship", numbersAreSupported(answer, evidenceIds, evidenceById, request.product.name)],
        ["question-locale", isTargetLocaleCopy(question, request.locale)],
        ["answer-locale", isTargetLocaleCopy(answer, request.locale)],
        ["question-coherence", isCoherentPublicCopy(question, "question")],
        ["answer-coherence", isCoherentPublicCopy(answer, "statement")],
        // A planned answer may quote a measurement, but not by pasting the
        // panel it was printed on. The normalizer already decides what a
        // before/after OCR panel is; the same predicate decides it here, so a
        // block the metric gate refuses as one claim cannot re-enter public
        // copy through an FAQ answer instead.
        ["answer-transcription", !isCompressedMultiClaimMetricBlock(answer)],
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
        && numbersAreSupported(candidate.text, candidate.evidenceIds, evidenceById, request.product.name)
        && evidenceSemanticallySupportsText(candidate.text, candidate.evidenceIds, evidenceById, request.product, semanticAuditPassed);
      if (raw.howTo.eligible && !supported) {
        gateWarnings.push(`HowTo step ${step.position} was omitted because it was not an actionable, locale-compatible usage step supported by its cited evidence.`);
      }
      return { ...candidate, supported };
    })
    .filter((step) => step.supported)
    // A missing model-provided name should stay blank rather than fall back
    // to a truncated copy of `text`, which is not a distinct step label.
    .map((step, index) => ({ ...step, position: index + 1 }))
    .filter((step, index, items) => items.findIndex((candidate) => usageActionsAreSemanticallyEquivalent(candidate.text, step.text)) === index)
    .map(({ supported: _supported, ...step }) => step)
    .slice(0, 8);
  const howToEligible = raw.howTo.eligible
    && cleanText(raw.howTo.goal).length > 0
    && steps.length >= 1
    && hasSourceOrderProvenance(steps, evidenceById);
  // The model reads the source content and decides whether it is clearly a
  // usage direction. Structure stays source-faithful: an explicitly ordered
  // source keeps its procedure, anything else is published as one step.
  const modelHowTo: PdpGeoPlannedHowTo | undefined = howToEligible
    ? {
        ...raw.howTo,
        goal: cleanText(raw.howTo.goal),
        ordered: raw.howTo.ordered && steps.length > 1,
        steps: steps.length > 1 && !raw.howTo.ordered
          ? [{ position: 1, name: "", text: joinUnorderedUsageActions(steps.map((step) => step.text)), evidenceIds: uniqueText(steps.flatMap((step) => step.evidenceIds)) }]
          : steps,
        evidenceIds: sanitizeIds(raw.howTo.evidenceIds),
        omitReason: ""
      }
    : undefined;
  const plannedHowTo = sourceFaithfulHowTo.eligible ? sourceFaithfulHowTo : modelHowTo ?? sourceFaithfulHowTo;
  if (raw.howTo.eligible && !plannedHowTo.eligible) gateWarnings.push("HowTo was omitted because it did not have a goal and at least one source-backed customer usage action.");

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
        && numbersAreSupported(text, candidate.evidenceIds, evidenceById, request.product.name)
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
    // Usage structure is source-faithful. The model may reason about
    // applicability and compose a single gated step when normalization found
    // no usage, but it cannot split, reorder, or invent a documented procedure.
    howTo: plannedHowTo,
    cep,
    warnings: [...raw.warnings.map(cleanText).filter(Boolean), ...gateWarnings]
  };
  return { plan, gateWarnings };
}

function retainAuditedDescriptionUnits(input: {
  text: string;
  ledger: PdpGeoAtomicEvidence[];
  evidenceById: Map<string, PdpGeoAtomicEvidence>;
  product: PdpProductSignal;
  locale: PdpGeoLocale;
  field: string;
}): { text: string; evidenceIds: string[]; droppedUnits: string[] } {
  // Field-level citation recovery remains available for a model that omitted a
  // matching ID. Each retained sentence is still narrowed to its top matches.
  const citedLedger = input.ledger;
  const accepted: Array<{ text: string; evidenceIds: string[] }> = [];
  const droppedUnits: string[] = [];
  for (const unit of descriptionClaimUnits(input.text)) {
    const evidenceIds = recoverDescriptionEvidenceIds(unit, [], citedLedger);
    const cited = evidenceIds
      .map((id) => input.evidenceById.get(id))
      .filter((item): item is PdpGeoAtomicEvidence => Boolean(item));
    const citedText = cited.map((item) => item.text).join(" ");
    const identitySupported = descriptionIdentityUnitIsSupported(unit, cited, input.product)
      || descriptionPageIntroductionUnitIsSupported(unit, cited, input.product);
    const supported = evidenceIds.length > 0
      && numbersAreSupported(unit, evidenceIds, input.evidenceById, input.product.name)
      && isTargetLocaleCopy(unit, input.locale)
      && isCoherentPublicCopy(unit, "statement")
      && contextAssociationsAreSupported(unit, citedText)
      && descriptionFluencyIsSupported(unit, input.field)
      && (identitySupported || descriptionEvidenceSemanticallySupportsText(
        unit,
        evidenceIds,
        input.evidenceById,
        input.product,
        true
      ));
    if (supported) accepted.push({ text: unit, evidenceIds });
    else droppedUnits.push(unit);
  }
  return {
    text: accepted.map((item) => item.text).join(" "),
    evidenceIds: uniqueText(accepted.flatMap((item) => item.evidenceIds)),
    droppedUnits
  };
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
  if (steps.length < 1) return false;
  const cited = uniqueText(steps.flatMap((step) => step.evidenceIds))
    .map((id) => evidenceById.get(id))
    .filter((item): item is PdpGeoAtomicEvidence => Boolean(item));
  const citedUsage = cited
    .filter((item) => item.role === "usage")
    .map((item) => item.text);
  if (steps.length === 1) {
    return citedUsage.some((value) => usageActionsAreSemanticallyEquivalent(steps[0]?.text ?? "", value));
  }
  const explicitSourceSequence = extractExplicitUsageSequence(citedUsage);
  if (explicitSourceSequence.length !== steps.length) return false;
  return steps.every((step, index) => usageActionsAreSemanticallyEquivalent(
    step.text,
    explicitSourceSequence[index] ?? ""
  ));
}

function extractOrderedUsageSegments(value: string): string[] {
  const numbered = extractSequentialOrdinalSegments(value);
  if (numbered.length >= 2) {
    return numbered.filter(isConcreteUsageAction);
  }
  const clauses = cleanText(value).split(/(?<=[.!?。！？;；])\s+/u).map(cleanText).filter(Boolean);
  return extractLexicallyMarkedUsageSequence(clauses);
}

/**
 * 서수 마커는 1부터 이어지는 수열이다. 아무 숫자나 마커로 읽으면 상품명의
 * "365"나 용량의 "200"이 다음 단계의 시작으로 오인되고, 그 앞에 전사된 패키지
 * 라벨이 단계 본문으로 발행된다. 그래서 다음 마커는 "다음 서수"만 찾는다.
 *
 * 첫 마커가 전사에서 떨어져 나간 경우("사용법 1"이 제목으로 분리) 남아 있는
 * "2"가 원문이 번호를 매겼다는 증거이므로, 그 앞의 문장을 1단계로 되살린다.
 * 되살릴 수 있는 첫 마커가 정확히 2인 이유는, 앞선 조각 하나가 대신할 수 있는
 * 빠진 단계가 하나뿐이기 때문이다.
 */
function extractSequentialOrdinalSegments(value: string): string[] {
  const text = cleanText(value);
  const findMarker = (ordinal: number, from: number) => {
    const match = new RegExp(`(?:^|\\s)(?:step\\s*)?${ordinal}\\s*(?:단계|段階)?[.):、]?\\s+`, "iu").exec(text.slice(from));
    return match?.index === undefined
      ? undefined
      : { start: from + match.index, contentStart: from + match.index + match[0].length };
  };

  const leadingMarker = findMarker(1, 0);
  const firstMarker = leadingMarker ?? findMarker(2, 0);
  if (!firstMarker) {
    return [];
  }

  const segments: string[] = [];
  if (!leadingMarker) {
    const lead = cleanText(text.slice(0, firstMarker.start));
    if (!isConcreteUsageAction(lead)) {
      return [];
    }
    segments.push(lead);
  }

  let cursor = firstMarker.contentStart;
  for (let ordinal = (leadingMarker ? 1 : 2) + 1; ; ordinal += 1) {
    const nextMarker = findMarker(ordinal, cursor);
    segments.push(closeAtFirstSentenceEnd(text.slice(cursor, nextMarker ? nextMarker.start : undefined)));
    if (!nextMarker) {
      break;
    }
    cursor = nextMarker.contentStart;
  }

  return segments.filter(Boolean);
}

/**
 * 한 단계는 자기 문장에서 끝난다. 마커 사이에 전사된 주변 텍스트(패키지 라벨,
 * 캡션)는 그 문장 뒤에 붙어 오므로, 첫 문장 종결에서 잘라 단계 본문에서 뺀다.
 */
function closeAtFirstSentenceEnd(value: string): string {
  const text = cleanText(value);
  const sentenceEnd = text.search(/[.!?。！？](?:\s|$)/u);
  return sentenceEnd >= 0 ? cleanText(text.slice(0, sentenceEnd + 1)) : text;
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
  const steps = dedupeRewordedNumberedSteps(numbered);
  if (steps.length < 2
    || steps[0]?.position !== 1
    || !steps.every((item, index) => item.position === index + 1)) {
    return [];
  }
  return uniqueText(steps.map((item) => item.text));
}

/**
 * 같은 번호에 같은 동작이 두 어투로 실린 경우 하나로 접는다.
 *
 * 한 상품 페이지에서 같은 단계가 두 번 들어오는 일은 흔하다 — 분류 모델이 다시
 * 쓴 문장("미세 분사합니다")과 원문 어투("미세 분사를 합니다")가 각각 번호를
 * 달고 오기 때문이다. 그러면 서수가 1,1,2,2가 되어 연속성 검사가 실패하고,
 * 원문이 분명히 번호를 매긴 절차가 한 단계로 뭉친다(1027 실측: 한 단계에 세
 * 문장이 이어붙었다).
 *
 * 접는 것은 **같은 번호이면서 같은 동작일 때만**이다. 같은 번호에 서로 다른
 * 동작이 실려 있으면 원문의 순서를 알 수 없으므로, 그대로 남겨 연속성 검사가
 * 실패하게 둔다 — 없는 순서를 지어내는 것보다 하나의 노트로 발행하는 편이 낫다.
 */
function dedupeRewordedNumberedSteps(
  numbered: Array<{ position: number; text: string; sourceIndex: number }>
): Array<{ position: number; text: string; sourceIndex: number }> {
  const kept: Array<{ position: number; text: string; sourceIndex: number }> = [];
  for (const item of numbered) {
    const sameStep = kept.some((existing) =>
      existing.position === item.position && usageActionsAreSemanticallyEquivalent(existing.text, item.text));
    if (!sameStep) {
      kept.push(item);
    }
  }
  return kept;
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

/**
 * Merges usage actions that the source never ordered into one step, dropping
 * semantically duplicated instructions so the merged text reads as a single
 * direction rather than a synthetic procedure.
 */
function joinUnorderedUsageActions(actions: string[]): string {
  const merged: string[] = [];
  for (const action of actions) {
    const text = cleanText(action);
    if (!text || merged.some((kept) => usageActionsAreSemanticallyEquivalent(kept, text))) continue;
    merged.push(text);
  }
  return merged
    .map((text) => /[.!?。！？]$/u.test(text) ? text : `${text}.`)
    .join(" ")
    .trim();
}

function usageActionsAreSemanticallyEquivalent(left: string, right: string): boolean {
  const leftKey = usageActionSemanticKey(left);
  const rightKey = usageActionSemanticKey(right);
  return Boolean(leftKey) && (leftKey === rightKey || leftKey.includes(rightKey) || rightKey.includes(leftKey));
}

function usageActionSemanticKey(value: string): string {
  return normalizeForMatch(value)
    .replace(/아침\s*(?:과|와|또는|[/,·])?\s*저녁|morning\s*(?:and|or|[/,])?\s*(?:evening|night)/giu, "morning night")
    .replace(/피부\s*결/gu, "피부결")
    .replace(/펴\s*(?:바르는\s*것이다|바릅니다|발라\s*주세요|바르세요|바르십시오|바른다)/gu, "펴바르")
    .replace(/(?:적당량|소량)(?:의\s*내용물)?(?:을|를)?\s*(?:덜어|취해)?/gu, " ")
    .replace(/\b(?:an?\s+)?(?:appropriate|small)\s+amount\b/giu, " ")
    .replace(/(?:부드럽게|고르게|충분히|gently|evenly|thoroughly)/giu, " ")
    // 경동사 구문을 한 형태로 모은다. "분사를 합니다"와 "분사합니다"는 같은
    // 동작인데, 목적격 조사와 띄어쓰기만 다른 두 표기를 다른 동작으로 세면
    // 원문이 번호를 매긴 절차가 서수 중복으로 무너진다(1027 실측).
    .replace(/([가-힣]+)(?:을|를)\s*(하|합|해|했)/gu, "$1$2")
    .replace(/([가-힣]+)\s+(하|합|해|했)/gu, "$1$2")
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

/**
 * Numbers that appear as part of the product's own name ("모이베리어 365
 * 크림 미스트") are identity notation, not numeric claims: the name is
 * verified identity from the normalized input, so public copy may repeat it
 * without a citing atom. Masking name occurrences before token extraction
 * keeps genuinely claimed numbers fully gated — a unit-bearing claim such as
 * "365일 보습" tokenizes with its unit and is untouched by this mask.
 */
function maskProductIdentityMentions(text: string, productName: string): string {
  const trimmed = productName.trim();
  if (!trimmed) return text;
  const escaped = trimmed
    .split(/\s+/u)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s*");
  // A product name that starts or ends on a bare digit run (e.g. "10", "365
  // 크림") must not splice into a larger unrelated number that happens to sit
  // flush against it in the text (e.g. matching "10" inside "100명" and
  // leaving a forged "0명"). Guarding both ends on \p{N} — the same digit
  // class NUMERIC_CLAIM_TOKEN_PATTERN already boundary-checks against —
  // keeps the mask from ever landing mid-digit-run.
  const guarded = `(?<!\\p{N})${escaped}(?!\\p{N})`;
  return text.replace(new RegExp(guarded, "giu"), " ");
}

export function numbersAreSupported(text: string, evidenceIds: string[], evidenceById: Map<string, PdpGeoAtomicEvidence>, productName: string): boolean {
  const claimText = maskProductIdentityMentions(text, productName);
  // Preserve atomic-evidence boundaries. Joining atoms with plain whitespace
  // creates one artificial numeric clause and makes valid FAQ answers fail
  // when a cited atom also contains sample dates or other scoped numbers.
  const evidenceText = evidenceIds.map((id) => evidenceById.get(id)?.text ?? "").filter(Boolean).join(". ");
  // Checked ahead of the token short-circuit below: a claim whose only
  // number is a calendar date ("2022년 12월 19일 기준으로…") tokenizes to
  // zero non-date numeric tokens once scanCalendarDates lifts the date out,
  // and returning true before ever checking the date itself would let a
  // fabricated or evidence-mismatched date pass with no verification at all.
  if (!calendarDatesAreSupported(claimText, evidenceText)) return false;
  const tokens = numericClaimTokens(claimText);
  if (tokens.length === 0) return true;
  const evidenceTokens = new Set(numericClaimTokens(evidenceText));
  if (!tokens.every((token) => evidenceTokens.has(token))) return false;
  if (!numericRelationshipsAreSupported(claimText, evidenceText, evidenceIds, evidenceById)) return false;
  if (!numericTokensHaveConfidentSupport(claimText, evidenceIds, evidenceById)) return false;

  const lowerText = claimText.toLocaleLowerCase();
  const lowerEvidence = evidenceText.toLocaleLowerCase();
  const scopedContexts = [
    /(?:self[-\s]?assessment|consumer\s+(?:survey|test)|survey|자가\s*평가|소비자\s*(?:설문|평가)|アンケート|自己評価)/i,
    /(?:clinical|instrumental|in[-\s]?vivo|임상|기기\s*(?:평가|측정)|臨床|機器測定)/i,
    /(?:results?\s+(?:may\s+)?vary|individual\s+results|개인차|결과는\s*다를|個人差|結果には差)/i
  ];
  return scopedContexts.every((pattern) => !pattern.test(lowerEvidence) || pattern.test(lowerText));
}

/** Exported for tests only — not part of the package surface (index.ts). */
export function numericSupportFailureReason(
  text: string,
  evidenceIds: string[],
  evidenceById: Map<string, PdpGeoAtomicEvidence>,
  productName: string
): string {
  // Mirror numbersAreSupported's masking and check order exactly: without
  // this, a number that is part of the product's own name (e.g. "365" in
  // "모이베리어 365 크림") gets misreported as an unsupported numeric claim,
  // and a failing calendar date gets buried behind an unrelated reason.
  const claimText = maskProductIdentityMentions(text, productName);
  const evidenceText = evidenceIds.map((id) => evidenceById.get(id)?.text ?? "").filter(Boolean).join(". ");
  if (!calendarDatesAreSupported(claimText, evidenceText)) {
    return "a stated date was not present in the cited evidence";
  }
  const outputTokens = numericClaimTokens(claimText);
  const evidenceTokens = new Set(numericClaimTokens(evidenceText));
  const missing = uniqueText(outputTokens.filter((token) => !evidenceTokens.has(token)));
  if (missing.length > 0) {
    return `numeric value(s) ${missing.join(", ")} were not present in the cited evidence`;
  }
  if (!numericRelationshipsAreSupported(claimText, evidenceText, evidenceIds, evidenceById)) {
    return "one or more numeric relationships were not present in a single cited evidence clause";
  }
  if (!numericTokensHaveConfidentSupport(claimText, evidenceIds, evidenceById)) {
    return "a numeric value was supported only by a low-confidence OCR transcription";
  }
  return "a numeric study-scope qualifier was not preserved from the cited evidence";
}

/** Exported for tests only — not part of the package surface (index.ts). */
export function numericRelationshipsAreSupported(
  text: string,
  evidenceText: string,
  evidenceIds: string[],
  evidenceById: Map<string, PdpGeoAtomicEvidence>
): boolean {
  const outputGroups = numericClaimGroups(text).filter((group) => group.length >= 2);
  if (outputGroups.length === 0) return true;
  const evidenceGroups = [
    ...numericClaimGroups(evidenceText),
    ...groupedMetricNumericClaims(evidenceIds, evidenceById),
    ...groupedImageNumericClaims(evidenceIds, evidenceById)
  ];
  return outputGroups.every((group) => evidenceGroups.some((candidate) =>
    group.every((token) => candidate.includes(token))
  ));
}

/**
 * Mirrors the OCR extractor's low-confidence transcription threshold: a
 * confidence below this reflects a transcription the extractor itself
 * flagged as unreliable, so a numeric claim resting solely on such an atom
 * has not actually been read off the source image with any assurance.
 */
const LOW_OCR_CONFIDENCE_THRESHOLD = 0.6;

/**
 * A numeric token can be textually present in a cited atom yet only because
 * OCR misread the source image with low confidence. This checks the other
 * side of that risk: for every numeric token the output states, at least one
 * cited atom that actually contains the token must be confident (non-OCR
 * atoms carry no ocrConfidence and count as confident by definition). A token
 * with no citing atom at all is left to `numbersAreSupported`'s containment
 * check — this function only judges the confidence of support that exists.
 *
 * Exported for tests only — not part of the package surface (index.ts).
 */
export function numericTokensHaveConfidentSupport(
  text: string,
  evidenceIds: string[],
  evidenceById: Map<string, PdpGeoAtomicEvidence>
): boolean {
  const tokens = numericClaimTokens(text);
  if (tokens.length === 0) return true;
  const citedAtoms = evidenceIds.map((id) => evidenceById.get(id)).filter((item): item is PdpGeoAtomicEvidence => Boolean(item));
  return tokens.every((token) => {
    const containingAtoms = citedAtoms.filter((atomItem) => numericClaimTokens(atomItem.text).includes(token));
    if (containingAtoms.length === 0) return true;
    return containingAtoms.some((atomItem) => (atomItem.ocrConfidence ?? 1) >= LOW_OCR_CONFIDENCE_THRESHOLD);
  });
}

function groupedMetricNumericClaims(
  evidenceIds: string[],
  evidenceById: Map<string, PdpGeoAtomicEvidence>
): string[][] {
  const byEvidenceGroup = new Map<string, string[]>();
  for (const id of evidenceIds) {
    const item = evidenceById.get(id);
    if (!item || item.role !== "metric") continue;
    const group = item.text.match(/(?:^|;\s*)evidenceGroup=([^;]+)/u)?.[1]?.trim();
    if (!group) continue;
    const values = byEvidenceGroup.get(group) ?? [];
    values.push(item.text);
    byEvidenceGroup.set(group, values);
  }
  return [...byEvidenceGroup.values()]
    .filter((items) => items.length >= 2)
    .map((items) => uniqueText(items.flatMap(numericClaimTokens)));
}

/**
 * Cited atoms that share a source image often carry numbers that were split
 * across separate OCR-derived atoms even though the image presented them
 * together (e.g. three metric callouts rendered in one infographic). Group
 * cited atoms with numeric tokens by shared imageUrl so those numbers count
 * as co-occurring evidence, the same way groupedMetricNumericClaims does for
 * an explicit evidenceGroup= tag.
 */
function groupedImageNumericClaims(
  evidenceIds: string[],
  evidenceById: Map<string, PdpGeoAtomicEvidence>
): string[][] {
  const byImageUrl = new Map<string, string[]>();
  for (const id of evidenceIds) {
    const item = evidenceById.get(id);
    if (!item || !item.imageUrls || numericClaimTokens(item.text).length === 0) continue;
    for (const imageUrl of item.imageUrls) {
      const values = byImageUrl.get(imageUrl) ?? [];
      values.push(item.text);
      byImageUrl.set(imageUrl, values);
    }
  }
  return [...byImageUrl.values()]
    .filter((items) => items.length >= 2)
    .map((items) => uniqueText(items.flatMap(numericClaimTokens)));
}

// "-으며"/"-하며" are the same coordinating-verb ending as the bare "이며"
// below (이(다)+며, 하(다)+며, or a consonant-final stem+으며) — a closed
// grammatical suffix, not content. Anchored on a preceding Hangul syllable
// and a following pause/boundary so it only fires as a real clause-final
// connective ("구성되어 있으며", "포함하며"), not as an incidental substring.
// Shared with scanCalendarDates below so a range-continuation date inherits
// its year/month only from within the same clause, using the same notion of
// "clause" the numeric-relationship grouping already relies on.
const CLAUSE_BOUNDARY_PATTERN = /(?:[;。！？!?]|\.(?=\s|$)|,(?=\s*[^\d\s])|\b(?:and|also|while|whereas)\b|(?:그리고|또한|반면|이며)|(?<=[가-힣])(?:으며|하며)(?=[,\s]|$)|(?:および|また|一方))/giu;

function numericClaimGroups(value: string): string[][] {
  return value
    .split(CLAUSE_BOUNDARY_PATTERN)
    .map((clause) => numericClaimTokens(clause))
    .filter((tokens) => tokens.length > 0);
}

/**
 * Calendar dates written in different formats.
 *
 * A study period reaches the planner serialized as `2023.02.02-2023.03.23` and
 * leaves it as natural prose — `2023년 2월 2일부터 3월 23일까지`, `February 2,
 * 2023`. Compared as loose numerals those look like different numbers, so a
 * correctly cited study read as a fabricated measurement. A date is provenance,
 * not a measured outcome, so it is lifted out of the numeric comparison and
 * checked as a date instead.
 */
const ENGLISH_MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december"
];

/** Bounded so a dot/dash/slash-chained number can only be mistaken for a
 * calendar date if it also happens to fall within an actual calendar range —
 * a version string ("2.70") or a two-part decimal ("4.05") already fails on
 * field count (a date needs three fields here). A three-field chain that
 * starts with a two-digit number and stays within valid month/day ranges
 * ("12.5.3") is still read as a date, routing it to the stricter date-
 * equivalence check instead of plain numeric-token containment — the
 * conservative, over-blocking direction, not a defect. */
// Longer alternatives are listed first: a trailing alternation branch is
// only tried on backtrack, and when the day group is the last thing in a
// pattern there is nothing after it to force that backtrack, so "19" would
// otherwise short-match as just "1" via the single-digit branch. The day
// group additionally forbids a trailing digit (`(?!\d)`): without it, an
// invalid two-digit day like "70" or "32" still partial-matches its leading
// digit as a valid single-digit day ("7", "3") once nothing after it forces
// a full backtrack to reject the whole alternation — exactly the shape
// "2.70.5"/"22.12.32" take.
const MONTH_GROUP = "(1[0-2]|0?[1-9])";
const DAY_GROUP = "([12]\\d|3[01]|0?[1-9])(?!\\d)";

const CALENDAR_DATE_PATTERNS: Array<{ pattern: RegExp; hasYear: boolean }> = [
  // Year-first numeric: 2023.02.02, 2023-02-02, 2023/02/02, or a 2-digit-year
  // form as printed on packaging/lab reports ("22.12.19"). The year is kept
  // exactly as captured (2 or 4 digits) — never expanded into a guessed
  // century — and compared later on its trailing digits (yearsAreCompatible).
  { pattern: new RegExp(`(\\d{2,4})\\s*[.\\-/]\\s*${MONTH_GROUP}\\s*[.\\-/]\\s*${DAY_GROUP}`, "gu"), hasYear: true },
  // Year-bearing CJK: 2023년 2월 2일, 2023年2月2日 (day optional)
  { pattern: /(\d{4})\s*[년年]\s*(\d{1,2})\s*[월月](?:\s*(\d{1,2})\s*[일日])?/gu, hasYear: true },
  // Month-day CJK without a year, as a range's second endpoint usually is
  { pattern: /(?<![\d년年])(\d{1,2})\s*[월月]\s*(\d{1,2})\s*[일日]/gu, hasYear: false }
];

const ENGLISH_DATE_PATTERNS: Array<{ pattern: RegExp; monthFirst: boolean }> = [
  { pattern: new RegExp(`\\b(${ENGLISH_MONTHS.join("|")})\\.?\\s+(\\d{1,2})(?:\\s*,\\s*(\\d{4}))?`, "giu"), monthFirst: true },
  { pattern: new RegExp(`\\b(\\d{1,2})\\s+(${ENGLISH_MONTHS.join("|")})\\.?(?:\\s*,?\\s*(\\d{4}))?`, "giu"), monthFirst: false }
];

/**
 * A day-only mention that closes off a range ("19일부터 22일까지", "22日から
 * 22日まで") inherits the year and month of a complete date already scanned
 * earlier in the same clause — the same "range's second endpoint omits what
 * the first already gave" principle as the year-less CJK pattern above,
 * extended to an endpoint that omits the month too. The "까지"/"まで" (until)
 * requirement is the guard: without a preceding complete date in the same
 * clause this pattern is never even attempted (see scanCalendarDatesInClause
 * below), so an unrelated duration mention ("30일까지 사용해보세요") in a
 * clause that has no date at all is left completely untouched.
 */
const RANGE_END_DAY_PATTERN = new RegExp(`${DAY_GROUP}\\s*[일日]\\s*(?:까지|まで)`, "gu");

interface CalendarDateScan {
  /** The input with every date replaced, so numeric tokenizing skips them. */
  text: string;
  /** Normalized `year-month-day` keys; year is empty when unstated. */
  dates: string[];
}

/**
 * Scans a single clause. Kept clause-scoped (rather than run over the whole
 * text at once) so a range-continuation day only ever inherits the year and
 * month of a date stated in the *same* clause, never one from an unrelated
 * clause elsewhere in the same sentence or answer.
 */
function scanCalendarDatesInClause(value: string): CalendarDateScan {
  const dates: string[] = [];
  let text = value;
  let lastDated: { year: string; month: string } | null = null;
  const record = (year: string, month: string, day: string) => {
    dates.push(`${year}-${Number(month)}-${day ? Number(day) : ""}`);
    if (month) lastDated = { year, month };
  };
  for (const { pattern, hasYear } of CALENDAR_DATE_PATTERNS) {
    text = text.replace(pattern, (_match, first: string, second: string, third?: string) => {
      if (hasYear) record(first, second, third ?? "");
      else record("", first, second);
      return " ";
    });
  }
  for (const { pattern, monthFirst } of ENGLISH_DATE_PATTERNS) {
    text = text.replace(pattern, (_match, first: string, second: string, year?: string) => {
      const monthName = (monthFirst ? first : second).toLocaleLowerCase();
      const day = monthFirst ? second : first;
      record(year ?? "", String(ENGLISH_MONTHS.indexOf(monthName) + 1), day);
      return " ";
    });
  }
  if (lastDated) {
    const { year, month } = lastDated;
    text = text.replace(RANGE_END_DAY_PATTERN, (_match, day: string) => {
      record(year, month, day);
      return " ";
    });
  }
  return { text, dates };
}

function scanCalendarDates(value: string): CalendarDateScan {
  // Split on the same clause boundaries numericClaimGroups uses, so a
  // range-continuation date (see scanCalendarDatesInClause) can only ever
  // inherit from a date in its own clause. A fresh copy of the shared
  // boundary pattern avoids mutating its lastIndex across calls.
  const boundaryPattern = new RegExp(CLAUSE_BOUNDARY_PATTERN.source, CLAUSE_BOUNDARY_PATTERN.flags);
  const separators = value.match(boundaryPattern) ?? [];
  const clauses = value.split(CLAUSE_BOUNDARY_PATTERN);
  let text = "";
  const dates: string[] = [];
  clauses.forEach((clause, index) => {
    const scanned = scanCalendarDatesInClause(clause);
    text += scanned.text;
    dates.push(...scanned.dates);
    if (index < separators.length) text += separators[index];
  });
  return { text, dates: uniqueText(dates) };
}

/**
 * A 2-digit year is compared against a 4-digit year on its trailing two
 * digits, never by guessing a century and expanding it ("22" is not turned
 * into "2022") — so "22" and "2022" are compatible, but "22" and "2021" are
 * not, and two 2-digit years must match exactly.
 */
function yearsAreCompatible(year: string | undefined, candidateYear: string | undefined): boolean {
  if (!year || !candidateYear) return true;
  if (year.length === candidateYear.length) return year === candidateYear;
  const [longer, shorter] = year.length > candidateYear.length ? [year, candidateYear] : [candidateYear, year];
  return longer.endsWith(shorter);
}

/**
 * Every date stated in the output must be stated by the cited evidence. A date
 * written without a year matches on month and day, because a range's second
 * endpoint normally omits the year the first one already gave.
 */
function calendarDatesAreSupported(text: string, evidenceText: string): boolean {
  const output = scanCalendarDates(text).dates;
  if (output.length === 0) return true;
  const evidence = scanCalendarDates(evidenceText).dates;
  return output.every((date) => {
    const [year, month, day] = date.split("-");
    return evidence.some((candidate) => {
      const [candidateYear, candidateMonth, candidateDay] = candidate.split("-");
      if (month !== candidateMonth) return false;
      if (day && candidateDay && day !== candidateDay) return false;
      return yearsAreCompatible(year, candidateYear);
    });
  });
}

/** Recognized measurement units, shared by the tokenizer and the enumeration-marker mask below. */
const NUMERIC_UNIT_PATTERN = "(?:%|％|ppm|ml|mg|kg|g|oz|hours?|hrs?|days?|weeks?|months?|minutes?|seconds?|participants?|subjects?|users?|people|times?|layers?|krw|usd|eur|gbp|jpy|시간|일|주|개월|분|초|명|회|배|개|층|원|달러|유로|엔|人|時間|日|週間|か月|分|秒)";

/**
 * Korean case/topic particles glue directly onto a preceding unit with no
 * space ("94%와", "48시간이"). This is a closed grammar class rather than
 * domain content, so enumerating it does not run afoul of the
 * no-keyword-hardcoding policy for semantic rules.
 */
const KOREAN_PARTICLE_PATTERN = "(?:은|는|이|가|을|를|와|과|도|만|의|에|에서|에게|한테|보다|처럼|같이|마다|조차|밖에|이나|나|부터|까지|이라|라|로|으로|랑|이랑|고|이고)";

const NUMERIC_CLAIM_TOKEN_PATTERN = new RegExp(
  "(?<![\\p{L}\\p{N}])\\d+(?:[.,]\\d+)?(?:" +
    // A unit-bearing number: a following Hangul particle (word-continuation
    // by character class alone) doesn't disqualify it, only another digit or
    // a non-particle letter does — otherwise "94%와" would drop the unit.
    "\\s*" + NUMERIC_UNIT_PATTERN + "(?![.,]\\d|\\p{N}|(?:(?!" + KOREAN_PARTICLE_PATTERN + ")\\p{L}))" +
    "|" +
    // A bare number with no unit: any following letter or digit means it's
    // part of a larger token (avoids partial matches like "94" in "945").
    "(?![.,]\\d|[\\p{L}\\p{N}])" +
  ")",
  "giu"
);

const CLAUSE_START = "(?:^|[\\n\\r]|[;:。！？!?]|\\.(?=\\s|$))";
const CLAUSE_END = "(?:$|[\\n\\r]|[;:。！？!?])";

/**
 * Enumeration list markers ("1) 세안 직후…", "사용법 2") are not
 * measurements: a bare 1–2 digit integer with no unit, standing alone at a
 * clause boundary, is a list index or step label rather than a measured
 * value — every real measurement in this corpus carries a unit. Anchoring
 * the exclusion on "no unit at a clause edge" keeps genuine numbers,
 * including a unit-bearing one that happens to open a clause ("48시간 보습
 * 지속…"), untouched. Clause boundaries mirror numericClaimGroups' own
 * splitter, since this masking runs before that splitting happens.
 */
function maskEnumerationMarkers(text: string): string {
  return text
    .replace(
      // A "." only reads as a marker delimiter ("1. 세안…") when it is
      // followed by whitespace or the end, same as numericClaimGroups' own
      // clause splitter — otherwise "2.70"'s decimal point would be
      // mistaken for one and strip the leading digit off a real number.
      new RegExp(`(${CLAUSE_START})(\\s*)(\\d{1,2})(?=\\)|\\.(?=\\s|$)|\\s+(?!${NUMERIC_UNIT_PATTERN}))`, "giu"),
      (_match, boundary: string, spacing: string) => `${boundary}${spacing}`
    )
    .replace(
      // A short Latin-letter token right before the number (SPF/PA/pH-shaped
      // scale designators) means it is a graded value, not a list marker —
      // Korean step/list labels in this corpus are Hangul words, so this is
      // a structural distinction rather than an enumerated word list. But
      // that alone isn't enough: "STEP 2" and "DAY 3" are also Latin-labeled
      // and single-digit, yet they're ordinal step labels, not grades. The
      // exemption is narrowed to what actually reads as a graded scale
      // value — two digits ("SPF 50"), a decimal (already safe below, since
      // a "." right after the digit isn't a CLAUSE_END), or a trailing "+"
      // (also already safe, since "+" isn't whitespace/CLAUSE_END either) —
      // so a single bare digit after a Latin token still falls back to the
      // mask. A Hangul word immediately before ("용량 30", "총 12") is not
      // distinguishable this way at all, so a genuine graded value in that
      // shape is masked out of the output tokens and thereby exempted from
      // evidence verification — the permissive direction, since the gate only
      // ever checks tokens that survive the mask. The gap stays acknowledged
      // and unpoliced because closing it would mean hardcoding specific Korean
      // content words, which the no-keyword-hardcoding policy for semantic
      // rules forbids; it is bounded to bare 1–2 digit integers carrying no
      // unit at a clause edge, so every measured value stays verified.
      new RegExp(`(?:(?<!\\p{Script=Latin}{1,8}\\s)(?<=^|\\s)\\d{2}|(?<=^|\\s)\\d(?!\\d))(?=\\s*${CLAUSE_END})`, "gu"),
      () => " "
    );
}

/** Exported for tests only — not part of the package surface (index.ts). */
export function numericClaimTokens(text: string): string[] {
  return Array.from(scanCalendarDates(maskEnumerationMarkers(text)).text.matchAll(NUMERIC_CLAIM_TOKEN_PATTERN))
    .map((match) => match[0]
      .replace(/,/g, "")
      .replace(/\s+/g, "")
      .toLocaleLowerCase()
      .replace(/(?:krw|usd|eur|gbp|jpy|원|달러|유로|엔)$/u, "")
      .replace(/^(\d+)\.0+$/u, "$1")
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
      .replace(/layers?$/, "층")
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

/**
 * Removes editorial wrapping around a customer qualifier without changing its
 * meaning. This is a locale-level fluency rule, not a product-copy template:
 * facts, scope, and modality remain unchanged.
 */
function normalizePlannerCustomerCaveat(value: string, locale: PdpGeoLocale): string {
  if (locale === "ko-KR") {
    return value.replace(
      /개인\s*차가\s*있을\s*수\s*있다는\s*(?:단서|문구|주의\s*문구|조건)(?:가|이)?\s*(?:붙|달|제시|표기)(?:어\s*있|되)?(?:습니다|어\s*있습니다|됩니다)?[.!。]?/gu,
      "개인 차가 있을 수 있습니다."
    );
  }
  if (locale === "en-US" || locale === "en-GB") {
    return value.replace(
      /(?:a|the)\s+(?:disclaimer|caveat|qualifier|condition|note)\s+(?:is\s+attached\s+(?:to\s+say|stating)|states?|says?|notes?|indicates?)\s+(?:that\s+)?individual\s+results\s+may\s+vary[.!]?/giu,
      "Individual results may vary."
    );
  }
  return value;
}

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
    if (/개인\s*차가\s*있을\s*수\s*있다는\s*(?:단서|문구|주의\s*문구|조건)(?:가|이)?\s*(?:붙|달|제시|표기)/u.test(text)
      || /[가-힣]으입니다\b/u.test(text)) {
      return false;
    }
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

function isPublicDescriptionField(field: string): boolean {
  return field === "Product.description" || field === "WebPage.description";
}

/**
 * Recovers evidence citations only when the generated description itself can
 * be matched back to an existing atomic fact. This handles a common planner
 * failure mode where a supported routine, price, review pattern, or metric is
 * written correctly but its ID is accidentally omitted from the field-level
 * citation list. Recovered IDs are still subjected to every downstream gate.
 */
function recoverDescriptionEvidenceIds(
  text: string,
  suppliedIds: string[],
  ledger: PdpGeoAtomicEvidence[]
): string[] {
  const recovered = [...suppliedIds];
  const seen = new Set(recovered);
  for (const unit of descriptionClaimUnits(text)) {
    const ranked = ledger
      .filter((item) => !seen.has(item.id))
      .map((item) => ({ item, score: descriptionEvidenceRelevanceScore(unit, item) }))
      .filter(({ score }) => score >= 7)
      .sort((left, right) => right.score - left.score || right.item.confidence - left.item.confidence);
    // Cite an atom only when it covers wording that the already-cited atoms do
    // not. The sentence then sizes its own evidence: one that states identity,
    // audience and benefit draws an atom for each, while one enumerating four
    // review terms draws four. A fixed count could do neither — it starved
    // multi-part sentences, and because it kept only the top few, any change
    // in relevance scoring reshuffled which atoms a sentence cited and flipped
    // it between supported and unsupported. Citing everything relevant is
    // equally wrong: near-duplicate and loosely related atoms dilute the
    // polarity, modality and context checks that run against the cited set. An
    // atom covering nothing new serves neither purpose, so it is skipped.
    const claimTokens = meaningfulEvidenceTokens(unit);
    const covered = new Set<string>();
    for (const { item } of ranked) {
      const evidenceTokens = meaningfulEvidenceTokens(item.text);
      const newlyCovered = claimTokens.filter((token) => !covered.has(token)
        && evidenceTokens.some((candidate) => evidenceTokensMatch(token, candidate)));
      if (newlyCovered.length === 0) continue;
      for (const token of newlyCovered) covered.add(token);
      recovered.push(item.id);
      seen.add(item.id);
    }
  }
  return recovered;
}

function descriptionEvidenceRelevanceScore(unit: string, evidence: PdpGeoAtomicEvidence): number {
  const unitKey = normalizeForMatch(unit);
  const evidenceKey = normalizeForMatch(evidence.text);
  if (!unitKey || !evidenceKey) return 0;
  if (unitKey === evidenceKey || unitKey.includes(evidenceKey) || evidenceKey.includes(unitKey)) return 100;

  const unitTokens = meaningfulEvidenceTokens(unit);
  const evidenceTokens = meaningfulEvidenceTokens(evidence.text);
  const tokenMatches = unitTokens.filter((token) => evidenceTokens.some((candidate) => evidenceTokensMatch(token, candidate))).length;
  const unitConcepts = semanticConcepts(unit);
  const evidenceConcepts = semanticConcepts(evidence.text);
  const conceptMatches = [...unitConcepts].filter((concept) => evidenceConcepts.has(concept)).length;
  const unitContexts = contextConcepts(unit);
  const evidenceContexts = contextConcepts(evidence.text);
  const contextMatches = [...unitContexts].filter((concept) => evidenceContexts.has(concept)).length;
  const unitNumbers = numericClaimTokens(unit);
  const evidenceNumbers = new Set(numericClaimTokens(evidence.text));
  const numberMatches = unitNumbers.filter((value) => evidenceNumbers.has(value)).length;
  const completeNumericMatch = unitNumbers.length > 0 && numberMatches === unitNumbers.length;
  const matchingRole = evidenceRolesSupportClaimTopics(unit, [evidence]);
  if (tokenMatches === 0 && contextMatches === 0 && numberMatches === 0) return 0;
  return tokenMatches * 2
    + conceptMatches * 3
    + contextMatches * 4
    + numberMatches * 3
    + (completeNumericMatch ? 8 : 0)
    + (matchingRole ? 1 : 0);
}

function descriptionClaimUnits(text: string): string[] {
  const value = cleanText(text);
  const units: string[] = [];
  const boundaryPattern = /[.!?。！？]\s+/gu;
  let start = 0;
  for (const match of value.matchAll(boundaryPattern)) {
    const boundaryStart = match.index;
    const boundaryEnd = boundaryStart + match[0].length;
    const punctuation = match[0].trim().slice(-1);
    const before = value.slice(0, boundaryStart + 1);
    const next = value.slice(boundaryEnd).trimStart();
    const periodIsAbbreviation = punctuation === "." && (
      /\b(?:fl|oz|ml|mg|kg|g|lb|lbs|dr|mr|mrs|ms|no|vs)\.$/iu.test(before)
      || /(?:\be\.g|\bi\.e)\.$/iu.test(before)
      || /^[a-z]|^\//u.test(next)
    );
    if (periodIsAbbreviation) continue;
    const unit = cleanText(value.slice(start, boundaryStart + 1));
    if (unit) units.push(unit);
    start = boundaryEnd;
  }
  const tail = cleanText(value.slice(start));
  if (tail) units.push(tail);
  return units.length > 0 ? units : cleanText(text) ? [cleanText(text)] : [];
}

function descriptionEvidenceSemanticallySupportsText(
  text: string,
  evidenceIds: string[],
  evidenceById: Map<string, PdpGeoAtomicEvidence>,
  product: PdpProductSignal,
  semanticAuditPassed: boolean
): boolean {
  if (!semanticAuditPassed) {
    return evidenceSemanticallySupportsText(text, evidenceIds, evidenceById, product, false, 0.5);
  }
  const cited = evidenceIds.map((id) => evidenceById.get(id)).filter((item): item is PdpGeoAtomicEvidence => Boolean(item));
  const units = descriptionClaimUnits(text);
  if (units.length > 0 && units.every((unit) =>
    descriptionIdentityUnitIsSupported(unit, cited, product)
    || descriptionPageIntroductionUnitIsSupported(unit, cited, product))) {
    return true;
  }
  const substantive = cited.filter((item) => item.role !== "identity");
  if (substantive.length === 0 || !evidenceRolesSupportClaimTopics(text, cited)) return false;
  const evidenceText = substantive.map((item) => item.text).join(" ");
  if (!contextAssociationsAreSupported(text, evidenceText)
    || !claimRiskIsSupported(text, evidenceText)
    || !claimPolarityAndModalityArePreserved(text, evidenceText)
    || !causalIngredientBenefitLinkIsSupported(text, cited, product)) {
    return false;
  }

  return units.length > 0 && units.every((unit) =>
    descriptionIdentityUnitIsSupported(unit, cited, product)
    || descriptionPageIntroductionUnitIsSupported(unit, cited, product)
    || evidenceSemanticallySupportsText(unit, evidenceIds, evidenceById, product, true, 0.25)
  );
}

/**
 * A sentence that only states what the product IS ("Product X is EXAMPLEDERMA's
 * mild cleanser") makes no claim beyond naming it, so it is exempt from the
 * clause-level evidence audit the way a numeric identity token (product name
 * containing "365") is exempt from the numeric gate — see
 * numbersAreSupported/maskProductIdentityMentions. Getting this exemption
 * right requires judging what KIND of statement the unit makes, not just
 * which words it uses:
 *
 * 1. it must actually cite identity evidence and name the product as its
 *    subject (descriptionUnitNamesProductAsSubject) — a sentence about
 *    something else that merely reuses identity words does not qualify;
 * 2. its predicate must be a copula ("is/are a|an", ~입니다/이다, です/である),
 *    not an action or effect predicate (~돕습니다/~줍니다, cleanses, helps) —
 *    descriptionUnitPredicateIsIdentityCopula tests this positively, so an
 *    open-ended verb vocabulary never needs to be enumerated: whatever the
 *    predicate is, if it is not a recognized copula, the sentence is not an
 *    identity statement and falls through to the ordinary semantic audit;
 * 3. every substantive token it uses must come from the identity fields OR
 *    the evidence actually cited for this sentence — not from identity
 *    fields alone. A real production run dropped
 *    "…EXAMPLEDERMA의 약산성 클렌저입니다" (a plain is-a sentence) because "약산성"
 *    is not part of the product's name/brand/category, even though the
 *    ledger states it verbatim elsewhere and that atom was cited. Requiring
 *    every token to be an identity FIELD conflated "is this an identity
 *    sentence" with "does this sentence add zero new information," which are
 *    different questions; pooling in the cited evidence text answers the
 *    first question without silently answering the second one for it.
 *
 * The plan for this fix line originally called for stripping only the
 * unsupported modifier and keeping the rest of the sentence. That is not
 * implemented here: rewriting model-authored prose risks producing
 * disfluent copy, and the actual defect was a *supported* modifier being
 * judged against the wrong pool, which condition 3 above fixes directly. A
 * sentence carrying a modifier the evidence never states anywhere is still
 * dropped as a whole unit, same as before this change.
 */
export function descriptionIdentityUnitIsSupported(
  unit: string,
  cited: PdpGeoAtomicEvidence[],
  product: PdpProductSignal
): boolean {
  const identityEvidence = cited.filter((item) => item.role === "identity");
  if (identityEvidence.length === 0) return false;
  if (!descriptionUnitNamesProductAsSubject(unit, product)) return false;
  if (!descriptionUnitPredicateIsIdentityCopula(unit)) return false;

  const identityText = [
    ...cited.map((item) => item.text),
    product.name,
    product.originalName ?? "",
    product.brand ?? "",
    product.category ?? ""
  ].join(" ");
  const identityTokens = meaningfulEvidenceTokens(identityText);
  const unitTokens = meaningfulEvidenceTokens(unit);
  return unitTokens.length > 0
    && unitTokens.every((token) => identityTokens.some((candidate) => evidenceTokensMatch(token, candidate)));
}

/**
 * Presence of the product's own name/original name anywhere in the unit is
 * the same "subject" test this file already applies elsewhere (see
 * isParallelProductCompositionBenefitClause's hasProductSubject): these are
 * short, single-clause description sentences, so a mention of the product's
 * own name is a reliable proxy for it being the grammatical subject, without
 * needing a real parser to locate the subject position.
 */
function descriptionUnitNamesProductAsSubject(unit: string, product: PdpProductSignal): boolean {
  const normalizedUnit = normalizeEntityMention(unit);
  return [product.name, product.originalName]
    .filter((value): value is string => Boolean(cleanText(value ?? "")))
    .some((name) => {
      const entity = normalizeEntityMention(name);
      return Boolean(entity) && normalizedUnit.includes(entity);
    });
}

/**
 * Copula ("is-a") predicates form a closed grammatical class in each locale,
 * so they can be matched positively and completely. Action/effect predicates
 * cannot be enumerated the same way (돕습니다/줍니다/cleanses/moisturizes/助け…
 * is an open-ended and ever-growing list), so this function never lists
 * them: any unit whose predicate does not match a recognized copula form
 * simply returns false, whatever verb it actually used.
 */
// 습니다체(입니다/이다) plus the 해요체 present-tense forms shared with
// final-proofreader's copula-allomorph table (see KOREAN_COPULA_POLITE_PRESENT_ENDINGS
// in normalize.ts) — a prior version of this gate checked only the former and
// dropped a valid 해요체 identity sentence the proofreader already treated as
// a copula. Past-tense 해요체 (였어요/이었어요) is intentionally left out of
// the shared constant's scope for now, matching what the proofreader table
// covers; extend the shared array, not this regex, if that changes.
const KOREAN_COPULA_ENDING_PATTERN = new RegExp(
  `(?:${KOREAN_COPULA_ENDING_FORMS.join("|")})[.!?]*$`,
  "u"
);

function descriptionUnitPredicateIsIdentityCopula(unit: string): boolean {
  const trimmed = cleanText(unit).replace(/[)\]"'”’]+$/u, "");
  if (!trimmed) return false;
  const jaCopulaEnding = /(?:でした|である|だった|です)[.!?。！？]*$/u;
  if (KOREAN_COPULA_ENDING_PATTERN.test(trimmed) || jaCopulaEnding.test(trimmed)) return true;

  const enCopula = /^[^,]*?\b(?:is|are|was|were)\s+(?:a|an)\b/iu.exec(trimmed);
  if (!enCopula) return false;
  // A second finite predicate coordinated after the copula clause ("...is a
  // cleanser, and it removes...") rides an action claim in on the identity
  // clause's coattails, so it disqualifies the exception even though the
  // sentence also contains "is a".
  const remainder = trimmed.slice(enCopula.index + enCopula[0].length);
  const coordinatedSecondPredicate = /,\s*(?:and|but)\s+(?:it\s+|which\s+|that\s+)?\w+s\b/iu.test(remainder);
  return !coordinatedSecondPredicate;
}

function descriptionPageIntroductionUnitIsSupported(
  unit: string,
  cited: PdpGeoAtomicEvidence[],
  product: PdpProductSignal
): boolean {
  if (!/(?:상품\s*페이지|제품\s*페이지|product(?:-detail)?\s+page|PDP|商品ページ)/iu.test(unit)) return false;
  const productEntity = normalizeEntityMention(product.name);
  if (!productEntity || !normalizeEntityMention(unit).includes(productEntity)) return false;

  const identityTokens = meaningfulEvidenceTokens([
    product.name,
    product.originalName ?? "",
    product.brand ?? "",
    product.category ?? "",
    ...cited.filter((item) => item.role === "identity").map((item) => item.text)
  ].join(" "));
  const structuralPageToken = /^(?:page|pdp|product|information|feature|features|choice|choose|selection|present|presents|introduce|introduces|show|shows|선보|특징|선택|필요|정보|한데|담|소개|페이지|商品|製品|情報|特徴|選択|紹介)/iu;
  const factualTokens = meaningfulEvidenceTokens(unit)
    .filter((token) => !structuralPageToken.test(token))
    .filter((token) => !identityTokens.some((identity) => evidenceTokensMatch(token, identity)));
  if (factualTokens.length === 0) return true;

  const evidenceText = cited.map((item) => item.text).join(" ");
  const evidenceTokens = meaningfulEvidenceTokens(evidenceText);
  const matched = factualTokens.filter((token) => evidenceTokens.some((candidate) => evidenceTokensMatch(token, candidate))).length;
  const conceptsSupported = [...semanticConcepts(unit)].every((concept) => semanticConcepts(evidenceText).has(concept));
  return conceptsSupported
    && matched >= Math.min(2, factualTokens.length)
    && matched / factualTokens.length >= 0.5;
}

function descriptionSemanticEvidenceFailureReason(
  text: string,
  evidenceIds: string[],
  evidenceById: Map<string, PdpGeoAtomicEvidence>,
  product: PdpProductSignal,
  semanticAuditPassed: boolean
): string {
  if (!semanticAuditPassed) {
    return semanticEvidenceFailureReason(text, evidenceIds, evidenceById, product, false, 0.5);
  }
  const cited = evidenceIds.map((id) => evidenceById.get(id)).filter((item): item is PdpGeoAtomicEvidence => Boolean(item));
  const substantive = cited.filter((item) => item.role !== "identity");
  if (substantive.length === 0) return "no substantive cited evidence remained after ID validation";
  if (!evidenceRolesSupportClaimTopics(text, cited)) return "one or more description topics lacked a matching evidence role";
  const evidenceText = substantive.map((item) => item.text).join(" ");
  if (!contextAssociationsAreSupported(text, evidenceText)) return "a CEP context association was not explicit in the cited evidence";
  if (!claimRiskIsSupported(text, evidenceText)) return "a high-risk claim was stronger than the cited evidence";
  if (!claimPolarityAndModalityArePreserved(text, evidenceText)) return "claim polarity or modality was stronger than the cited evidence";
  if (!causalIngredientBenefitLinkIsSupported(text, cited, product)) return "an ingredient-benefit causal relation lacked one matching source clause";
  const unsupported = descriptionClaimUnits(text).find((unit) =>
    !descriptionIdentityUnitIsSupported(unit, cited, product)
    && !descriptionPageIntroductionUnitIsSupported(unit, cited, product)
    && !evidenceSemanticallySupportsText(unit, evidenceIds, evidenceById, product, true, 0.25)
  );
  return unsupported
    ? `claim unit "${truncate(unsupported, 140)}" lacked clause-level semantic support`
    : "the audited description did not pass clause-level evidence analysis";
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
  if (mentions <= 2) return true;
  const sentences = descriptionClaimUnits(text);
  const startsWithEntity = sentences.map((sentence) => normalizeEntityMention(sentence).startsWith(entity));
  const consecutiveStarts = startsWithEntity.some((starts, index) => starts && startsWithEntity[index - 1]);
  return !consecutiveStarts
    && mentions <= Math.max(2, Math.ceil(sentences.length / 2))
    && startsWithEntity.filter(Boolean).length <= Math.ceil(sentences.length / 2);
}

function descriptionFieldRoleIsSupported(text: string, product: PdpProductSignal, field: string): boolean {
  if (field !== "WebPage.description") {
    return true;
  }
  const opening = cleanText(text).split(/[.!?。！？]\s*/u)[0] ?? "";
  const productEntity = normalizeEntityMention(product.name);
  const openingEntity = normalizeEntityMention(opening);
  const namesProduct = Boolean(productEntity) && openingEntity.includes(productEntity);
  const identifiesProductPage = /(?:상품\s*페이지|제품\s*페이지|product(?:-detail)?\s+page|PDP|商品ページ)/iu.test(opening);
  const usesStiffWrapper = /(?:이\s*페이지에서는|페이지\s*본문에서는|페이지에서\s*확인할\s*수\s*있는|페이지에\s*공개된|this\s+page\s+(?:explains|covers|shows|lists)|このページでは)/iu.test(opening);
  const usesTautologicalIntroduction = /(?:상품|제품)\s*페이지는[^.!?。！？]{0,100}(?:상품|제품)(?:을|를)?\s*(?:소개|보여)합니다|product(?:-detail)?\s+page\s+(?:introduces|presents)\s+(?:a|the)\s+product/iu.test(opening);
  return namesProduct && identifiesProductPage && !usesStiffWrapper && !usesTautologicalIntroduction;
}

function descriptionFluencyIsSupported(text: string, field: string): boolean {
  if (!/^(?:Product|WebPage)\.description$|^content\.sections\.description$/u.test(field)) {
    return true;
  }
  const value = cleanText(text);
  if (/[☑※□■]/u.test(value)) return false;
  if (/(?:^|[.!?。！？]\s*|,\s*)(?:하는|되는|있는|돕는|위한|통한)\s+(?:기술|공법|포뮬러)(?:이|가|은|는)?\s*(?:적용|사용|포함)/u.test(value)) {
    return false;
  }
  if (/참고할\s*수\s*있는\s*(?:시험|테스트)\s*정보(?:입니다|로\s*제시됩니다)/u.test(value)) {
    return false;
  }
  if (/(?:실제\s*)?고객\s*리뷰에서는[^.!?。！？]{0,180}(?:언급|표시|제시)됩니다/u.test(value)) {
    return false;
  }
  return true;
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
  ["cooling", /\b(?:cooling|refreshing|chilled?)\b|(?:쿨링|시원|냉감|청량)|(?:クール|ひんやり|冷感)/iu],
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
  if (faqEvidenceSelectorQuestionIsSupported(question, cited, evidenceText, product)) {
    return true;
  }
  // Two different jobs, so two different sets. The subset test asks whether
  // the question demands anything the evidence does not state, and identity
  // must be excluded from it. The anchor test below asks whether the question
  // is semantically tied to this product at all, and naming the product is
  // exactly such a tie — so it uses the full set.
  const questionConcepts = claimSemanticConcepts(question, product);
  const anchorConcepts = semanticConcepts(question);
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
    && (matched >= Math.min(1, questionTokens.length) || anchorConcepts.size > 0);
}

/**
 * The concepts a sentence asserts, excluding those it carries only by naming
 * the product.
 *
 * A FAQ question is required to name the exact product, and a product name or
 * category can itself map to a concept — "크림" yields `cream`. Comparing the
 * raw concept set against the evidence then demanded that a safety-test atom
 * also mention the word cream, and rejected a well-supported question for
 * obeying the contract that put the product name in it. Identity is not a
 * claim, so it is removed before the comparison.
 */
function claimSemanticConcepts(text: string, product: PdpProductSignal): Set<string> {
  const identityConcepts = semanticConcepts([
    product.name,
    product.originalName ?? "",
    product.brand ?? "",
    product.category ?? ""
  ].join(" "));
  return new Set([...semanticConcepts(text)].filter((concept) => !identityConcepts.has(concept)));
}

function faqEvidenceSelectorQuestionIsSupported(
  question: string,
  cited: PdpGeoAtomicEvidence[],
  evidenceText: string,
  product: PdpProductSignal
): boolean {
  const asksForEvidence = /\b(?:evidence|proof|results?|measurements?|tests?|tested)\b|(?:근거|결과|측정|시험|테스트|완료\s*표기)|(?:根拠|結果|測定|試験|テスト)/iu.test(question);
  if (!asksForEvidence) return false;
  const roleSet = new Set(cited.map((item) => item.role));
  if (!["metric", "source", "faq", "description", "benefit", "effect"].some((role) => roleSet.has(role as PdpGeoEvidenceRole))) {
    return false;
  }
  const questionConcepts = claimSemanticConcepts(question, product);
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
  const evidenceConcepts = semanticConcepts(`${evidenceText} ${identityText(product)}`);
  return [...claimConcepts].every((concept) => evidenceConcepts.has(concept))
    && matched >= Math.min(2, claimTokens.length)
    // The model-backed corrective pass has already audited entailment and the
    // invariant checks above still enforce role, risk, polarity, context and
    // causal scope. Korean inflection and connective wording can otherwise
    // make a fully grounded multi-atom answer miss the old 40% lexical quota.
    && matched / claimTokens.length >= 0.25;
}

/** The product's own entity wording: name, original name, brand, category. */
function identityText(product: PdpProductSignal): string {
  return [product.name, product.originalName ?? "", product.brand ?? "", product.category ?? ""].join(" ");
}

function evidenceSemanticallySupportsText(
  text: string,
  evidenceIds: string[],
  evidenceById: Map<string, PdpGeoAtomicEvidence>,
  product: PdpProductSignal,
  semanticAuditPassed: boolean,
  auditedLexicalThreshold = 0.55
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
    // Naming what the product is repeats the entity, it does not claim an
    // outcome, so the product's own identity establishes those concepts. The
    // lexical side above already grants that parity by dropping identity
    // tokens from the claim; without the same parity here a concept carried
    // only by the product name — the category noun in "…크림 미스트" — stayed
    // permanently unsupported and took its whole sentence down with it.
    const evidenceConcepts = semanticConcepts(`${evidenceText} ${identityText(product)}`);
    return [...claimConcepts].every((concept) => evidenceConcepts.has(concept))
      && matched >= Math.min(3, claimTokens.length)
      && matched / claimTokens.length >= auditedLexicalThreshold;
  }
  return matched === claimTokens.length;
}

function semanticEvidenceFailureReason(
  text: string,
  evidenceIds: string[],
  evidenceById: Map<string, PdpGeoAtomicEvidence>,
  product: PdpProductSignal,
  semanticAuditPassed: boolean,
  auditedLexicalThreshold = 0.55
): string {
  const cited = evidenceIds.map((id) => evidenceById.get(id)).filter((item): item is PdpGeoAtomicEvidence => Boolean(item));
  const substantive = cited.filter((item) => item.role !== "identity");
  if (substantive.length === 0) return "no substantive cited evidence remained after ID validation";
  if (substantive.every((item) => item.role === "review") && !hasReviewAttribution(text)) {
    return "review-derived language was not explicitly attributed to customers or reviews";
  }
  if (!evidenceRolesSupportClaimTopics(text, cited)) return "one or more claim topics lacked a matching evidence role";
  const evidenceText = substantive.map((item) => item.text).join(" ");
  if (!contextAssociationsAreSupported(text, evidenceText)) return "a CEP context association was not explicit in the cited evidence";
  if (!claimRiskIsSupported(text, evidenceText)) return "a high-risk claim was stronger than the cited evidence";
  if (!claimPolarityAndModalityArePreserved(text, evidenceText)) return "claim polarity or modality was stronger than the cited evidence";
  if (!causalIngredientBenefitLinkIsSupported(text, cited, product)) return "an ingredient-benefit causal relation lacked one matching source clause";
  if (usesDifferentPrimaryScript(text, evidenceText)) {
    return semanticAuditPassed && crossLanguageConceptsAreSupported(text, evidenceText)
      ? "cross-language evidence did not pass the audited semantic gate"
      : "cross-language concepts were not fully supported by the cited evidence";
  }
  const identityTokens = meaningfulEvidenceTokens([
    product.name,
    product.originalName ?? "",
    product.brand ?? "",
    product.category ?? ""
  ].join(" "));
  const claimTokens = meaningfulEvidenceTokens(text)
    .filter((token) => !identityTokens.some((identity) => evidenceTokensMatch(token, identity)));
  const sourceTokens = meaningfulEvidenceTokens(evidenceText);
  const matched = claimTokens.filter((token) => sourceTokens.some((source) => evidenceTokensMatch(token, source))).length;
  const missingConcepts = [...semanticConcepts(text)].filter((concept) => !semanticConcepts(evidenceText).has(concept));
  if (missingConcepts.length > 0) return `semantic concept(s) ${missingConcepts.join(", ")} were not present in the cited evidence`;
  const ratio = claimTokens.length === 0 ? 1 : matched / claimTokens.length;
  return `audited lexical grounding was ${(ratio * 100).toFixed(0)}%, below the required ${(auditedLexicalThreshold * 100).toFixed(0)}%`;
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
    "product", "page", "pdp", "serum", "cream", "toner", "formula", "item", "information", "details", "include", "includes", "contain", "contains", "composed", "shows", "explains", "check", "find", "main", "key", "benefit", "feature", "features", "ingredient", "ingredients",
    "제품", "상품", "페이지", "정보", "확인", "확인할", "있습니다", "합니다", "어떤", "무엇", "어떻게", "위한", "통해", "대한", "그리고", "또는", "핵심", "장점", "주요", "소개", "소개됩니다", "특징", "성분", "포함", "함유", "구성", "공식", "관련", "해당", "함께", "각각", "내용", "설명", "설명됩니다", "제시", "제시됩니다", "표기", "표기됩니다", "완료",
    "商品", "製品", "ページ", "情報", "確認", "できます", "です", "ます", "どの", "どんな", "について", "主な", "利点", "特徴", "成分", "含む", "配合", "構成"
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
  const assertedRelationClauses = text
    .split(/[.!?。！？;；\n]+/u)
    .map(cleanText)
    .filter(Boolean)
    .filter((clause) => {
      const clauseTokens = meaningfulEvidenceTokens(clause);
      const mentionsIngredient = ingredientTokens.some((token) => clauseTokens.some((candidate) => evidenceTokensMatch(token, candidate)));
      const mentionsBenefit = benefitTokens.some((token) => clauseTokens.some((candidate) => evidenceTokensMatch(token, candidate)));
      return mentionsIngredient
        && mentionsBenefit
        && explicitIngredientBenefitRelationPattern.test(clause)
        && !isParallelProductCompositionBenefitClause(clause, product);
    });
  // Composition and finished-product benefits may coexist in one description
  // as independent sentences. Only an output clause that actually asserts a
  // relationship needs matching source evidence for that relationship.
  if (assertedRelationClauses.length === 0) return true;
  return assertedRelationClauses.every((assertedClause) => {
    const assertedTokens = meaningfulEvidenceTokens(assertedClause);
    const assertedIngredients = ingredientTokens
      .filter((token) => assertedTokens.some((candidate) => evidenceTokensMatch(token, candidate)));
    const assertedBenefits = benefitTokens
      .filter((token) => assertedTokens.some((candidate) => evidenceTokensMatch(token, candidate)));
    return cited.some((item) => item.text
      .split(/[.!?。！？;；\n]+/u)
      .map(cleanText)
      .filter(Boolean)
      .some((clause) => {
        const sourceTokens = meaningfulEvidenceTokens(clause);
        const matchesAssertedIngredient = assertedIngredients
          .some((token) => sourceTokens.some((candidate) => evidenceTokensMatch(token, candidate)));
        const matchesAssertedBenefit = assertedBenefits
          .some((token) => sourceTokens.some((candidate) => evidenceTokensMatch(token, candidate)));
        return matchesAssertedIngredient
          && matchesAssertedBenefit
          && explicitIngredientBenefitRelationPattern.test(clause);
      }));
  });
}

/**
 * A product can be the subject of two parallel facts in one fluent clause:
 * it includes a formula component and it supports a finished-product benefit.
 * That grammar does not make the ingredient the cause of the benefit. Keep
 * causal bridges (through, based on, powered by, 통해, 기반) outside this
 * exception so relationship evidence is still required for them.
 */
function isParallelProductCompositionBenefitClause(clause: string, product: PdpProductSignal): boolean {
  const hasProductSubject = [product.name, product.originalName]
    .filter((value): value is string => Boolean(cleanText(value ?? "")))
    .some((entity) => normalizeEntityMention(clause).includes(normalizeEntityMention(entity)))
    || /\b(?:the|this)\s+product\b|(?:이|해당)\s*제품(?:은|는|이|가)|本品(?:は|が)/iu.test(clause);
  if (!hasProductSubject) return false;
  if (/\b(?:through|via|based\s+on|powered\s+by|because\s+of)\b|(?:통해|기반(?:으로)?|바탕으로|덕분에|때문에|로\s*인해)|(?:を通じ|に基づ|によって)/iu.test(clause)) {
    return false;
  }
  return /(?:포함|함유|배합)(?:하고|하며|해\s*있고|되어\s*있고|하고\s*있으며)[^.!?。！？;；\n]{0,140}(?:도와|돕|지원)|\b(?:includes?|contains?|features?)\b[^.!?]{0,140}\band\b[^.!?]{0,100}\b(?:helps?|supports?|provides?)\b|(?:配合|含有|含み)[^。！？]{0,140}(?:かつ|し、|して)[^。！？]{0,100}(?:助け|支え)/iu.test(clause);
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
  const sameIntent = normalizeForMatch(left.intent) !== "" && normalizeForMatch(left.intent) === normalizeForMatch(right.intent);
  const sameCep = normalizeForMatch(left.cep) !== "" && normalizeForMatch(left.cep) === normalizeForMatch(right.cep);
  return normalizeForMatch(left.question) === normalizeForMatch(right.question)
    || (sameIntent && sameCep)
    // A raw whole-vocabulary overlap ratio is diluted by tokens the two
    // questions share only because they both name the product (brand,
    // product name, category words repeat in almost every FAQ question).
    // A narrower question whose meaningful, stopword-and-particle-stripped
    // tokens are (almost) entirely covered by a broader one asks the same
    // thing with less detail -- e.g. "what are the ingredients and
    // benefits" duplicates "what are the main benefits" -- so route through
    // the same containment-based similarity check used elsewhere for
    // near-duplicate evidence/claim text instead of a bespoke keyword rule.
    || textsAreTooSimilar(left.question, right.question);
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

function isReviewDerivedUsageText(value: string, product: PdpProductSignal): boolean {
  const candidate = normalizeForMatch(value);
  if (!candidate) return false;
  if (/(?:customer\s+review|reviewer|고객\s*리뷰|구매\s*후기|리뷰\s*(?:내용|작성)|カスタマーレビュー)/iu.test(value)) {
    return true;
  }
  return [
    ...product.reviews.items.map((item) => item.body),
    ...product.reviews.keywords
  ].some((review) => {
    const key = normalizeForMatch(review);
    return Boolean(key) && (candidate === key || Math.min(candidate.length, key.length) >= 12 && (candidate.includes(key) || key.includes(candidate)));
  });
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
