import type { EvalUiLanguage, GeoQualityEvalInput } from "../types";
import { getGeoQualityCopy } from "./copy";
import {
  clampQualityScore,
  collectPublicArtifactHits,
  collectMetricIntegrityIssues,
  collectSchemaFaqQuestions,
  collectTextValues,
  collectValidationDetailLines,
  collectValidationImprovementLines,
  countDanglingLocalSchemaReferences,
  countSchemaItems,
  countValidHowToSteps,
  countValidSchemaFaqItems,
  ensureQualityItems,
  findSchemaNode,
  getRecordString,
  getSchemaGraph,
  getSchemaNodeTypes,
  hasCustomerChoiceCue,
  hasIngredientBenefitChoiceBridge,
  hasReportedSampleScopeDisclosure,
  hasSelectionCriteriaCue,
  isDisabledHtmlContentValidationScope,
  partitionValidationWarnings,
  uniqueQualityItems
} from "./internal";

/**
 * Deterministic GEO/CEP/E-E-A-T quality rubric over a schema.org PDP graph.
 * Conservative lint-style diagnostics — NOT a citation-probability estimate
 * (the citation probe measures that). Input is a structural contract, so any
 * JSON-LD + optional diagnostics can be scored, not only generator runs.
 *
 * Score deltas/caps for every dimension are tabulated in
 * `docs/quality-scoring.md` — keep that document in sync with this file and
 * `./internal.ts` whenever a condition or delta changes.
 */

export type GeoQualityDimensionId = "geo" | "cep" | "eeat";

export interface GeoQualityDimension {
  id: GeoQualityDimensionId;
  label: string;
  score: number;
  criteria: string;
  summary: string;
  evidence: string[];
  improvements: string[];
}

export interface GeoQualityEvaluation {
  overallScore: number;
  dimensions: GeoQualityDimension[];
  validationDetails: string[];
  validationImprovements: string[];
}

export function evaluateGeoQuality(input: GeoQualityEvalInput, language: EvalUiLanguage): GeoQualityEvaluation {
  const copy = getGeoQualityCopy(language);
  const diagnostics = input.diagnostics;
  const graph = getSchemaGraph(input.jsonLd);
  const schemaTypes = new Set(graph.flatMap((node) => getSchemaNodeTypes(node)));
  const productNode = findSchemaNode(graph, "Product");
  const webPageNode = findSchemaNode(graph, "WebPage");
  const faqNode = findSchemaNode(graph, "FAQPage");
  const howToNode = findSchemaNode(graph, "HowTo");
  const breadcrumbNode = findSchemaNode(graph, "BreadcrumbList");
  const schemaTypeList = Array.from(schemaTypes).join(", ") || copy.none;
  const productText = [
    productNode ? collectTextValues(productNode).join(" ") : "",
    webPageNode ? collectTextValues(webPageNode).join(" ") : ""
  ].join("\n");
  const publicText = graph.flatMap((node) => collectTextValues(node)).join("\n");
  const faqQuestions = collectSchemaFaqQuestions(faqNode);
  const schemaFaqCount = countSchemaItems(faqNode?.["mainEntity"]);
  const schemaHowToCount = countSchemaItems(howToNode?.["step"]);
  const faqStructureValid = !faqNode || countValidSchemaFaqItems(faqNode) === schemaFaqCount && schemaFaqCount > 0;
  // Generator contract (pdp-geo-generator-agent graph-integrity.ts
  // `hasValidHowTo`, RAG policy geo-research §4.6 / cep_v1.md §5.1):
  // one source instruction maps to exactly one HowTo step, and a single-step
  // HowTo is valid schema.org — the rubric must not penalize that shape.
  const howToStructureValid = !howToNode
    || getRecordString(howToNode, "name").trim().length > 0
      && countValidHowToSteps(howToNode) === schemaHowToCount
      && schemaHowToCount >= 1;
  const danglingLocalReferences = countDanglingLocalSchemaReferences(graph);
  const imageCount = Math.max(countSchemaItems(productNode?.["image"]), (diagnostics.normalizedProduct.images ?? []).length);
  const offerCount = countSchemaItems(productNode?.["offers"]);
  const breadcrumbCount = Math.max(countSchemaItems(breadcrumbNode?.["itemListElement"]), (diagnostics.normalizedProduct.breadcrumbs ?? []).length);
  const additionalPropertyCount = countSchemaItems(productNode?.["additionalProperty"]);
  const scoredValidationRepairs = (diagnostics.validationRepairs ?? [])
    .filter((repair) => !isDisabledHtmlContentValidationScope(repair.field));
  const validationRepairs = scoredValidationRepairs.length;
  const scoredValidationWarnings = diagnostics.validationWarnings
    .filter((warning) => !isDisabledHtmlContentValidationScope(warning));
  const validationWarnings = partitionValidationWarnings(scoredValidationWarnings, scoredValidationRepairs)
    .unresolvedWarnings.length;
  const hasCleanValidation = validationWarnings === 0 && validationRepairs === 0;
  const validationDetailLines = collectValidationDetailLines(diagnostics, copy);
  const validationImprovementDirections = validationWarnings > 0 ? collectValidationImprovementLines(diagnostics, copy) : [];
  const artifactHits = collectPublicArtifactHits(publicText, faqQuestions, language);
  const metricIssues = collectMetricIntegrityIssues(publicText, language);
  const ingredientCount = (diagnostics.normalizedProduct.ingredients ?? []).length;
  // P0 스키마 정책: positiveNotes는 머천트 PDP에서 발행하지 않으므로 벤핏
  // 신호는 정규화된 diagnostics(benefits/effects)로만 계수한다.
  const benefitCount = (diagnostics.normalizedProduct.benefits ?? []).length + (diagnostics.normalizedProduct.effects ?? []).length;
  const hasIngredientBenefitBridge = hasIngredientBenefitChoiceBridge(productText);
  const hasCustomerCue = hasCustomerChoiceCue(productText);
  const hasSelectionCue = hasSelectionCriteriaCue(productText);
  const cepRagUsage = (diagnostics.ragUsage ?? []).filter((usage) => (
    usage.principle === "target customer context"
    || usage.references.some((reference) => reference.kind === "cep")
  )).length;
  const evidenceBackedUsage = (diagnostics.ragUsage ?? []).some((usage) => usage.enabled && usage.principle === "evidence-backed claims");
  const sourceEvidence = (diagnostics.evidence ?? []).filter((item) => (
    item.source === "input"
    || item.source === "fieldMapping"
    || item.source === "rag"
    || item.source === "terminology"
  ));
  const sourceEvidenceTypes = new Set(sourceEvidence.map((item) => item.source)).size;
  const evidenceLedger = diagnostics.evidenceLedger ?? [];
  const evidenceLedgerIds = new Set(evidenceLedger.map((item) => item.id));
  const contentPlan = diagnostics.contentPlan;
  const modelContentPlan = contentPlan?.mode === "model" ? contentPlan : undefined;
  const plannedEvidenceUnits = modelContentPlan ? [
    ...(modelContentPlan.productDescription?.include ? [modelContentPlan.productDescription.evidenceIds ?? []] : []),
    ...(modelContentPlan.webPageDescription?.include ? [modelContentPlan.webPageDescription.evidenceIds ?? []] : []),
    ...modelContentPlan.faq.filter((item) => item.include).map((item) => item.evidenceIds ?? []),
    ...(modelContentPlan.howTo?.eligible ? modelContentPlan.howTo.steps.map((step) => step.evidenceIds ?? []) : []),
    ...modelContentPlan.cep.map((item) => item.evidenceIds ?? [])
  ] : [];
  const atomicallyCoveredPlanUnits = plannedEvidenceUnits.filter((evidenceIds) => (
    evidenceIds.length > 0 && evidenceIds.every((id) => evidenceLedgerIds.has(id))
  )).length;
  const invalidPlannedEvidenceRefs = new Set(
    plannedEvidenceUnits.flat().filter((id) => !evidenceLedgerIds.has(id))
  ).size;
  const hasAtomicEvidenceCoverage = evidenceLedger.length > 0 && plannedEvidenceUnits.length > 0;
  const plannedFaqCount = modelContentPlan?.faq.filter((item) => item.include).length;
  const faqPlanConsistent = !modelContentPlan || schemaFaqCount === plannedFaqCount;
  const howToPlanConsistent = !modelContentPlan
    || (modelContentPlan.howTo?.eligible
      ? Boolean(howToNode) && schemaHowToCount === (modelContentPlan.howTo?.steps.length ?? 0)
      : !howToNode);
  const hasClaimMetrics = /(?:\+?\d+(?:\.\d+)?\s*[%％])/.test(publicText);
  const hasStudySample = /\b\d{2,4}\s+(?:women|men|participants|subjects|users|respondents|people)\b/i.test(publicText)
    // Korean sample-size disclosure: "<수사><수량 명사>". Natural Korean always
    // attaches a particle to the noun ("32명을 대상으로", "53명이 참여") — requiring
    // a non-letter right boundary rejected every real sentence, since the
    // particle character is itself a letter. Only reject a digit glued directly
    // to the noun (e.g. part of an unrelated larger number); any following
    // Hangul particle/word is accepted.
    || /(?:^|[^\d])\d{2,4}\s*(?:명|인|참여자|대상|사용자|응답자|여성|남성)(?!\d)/.test(publicText);
  const hasSampleScopeDisclosure = hasReportedSampleScopeDisclosure(publicText);
  const hasSampleScope = hasStudySample || hasSampleScopeDisclosure;
  const hasTimeScope = /\b(?:after\s+)?\d+\s*(?:day|days|week|weeks|hour|hours)\b/i.test(publicText)
    // Bare duration + explicit temporal connector ("N시간/일/주 후|동안|뒤" — "after/
    // during/later") is an unambiguous test-timing scope no matter what Hangul
    // text follows, so no trailing \b is used: JS `\b` is defined over
    // [A-Za-z0-9_] only, so it never matches right after a Hangul character
    // followed by more Hangul/whitespace (the normal case in Korean prose),
    // which made this alternative dead in practice.
    || /\d+(?:\.\d+)?\s*(?:시간|일|주)\s*(?:후|동안|뒤)/.test(publicText)
    // Duration + clinical patch-test noun ("48시간 패치"/"48시간 첩포") — a specific
    // skin-safety test format. Kept separate from the bare-duration alternative
    // above (rather than dropping its right boundary entirely) so generic
    // durability/marketing claims like "24시간 보습 지속" are not swept in.
    || /\d+(?:\.\d+)?\s*시간\s*(?:패치|첩포)/.test(publicText)
    // "N일간/N주간/N개월간", "N개월 동안" — 간/동안 glued to the unit is itself a
    // duration-scoping marker, not a bare unit followed by unrelated text.
    || /\d+(?:\.\d+)?\s*(?:일|주|개월)\s*(?:간|동안)/.test(publicText)
    || /(?:사용|도포|세정)\s*(?:직후|전|\d+(?:\.\d+)?\s*(?:시간|일|주)\s*후)/.test(publicText)
    || /(?:시험|측정|조사|평가)?\s*기간(?:은|:)?\s*20\d{2}[./-]\d{1,2}[./-]\d{1,2}\s*(?:~|-|–|—|부터|에서)\s*20\d{2}[./-]\d{1,2}[./-]\d{1,2}/.test(publicText)
    // Korean-worded date range without an explicit "기간" label: "2022년 12월
    // 19일부터 22일까지" (month stated once, day repeated) and "2018년 4월 13일부터
    // 6월 1일까지" (month changes across the range).
    || /20\d{2}년\s*\d{1,2}월\s*\d{1,2}일\s*(?:부터|~|-|–|—)\s*(?:\d{1,2}월\s*)?\d{1,2}일\s*(?:까지)?/.test(publicText)
    // 2-digit-year numeric date range: "22.12.19-22.12.22" / "22.12.19~22.12.22".
    || /\d{2}[./-]\d{1,2}[./-]\d{1,2}\s*(?:~|-|–|—)\s*\d{2}[./-]\d{1,2}[./-]\d{1,2}/.test(publicText);
  const hasReportedDetails = /\b(?:reported details|clinical|instrumental|home usage|survey|self-assessment|participants|subjects)\b/i.test(publicText)
    || /(?:확인 지표|임상|인체\s*적용|자가\s*평가|테스트|시험|참여자|대상|사용자)/.test(publicText);
  const hasProductDescription = Boolean(productNode && getRecordString(productNode, "description").trim().length > 0);
  const hasProductIdentity = Boolean(productNode
    && getRecordString(productNode, "@id").trim()
    && getRecordString(productNode, "name").trim());
  const hasWebPageIdentity = Boolean(webPageNode
    && getRecordString(webPageNode, "@id").trim()
    && getRecordString(webPageNode, "name").trim());
  const ingredientBenefitBridgeApplicable = ingredientCount > 0 && benefitCount > 0;

  // Research-calibrated gatekeeper signals (What Gets Cited, SIGIR 2026):
  // an explicit price and a freshness timestamp are the two on-page citation
  // gatekeepers this rubric can verify deterministically.
  const hasOfferPrice = hasExplicitOfferPrice(productNode);
  const hasFreshnessSignal = hasFreshnessTimestamp(graph, webPageNode);
  // Cue detectors are regex-based; cross-check against the evidence-bound
  // content plan so a single missed regex cannot swing the CEP score.
  const customerCueSatisfied = hasCustomerCue || (contentPlan?.cep.length ?? 0) > 0;
  const selectionCueSatisfied = hasSelectionCue || (contentPlan?.cep.length ?? 0) > 0;
  const groundedCepPlan = Boolean(contentPlan)
    && (contentPlan?.cep.length ?? 0) > 0
    && (contentPlan?.cep ?? []).every((item) => (item.evidenceIds ?? []).length > 0);

  // These are conservative lint-style diagnostics, not citation-probability
  // estimates. Optional FAQ/HowTo nodes never add points; they can only expose
  // structure/parity problems when the generator chose to emit them.
  // Validation warnings/repairs penalize GEO (schema hygiene) ONLY — they are
  // no longer triple-counted across all three dimensions.
  const geoScore = clampQualityScore(
    90
    + (hasOfferPrice ? 5 : 0)
    + (hasFreshnessSignal ? 5 : 0)
    - (!hasProductIdentity ? 18 : 0)
    - (!hasWebPageIdentity ? 14 : 0)
    - (!hasProductDescription ? 10 : 0)
    - Math.min(16, danglingLocalReferences * 8)
    - (!faqStructureValid ? 8 : 0)
    - (!howToStructureValid ? 8 : 0)
    - (!faqPlanConsistent ? 10 : 0)
    - (!howToPlanConsistent ? 10 : 0)
    - Math.min(16, artifactHits.length * 8)
    - Math.min(15, validationWarnings * 3)
    - Math.min(10, validationRepairs * 2)
  );
  const cepScore = clampQualityScore(
    85
    + (ingredientBenefitBridgeApplicable && hasIngredientBenefitBridge ? 8 : 0)
    + (cepRagUsage > 0 ? 4 : 0)
    + (groundedCepPlan ? 3 : 0)
    - (!customerCueSatisfied ? 12 : 0)
    - (!selectionCueSatisfied ? 10 : 0)
    - (ingredientBenefitBridgeApplicable && !hasIngredientBenefitBridge ? 12 : 0)
    - (ingredientCount === 0 && benefitCount === 0 ? 12 : 0)
    - Math.min(16, contentPlan ? contentPlan.cep.filter((item) => (item.evidenceIds ?? []).length === 0).length * 8 : 0)
    - Math.min(12, artifactHits.length * 6)
  );
  const eeatScore = clampQualityScore(
    90
    + (hasAtomicEvidenceCoverage && atomicallyCoveredPlanUnits === plannedEvidenceUnits.length ? 5 : 0)
    + (evidenceBackedUsage ? 3 : 0)
    + (hasClaimMetrics && hasReportedDetails ? 2 : 0)
    - (evidenceLedger.length === 0 && sourceEvidence.length === 0 ? 30 : 0)
    - Math.min(24, Math.max(0, plannedEvidenceUnits.length - atomicallyCoveredPlanUnits) * 8)
    - Math.min(20, invalidPlannedEvidenceRefs * 5)
    - (hasClaimMetrics && !hasSampleScope ? 12 : 0)
    - (hasClaimMetrics && !hasTimeScope ? 10 : 0)
    - (hasClaimMetrics && !hasReportedDetails ? 8 : 0)
    - Math.min(24, metricIssues.length * 12)
    - Math.min(12, artifactHits.length * 4)
  );

  const geoEvidence = uniqueQualityItems([
    copy.geoSchemaEvidence(graph.length, schemaTypeList),
    hasOfferPrice ? copy.gatekeeperPriceEvidence : copy.gatekeeperPriceMissingEvidence,
    hasFreshnessSignal ? copy.gatekeeperFreshnessEvidence : copy.gatekeeperFreshnessMissingEvidence,
    copy.geoEntityEvidence(schemaFaqCount, schemaHowToCount, breadcrumbCount),
    copy.geoCommerceEvidence(imageCount, offerCount, additionalPropertyCount),
    copy.schemaReferenceEvidence(danglingLocalReferences),
    copy.planApplicabilityEvidence(faqPlanConsistent, howToPlanConsistent, Boolean(modelContentPlan)),
    hasCleanValidation ? copy.cleanValidationEvidence : validationWarnings > 0 ? copy.warningEvidence(validationWarnings) : undefined,
    validationRepairs > 0 ? copy.repairEvidence(validationRepairs) : undefined
  ]);
  const cepEvidence = uniqueQualityItems([
    copy.cepSignalEvidence(ingredientCount, benefitCount),
    hasIngredientBenefitBridge ? copy.cepBridgeEvidence : copy.cepBridgeMissingEvidence,
    selectionCueSatisfied || customerCueSatisfied ? copy.cepChoiceEvidence : copy.cepChoiceMissingEvidence,
    cepRagUsage > 0 ? copy.cepRagEvidence(cepRagUsage) : undefined
  ]);
  const eeatEvidence = uniqueQualityItems([
    evidenceLedger.length > 0
      ? copy.atomicEvidenceCount(evidenceLedger.length, new Set(evidenceLedger.map((item) => item.role)).size)
      : copy.eeatEvidenceCount(sourceEvidence.length, sourceEvidenceTypes),
    hasClaimMetrics ? copy.eeatMetricEvidence : copy.eeatMetricMissingEvidence,
    hasClaimMetrics
      ? (hasSampleScope || hasTimeScope ? copy.eeatStudyEvidence(hasSampleScope, hasTimeScope) : copy.eeatStudyMissingEvidence)
      : undefined,
    evidenceBackedUsage ? copy.eeatRagEvidence : undefined,
    hasAtomicEvidenceCoverage
      ? copy.atomicEvidenceCoverage(atomicallyCoveredPlanUnits, plannedEvidenceUnits.length, invalidPlannedEvidenceRefs)
      : copy.atomicEvidenceUnavailable
  ]);

  const geoImprovements = ensureQualityItems([
    ...artifactHits,
    !hasFreshnessSignal ? copy.gatekeeperFreshnessImprovement : undefined,
    !hasOfferPrice ? copy.gatekeeperPriceImprovement : undefined,
    !productNode ? copy.missingProductSchema : undefined,
    !webPageNode ? copy.missingWebPageSchema : undefined,
    !faqStructureValid ? copy.faqApplicabilityImprovement : undefined,
    !howToStructureValid ? copy.howToApplicabilityImprovement : undefined,
    !faqPlanConsistent ? copy.faqPlanImprovement : undefined,
    !howToPlanConsistent ? copy.howToPlanImprovement : undefined,
    danglingLocalReferences > 0 ? copy.schemaReferenceImprovement(danglingLocalReferences) : undefined,
    validationRepairs > 0 ? copy.repairStabilityImprovement(validationRepairs) : undefined,
    validationWarnings > 0 ? copy.validationImprovement(validationWarnings) : undefined,
    ...validationImprovementDirections
  ], copy.geoFallbackImprovement);
  const cepImprovements = ensureQualityItems([
    ingredientBenefitBridgeApplicable && !hasIngredientBenefitBridge ? copy.cepBridgeImprovement : undefined,
    !selectionCueSatisfied ? copy.cepChoiceImprovement : undefined,
    ingredientCount === 0 ? copy.cepIngredientImprovement : undefined,
    benefitCount === 0 ? copy.cepBenefitImprovement : undefined,
    ...artifactHits
  ], copy.cepFallbackImprovement);
  const eeatImprovements = ensureQualityItems([
    ...metricIssues,
    hasClaimMetrics && !hasSampleScope ? copy.eeatSampleImprovement : undefined,
    hasClaimMetrics && !hasTimeScope ? copy.eeatTimeImprovement : undefined,
    !evidenceBackedUsage ? copy.eeatRagImprovement : undefined,
    hasAtomicEvidenceCoverage && atomicallyCoveredPlanUnits < plannedEvidenceUnits.length
      ? copy.atomicEvidenceImprovement(plannedEvidenceUnits.length - atomicallyCoveredPlanUnits)
      : undefined,
    validationRepairs > 0 ? copy.repairStabilityImprovement(validationRepairs) : undefined,
    validationWarnings > 0 ? copy.validationImprovement(validationWarnings) : undefined,
    ...validationImprovementDirections
  ], copy.eeatFallbackImprovement);

  const geoIssueCount = artifactHits.length
    + validationWarnings
    + validationRepairs
    + danglingLocalReferences
    + Number(!hasProductIdentity)
    + Number(!hasWebPageIdentity)
    + Number(!hasProductDescription)
    + Number(!faqStructureValid)
    + Number(!howToStructureValid)
    + Number(!faqPlanConsistent)
    + Number(!howToPlanConsistent)
    // The gatekeeper checks only add score bonuses, but a missing gatekeeper
    // still emits an improvement — count it so the summary can't claim "no
    // observable diagnostic issue" while listing action items.
    + Number(!hasOfferPrice)
    + Number(!hasFreshnessSignal);
  const cepIssueCount = artifactHits.length
    + Number(!customerCueSatisfied)
    + Number(!selectionCueSatisfied)
    + Number(ingredientBenefitBridgeApplicable && !hasIngredientBenefitBridge)
    + Number(ingredientCount === 0 && benefitCount === 0)
    + (contentPlan?.cep.filter((item) => (item.evidenceIds ?? []).length === 0).length ?? 0);
  const eeatIssueCount = metricIssues.length
    + Number(evidenceLedger.length === 0 && sourceEvidence.length === 0)
    + Number(hasClaimMetrics && !hasSampleScope)
    + Number(hasClaimMetrics && !hasTimeScope)
    + Number(hasClaimMetrics && !hasReportedDetails)
    + Math.max(0, plannedEvidenceUnits.length - atomicallyCoveredPlanUnits)
    + invalidPlannedEvidenceRefs;

  const dimensions: GeoQualityDimension[] = [
    {
      id: "geo",
      label: "GEO",
      score: geoScore,
      criteria: copy.geoCriteria,
      summary: copy.scoreSummary(geoScore, geoIssueCount),
      evidence: geoEvidence,
      improvements: geoImprovements
    },
    {
      id: "cep",
      label: "CEP",
      score: cepScore,
      criteria: copy.cepCriteria,
      summary: copy.scoreSummary(cepScore, cepIssueCount),
      evidence: cepEvidence,
      improvements: cepImprovements
    },
    {
      id: "eeat",
      label: "E-E-A-T",
      score: eeatScore,
      criteria: copy.eeatCriteria,
      summary: copy.scoreSummary(eeatScore, eeatIssueCount),
      evidence: eeatEvidence,
      improvements: eeatImprovements
    }
  ];

  return {
    overallScore: Math.round(dimensions.reduce((sum, dimension) => sum + dimension.score, 0) / dimensions.length),
    dimensions,
    validationDetails: validationDetailLines,
    validationImprovements: validationImprovementDirections
  };
}

export function formatGeoQualityEvaluationText(
  productName: string,
  evaluation: GeoQualityEvaluation,
  language: EvalUiLanguage
): string {
  const copy = getGeoQualityCopy(language);
  const lines = [
    copy.title,
    `${copy.productLabel}: ${productName}`,
    `${copy.overallScoreLabel}: ${evaluation.overallScore}/100`,
    ""
  ];

  for (const dimension of evaluation.dimensions) {
    lines.push(`${dimension.label}: ${dimension.score}/100`);
    lines.push(`${copy.criteriaLabel}: ${dimension.criteria}`);
    lines.push(`${copy.summaryLabel}: ${dimension.summary}`);
    lines.push(`${copy.evidenceLabel}:`);
    lines.push(...dimension.evidence.map((item) => `- ${item}`));
    lines.push(`${copy.improvementLabel}:`);
    lines.push(...dimension.improvements.map((item) => `- ${item}`));
    lines.push("");
  }

  if (evaluation.validationDetails.length > 0 || evaluation.validationImprovements.length > 0) {
    lines.push(copy.validationDetailLabel);
    if (evaluation.validationDetails.length > 0) {
      lines.push(`${copy.validationIssueLabel}:`);
      lines.push(...evaluation.validationDetails.map((item) => `- ${item}`));
    }
    if (evaluation.validationImprovements.length > 0) {
      lines.push(`${copy.validationDirectionLabel}:`);
      lines.push(...evaluation.validationImprovements.map((item) => `- ${item}`));
    }
  }

  return lines.join("\n").trim();
}

/** True when the Product offer carries an explicit numeric price (citation gatekeeper). */
function hasExplicitOfferPrice(productNode: Record<string, unknown> | undefined): boolean {
  if (!productNode) {
    return false;
  }
  const offers = productNode["offers"];
  const candidates = Array.isArray(offers) ? offers : offers ? [offers] : [];
  return candidates.some((offer) => {
    if (!offer || typeof offer !== "object") {
      return false;
    }
    const price = (offer as Record<string, unknown>)["price"];
    return typeof price === "number" || (typeof price === "string" && price.trim().length > 0);
  });
}

/** True when any WebPage/graph node exposes a freshness timestamp (citation gatekeeper). */
function hasFreshnessTimestamp(graph: Array<Record<string, unknown>>, webPageNode: Record<string, unknown> | undefined): boolean {
  const nodes = webPageNode ? [webPageNode, ...graph] : graph;
  return nodes.some((node) => ["dateModified", "datePublished", "dateCreated"].some((key) => {
    const value = node[key];
    return typeof value === "string" && value.trim().length > 0;
  }));
}
