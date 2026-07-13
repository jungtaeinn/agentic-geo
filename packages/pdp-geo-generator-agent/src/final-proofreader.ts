import { z } from "zod";
import { validatePdpGeoArtifacts } from "./validate";
import type {
  JsonObject,
  PdpGeoAtomicEvidence,
  PdpGeoContentArtifact,
  PdpGeoContentPlan,
  PdpGeoEvidence,
  PdpGeoFinalProofreader,
  PdpGeoFinalProofreadingDiagnostics,
  PdpGeoFinalProofreadingEdit,
  PdpGeoFinalProofreadingField,
  PdpGeoFinalProofreadingFieldPath,
  PdpGeoFinalProofreadingIssueCode,
  PdpGeoFinalProofreadingRequest,
  PdpGeoFinalProofreadingResult,
  PdpGeoFinalProofreadingSkippedField,
  PdpGeoGeneratorOptions,
  PdpGeoLocale,
  PdpGeoPublicCopyProvenance,
  PdpGeoSchemaMarkup,
  PdpGeoTokenUsage,
  PdpProductSignal
} from "./types";

const FINAL_PROOFREADING_TIMEOUT_MS = 90_000;
const DEFAULT_FINAL_PROOFREADING_MAX_OUTPUT_TOKENS = 6_000;
const finalProofreadingIssueCodes: PdpGeoFinalProofreadingIssueCode[] = [
  "awkward",
  "grammar",
  "duplicate-sentence",
  "duplicate-word",
  "punctuation"
];

const finalProofreadingEditSchema = z.object({
  fieldPath: z.string(),
  sourceHash: z.string(),
  action: z.enum(["keep", "revise"]),
  revisedText: z.string(),
  issueCodes: z.array(z.enum(finalProofreadingIssueCodes))
}).strict();

const finalProofreadingResultSchema = z.object({
  edits: z.array(finalProofreadingEditSchema),
  warnings: z.array(z.string())
}).strict();

export const pdpGeoFinalProofreadingJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    edits: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          fieldPath: { type: "string" },
          sourceHash: { type: "string" },
          action: { type: "string", enum: ["keep", "revise"] },
          revisedText: { type: "string" },
          issueCodes: { type: "array", items: { type: "string", enum: finalProofreadingIssueCodes } }
        },
        required: ["fieldPath", "sourceHash", "action", "revisedText", "issueCodes"]
      }
    },
    warnings: { type: "array", items: { type: "string" } }
  },
  required: ["edits", "warnings"]
} as const;

export interface PdpGeoFinalProofreadingApplicationInput {
  product: PdpProductSignal;
  locale: PdpGeoLocale;
  market?: string;
  schemaMarkup: PdpGeoSchemaMarkup;
  content: PdpGeoContentArtifact;
  evidenceLedger: PdpGeoAtomicEvidence[];
  contentPlan?: PdpGeoContentPlan;
  publicCopyProvenance?: PdpGeoPublicCopyProvenance[];
}

export interface PdpGeoFinalProofreadingApplication {
  schemaMarkup: PdpGeoSchemaMarkup;
  content: PdpGeoContentArtifact;
  evidence: PdpGeoEvidence[];
  usage?: PdpGeoTokenUsage;
  diagnostics: PdpGeoFinalProofreadingDiagnostics;
  finalPublicCopyProvenance: PdpGeoPublicCopyProvenance[];
}

interface ModelBackedFinalProofreaderConfig {
  provider: Exclude<PdpGeoGeneratorOptions["provider"], undefined>;
  apiKey?: string;
  model?: string;
  endpoint?: string;
  deployment?: string;
  apiVersion?: string;
  temperature?: number;
  maxOutputTokens?: number;
}

interface EditableBinding {
  field: PdpGeoFinalProofreadingField;
  kind: "product-description" | "webpage-description" | "faq-question" | "faq-answer" | "howto-step";
  faqIndex?: number;
  stepIndex?: number;
}

/**
 * Captures post-render evidence bindings before any optional copy refiner runs.
 * A later stage may use an entry only while its path, text, and hash still
 * match exactly; a refiner that changes the text therefore invalidates it.
 */
export function createPdpGeoPublicCopyProvenance(input: {
  schemaMarkup: PdpGeoSchemaMarkup;
  contentPlan?: PdpGeoContentPlan;
  evidenceLedger: PdpGeoAtomicEvidence[];
}): PdpGeoPublicCopyProvenance[] {
  const graph = readGraph(input.schemaMarkup.jsonLd);
  const validIds = new Set(input.evidenceLedger.map((item) => item.id));
  const entries: PdpGeoPublicCopyProvenance[] = [];
  const add = (
    fieldPath: PdpGeoFinalProofreadingFieldPath,
    text: string,
    evidenceIds: string[],
    origin: PdpGeoPublicCopyProvenance["origin"],
    sentenceEvidenceIds?: string[][]
  ) => {
    const ids = uniqueText(evidenceIds).filter((id) => validIds.has(id));
    if (!text.trim() || ids.length === 0) return;
    const sentenceIds = sentenceEvidenceIds?.map((sentenceIds) => uniqueText(sentenceIds).filter((id) => validIds.has(id)));
    if (sentenceIds?.some((ids) => ids.length === 0)) return;
    entries.push(createPublicCopyProvenanceEntry(fieldPath, text, ids, origin, sentenceIds));
  };

  const product = graph.find((node) => isSchemaNodeOfType(node, "Product"));
  const productDescription = readString(product, "description");
  if (productDescription) {
    const plannedIds = input.contentPlan?.mode === "model"
      && input.contentPlan.productDescription.include
      && cleanProposedText(input.contentPlan.productDescription.text) === cleanProposedText(productDescription)
      ? input.contentPlan.productDescription.evidenceIds
      : [];
    const plannedEvidence = input.evidenceLedger.filter((item) => plannedIds.includes(item.id));
    const plannedRendered = renderedSentenceEvidence(productDescription, plannedEvidence, [
      "identity", "description", "benefit", "effect", "ingredient", "audience", "metric", "review", "source"
    ]);
    const rendered = renderedSentenceEvidence(productDescription, input.evidenceLedger, [
      "identity", "description", "benefit", "effect", "ingredient", "audience", "metric", "review", "source"
    ]);
    const selected = plannedIds.length > 0 ? plannedRendered : rendered;
    add(
      "Product.description",
      productDescription,
      selected.evidenceIds,
      plannedIds.length > 0 ? "model-plan" : "deterministic-renderer",
      selected.sentenceEvidenceIds
    );
  }

  const webPage = graph.find((node) => isSchemaNodeOfType(node, "WebPage"));
  const webPageDescription = readString(webPage, "description");
  if (webPageDescription) {
    const rendered = renderedSentenceEvidence(webPageDescription, input.evidenceLedger, [
      "identity", "description", "benefit", "effect", "ingredient", "audience", "usage", "metric", "faq", "review", "source"
    ]);
    add(
      "WebPage.description",
      webPageDescription,
      rendered.evidenceIds,
      "deterministic-renderer",
      rendered.sentenceEvidenceIds
    );
  }

  const faqPage = graph.find((node) => isSchemaNodeOfType(node, "FAQPage"));
  if (isRecord(faqPage) && Array.isArray(faqPage.mainEntity)) {
    faqPage.mainEntity.forEach((item, index) => {
      if (!isRecord(item) || typeof item.name !== "string" || !isRecord(item.acceptedAnswer) || typeof item.acceptedAnswer.text !== "string") return;
      const planned = input.contentPlan?.mode === "model" ? input.contentPlan.faq[index] : undefined;
      const directIds = exactRenderedEvidenceIds(`${item.name}\n${item.acceptedAnswer.text}`, input.evidenceLedger, ["faq"]);
      const plannedMatches = Boolean(planned?.include
        && cleanProposedText(planned.question) === cleanProposedText(item.name)
        && cleanProposedText(planned.answer) === cleanProposedText(item.acceptedAnswer.text));
      const plannedEvidence = plannedMatches && planned
        ? input.evidenceLedger.filter((evidence) => planned.evidenceIds.includes(evidence.id))
        : [];
      const plannedQuestion = renderedSentenceEvidence(item.name, plannedEvidence, ["identity", "description", "benefit", "effect", "ingredient", "audience", "usage", "metric", "faq", "review", "source"]);
      const plannedAnswer = renderedSentenceEvidence(item.acceptedAnswer.text, plannedEvidence, ["identity", "description", "benefit", "effect", "ingredient", "audience", "usage", "metric", "faq", "review", "source"]);
      const ids = plannedMatches && planned?.evidenceIds.length ? planned.evidenceIds : directIds;
      const origin = plannedMatches && planned?.evidenceIds.length ? "model-plan" : "deterministic-renderer";
      add(
        `FAQPage.mainEntity[${index}].name`,
        item.name,
        plannedMatches ? plannedQuestion.evidenceIds : ids,
        origin,
        plannedMatches ? plannedQuestion.sentenceEvidenceIds : undefined
      );
      add(
        `FAQPage.mainEntity[${index}].acceptedAnswer.text`,
        item.acceptedAnswer.text,
        plannedMatches ? plannedAnswer.evidenceIds : ids,
        origin,
        plannedMatches ? plannedAnswer.sentenceEvidenceIds : undefined
      );
    });
  }

  const howTo = graph.find((node) => isSchemaNodeOfType(node, "HowTo"));
  if (isRecord(howTo) && Array.isArray(howTo.step)) {
    howTo.step.forEach((item, index) => {
      if (!isRecord(item) || typeof item.text !== "string" || !item.text.trim()) return;
      const planned = input.contentPlan?.howTo.steps[index];
      const directIds = exactRenderedEvidenceIds(item.text, input.evidenceLedger, ["usage"]);
      const plannedMatches = Boolean(planned?.evidenceIds.length
        && cleanProposedText(planned.text) === cleanProposedText(item.text));
      const plannedEvidence = plannedMatches && planned
        ? input.evidenceLedger.filter((evidence) => planned.evidenceIds.includes(evidence.id))
        : [];
      const plannedRendered = renderedSentenceEvidence(item.text, plannedEvidence, ["usage"]);
      const ids = plannedMatches ? plannedRendered.evidenceIds : directIds;
      add(
        `HowTo.step[${index}].text`,
        item.text,
        ids,
        plannedMatches ? "model-plan" : "deterministic-renderer",
        plannedMatches ? plannedRendered.sentenceEvidenceIds : undefined
      );
    });
  }
  return entries;
}

function exactRenderedEvidenceIds(
  text: string,
  evidence: PdpGeoAtomicEvidence[],
  roles: PdpGeoAtomicEvidence["role"][]
): string[] {
  const normalized = normalizeEvidenceText(text);
  return evidence.filter((item) => {
    if (!roles.includes(item.role)) return false;
    const candidate = normalizeEvidenceText(item.text);
    return Boolean(candidate) && (candidate === normalized || candidate.includes(normalized) || normalized.includes(candidate) && candidate.length >= 12);
  }).map((item) => item.id);
}

function renderedSentenceEvidence(
  text: string,
  evidence: PdpGeoAtomicEvidence[],
  roles: PdpGeoAtomicEvidence["role"][]
): { evidenceIds: string[]; sentenceEvidenceIds: string[][] } {
  const eligible = evidence.filter((item) => roles.includes(item.role));
  const sentenceEvidenceIds = splitSentences(text).map((sentence) => {
    const normalizedSentence = normalizeEvidenceText(sentence);
    const lexicalMatches = eligible.filter((item) => {
      const candidate = normalizeEvidenceText(item.text);
      const minimumLength = /[가-힣ぁ-んァ-ン一-龯]/u.test(candidate) ? 2 : 3;
      if (candidate.length < minimumLength) return false;
      const exactEvidenceSentence = splitSentences(item.text)
        .some((evidenceSentence) => normalizeEvidenceText(evidenceSentence) === normalizedSentence);
      if (item.role === "source" || item.role === "description") return exactEvidenceSentence;
      if (item.role === "review" && !/\b(?:review|reviews|customer feedback)\b|(?:고객\s*)?(?:리뷰|후기)/iu.test(sentence)) return false;
      if (candidate === normalizedSentence || exactEvidenceSentence) return true;
      if (!normalizedSentence.includes(candidate)) return false;
      return true;
    });
    return sentenceEvidenceSupportsClaimFrame(sentence, lexicalMatches)
      ? uniqueText(lexicalMatches.map((item) => item.id))
      : [];
  });
  return {
    evidenceIds: uniqueText(sentenceEvidenceIds.flat()),
    sentenceEvidenceIds
  };
}

function sentenceEvidenceSupportsClaimFrame(sentence: string, evidence: PdpGeoAtomicEvidence[]): boolean {
  if (evidence.length === 0) return false;
  const evidenceText = evidence.map((item) => item.text).join(" ");
  const requiredMarkers = strongClaimMarkers(sentence);
  const evidenceMarkers = new Set(strongClaimMarkers(evidenceText));
  if (!requiredMarkers.every((marker) => evidenceMarkers.has(marker))) return false;
  const numericTokens = extractNumericTokens(sentence).map((token) => token.toLocaleLowerCase());
  const evidenceNumericTokens = new Set(extractNumericTokens(evidenceText).map((token) => token.toLocaleLowerCase()));
  if (!numericTokens.every((token) => evidenceNumericTokens.has(token))) return false;
  if (numericTokens.length > 0 && !evidence.some((item) => {
    const itemTokens = new Set(extractNumericTokens(item.text).map((token) => token.toLocaleLowerCase()));
    return numericTokens.every((token) => itemTokens.has(token));
  })) return false;
  const locale: PdpGeoLocale = /[가-힣]/u.test(sentence) ? "ko-KR" : /[ぁ-んァ-ン一-龯]/u.test(sentence) ? "ja-JP" : "en-US";
  const sentenceTokens = substantiveTokenSignature(sentence, locale);
  const evidenceTokens = new Set(substantiveTokenSignature(evidenceText, locale));
  const covered = sentenceTokens.filter((token) => evidenceTokens.has(token)).length;
  const hasFullSentenceEvidence = evidence.some((item) => splitSentences(item.text)
    .some((evidenceSentence) => normalizeEvidenceText(evidenceSentence) === normalizeEvidenceText(sentence)));
  if (!relationSubjectHasAtomicSupport(sentence, evidence, locale)) return false;
  return hasFullSentenceEvidence || sentenceTokens.length > 0 && covered / sentenceTokens.length >= 0.5;
}

function relationSubjectHasAtomicSupport(
  sentence: string,
  evidence: PdpGeoAtomicEvidence[],
  locale: PdpGeoLocale
): boolean {
  const relation = /\b(?:helps?|supports?|improves?|reduces?|increases?|causes?|strengthens?)\b|(?:도움|돕|지원|개선|감소|증가|강화|유발|통해)/iu;
  const match = relation.exec(sentence);
  if (!match || match.index === 0) return true;
  const subjectTokens = substantiveTokenSignature(sentence.slice(0, match.index), locale);
  if (subjectTokens.length === 0) return true;
  const evidenceWithSubject = evidence.filter((item) => {
    const tokens = new Set(substantiveTokenSignature(item.text, locale));
    return subjectTokens.every((token) => tokens.has(token));
  });
  if (evidenceWithSubject.length === 0) return false;
  const productIdentitySubject = evidenceWithSubject.some((item) => item.role === "identity"
    && (item.sourcePath === "product.name" || item.sourcePath === "product.originalName"));
  if (productIdentitySubject) return true;
  const sentenceTokens = substantiveTokenSignature(sentence, locale);
  return evidence.some((item) => {
    const tokens = new Set(substantiveTokenSignature(item.text, locale));
    return sentenceTokens.every((token) => tokens.has(token)) && relation.test(item.text);
  });
}

function strongClaimMarkers(value: string): string[] {
  const text = value.toLocaleLowerCase();
  const patterns: Array<[string, RegExp]> = [
    ["proven", /\bproven\b|입증|검증/gu],
    ["effective", /\beffective\b|효과적/gu],
    ["improve", /\bimprov(?:e|es|ed|ement|ements|ing)\b|개선/gu],
    ["reduce", /\breduc(?:e|es|ed|tion|tions|ing)\b|감소|완화/gu],
    ["increase", /\bincreas(?:e|es|ed|ing)\b|증가|향상/gu],
    ["clinical", /\bclinical(?:ly)?\b|임상/gu]
  ];
  return patterns.flatMap(([label, pattern]) => text.match(pattern)?.map(() => label) ?? []);
}

function normalizeEvidenceText(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase().replace(/[^\p{L}\p{N}%]+/gu, " ").replace(/\s+/g, " ").trim();
}

function createPublicCopyProvenanceEntry(
  fieldPath: PdpGeoFinalProofreadingFieldPath,
  text: string,
  evidenceIds: string[],
  origin: PdpGeoPublicCopyProvenance["origin"],
  sentenceEvidenceIds?: string[][]
): PdpGeoPublicCopyProvenance {
  const normalized = cleanProposedText(text);
  return {
    fieldPath,
    text: normalized,
    sourceHash: stableTextHash(`${fieldPath}\n${normalized}`),
    origin,
    evidenceIds: [...evidenceIds],
    sentences: splitSentences(normalized).map((sentence, index) => ({
      text: sentence,
      sourceHash: stableTextHash(`${fieldPath}#sentence[${index}]\n${sentence}`),
      evidenceIds: [...(sentenceEvidenceIds?.[index] ?? evidenceIds)]
    }))
  };
}

/**
 * Runs one final fluency-only model pass. The model never receives or returns a
 * free-form JSON-LD graph: it can propose text for a fixed, hashed field list
 * only, and every proposal is gated before deterministic re-serialization.
 */
export async function finalProofreadPdpGeoArtifacts(
  input: PdpGeoFinalProofreadingApplicationInput,
  options: PdpGeoGeneratorOptions
): Promise<PdpGeoFinalProofreadingApplication> {
  const base = createBaseApplication(input);
  const extraction = extractFinalProofreadingFields(input);
  const bindings = extraction.bindings;
  base.diagnostics.skippedFields = extraction.skippedFields;
  base.diagnostics.warnings.push(...extraction.skippedFields.map((item) => `${item.fieldPath} was not sent to final proofreading: ${item.reason}`));
  const resolved = resolveFinalProofreader(options);
  if (!resolved.proofreader) {
    if (resolved.warning) {
      base.diagnostics.warnings.push(resolved.warning);
      base.evidence.push({ field: "finalProofreading", source: "llm", value: `Final proofreading skipped: ${resolved.warning}` });
    }
    return base;
  }

  if (bindings.length === 0) {
    base.diagnostics.warnings.push("Final proofreading skipped because no eligible public-copy fields were present.");
    return base;
  }

  const request: PdpGeoFinalProofreadingRequest = {
    locale: input.locale,
    market: input.market,
    productName: input.product.name,
    brand: input.product.brand,
    fields: bindings.map((binding) => binding.field),
    evidenceLedger: input.evidenceLedger
  };

  try {
    const rawResult = await resolved.proofreader.proofread(request);
    const result = normalizeProofreadingResult(rawResult);
    const envelopeFailure = validateProofreadingEnvelope(request.fields, result.edits);
    if (envelopeFailure) {
      return rejectedApplication(base, result, envelopeFailure);
    }

    const gated = gateProposedEdits(bindings, result.edits, input);
    const applied = applyAcceptedEdits(input, bindings, gated.accepted);
    const introducedValidationIssues = gated.accepted.length > 0
      ? findIntroducedValidationIssues(input, applied)
      : [];
    if (introducedValidationIssues.length > 0) {
      const reason = `All proposed edits were reverted because read-only validation found new issues: ${introducedValidationIssues.join(" / ")}`;
      return {
        ...base,
        usage: result.usage,
        evidence: [{ field: "finalProofreading", source: "llm", value: reason }],
        diagnostics: {
          status: "rejected",
          called: true,
          applied: false,
          acceptedFields: [],
          acceptedEdits: [],
          rejectedEdits: [
            ...gated.rejected,
            ...gated.accepted.map((edit) => ({ fieldPath: edit.fieldPath, reason, proposedText: edit.revisedText }))
          ],
          skippedFields: extraction.skippedFields,
          warnings: uniqueText([...base.diagnostics.warnings, ...(result.warnings ?? []), ...gated.rejected.map((item) => item.reason), reason]),
          finalPublicCopyProvenance: base.finalPublicCopyProvenance
        }
      };
    }
    const warnings = uniqueText([
      ...base.diagnostics.warnings,
      ...(result.warnings ?? []),
      ...gated.rejected.map((item) => item.reason)
    ]);
    const acceptedFields = gated.accepted.map((item) => item.fieldPath);
    const bindingByPath = new Map(bindings.map((binding) => [binding.field.fieldPath, binding.field]));
    const acceptedEdits = gated.accepted.flatMap((edit) => {
      const field = bindingByPath.get(edit.fieldPath);
      return field ? [{
        fieldPath: edit.fieldPath,
        sourceHash: field.sourceHash,
        before: field.text,
        after: cleanProposedText(edit.revisedText),
        evidenceIds: [...field.evidenceIds],
        issueCodes: [...edit.issueCodes]
      }] : [];
    });
    const finalPublicCopyProvenance = rebasePublicCopyProvenance(input, gated.accepted);

    return {
      schemaMarkup: applied.schemaMarkup,
      content: applied.content,
      finalPublicCopyProvenance,
      evidence: [
        {
          field: "finalProofreading",
          source: "llm",
          value: acceptedFields.length > 0
            ? `Accepted fluency-only edits for: ${acceptedFields.join(", ")}. No schema fields, facts, evidence IDs, FAQ items, or HowTo steps were added or removed.`
            : "The final proofreader was called, but no proposed text changes passed the invariant gates."
        },
        ...gated.rejected.map((item) => ({
          field: item.fieldPath ? `finalProofreading.${item.fieldPath}` : "finalProofreading",
          source: "llm" as const,
          value: `Rejected: ${item.reason}`
        }))
      ],
      usage: result.usage,
      diagnostics: {
        status: acceptedFields.length > 0 ? "applied" : gated.rejected.length > 0 ? "rejected" : "kept",
        called: true,
        applied: acceptedFields.length > 0,
        acceptedFields,
        acceptedEdits,
        rejectedEdits: gated.rejected,
        skippedFields: extraction.skippedFields,
        warnings,
        finalPublicCopyProvenance
      }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Final proofreading provider failed.";
    return {
      ...base,
      evidence: [{ field: "finalProofreading", source: "llm", value: `Final proofreading failed closed: ${message}` }],
      diagnostics: {
        status: "failed",
        called: true,
        applied: false,
        acceptedFields: [],
        acceptedEdits: [],
        rejectedEdits: [{ reason: message }],
        skippedFields: extraction.skippedFields,
        warnings: uniqueText([...base.diagnostics.warnings, message]),
        finalPublicCopyProvenance: base.finalPublicCopyProvenance
      }
    };
  }
}

function findIntroducedValidationIssues(
  input: PdpGeoFinalProofreadingApplicationInput,
  candidate: { schemaMarkup: PdpGeoSchemaMarkup; content: PdpGeoContentArtifact }
): string[] {
  const baseline = validatePdpGeoArtifacts({
    schemaMarkup: input.schemaMarkup,
    content: input.content,
    fallbackProductName: input.content.sections.productName,
    fallbackDescription: input.content.sections.description,
    locale: input.locale
  });
  const proofread = validatePdpGeoArtifacts({
    schemaMarkup: candidate.schemaMarkup,
    content: candidate.content,
    fallbackProductName: candidate.content.sections.productName,
    fallbackDescription: candidate.content.sections.description,
    locale: input.locale
  });
  const remainingBaseline = new Map<string, number>();
  for (const finding of baseline.validationFindings) {
    const key = validationFindingKey(finding);
    remainingBaseline.set(key, (remainingBaseline.get(key) ?? 0) + 1);
  }
  return proofread.validationFindings.flatMap((finding) => {
    const key = validationFindingKey(finding);
    const remaining = remainingBaseline.get(key) ?? 0;
    if (remaining > 0) {
      remainingBaseline.set(key, remaining - 1);
      return [];
    }
    return [`${finding.field}: ${finding.issue}`];
  });
}

function validationFindingKey(finding: {
  field: string;
  source: string;
  issue: string;
  before?: unknown;
  suggestedAfter?: unknown;
  evidence?: string[];
}): string {
  const isRendererParityFinding = finding.field === "content.html"
    && /Generated HTML was not trusted as final output/iu.test(finding.issue);
  return JSON.stringify([
    finding.field,
    finding.source,
    finding.issue,
    isRendererParityFinding ? undefined : finding.before,
    isRendererParityFinding ? undefined : finding.suggestedAfter,
    finding.evidence ?? []
  ]);
}

export class ModelBackedFinalProofreader implements PdpGeoFinalProofreader {
  constructor(private readonly config: ModelBackedFinalProofreaderConfig) {}

  async proofread(request: PdpGeoFinalProofreadingRequest): Promise<PdpGeoFinalProofreadingResult> {
    const prompt = createFinalProofreadingPrompt(request);
    switch (this.config.provider) {
      case "openai":
        return this.openAi(prompt);
      case "gemini":
        return this.gemini(prompt);
      case "azure-openai":
        return this.chatCompletions(prompt, "azure-openai");
      case "aistudio":
        return this.chatCompletions(prompt, "aistudio");
      case "mock":
      case "custom":
      default:
        throw new Error(`${this.config.provider} final proofreading requires customFinalProofreader.`);
    }
  }

  private async openAi(prompt: { system: string; user: string }): Promise<PdpGeoFinalProofreadingResult> {
    if (!this.config.apiKey || !this.config.model) {
      throw new Error("OpenAI API key and model are required for final proofreading.");
    }
    const payload = await requestJsonWithTemperatureFallback(
      "https://api.openai.com/v1/responses",
      { Authorization: `Bearer ${this.config.apiKey}` },
      {
        model: this.config.model,
        instructions: prompt.system,
        input: prompt.user,
        ...temperatureBody(this.config.temperature),
        max_output_tokens: this.config.maxOutputTokens ?? DEFAULT_FINAL_PROOFREADING_MAX_OUTPUT_TOKENS,
        text: {
          format: {
            type: "json_schema",
            name: "pdp_geo_final_proofreading",
            strict: true,
            schema: pdpGeoFinalProofreadingJsonSchema
          }
        }
      },
      "OpenAI final proofreading"
    );
    return {
      ...parseFinalProofreadingText(providerText(payload)),
      usage: tokenUsageFromOpenAi(payload.usage)
    };
  }

  private async gemini(prompt: { system: string; user: string }): Promise<PdpGeoFinalProofreadingResult> {
    if (!this.config.apiKey || !this.config.model) {
      throw new Error("Gemini API key and model are required for final proofreading.");
    }
    const response = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.config.model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": this.config.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: prompt.system }] },
        contents: [{ role: "user", parts: [{ text: prompt.user }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: toGeminiSchema(pdpGeoFinalProofreadingJsonSchema),
          ...temperatureBody(this.config.temperature),
          maxOutputTokens: this.config.maxOutputTokens ?? DEFAULT_FINAL_PROOFREADING_MAX_OUTPUT_TOKENS
        }
      })
    }, "Gemini final proofreading");
    if (!response.ok) {
      throw new Error(`Gemini final proofreading failed: ${response.status}${await responseErrorSuffix(response)}`);
    }
    const payload = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: unknown;
    };
    const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("\n") ?? "";
    return { ...parseFinalProofreadingText(text), usage: tokenUsageFromGemini(payload.usageMetadata) };
  }

  private async chatCompletions(
    prompt: { system: string; user: string },
    provider: "azure-openai" | "aistudio"
  ): Promise<PdpGeoFinalProofreadingResult> {
    if (!this.config.apiKey || !this.config.endpoint || !this.config.deployment) {
      throw new Error(`${provider} endpoint, API key, and deployment are required for final proofreading.`);
    }
    const endpoint = this.config.endpoint.replace(/\/$/, "");
    const apiVersion = this.config.apiVersion ?? (provider === "azure-openai" ? "2025-04-01-preview" : undefined);
    const query = apiVersion ? `?api-version=${encodeURIComponent(apiVersion)}` : "";
    const url = `${endpoint}/openai/deployments/${encodeURIComponent(this.config.deployment)}/chat/completions${query}`;
    const payload = await requestJsonWithTemperatureFallback(
      url,
      provider === "azure-openai" ? { "api-key": this.config.apiKey } : { Authorization: `Bearer ${this.config.apiKey}` },
      {
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user }
        ],
        ...temperatureBody(this.config.temperature),
        max_completion_tokens: this.config.maxOutputTokens ?? DEFAULT_FINAL_PROOFREADING_MAX_OUTPUT_TOKENS,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "pdp_geo_final_proofreading",
            strict: true,
            schema: pdpGeoFinalProofreadingJsonSchema
          }
        }
      },
      `${provider} final proofreading`
    );
    return {
      ...parseFinalProofreadingText(providerText(payload)),
      usage: tokenUsageFromChatCompletions(payload.usage)
    };
  }
}

function createBaseApplication(input: PdpGeoFinalProofreadingApplicationInput): PdpGeoFinalProofreadingApplication {
  const finalPublicCopyProvenance = validCurrentPublicCopyProvenance(input);
  return {
    schemaMarkup: input.schemaMarkup,
    content: input.content,
    evidence: [],
    finalPublicCopyProvenance,
    diagnostics: {
      status: "skipped",
      called: false,
      applied: false,
      acceptedFields: [],
      acceptedEdits: [],
      rejectedEdits: [],
      skippedFields: [],
      warnings: [],
      finalPublicCopyProvenance
    }
  };
}

function rejectedApplication(
  base: PdpGeoFinalProofreadingApplication,
  result: PdpGeoFinalProofreadingResult,
  reason: string
): PdpGeoFinalProofreadingApplication {
  return {
    ...base,
    usage: result.usage,
    evidence: [{ field: "finalProofreading", source: "llm", value: `Final proofreading response rejected as a whole: ${reason}` }],
    diagnostics: {
      status: "rejected",
      called: true,
      applied: false,
      acceptedFields: [],
      acceptedEdits: [],
      rejectedEdits: [{ reason }],
      skippedFields: base.diagnostics.skippedFields,
      warnings: uniqueText([...(result.warnings ?? []), reason]),
      finalPublicCopyProvenance: base.finalPublicCopyProvenance
    }
  };
}

function validCurrentPublicCopyProvenance(
  input: PdpGeoFinalProofreadingApplicationInput
): PdpGeoPublicCopyProvenance[] {
  const validIds = new Set(input.evidenceLedger.map((item) => item.id));
  const current = publicCopyTextByPath(input.schemaMarkup.jsonLd);
  return (input.publicCopyProvenance ?? []).filter((entry) => {
    const text = current.get(entry.fieldPath);
    const sentences = splitSentences(cleanProposedText(entry.text));
    const sentencesValid = entry.sentences.length === sentences.length
      && entry.sentences.every((sentence, index) => (
        cleanProposedText(sentence.text) === sentences[index]
        && sentence.sourceHash === stableTextHash(`${entry.fieldPath}#sentence[${index}]\n${sentences[index]}`)
        && sentence.evidenceIds.length > 0
        && sentence.evidenceIds.every((id) => validIds.has(id))
      ));
    return Boolean(text)
      && cleanProposedText(text ?? "") === cleanProposedText(entry.text)
      && entry.sourceHash === stableTextHash(`${entry.fieldPath}\n${cleanProposedText(entry.text)}`)
      && entry.evidenceIds.length > 0
      && entry.evidenceIds.every((id) => validIds.has(id))
      && sentencesValid;
  }).map((entry) => ({
    ...entry,
    evidenceIds: [...entry.evidenceIds],
    sentences: entry.sentences.map((sentence) => ({ ...sentence, evidenceIds: [...sentence.evidenceIds] }))
  }));
}

function rebasePublicCopyProvenance(
  input: PdpGeoFinalProofreadingApplicationInput,
  edits: PdpGeoFinalProofreadingEdit[]
): PdpGeoPublicCopyProvenance[] {
  const editsByPath = new Map(edits.map((edit) => [edit.fieldPath, cleanProposedText(edit.revisedText)]));
  return validCurrentPublicCopyProvenance(input).map((entry) => {
    const revised = editsByPath.get(entry.fieldPath);
    return revised
      ? createPublicCopyProvenanceEntry(
          entry.fieldPath,
          revised,
          entry.evidenceIds,
          entry.origin,
          rebaseSentenceEvidenceIds(entry, revised)
        )
      : entry;
  });
}

function rebaseSentenceEvidenceIds(entry: PdpGeoPublicCopyProvenance, revised: string): string[][] {
  const sentences = splitSentences(revised);
  if (sentences.length === entry.sentences.length) {
    return entry.sentences.map((sentence) => [...sentence.evidenceIds]);
  }
  return sentences.map((sentence) => {
    const key = normalizeEvidenceText(sentence);
    return [...(entry.sentences.find((source) => normalizeEvidenceText(source.text) === key)?.evidenceIds ?? entry.evidenceIds)];
  });
}

function publicCopyTextByPath(jsonLd: JsonObject): Map<PdpGeoFinalProofreadingFieldPath, string> {
  const values = new Map<PdpGeoFinalProofreadingFieldPath, string>();
  const graph = readGraph(jsonLd);
  const product = graph.find((node) => isSchemaNodeOfType(node, "Product"));
  const webPage = graph.find((node) => isSchemaNodeOfType(node, "WebPage"));
  const productDescription = readString(product, "description");
  const webPageDescription = readString(webPage, "description");
  if (productDescription) values.set("Product.description", productDescription);
  if (webPageDescription) values.set("WebPage.description", webPageDescription);
  const faqPage = graph.find((node) => isSchemaNodeOfType(node, "FAQPage"));
  if (isRecord(faqPage) && Array.isArray(faqPage.mainEntity)) {
    faqPage.mainEntity.forEach((item, index) => {
      if (!isRecord(item)) return;
      if (typeof item.name === "string") values.set(`FAQPage.mainEntity[${index}].name`, item.name);
      if (isRecord(item.acceptedAnswer) && typeof item.acceptedAnswer.text === "string") {
        values.set(`FAQPage.mainEntity[${index}].acceptedAnswer.text`, item.acceptedAnswer.text);
      }
    });
  }
  const howTo = graph.find((node) => isSchemaNodeOfType(node, "HowTo"));
  if (isRecord(howTo) && Array.isArray(howTo.step)) {
    howTo.step.forEach((item, index) => {
      if (isRecord(item) && typeof item.text === "string") values.set(`HowTo.step[${index}].text`, item.text);
    });
  }
  return values;
}

function resolveFinalProofreader(options: PdpGeoGeneratorOptions): { proofreader?: PdpGeoFinalProofreader; warning?: string } {
  if (options.finalProofreading?.enabled === false) return {};
  if (options.customFinalProofreader) return { proofreader: options.customFinalProofreader };
  const settings = options.finalProofreading;
  if (!settings) return {};
  const provider = settings.provider ?? options.provider ?? "mock";
  const mayInheritProviderSettings = settings.provider === undefined || settings.provider === options.provider;
  const apiKey = settings.apiKey ?? (mayInheritProviderSettings ? options.apiKey : undefined);
  const enabled = settings.enabled ?? (provider !== "mock" && provider !== "custom" && Boolean(apiKey));
  if (!enabled) return {};
  if (provider === "mock" || provider === "custom") {
    return { warning: `${provider} final proofreading requires customFinalProofreader.` };
  }
  return {
    proofreader: new ModelBackedFinalProofreader({
      provider,
      apiKey,
      model: settings.model ?? (mayInheritProviderSettings ? options.model : undefined),
      endpoint: settings.endpoint ?? (mayInheritProviderSettings ? options.endpoint : undefined),
      deployment: settings.deployment
        ?? (mayInheritProviderSettings
          ? options.deployments?.proofreading ?? options.deployments?.reasoning ?? options.deployment
          : undefined),
      apiVersion: settings.apiVersion ?? (mayInheritProviderSettings ? options.apiVersion : undefined),
      temperature: options.temperature,
      maxOutputTokens: settings.maxOutputTokens
    })
  };
}

function createFinalProofreadingPrompt(request: PdpGeoFinalProofreadingRequest): { system: string; user: string } {
  return {
    system: [
      "You are the final fluency-only proofreader for already approved product schema copy.",
      "This is not a reasoning, fact-selection, SEO expansion, translation, or claim-writing task.",
      "Return exactly one edit for every input field, in the same order, with the exact fieldPath and sourceHash.",
      "Use action=keep and return the original text unchanged when no safe correction is necessary.",
      "You may automatically revise punctuation/spacing, remove an adjacent exact duplicate word or sentence, and make only narrow meaning-preserving grammar corrections.",
      "Allowed grammar corrections are: English a/an selection, same-tense subject-verb agreement, approved present-tense claim-verb agreement, and FAQ auxiliary inversion; Korean same-role particle allomorphs and approved sentence-final polite style inflections.",
      "Use issueCodes=[grammar] for those narrow grammar corrections. Do not add or remove articles/prepositions, change tense/voice/modality, reorder content words, or change Korean particle roles.",
      "If any other naturalness, grammar, or awkward word-order fix is needed, use action=keep with the original text and add a concise field-specific warning instead of rewriting it.",
      "Never add, remove, generalize, narrow, strengthen, weaken, translate, or reconnect any factual statement.",
      "Preserve product and brand names, ingredient and technology names, numbers, units, signs, periods, populations, test/review attribution, negation, uncertainty, and claim modality exactly.",
      "Never create an ingredient-to-benefit relationship, suitability claim, efficacy claim, comparison, routine order, review consensus, or market claim that the original field did not state.",
      "Product.description must keep its existing semantic role order. WebPage.description must remain page/brand/information-scope copy rather than becoming another product description.",
      "FAQ question intent and its paired answer must not change. Do not add, remove, merge, split, or reorder FAQ items.",
      "HowTo fields are punctuation-only: do not change words, actions, amounts, timing, body area, count, or order.",
      "Do not edit reviewBody, names, offers, URLs, identifiers, or schema structure; those fields are intentionally absent.",
      "Write in the existing target locale only. Evidence IDs and immutable tokens are read-only constraints, not material for adding facts.",
      "Return only the strict structured JSON requested by the response schema."
    ].join("\n"),
    user: JSON.stringify({
      locale: request.locale,
      market: request.market,
      productName: request.productName,
      brand: request.brand,
      fields: request.fields
    })
  };
}

function extractFinalProofreadingFields(input: PdpGeoFinalProofreadingApplicationInput): {
  bindings: EditableBinding[];
  skippedFields: PdpGeoFinalProofreadingSkippedField[];
} {
  const graph = readGraph(input.schemaMarkup.jsonLd);
  const bindings: EditableBinding[] = [];
  const skippedFields: PdpGeoFinalProofreadingSkippedField[] = [];
  const product = graph.find((node) => isSchemaNodeOfType(node, "Product"));
  const webPage = graph.find((node) => isSchemaNodeOfType(node, "WebPage"));
  const productDescription = readString(product, "description");
  const webPageDescription = readString(webPage, "description");

  if (productDescription && cleanProposedText(input.content.sections.description) === cleanProposedText(productDescription)) {
    const binding = createBinding(
      "Product.description",
      productDescription,
      "fluency-only",
      input,
      "product-description"
    );
    if (binding.field.evidenceIds.length > 0) bindings.push(binding);
    else skippedFields.push({ fieldPath: "Product.description", reason: "no exact final-text, sentence-hash, and evidence-ID provenance binding was available" });
  } else if (productDescription) {
    skippedFields.push({ fieldPath: "Product.description", reason: "schema and visible Product.description text were not identical" });
  }
  if (webPageDescription) {
    const binding = createBinding(
      "WebPage.description",
      webPageDescription,
      "fluency-only",
      input,
      "webpage-description"
    );
    if (binding.field.evidenceIds.length > 0) bindings.push(binding);
    else skippedFields.push({ fieldPath: "WebPage.description", reason: "no exact final-text, sentence-hash, and evidence-ID provenance binding was available" });
  }

  const faqPage = graph.find((node) => isSchemaNodeOfType(node, "FAQPage"));
  if (isRecord(faqPage) && Array.isArray(faqPage.mainEntity)) {
    faqPage.mainEntity.forEach((item, index) => {
      if (!isRecord(item)) return;
      const question = typeof item.name === "string" ? item.name.trim() : "";
      const answerNode = isRecord(item.acceptedAnswer) ? item.acceptedAnswer : undefined;
      const answer = answerNode && typeof answerNode.text === "string" ? answerNode.text.trim() : "";
      if (!question || !answer) return;
      const questionPath = `FAQPage.mainEntity[${index}].name` as const;
      const answerPath = `FAQPage.mainEntity[${index}].acceptedAnswer.text` as const;
      if (!input.content.sections.faq.includes(question) || !input.content.sections.faq.includes(answer)) {
        skippedFields.push(
          { fieldPath: questionPath, reason: "schema and visible FAQ pair text were not identical" },
          { fieldPath: answerPath, reason: "schema and visible FAQ pair text were not identical" }
        );
        return;
      }
      const questionBinding: EditableBinding = {
        ...createBinding(questionPath, question, "fluency-only", input, "faq-question", index, answer),
        faqIndex: index
      };
      const answerBinding: EditableBinding = {
        ...createBinding(answerPath, answer, "fluency-only", input, "faq-answer", index, question),
        faqIndex: index
      };
      if (questionBinding.field.evidenceIds.length > 0 && answerBinding.field.evidenceIds.length > 0) {
        bindings.push(questionBinding, answerBinding);
      } else {
        skippedFields.push(
          { fieldPath: questionPath, reason: "FAQ question and answer require an exact provenance binding as one atomic pair" },
          { fieldPath: answerPath, reason: "FAQ question and answer require an exact provenance binding as one atomic pair" }
        );
      }
    });
  }

  const howTo = graph.find((node) => isSchemaNodeOfType(node, "HowTo"));
  if (isRecord(howTo) && Array.isArray(howTo.step)) {
    howTo.step.forEach((item, index) => {
      if (!isRecord(item) || typeof item.text !== "string" || !item.text.trim()) return;
      const fieldPath = `HowTo.step[${index}].text` as const;
      if (!input.content.sections.howToUse.includes(item.text.trim())) {
        skippedFields.push({ fieldPath, reason: "schema and visible HowTo step text were not identical" });
        return;
      }
      const binding: EditableBinding = {
        ...createBinding(fieldPath, item.text.trim(), "punctuation-only", input, "howto-step", index),
        stepIndex: index
      };
      if (binding.field.evidenceIds.length > 0) bindings.push(binding);
      else skippedFields.push({ fieldPath, reason: "no exact final-text, sentence-hash, and usage-evidence provenance binding was available" });
    });
  }
  return { bindings, skippedFields };
}

function createBinding(
  fieldPath: PdpGeoFinalProofreadingFieldPath,
  text: string,
  constraint: PdpGeoFinalProofreadingField["constraint"],
  input: PdpGeoFinalProofreadingApplicationInput,
  kind: EditableBinding["kind"],
  index?: number,
  pairedText?: string
): EditableBinding {
  const validEvidenceIds = new Set(input.evidenceLedger.map((item) => item.id));
  const normalizedText = cleanProposedText(text);
  const expectedHash = stableTextHash(`${fieldPath}\n${normalizedText}`);
  const provenance = input.publicCopyProvenance?.find((item) => (
    item.fieldPath === fieldPath
    && cleanProposedText(item.text) === normalizedText
    && item.sourceHash === expectedHash
  ));
  return {
    kind,
    field: {
      fieldPath,
      sourceHash: expectedHash,
      text: normalizedText,
      constraint,
      evidenceIds: (provenance?.evidenceIds ?? []).filter((id) => validEvidenceIds.has(id)),
      immutableTokens: createImmutableTokens(text, input.product, input.content.sections.productName)
    }
  };
}

function createImmutableTokens(text: string, product: PdpProductSignal, publicProductName: string): string[] {
  const candidates = uniqueText([
    publicProductName,
    product.name,
    product.originalName,
    product.brand,
    ...product.ingredients,
    ...(product.semanticFacts?.ingredients ?? []),
    ...(product.semanticFacts?.ingredientBenefitLinks ?? []).map((item) => item.ingredient),
    ...extractNumericTokens(text),
    ...extractIdentifierTokens(text)
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0));
  return candidates
    .filter((candidate) => normalizedIncludes(text, candidate))
    .sort((left, right) => right.length - left.length);
}

function validateProofreadingEnvelope(
  fields: PdpGeoFinalProofreadingField[],
  edits: PdpGeoFinalProofreadingEdit[]
): string | undefined {
  if (fields.length !== edits.length) {
    return `Expected ${fields.length} field edits but received ${edits.length}; the entire response was discarded.`;
  }
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    const edit = edits[index];
    if (!field || !edit || edit.fieldPath !== field.fieldPath || edit.sourceHash !== field.sourceHash) {
      return `Field path/order/source hash mismatch at index ${index}; the entire response was discarded.`;
    }
    if (edit.action === "keep" && edit.revisedText !== field.text) {
      return `${field.fieldPath} used action=keep but changed the text; the entire response was discarded.`;
    }
    if (edit.action === "keep" && edit.issueCodes.length > 0) {
      return `${field.fieldPath} reported issues while using action=keep; the entire response was discarded.`;
    }
    if (edit.action === "revise" && edit.issueCodes.length === 0) {
      return `${field.fieldPath} proposed a revision without an allowed fluency issue code; the entire response was discarded.`;
    }
  }
  return undefined;
}

function gateProposedEdits(
  bindings: EditableBinding[],
  edits: PdpGeoFinalProofreadingEdit[],
  input: PdpGeoFinalProofreadingApplicationInput
): {
  accepted: PdpGeoFinalProofreadingEdit[];
  rejected: PdpGeoFinalProofreadingDiagnostics["rejectedEdits"];
} {
  const accepted: PdpGeoFinalProofreadingEdit[] = [];
  const rejected: PdpGeoFinalProofreadingDiagnostics["rejectedEdits"] = [];
  const acceptedByPath = new Map<PdpGeoFinalProofreadingFieldPath, PdpGeoFinalProofreadingEdit>();
  const rejectedFaqIndexes = new Set<number>();

  edits.forEach((edit, index) => {
    const binding = bindings[index];
    if (!binding || edit.action === "keep" || edit.revisedText === binding.field.text) return;
    const reason = proofreadingRejectionReason(
      binding,
      edit,
      input.locale,
      input.product
    );
    if (reason) {
      rejected.push({ fieldPath: binding.field.fieldPath, reason, proposedText: edit.revisedText });
      if (binding.faqIndex !== undefined) rejectedFaqIndexes.add(binding.faqIndex);
      return;
    }
    acceptedByPath.set(binding.field.fieldPath, edit);
  });

  for (const binding of bindings) {
    const edit = acceptedByPath.get(binding.field.fieldPath);
    if (!edit) continue;
    if (binding.faqIndex !== undefined && rejectedFaqIndexes.has(binding.faqIndex)) {
      rejected.push({
        fieldPath: binding.field.fieldPath,
        reason: "FAQ question and answer edits are atomic; both were reverted because one field failed an invariant gate.",
        proposedText: edit.revisedText
      });
      continue;
    }
    accepted.push(edit);
  }
  return { accepted, rejected };
}

function proofreadingRejectionReason(
  binding: EditableBinding,
  edit: PdpGeoFinalProofreadingEdit,
  locale: PdpGeoLocale,
  product: PdpProductSignal
): string | undefined {
  const original = binding.field.text;
  if (containsUnsafeUnicode(edit.revisedText)) return "The proposal contained a Unicode control, bidi, or zero-width formatting character.";
  const candidate = cleanProposedText(edit.revisedText);
  if (!candidate) return "The proposed text was empty.";
  if (binding.field.evidenceIds.length === 0) return "The finalized field no longer has an exact evidence-ID binding; the edit was rejected.";
  if (!isTargetLocaleCompatible(original, candidate, locale)) return "The proposal changed or mixed the target locale.";
  if (candidate.length > original.length * 1.15 + 12) return "The proposal expanded the copy beyond fluency-only editing.";
  const minimumRatio = binding.kind === "faq-question" ? 0.55 : 0.35;
  if (candidate.length < original.length * minimumRatio) return "The proposal removed too much source meaning for a fluency-only edit.";
  if (binding.field.constraint === "punctuation-only" && stripPunctuation(candidate) !== stripPunctuation(original)) {
    return "HowTo text may change punctuation or spacing only.";
  }
  for (const token of binding.field.immutableTokens) {
    if (!candidate.includes(token)) return `Immutable token was removed or changed: ${token}`;
  }
  if (!sameOrderedUniqueTokens(extractNumericTokens(original), extractNumericTokens(candidate))) {
    return "A number, sign, unit, duration, population, or measured-value token changed.";
  }
  if (!sameClaimModality(original, candidate)) {
    return "Negation, uncertainty, attribution, causality, or claim strength changed.";
  }
  if (!sameReviewScope(original, candidate)) {
    return "Customer-review attribution or single-versus-aggregate review scope changed.";
  }
  if (introducesIngredientCausality(original, candidate, product)) {
    return "The proposal introduced a new ingredient-to-benefit or causal relationship.";
  }
  if (!preservesTerminalSpeechActs(original, candidate)) {
    return "A statement, question, command, or exclamation was changed into a different speech act.";
  }
  if (protectedPunctuationSignature(original) !== protectedPunctuationSignature(candidate)) {
    return "Quote, bracket, colon, semicolon, slash, or dash scope changed.";
  }
  if (!sameSubstantiveTokenSignature(original, candidate, locale)) {
    return "A customer concern, benefit, ingredient/technology, usage condition, or other substantive fact token changed.";
  }
  if (!preservesSentenceSemanticUnits(original, candidate, locale)) {
    return "Sentence-level facts or their required order changed.";
  }
  const surfaceEdit = classifyConstrainedFluencyTransformation(original, candidate, locale, binding.kind, product);
  if (!surfaceEdit.allowed) {
    return "The proposal was not explainable by the closed fluency allowlist; factual words, relations, tense, voice, and content-word order must remain unchanged.";
  }
  const missingIssueCode = surfaceEdit.requiredIssueCodes.find((code) => !edit.issueCodes.includes(code));
  if (missingIssueCode) {
    return `The proposal performed ${missingIssueCode} cleanup without declaring the matching issue code.`;
  }
  if (binding.kind === "webpage-description" && hasPageRole(original) && !hasPageRole(candidate)) {
    return "WebPage.description lost its page-level role.";
  }
  if (binding.kind === "product-description" && !hasPageRole(original) && hasPageRole(candidate)) {
    return "Product.description was changed into page-level copy.";
  }
  if (binding.kind === "faq-question" && /[?？]\s*$/.test(original) && !/[?？]\s*$/.test(candidate)) {
    return "The FAQ question is no longer a question.";
  }
  if (sentenceCount(candidate) > sentenceCount(original)) {
    return "The proposal added or split sentences instead of only proofreading them.";
  }
  if (removesDistinctSentence(original, candidate, locale)) {
    return "The proposal removed a distinct sentence rather than a proven duplicate sentence.";
  }
  const threshold = binding.kind === "faq-question" ? 0.52 : 0.42;
  if (textSimilarity(original, candidate) < threshold) {
    return "The proposal changed too much substantive wording for a fluency-only edit.";
  }
  return undefined;
}

function classifyConstrainedFluencyTransformation(
  original: string,
  candidate: string,
  locale: PdpGeoLocale,
  kind: EditableBinding["kind"],
  product: PdpProductSignal
): { allowed: boolean; requiredIssueCodes: PdpGeoFinalProofreadingIssueCode[] } {
  const surface = classifySurfaceOnlyTransformation(original, candidate);
  if (surface.allowed) return surface;
  if (kind === "howto-step") return { allowed: false, requiredIssueCodes: [] };
  if (locale === "en-US" || locale === "en-GB") {
    return isAllowedEnglishGrammarTransformation(original, candidate, kind, product)
      ? { allowed: true, requiredIssueCodes: ["grammar"] }
      : { allowed: false, requiredIssueCodes: [] };
  }
  if (locale === "ko-KR") {
    return isAllowedKoreanGrammarTransformation(original, candidate)
      ? { allowed: true, requiredIssueCodes: ["grammar"] }
      : { allowed: false, requiredIssueCodes: [] };
  }
  return { allowed: false, requiredIssueCodes: [] };
}

const englishAgreementGroups: Record<string, string> = {
  a: "article-indefinite",
  an: "article-indefinite",
  am: "be-present",
  is: "be-present",
  are: "be-present",
  was: "be-past",
  were: "be-past",
  has: "have-present",
  have: "have-present",
  do: "do-present",
  does: "do-present"
};

const englishClaimAgreementLemmas = new Set([
  "contain", "include", "feature", "provide", "support", "help", "show", "mention", "indicate", "present", "cover"
]);

function isAllowedEnglishGrammarTransformation(
  original: string,
  candidate: string,
  kind: EditableBinding["kind"],
  product: PdpProductSignal
): boolean {
  const originalSentences = splitSentences(original);
  const candidateSentences = splitSentences(candidate);
  if (originalSentences.length !== candidateSentences.length) return false;
  let operationCount = 0;
  for (let index = 0; index < originalSentences.length; index += 1) {
    const leftRaw = englishCasedWordTokens(originalSentences[index] ?? "");
    const rightRaw = englishCasedWordTokens(candidateSentences[index] ?? "");
    const left = leftRaw.map((token) => token.toLocaleLowerCase());
    const right = rightRaw.map((token) => token.toLocaleLowerCase());
    if (left.length !== right.length) return false;
    const direct = classifyEnglishAgreementTokens(left, right, leftRaw, rightRaw, product, kind);
    if (direct !== undefined) {
      operationCount += direct;
      continue;
    }
    if (kind !== "faq-question" || originalSentences.length !== 1 || !isAllowedFaqAuxiliaryInversion(left, right, product)) {
      return false;
    }
    operationCount += 1;
  }
  return operationCount >= 1 && operationCount <= 3;
}

function englishWordTokens(value: string): string[] {
  return englishCasedWordTokens(value).map((token) => token.toLocaleLowerCase());
}

function englishCasedWordTokens(value: string): string[] {
  return value.match(/[A-Za-z]+(?:'[A-Za-z]+)?|[\p{L}\p{N}]+/gu) ?? [];
}

function classifyEnglishAgreementTokens(
  left: string[],
  right: string[],
  leftRaw: string[],
  rightRaw: string[],
  product: PdpProductSignal,
  kind: EditableBinding["kind"]
): number | undefined {
  let operations = 0;
  for (let index = 0; index < left.length; index += 1) {
    const original = left[index] ?? "";
    const candidate = right[index] ?? "";
    if (original === candidate) continue;
    const originalGroup = englishAgreementTokenGroup(original);
    const candidateGroup = englishAgreementTokenGroup(candidate);
    if (!originalGroup || originalGroup !== candidateGroup) return undefined;
    if (originalGroup === "article-indefinite") {
      const isSentenceInitial = index === 0;
      const originalCaseValid = !isSentenceInitial && /^(?:a|an)$/u.test(leftRaw[index] ?? "");
      const candidateCaseValid = !isSentenceInitial && /^(?:a|an)$/u.test(rightRaw[index] ?? "");
      const identifierFrame = new Set(["vitamin", "formula", "grade", "type", "complex", "variant", "shade", "model", "class", "group"]);
      const followingRaw = rightRaw[index + 1] ?? "";
      const finiteVerbFollower = new Set(["am", "is", "are", "was", "were", "has", "have", "had", "do", "does", "did", "can", "could", "may", "might", "will", "would", "shall", "should", "must"]);
      if (!originalCaseValid
        || !candidateCaseValid
        || identifierFrame.has(right[index - 1] ?? "")
        || !/^[a-z]/u.test(followingRaw)
        || finiteVerbFollower.has(right[index + 1] ?? "")
        || !isPhonologicallyValidIndefiniteArticle(candidate, right[index + 1] ?? "")) return undefined;
    }
    if (originalGroup !== "article-indefinite"
      && !isCorrectEnglishAgreement(candidate, right, index, product, kind)) return undefined;
    operations += 1;
  }
  return operations;
}

function englishAgreementTokenGroup(token: string): string | undefined {
  const fixed = englishAgreementGroups[token];
  if (fixed) return fixed;
  const lemma = token.endsWith("s") ? token.slice(0, -1) : token;
  return englishClaimAgreementLemmas.has(lemma) ? `claim-present:${lemma}` : undefined;
}

function isPhonologicallyValidIndefiniteArticle(article: string, following: string): boolean {
  if (!following) return false;
  const beginsWithVowelSound = /^[aeiou]/i.test(following) && !/^(?:uni|use|user|euro)/i.test(following)
    || /^(?:honest|hour|heir)/i.test(following);
  return beginsWithVowelSound ? article === "an" : article === "a";
}

function isCorrectEnglishAgreement(
  candidate: string,
  tokens: string[],
  verbIndex: number,
  product: PdpProductSignal,
  kind: EditableBinding["kind"]
): boolean {
  const number = englishSubjectNumber(tokens, verbIndex, product, kind);
  if (!number) return false;
  const group = englishAgreementTokenGroup(candidate);
  if (group === "be-present") {
    if (candidate === "am") return number === "first-singular";
    return number === "plural" ? candidate === "are" : candidate === "is";
  }
  if (group === "be-past") return number === "plural" ? candidate === "were" : candidate === "was";
  if (group === "have-present") return number === "plural" || number === "first-singular" ? candidate === "have" : candidate === "has";
  if (group === "do-present") return number === "plural" || number === "first-singular" ? candidate === "do" : candidate === "does";
  if (group?.startsWith("claim-present:")) {
    return number === "plural" || number === "first-singular"
      ? !candidate.endsWith("s")
      : candidate.endsWith("s");
  }
  return false;
}

function englishSubjectNumber(
  tokens: string[],
  verbIndex: number,
  product: PdpProductSignal,
  kind: EditableBinding["kind"]
): "singular" | "plural" | "first-singular" | undefined {
  const productTokenSets = uniqueText([product.name, product.originalName])
    .map(englishWordTokens)
    .filter((value) => value.length > 0);
  const before = tokens.slice(0, verbIndex);
  const after = tokens.slice(verbIndex + 1);
  const subjectSide = verbIndex === 0 && kind === "faq-question" ? after : before;
  if (subjectSide.some((token) => token === "and" || token === "or")) return undefined;
  const exactProductSubject = productTokenSets.some((name) => {
    const allowed = verbIndex === 0 ? subjectSide.slice(0, name.length) : subjectSide.slice(-name.length);
    const remaining = verbIndex === 0 ? subjectSide.slice(name.length) : subjectSide.slice(0, -name.length);
    return JSON.stringify(allowed) === JSON.stringify(name)
      && (verbIndex === 0 || remaining.every((token) => new Set(["the", "this", "that"]).has(token)));
  });
  if (exactProductSubject) {
    return "singular";
  }
  if (subjectSide.some((token) => new Set(["in", "of", "with", "from", "for", "on", "at", "by", "between", "among"]).has(token))) {
    return undefined;
  }
  const subject = verbIndex === 0 ? subjectSide[0] : subjectSide.at(-1);
  if (!subject) return undefined;
  if (subject === "i") return "first-singular";
  if (new Set(["we", "you", "they", "these", "those", "reviews", "customers", "ingredients", "results", "products"]).has(subject)) {
    return "plural";
  }
  if (new Set(["he", "she", "it", "this", "that", "product", "serum", "cream", "page", "formula", "ingredient", "technology", "review", "customer"]).has(subject)) {
    return "singular";
  }
  return undefined;
}

function isAllowedFaqAuxiliaryInversion(left: string[], right: string[], product: PdpProductSignal): boolean {
  if (left.some((token) => new Set(["and", "or", "not", "never"]).has(token))) return false;
  const auxiliaryGroups = new Set(["be-present", "be-past", "have-present", "do-present"]);
  const findAuxiliary = (tokens: string[]) => tokens
    .map((token, index) => ({ index, group: englishAgreementTokenGroup(token) }))
    .filter((item) => item.group && auxiliaryGroups.has(item.group));
  const leftAux = findAuxiliary(left);
  const rightAux = findAuxiliary(right);
  if (leftAux.length !== 1 || rightAux.length !== 1 || leftAux[0]?.group !== rightAux[0]?.group) return false;
  const leftIndex = leftAux[0]?.index ?? -1;
  const rightIndex = rightAux[0]?.index ?? -1;
  if (leftIndex === rightIndex || leftIndex === 0 || rightIndex !== 0) return false;
  const without = (tokens: string[], index: number) => tokens.filter((_, tokenIndex) => tokenIndex !== index);
  return JSON.stringify(without(left, leftIndex)) === JSON.stringify(without(right, rightIndex))
    && isCorrectEnglishAgreement(right[0] ?? "", right, 0, product, "faq-question");
}

const koreanParticleGroups: Array<{ forms: string[]; group: string }> = [
  { forms: ["이에요", "예요"], group: "copula-polite" },
  { forms: ["으로", "로"], group: "direction" },
  { forms: ["은", "는"], group: "topic" },
  { forms: ["이", "가"], group: "subject" },
  { forms: ["을", "를"], group: "object" },
  { forms: ["과", "와"], group: "and" }
];

const koreanStyleEndings: Array<{ forms: string[]; group: string }> = [
  { forms: ["이다", "입니다"], group: "copula-present" },
  { forms: ["한다", "합니다"], group: "hada-present" },
  { forms: ["된다", "됩니다"], group: "doeda-present" },
  { forms: ["있다", "있습니다"], group: "exist-present" },
  { forms: ["없다", "없습니다"], group: "absent-present" }
];

function isAllowedKoreanGrammarTransformation(original: string, candidate: string): boolean {
  const originalSentences = splitSentences(original);
  const candidateSentences = splitSentences(candidate);
  if (originalSentences.length !== candidateSentences.length) return false;
  let operationCount = 0;
  for (let sentenceIndex = 0; sentenceIndex < originalSentences.length; sentenceIndex += 1) {
    const left = koreanWordTokens(originalSentences[sentenceIndex] ?? "");
    const right = koreanWordTokens(candidateSentences[sentenceIndex] ?? "");
    if (left.length !== right.length) return false;
    for (let tokenIndex = 0; tokenIndex < left.length; tokenIndex += 1) {
      const originalToken = left[tokenIndex] ?? "";
      const candidateToken = right[tokenIndex] ?? "";
      if (originalToken === candidateToken) continue;
      const particleChange = sameKoreanParticleAllomorph(originalToken, candidateToken);
      const safeParticleStem = koreanParticleStem(candidateToken);
      const entityDescriptorFollows = /^(?:기술|연구소|성분|포뮬러|브랜드|원료|기관)(?:은|는|이|가|을|를|의|에|에서)?$/u
        .test(right[tokenIndex + 1] ?? "");
      const styleChange = tokenIndex === left.length - 1 && sameKoreanStyleEnding(originalToken, candidateToken);
      if (!particleChange && !styleChange
        || particleChange && (entityDescriptorFollows || !safeParticleStem || !safeKoreanParticleStems.has(safeParticleStem))) return false;
      operationCount += 1;
    }
  }
  return operationCount >= 1 && operationCount <= 3;
}

function koreanWordTokens(value: string): string[] {
  return value.match(/[\p{L}\p{N}]+/gu) ?? [];
}

function sameKoreanParticleAllomorph(original: string, candidate: string): boolean {
  for (const { forms } of koreanParticleGroups) {
    const left = splitKoreanEnding(original, forms);
    const right = splitKoreanEnding(candidate, forms);
    if (!left || !right || left.stem !== right.stem || left.ending === right.ending) continue;
    return isCorrectKoreanAllomorph(right.stem, right.ending);
  }
  return false;
}

const safeKoreanParticleStems = new Set([
  "피부", "고객", "사용자", "제품", "상품", "페이지", "세럼", "크림", "로션", "토너", "에센스", "앰플",
  "성분", "원료", "제형", "캡슐", "효능", "효과", "보습", "장벽", "리뷰", "후기", "단계", "루틴", "결과", "수치"
]);

function koreanParticleStem(value: string): string | undefined {
  for (const { forms } of koreanParticleGroups) {
    const parsed = splitKoreanEnding(value, forms);
    if (parsed) return parsed.stem;
  }
  return undefined;
}

function sameKoreanStyleEnding(original: string, candidate: string): boolean {
  for (const { forms } of koreanStyleEndings) {
    const left = splitKoreanEnding(original, forms);
    const right = splitKoreanEnding(candidate, forms);
    if (left && right
      && left.stem === right.stem
      && left.ending !== right.ending
      && /습니다$|입니다$/u.test(right.ending)
      && !/습니다$|입니다$/u.test(left.ending)) return true;
  }
  return false;
}

function splitKoreanEnding(value: string, endings: string[]): { stem: string; ending: string } | undefined {
  const ending = [...endings].sort((left, right) => right.length - left.length)
    .find((candidate) => value.length > candidate.length && value.endsWith(candidate));
  return ending ? { stem: value.slice(0, -ending.length), ending } : undefined;
}

function isCorrectKoreanAllomorph(stem: string, ending: string): boolean {
  const last = stem.at(-1);
  if (!last || !/[가-힣]/u.test(last)) return false;
  const jongseong = (last.charCodeAt(0) - 0xac00) % 28;
  if (ending === "은" || ending === "이" || ending === "을" || ending === "과" || ending === "이에요") return jongseong !== 0;
  if (ending === "는" || ending === "가" || ending === "를" || ending === "와" || ending === "예요") return jongseong === 0;
  if (ending === "으로") return jongseong !== 0 && jongseong !== 8;
  if (ending === "로") return jongseong === 0 || jongseong === 8;
  return false;
}

function classifySurfaceOnlyTransformation(original: string, candidate: string): {
  allowed: boolean;
  requiredIssueCodes: PdpGeoFinalProofreadingIssueCode[];
} {
  const originalUnits = surfaceSentenceUnits(original);
  const candidateUnits = surfaceSentenceUnits(candidate);
  const originalCollapsed = collapseAdjacentSurfaceSentenceUnits(originalUnits);
  const candidateCollapsed = collapseAdjacentSurfaceSentenceUnits(candidateUnits);
  const originalCanonical = originalCollapsed.map((unit) => ({ ...unit, tokens: collapseAdjacentTokens(unit.tokens) }));
  const candidateCanonical = candidateCollapsed.map((unit) => ({ ...unit, tokens: collapseAdjacentTokens(unit.tokens) }));

  if (JSON.stringify(originalCanonical) !== JSON.stringify(candidateCanonical)) {
    return { allowed: false, requiredIssueCodes: [] };
  }
  if (candidateUnits.reduce((sum, unit) => sum + unit.tokens.length, 0) > originalUnits.reduce((sum, unit) => sum + unit.tokens.length, 0)
    || candidateUnits.length > originalUnits.length) {
    return { allowed: false, requiredIssueCodes: [] };
  }

  const requiredIssueCodes: PdpGeoFinalProofreadingIssueCode[] = [];
  if (candidateUnits.length < originalUnits.length) requiredIssueCodes.push("duplicate-sentence");
  const removedAdjacentWord = originalCollapsed.some((unit, index) => {
    const candidateUnit = candidateCollapsed[index];
    return Boolean(candidateUnit)
      && candidateUnit!.tokens.length < unit.tokens.length
      && candidateUnit!.speechAct === unit.speechAct
      && JSON.stringify(collapseAdjacentTokens(unit.tokens)) === JSON.stringify(collapseAdjacentTokens(candidateUnit!.tokens));
  });
  if (removedAdjacentWord) requiredIssueCodes.push("duplicate-word");
  if (requiredIssueCodes.length === 0) requiredIssueCodes.push("punctuation");
  return { allowed: true, requiredIssueCodes };
}

function protectedPunctuationSignature(value: string): string {
  const canonical = collapseAdjacentExactSentences(value);
  return Array.from(canonical.matchAll(/[^\p{L}\p{N}\s]/gu)).filter((match) => (
    !isSentenceTerminalPunctuation(canonical, match.index ?? 0, match[0] ?? "")
  )).map((match) => {
    const prefix = canonical.slice(0, match.index ?? 0);
    const lexicalBoundary = prefix.match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu)?.length ?? 0;
    return `${match[0]}@${lexicalBoundary}`;
  }).join("|");
}

function collapseAdjacentExactSentences(value: string): string {
  return splitSentences(value)
    .filter((sentence, index, sentences) => index === 0 || sentence !== sentences[index - 1])
    .join(" ");
}

function isSentenceTerminalPunctuation(value: string, index: number, character: string): boolean {
  if (!/[.!?。！？]/u.test(character)) return false;
  const following = value.slice(index + character.length);
  return /^(?:[.!?。！？]+["'”’\])}]*)?(?:\s|$)/u.test(following);
}

interface SurfaceSentenceUnit {
  tokens: string[];
  speechAct: "statement" | "question" | "exclamation";
}

function surfaceSentenceUnits(value: string): SurfaceSentenceUnit[] {
  return splitSentences(value).map((sentence) => ({
    tokens: sentence.match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu) ?? [],
    speechAct: terminalSpeechAct(sentence)
  }));
}

function collapseAdjacentTokens(tokens: string[]): string[] {
  return tokens.filter((token, index) => index === 0 || token !== tokens[index - 1]);
}

function collapseAdjacentSurfaceSentenceUnits(units: SurfaceSentenceUnit[]): SurfaceSentenceUnit[] {
  return units.filter((unit, index) => index === 0 || JSON.stringify(unit) !== JSON.stringify(units[index - 1]));
}

function preservesTerminalSpeechActs(original: string, candidate: string): boolean {
  const signature = (value: string) => collapseAdjacentSurfaceSentenceUnits(surfaceSentenceUnits(value))
    .map((unit) => unit.speechAct);
  return JSON.stringify(signature(original)) === JSON.stringify(signature(candidate));
}

function terminalSpeechAct(value: string): SurfaceSentenceUnit["speechAct"] {
  if (/[?？]\s*["'”’)]*\s*$/u.test(value)) return "question";
  if (/[!！]\s*["'”’)]*\s*$/u.test(value)) return "exclamation";
  return "statement";
}

function containsUnsafeUnicode(value: string): boolean {
  if (/```/u.test(value)) return true;
  return Array.from(value).some((character) => /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]|[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\u0334-\u0338\u20d2-\u20ff\ufe00-\ufe0f\u{e0100}-\u{e01ef}]/u.test(character));
}

function applyAcceptedEdits(
  input: PdpGeoFinalProofreadingApplicationInput,
  bindings: EditableBinding[],
  edits: PdpGeoFinalProofreadingEdit[]
): { schemaMarkup: PdpGeoSchemaMarkup; content: PdpGeoContentArtifact } {
  if (edits.length === 0) return { schemaMarkup: input.schemaMarkup, content: input.content };
  const jsonLd = cloneJsonObject(input.schemaMarkup.jsonLd);
  const graph = readGraph(jsonLd);
  const product = graph.find((node) => isSchemaNodeOfType(node, "Product"));
  const webPage = graph.find((node) => isSchemaNodeOfType(node, "WebPage"));
  const faqPage = graph.find((node) => isSchemaNodeOfType(node, "FAQPage"));
  const howTo = graph.find((node) => isSchemaNodeOfType(node, "HowTo"));
  const sections = { ...input.content.sections };
  const bindingByPath = new Map(bindings.map((binding) => [binding.field.fieldPath, binding]));

  for (const edit of edits) {
    const text = cleanProposedText(edit.revisedText);
    const binding = bindingByPath.get(edit.fieldPath);
    if (!binding) continue;
    if (edit.fieldPath === "Product.description" && isRecord(product)) {
      product.description = text;
      sections.description = text;
      continue;
    }
    if (edit.fieldPath === "WebPage.description" && isRecord(webPage)) {
      webPage.description = text;
      continue;
    }
    if (binding.faqIndex !== undefined && isRecord(faqPage) && Array.isArray(faqPage.mainEntity)) {
      const item = faqPage.mainEntity[binding.faqIndex];
      if (!isRecord(item)) continue;
      if (binding.kind === "faq-question") item.name = text;
      if (binding.kind === "faq-answer" && isRecord(item.acceptedAnswer)) item.acceptedAnswer.text = text;
      continue;
    }
    if (binding.stepIndex !== undefined && isRecord(howTo) && Array.isArray(howTo.step)) {
      const item = howTo.step[binding.stepIndex];
      if (!isRecord(item)) continue;
      const before = typeof item.text === "string" ? item.text : "";
      item.text = text;
      sections.howToUse = replaceFirstExact(sections.howToUse, before, text);
    }
  }

  const faqItems = readFaqItems(jsonLd);
  if (edits.some((edit) => edit.fieldPath.startsWith("FAQPage.")) && faqItems.length > 0) {
    sections.faq = faqItems.map((item) => `Q. ${item.question}\nA. ${item.answer}`).join("\n\n");
  }
  const schemaMarkup = schemaMarkupFromJsonLd(jsonLd);
  const content = {
    ...input.content,
    sections,
    html: ""
  };
  return { schemaMarkup, content };
}

function normalizeProofreadingResult(value: PdpGeoFinalProofreadingResult): PdpGeoFinalProofreadingResult {
  const parsed = finalProofreadingResultSchema.safeParse({
    edits: value.edits,
    warnings: value.warnings
  });
  if (!parsed.success) {
    throw new Error(`Final proofreading response did not match the strict schema: ${parsed.error.issues[0]?.message ?? "invalid payload"}`);
  }
  return {
    edits: parsed.data.edits as PdpGeoFinalProofreadingEdit[],
    warnings: parsed.data.warnings,
    usage: value.usage,
    rawText: value.rawText
  };
}

function parseFinalProofreadingText(value: string): PdpGeoFinalProofreadingResult {
  const rawText = value.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const match = rawText.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Final proofreading returned no parseable JSON object.");
  const parsed = finalProofreadingResultSchema.safeParse(JSON.parse(match[0]));
  if (!parsed.success) {
    throw new Error(`Final proofreading JSON failed strict validation: ${parsed.error.issues[0]?.message ?? "invalid payload"}`);
  }
  return {
    edits: parsed.data.edits as PdpGeoFinalProofreadingEdit[],
    warnings: parsed.data.warnings,
    rawText
  };
}

function sameClaimModality(original: string, candidate: string): boolean {
  return JSON.stringify(extractClaimModalitySignature(original)) === JSON.stringify(extractClaimModalitySignature(candidate));
}

function extractClaimModalitySignature(value: string): string[] {
  const text = value.toLocaleLowerCase();
  const patterns: Array<[string, RegExp]> = [
    ["not", /\bnot\b|않/gu],
    ["no", /\bno\b|없|아니|미포함|불가/gu],
    ["never", /\bnever\b/gu],
    ["without", /\bwithout\b/gu],
    ["may", /\bmay\b/gu],
    ["might", /\bmight\b/gu],
    ["can", /\bcan\b|도울\s*수/gu],
    ["could", /\bcould\b/gu],
    ["help", /\bhelps?\b|도움|돕/gu],
    ["support", /\bsupports?\b|기여/gu],
    ["suggest", /\bsuggests?\b/gu],
    ["reported", /\breported?\b|보고/gu],
    ["measured", /\bmeasur(?:e|ed|ement)s?\b|측정/gu],
    ["tested", /\btests?|tested\b|시험|테스트/gu],
    ["study", /\bstud(?:y|ies)\b|연구/gu],
    ["result", /\bresults?\b|결과/gu],
    ["observed", /\bobserv(?:e|ed|ation)s?\b|관찰/gu],
    ["review", /\breviews?\b|리뷰|후기/gu],
    ["presented", /\bpresented?\b|제시/gu],
    ["because", /\bbecause\b|때문/gu],
    ["therefore", /\btherefore\b/gu],
    ["cause", /\bcauses?\b/gu],
    ["due-to", /\bdue\s+to\b/gu],
    ["through", /\bthrough\b|통해/gu],
    ["effective", /\beffective\b|효과적/gu],
    ["improve", /\bimproves?\b|개선/gu],
    ["reduce", /\breduces?\b|감소/gu],
    ["increase", /\bincreases?\b|증가/gu],
    ["proven", /\bproven\b|입증/gu]
  ];
  return uniqueText(patterns.flatMap(([label, pattern]) => {
    const count = text.match(pattern)?.length ?? 0;
    return Array.from({ length: count }, () => label);
  }));
}

function sameReviewScope(original: string, candidate: string): boolean {
  const signature = (value: string) => ({
    review: /\b(?:review|reviews|customer feedback)\b|(?:고객\s*)?(?:리뷰|후기)/iu.test(value),
    single: /\b(?:one|a single)\s+(?:customer\s+)?review\b|(?:한|1명의?)\s*(?:고객\s*)?(?:리뷰|후기)/iu.test(value),
    aggregate: /\b(?:customers|reviewers|reviews\s+(?:show|mention|indicate))\b|(?:고객들|여러\s*(?:고객|리뷰)|공통\s*(?:경향|반응)|고객\s*리뷰에서는)/iu.test(value),
    positiveOnly: /\bpositive\s+reviews?\b|긍정(?:적인)?\s*(?:리뷰|후기)/iu.test(value)
  });
  const left = signature(original);
  const right = signature(candidate);
  return Object.keys(left).every((key) => left[key as keyof typeof left] === right[key as keyof typeof right]);
}

function introducesIngredientCausality(original: string, candidate: string, product: PdpProductSignal): boolean {
  const ingredients = uniqueText([
    ...product.ingredients,
    ...(product.semanticFacts?.ingredients ?? []),
    ...(product.semanticFacts?.ingredientBenefitLinks ?? []).map((item) => item.ingredient)
  ].filter((value): value is string => Boolean(value)));
  const hasLinkedSentence = (value: string, ingredient: string) => splitSentences(value).some((sentence) => (
    normalizedIncludes(sentence, ingredient)
    && /\b(?:because|therefore|causes?|due\s+to|helps?|supports?|improves?|reduces?|increases?)\b|(?:때문|통해|돕|도움|기여|개선|감소|증가|효과)/iu.test(sentence)
  ));
  return ingredients.some((ingredient) => !hasLinkedSentence(original, ingredient) && hasLinkedSentence(candidate, ingredient));
}

function hasPageRole(value: string): boolean {
  return /\b(?:official\s+)?product\s+page\b|\bpage\s+(?:covers|provides|presents|includes)\b|(?:공식\s*)?상품\s*페이지|페이지(?:에서는|는|가)/iu.test(value);
}

function isTargetLocaleCompatible(original: string, candidate: string, locale: PdpGeoLocale): boolean {
  const ratio = (value: string, pattern: RegExp) => {
    const letters = value.match(/[\p{L}]/gu)?.length ?? 0;
    const target = value.match(pattern)?.length ?? 0;
    return letters > 0 ? target / letters : 0;
  };
  if (locale === "ko-KR" && ratio(original, /[가-힣]/g) >= 0.35) return ratio(candidate, /[가-힣]/g) >= 0.3;
  if (locale === "ja-JP" && ratio(original, /[ぁ-んァ-ン一-龯]/g) >= 0.35) return ratio(candidate, /[ぁ-んァ-ン一-龯]/g) >= 0.3;
  if ((locale === "en-US" || locale === "en-GB") && ratio(original, /[A-Za-z]/g) >= 0.5) return ratio(candidate, /[A-Za-z]/g) >= 0.5;
  return true;
}

function textSimilarity(left: string, right: string): number {
  const leftSet = characterNgrams(normalizeForSimilarity(left));
  const rightSet = characterNgrams(normalizeForSimilarity(right));
  if (leftSet.size === 0 || rightSet.size === 0) return left === right ? 1 : 0;
  const overlap = [...leftSet].filter((value) => rightSet.has(value)).length;
  return (2 * overlap) / (leftSet.size + rightSet.size);
}

const englishProofreadingStopWords = new Set([
  "a", "an", "the", "and", "or", "but", "nor", "so", "yet",
  "of", "for", "to", "in", "on", "at", "by", "with", "from", "as", "into", "onto",
  "this", "that", "these", "those", "it", "its", "they", "their", "them", "which", "who", "whom",
  "is", "are", "was", "were", "be", "been", "being", "has", "have", "had", "do", "does", "did"
]);

function sameSubstantiveTokenSignature(original: string, candidate: string, locale: PdpGeoLocale): boolean {
  return JSON.stringify(substantiveTokenSignature(original, locale))
    === JSON.stringify(substantiveTokenSignature(candidate, locale));
}

function substantiveTokenSignature(value: string, locale: PdpGeoLocale): string[] {
  const tokens = value.match(/[\p{L}][\p{L}\p{N}-]*/gu) ?? [];
  return uniqueText(tokens
    .map((token) => normalizeSubstantiveToken(token, locale))
    .filter((token): token is string => Boolean(token)));
}

function normalizeSubstantiveToken(value: string, _locale: PdpGeoLocale): string | undefined {
  let token = value.toLocaleLowerCase().replace(/^-+|-+$/g, "");
  if (!token) return undefined;
  if (/[가-힣]/u.test(token)) {
    const suffixes = [
      "이었습니다", "였습니다", "하였습니다", "되었습니다", "했습니다",
      "있습니다", "없습니다", "됩니다", "합니다", "입니다",
      "한다", "된다", "있다", "없다", "이다",
      "으로부터", "에게서는", "에서는", "으로", "에게", "께서", "까지", "부터", "처럼", "보다",
      "이라고", "라고", "하며", "하여", "하고", "되는", "하는", "된", "한",
      "에서", "에게", "으로", "은", "는", "이", "가", "을", "를", "와", "과", "의", "에", "로", "도", "만"
    ];
    let changed = true;
    while (changed) {
      changed = false;
      for (const suffix of suffixes) {
        if (token.length > suffix.length + 1 && token.endsWith(suffix)) {
          token = token.slice(0, -suffix.length);
          changed = true;
          break;
        }
      }
    }
    return token.length >= 2 && !new Set(["그리고", "또는", "하지만", "또한", "위"]).has(token) ? token : undefined;
  }
  if (englishProofreadingStopWords.has(token)) return undefined;
  if (token.length > 5 && token.endsWith("ies")) token = `${token.slice(0, -3)}y`;
  else if (token.length > 5 && token.endsWith("ing")) token = token.slice(0, -3);
  else if (token.length > 4 && token.endsWith("ed")) token = token.slice(0, -2);
  else if (token.length > 4 && token.endsWith("es")) token = token.slice(0, -2);
  else if (token.length > 3 && token.endsWith("s")) token = token.slice(0, -1);
  return token.length >= 2 ? token : undefined;
}

function preservesSentenceSemanticUnits(original: string, candidate: string, locale: PdpGeoLocale): boolean {
  const originalUnits = splitSentences(original).map((sentence) => sentenceSemanticUnitSignature(sentence, locale));
  const candidateUnits = splitSentences(candidate).map((sentence) => sentenceSemanticUnitSignature(sentence, locale));
  if (originalUnits.length === candidateUnits.length) {
    return originalUnits.every((unit, index) => unit === candidateUnits[index]);
  }
  if (candidateUnits.length > originalUnits.length) return false;
  return !originalUnits.some((unit) => !candidateUnits.includes(unit));
}

function removesDistinctSentence(original: string, candidate: string, locale: PdpGeoLocale): boolean {
  const originalUnits = splitSentences(original).map((sentence) => sentenceSemanticUnitSignature(sentence, locale));
  const candidateUnits = splitSentences(candidate).map((sentence) => sentenceSemanticUnitSignature(sentence, locale));
  if (candidateUnits.length >= originalUnits.length) return false;
  return originalUnits.some((unit) => !candidateUnits.includes(unit));
}

function sentenceSemanticUnitSignature(value: string, locale: PdpGeoLocale): string {
  return JSON.stringify({
    tokens: substantiveTokenSignature(value, locale),
    numbers: extractNumericTokens(value).map((token) => token.toLocaleLowerCase())
  });
}

function characterNgrams(value: string): Set<string> {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= 3) return new Set([compact]);
  return new Set(Array.from({ length: compact.length - 2 }, (_, index) => compact.slice(index, index + 3)));
}

function normalizeForSimilarity(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}%]+/gu, " ").trim();
}

function stripPunctuation(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}%]+/gu, "");
}

function extractNumericTokens(value: string): string[] {
  return Array.from(value.matchAll(/(?:[$€£₩]\s*)?[+\-−]?\d+(?:[.,]\d+)?\s*(?:%|％|배|x|회|명|인|주|일|시간|분|초|weeks?|days?|hours?|minutes?|seconds?|users?|participants?|subjects?|women|men|ml|mL|l|g|mg|µg|μg|kg|oz|ppm|mm|cm|°c|krw|usd|eur|gbp)?/giu))
    .map((match) => match[0].replace(/[−]/g, "-").replace(/％/g, "%").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function extractIdentifierTokens(value: string): string[] {
  return uniqueText([
    ...(value.match(/\b(?=[A-Za-z0-9-]{3,}\b)(?=[A-Za-z0-9-]*[A-Z0-9])[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+\b/g) ?? []),
    ...(value.match(/\b[A-Z]{2,}[A-Z0-9-]*\b/g) ?? []),
    ...(value.match(/\b[A-Za-z]+\d+[A-Za-z0-9-]*\b/g) ?? [])
  ]);
}

function sameOrderedUniqueTokens(left: string[], right: string[]): boolean {
  const normalize = (values: string[]) => uniqueText(values.map((value) => value.toLocaleLowerCase()));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function sentenceCount(value: string): number {
  return splitSentences(value).length;
}

function splitSentences(value: string): string[] {
  return value.split(/(?<=[.!?。！？])\s+|\n+/u).map((item) => item.trim()).filter(Boolean);
}

function cleanProposedText(value: string): string {
  return value.normalize("NFC").replace(/```(?:json)?/gi, "").replace(/\s+([,.!?;:。！？])/g, "$1").replace(/[ \t]+/g, " ").trim();
}

function normalizedIncludes(value: string, candidate: string): boolean {
  const normalize = (item: string) => item.toLocaleLowerCase().replace(/\s+/g, " ").trim();
  return normalize(value).includes(normalize(candidate));
}

function stableTextHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function readFaqItems(jsonLd: JsonObject): Array<{ question: string; answer: string }> {
  const graph = readGraph(jsonLd);
  const faqPage = graph.find((node) => isSchemaNodeOfType(node, "FAQPage"));
  if (!isRecord(faqPage) || !Array.isArray(faqPage.mainEntity)) return [];
  return faqPage.mainEntity.flatMap((item) => {
    if (!isRecord(item) || typeof item.name !== "string" || !isRecord(item.acceptedAnswer) || typeof item.acceptedAnswer.text !== "string") return [];
    return [{ question: item.name, answer: item.acceptedAnswer.text }];
  });
}

function replaceFirstExact(value: string, before: string, after: string): string {
  const index = value.indexOf(before);
  return index >= 0 ? `${value.slice(0, index)}${after}${value.slice(index + before.length)}` : value;
}

function readGraph(jsonLd: JsonObject): Array<Record<string, any>> {
  const value = jsonLd["@graph"];
  return Array.isArray(value) ? value.filter(isRecord) as Array<Record<string, any>> : [];
}

function schemaMarkupFromJsonLd(jsonLd: JsonObject): PdpGeoSchemaMarkup {
  return {
    jsonLd,
    scriptTag: `<script type="application/ld+json">${escapeScriptJson(JSON.stringify(jsonLd, null, 2))}</script>`
  };
}

function cloneJsonObject(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function escapeScriptJson(value: string): string {
  return value.replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

function readString(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" && value[key].trim() ? value[key].trim() : undefined;
}

function isSchemaNodeOfType(value: unknown, type: string): boolean {
  if (!isRecord(value)) return false;
  const nodeType = value["@type"];
  return nodeType === type || (Array.isArray(nodeType) && nodeType.includes(type));
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueText(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
}

function temperatureBody(temperature: number | undefined): { temperature?: number } {
  return typeof temperature === "number" && Number.isFinite(temperature) ? { temperature } : {};
}

async function requestJsonWithTemperatureFallback(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  label: string
): Promise<Record<string, any>> {
  const request = (payload: Record<string, unknown>) => fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload)
  }, label);
  let response = await request(body);
  if (!response.ok) {
    const suffix = await responseErrorSuffix(response);
    if (body.temperature !== undefined && /temperature[^]*(?:unsupported|only the default)|unsupported value[^]*temperature/i.test(suffix)) {
      const { temperature: _temperature, ...retryBody } = body;
      response = await request(retryBody);
      if (response.ok) return response.json() as Promise<Record<string, any>>;
      throw new Error(`${label} failed: ${response.status}${await responseErrorSuffix(response)}`);
    }
    throw new Error(`${label} failed: ${response.status}${suffix}`);
  }
  return response.json() as Promise<Record<string, any>>;
}

async function fetchWithTimeout(url: string, init: RequestInit, label: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FINAL_PROOFREADING_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (isRecord(error) && error.name === "AbortError") {
      throw new Error(`${label} timed out after ${Math.round(FINAL_PROOFREADING_TIMEOUT_MS / 1000)}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function responseErrorSuffix(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned ? ` - ${cleaned.slice(0, 500)}` : "";
}

function providerText(payload: Record<string, any>): string {
  if (typeof payload.output_text === "string") return payload.output_text;
  if (Array.isArray(payload.output)) {
    return payload.output.flatMap((item: any) => Array.isArray(item?.content) ? item.content : [])
      .map((item: any) => typeof item?.text === "string" ? item.text : "")
      .filter(Boolean)
      .join("\n");
  }
  const content = payload.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

function tokenUsageFromOpenAi(value: unknown): PdpGeoTokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  return compactTokenUsage(value.input_tokens, value.output_tokens, value.total_tokens);
}

function tokenUsageFromChatCompletions(value: unknown): PdpGeoTokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  return compactTokenUsage(value.prompt_tokens, value.completion_tokens, value.total_tokens);
}

function tokenUsageFromGemini(value: unknown): PdpGeoTokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  return compactTokenUsage(value.promptTokenCount, value.candidatesTokenCount, value.totalTokenCount);
}

function compactTokenUsage(input: unknown, output: unknown, total: unknown): PdpGeoTokenUsage | undefined {
  const usage: PdpGeoTokenUsage = {
    inputTokens: typeof input === "number" ? input : undefined,
    outputTokens: typeof output === "number" ? output : undefined,
    totalTokens: typeof total === "number" ? total : undefined
  };
  return usage.inputTokens !== undefined || usage.outputTokens !== undefined || usage.totalTokens !== undefined ? usage : undefined;
}

function toGeminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toGeminiSchema);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "additionalProperties")
    .map(([key, item]) => [key, toGeminiSchema(item)]));
}
