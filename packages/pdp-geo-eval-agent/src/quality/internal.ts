import type { EvalDiagnosticsInput, EvalUiLanguage, EvalValidationRepair } from "../types";
import { findSerializedMetadataArtifact } from "../contracts/serialized-metadata";
import { getGeoQualityCopy, type GeoQualityCopy } from "./copy";

/**
 * Deterministic helpers behind the quality rubric: schema-graph readers,
 * cue/artifact/metric detectors, and validation-line collectors. All pure;
 * extracted from the console (which keeps its own copies for other panels).
 */
export function getSchemaGraph(jsonLd: unknown): Record<string, unknown>[] {
  if (!isRecord(jsonLd)) {
    return [];
  }

  const graph = jsonLd["@graph"];
  if (Array.isArray(graph)) {
    return graph.filter(isRecord);
  }

  return [jsonLd];
}

export function getSchemaNodeTypes(node: Record<string, unknown>): string[] {
  const type = node["@type"];
  if (typeof type === "string") {
    return [type];
  }
  if (Array.isArray(type)) {
    return type.filter((item): item is string => typeof item === "string");
  }
  return [];
}

export function findSchemaNode(graph: Record<string, unknown>[], type: string): Record<string, unknown> | undefined {
  return graph.find((node) => getSchemaNodeTypes(node).includes(type));
}

export function getRecordString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

export function countSchemaItems(value: unknown): number {
  if (Array.isArray(value)) {
    return value.filter(Boolean).length;
  }

  if (isRecord(value)) {
    const itemListElement = value["itemListElement"];
    const mainEntity = value["mainEntity"];
    const step = value["step"];
    if (Array.isArray(itemListElement)) {
      return itemListElement.filter(Boolean).length;
    }
    if (Array.isArray(mainEntity)) {
      return mainEntity.filter(Boolean).length;
    }
    if (Array.isArray(step)) {
      return step.filter(Boolean).length;
    }
    return 1;
  }

  return typeof value === "string" && value.trim().length > 0 ? 1 : 0;
}

export function collectTextValues(value: unknown, depth = 0): string[] {
  if (depth > 5) {
    return [];
  }
  if (typeof value === "string") {
    return value.trim().length > 0 ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectTextValues(item, depth + 1));
  }
  if (isRecord(value)) {
    return Object.values(value).flatMap((item) => collectTextValues(item, depth + 1));
  }
  return [];
}

export function collectSchemaFaqQuestions(faqNode: Record<string, unknown> | undefined): string[] {
  if (!faqNode) {
    return [];
  }

  const entities = faqNode["mainEntity"];
  if (!Array.isArray(entities)) {
    return [];
  }

  return entities.flatMap((entity) => {
    if (!isRecord(entity)) {
      return [];
    }
    const name = entity["name"];
    return typeof name === "string" && name.trim().length > 0 ? [name.trim()] : [];
  });
}

export function countValidSchemaFaqItems(faqNode: Record<string, unknown>): number {
  const entities = faqNode["mainEntity"];
  if (!Array.isArray(entities)) {
    return 0;
  }

  return entities.filter((entity) => {
    if (!isRecord(entity) || !getSchemaNodeTypes(entity).includes("Question")) {
      return false;
    }
    const answer = entity["acceptedAnswer"];
    return getRecordString(entity, "name").trim().length > 0
      && isRecord(answer)
      && getSchemaNodeTypes(answer).includes("Answer")
      && getRecordString(answer, "text").trim().length > 0;
  }).length;
}

export function countValidHowToSteps(howToNode: Record<string, unknown>): number {
  const steps = howToNode["step"];
  if (!Array.isArray(steps)) {
    return 0;
  }

  return steps.filter((step) => (
    isRecord(step)
    && getSchemaNodeTypes(step).includes("HowToStep")
    && getRecordString(step, "name").trim().length > 0
    && getRecordString(step, "text").trim().length > 0
  )).length;
}

export function countDanglingLocalSchemaReferences(graph: Record<string, unknown>[]): number {
  const nodeIds = new Set(graph.map((node) => getRecordString(node, "@id").trim()).filter(Boolean));
  const localBases = new Set(Array.from(nodeIds).map((id) => id.replace(/#[^#]*$/, "")));
  const relationKeys = ["about", "mainEntity", "mainEntityOfPage", "breadcrumb", "hasPart", "isPartOf"];
  const references = graph.flatMap((node) => relationKeys.flatMap((key) => collectSchemaIdReferences(node[key])));

  return new Set(references.filter((reference) => {
    if (!reference.includes("#") || nodeIds.has(reference)) {
      return false;
    }
    return localBases.has(reference.replace(/#[^#]*$/, ""));
  })).size;
}

export function countSchemaNodes(jsonLd: unknown): number {
  if (isRecord(jsonLd)) {
    const graph = jsonLd["@graph"];
    if (Array.isArray(graph)) {
      return graph.length;
    }
    return 1;
  }

  return 0;
}

export function uniqueQualityItems(items: Array<string | undefined>): string[] {
  return Array.from(new Set(items.filter((item): item is string => Boolean(item && item.trim().length > 0))));
}

export function ensureQualityItems(items: Array<string | undefined>, fallback: string): string[] {
  const uniqueItems = uniqueQualityItems(items);
  return uniqueItems.length > 0 ? uniqueItems : [fallback];
}

export function clampQualityScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function compactQualityText(value: string, maxLength = 180): string {
  const compacted = value.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) {
    return compacted;
  }

  return `${compacted.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

export function limitQualityValidationLines(
  items: string[],
  copy: GeoQualityCopy
): string[] {
  const maxItems = 24;
  if (items.length <= maxItems) {
    return items;
  }

  return [
    ...items.slice(0, maxItems),
    copy.validationMoreDetails(items.length - maxItems)
  ];
}

export function isDisabledHtmlContentValidationScope(value: string): boolean {
  return /^content(?:\.|\b)/iu.test(value.trim())
    || /(?:generated\s+html|html\s+content|accordion\s+html)/iu.test(value);
}

export function collectPublicArtifactHits(publicText: string, faqQuestions: string[], language: EvalUiLanguage): string[] {
  const copy = getGeoQualityCopy(language);
  const hits: string[] = [];
  const sourceHeadingQuestion = faqQuestions.find((question) => /^(?:key ingredients|ingredients|benefits|how to use|summary)$/i.test(question.trim()));
  const ocrNoise = publicText.match(/\b(?:3Home|SÉRUM|SERUM\s+ACTIVATEUR|ACTIVATEUR)\b/i)?.[0];
  const internalLabel = publicText.match(/\b(?:fallbackDescription|sentence QA|RAG chunk|schema-validator|html-validator)\b/i)?.[0];
  const serializedMetadata = findSerializedMetadataArtifact(publicText);

  if (sourceHeadingQuestion) {
    hits.push(copy.faqHeadingArtifact(sourceHeadingQuestion));
  }
  if (ocrNoise) {
    hits.push(copy.ocrNoiseArtifact(ocrNoise));
  }
  if (internalLabel) {
    hits.push(copy.internalArtifact(internalLabel));
  }
  if (serializedMetadata) {
    hits.push(copy.serializedMetadataArtifact(serializedMetadata));
  }

  return uniqueQualityItems(hits);
}

export function collectMetricIntegrityIssues(publicText: string, language: EvalUiLanguage): string[] {
  const copy = getGeoQualityCopy(language);
  const splitMetrics = Array.from(publicText.matchAll(/\+\d+\.\s+\d%/g)).map((match) => match[0]);
  const lowAgreementMetrics = Array.from(publicText.matchAll(/\b[1-9]%\s+agreed\b/gi)).map((match) => match[0]);
  // Claim-distortion lints added after a live run shipped all three defects:
  // duplicated units ("100%%"), stuttered verbs ("supports supports"), and a
  // share-of-participants value rendered as a change magnitude.
  const duplicatedUnit = publicText.match(/\d+(?:\.\d+)?%%/)?.[0];
  const duplicatedWord = publicText.match(/\b(supports|helps|improves|reduces|provides)\s+\1\b/i)?.[0];
  const implausibleMagnitude = publicText.match(/\b[a-z][a-z\s&,-]{2,60}\s(?:decreased|reduced|improved|increased)\sby\s(?:9[5-9]|100)\s?%/i)?.[0];
  // Claim-modality lints (E-E-A-T): self-assessment agreement upgraded to an
  // objective improvement reading, and self-assessment borrowing clinical
  // status in the same phrase ("self-assessment from clinical ...").
  const selfAssessmentUpgrade = publicText.match(/(?:self[-\s]?assessment|자가\s*평가)(?:(?!instrumental|기기\s*측정|임상|clinical\s+stud)[^.!?;]){0,120}(?:\b(?:showed|demonstrated|confirmed|proved|saw|exhibited)\b[^.!?;]{0,60}\bimprovement|\bimproved\s+by\b|개선(?:을|이)?\s*(?:확인|입증|보였))/iu)?.[0];
  const contradictoryModality = publicText.match(/clinical\s+self[-\s]?assessment|self[-\s]?assessment\s+(?:from|of|via|in)\s+(?:a\s+)?clinical|임상\s*(?:시험)?\s*(?:기반|의)?\s*자가\s*평가/iu)?.[0];
  // Realization-defect lints: a direction stem nested inside its own object
  // phrase ("improvement in Visible improvement in fine lines") and a
  // capitalized temporal clause spliced mid-sentence ("...fine lines After
  // one bottle of daily use"). Enumerations ("improvement in X and an
  // improvement in Y") and sentence-initial clauses stay clean.
  const duplicatedStem = publicText.match(/\b(improvement|reduction|increase|decrease)\s+(?:in|of)\s+(?:(?!and\b|or\b)[A-Za-z-]+\s+){0,3}\1\s+(?:in|of)\b/i)?.[0];
  const splicedClause = publicText.match(/[a-z],? (?:After|Before|During|Within) (?:one|two|three|a |an |the |\d|use|using|daily|application|cleansing)/)?.[0];

  return uniqueQualityItems([
    ...splitMetrics.map((value) => copy.metricSplitIssue(value)),
    ...lowAgreementMetrics.map((value) => copy.lowAgreementIssue(value)),
    duplicatedUnit ? copy.duplicatedUnitIssue(duplicatedUnit) : undefined,
    duplicatedWord ? copy.duplicatedWordIssue(duplicatedWord) : undefined,
    implausibleMagnitude ? copy.implausibleMagnitudeIssue(implausibleMagnitude.trim()) : undefined,
    selfAssessmentUpgrade ? copy.selfAssessmentUpgradeIssue(compactQualityText(selfAssessmentUpgrade.trim(), 120)) : undefined,
    contradictoryModality ? copy.contradictoryModalityIssue(compactQualityText(contradictoryModality.trim(), 120)) : undefined,
    duplicatedStem ? copy.duplicatedStemIssue(compactQualityText(duplicatedStem.trim(), 120)) : undefined,
    splicedClause ? copy.splicedClauseIssue(compactQualityText(splicedClause.trim(), 120)) : undefined
  ]);
}

export function hasIngredientBenefitChoiceBridge(text: string): boolean {
  return /(?:ingredient|active|extract|formula|formulated|contains|powered by|with|ceramide|capsule|technology|성분|함유|포함|포뮬러|캡슐|세라마이드|기술).{0,180}(?:help|support|improv|target|benefit|elastic|firm|wrinkle|barrier|hydration|moistur|radiance|texture|효능|효과|개선|강화|제공|도움|보습|수분|장벽|진정|선택|추천)/is.test(text);
}

export function hasCustomerChoiceCue(text: string): boolean {
  return /(?:skin type|works best for|solution for|ideal for|for customers|for users|concern|wrinkle|elasticity|dry|oily|combination|sensitive|피부|고민|선택|추천|적합)/i.test(text);
}

export function hasSelectionCriteriaCue(text: string): boolean {
  return /(?:choose|choice|selection|works best|solution for|skin type|customer|고객|선택|추천|적합)/i.test(text);
}

export function hasReportedSampleScopeDisclosure(publicText: string): boolean {
  return /(?:시험\s*대상|조사\s*대상|표본|대상자|sample|test\s+audience|study\s+audience|participants?|subjects?).{0,48}(?:확인되지|확인\s*불가|미공개|명시되지|not\s+disclosed|not\s+stated|not\s+specified)/i.test(publicText)
    || /(?:원문|공개\s*범위|public\s+source).{0,64}(?:시험\s*대상|조사\s*대상|표본|sample|audience).{0,48}(?:확인되지|확인\s*불가|미공개|명시되지|not\s+disclosed|not\s+stated|not\s+specified)/i.test(publicText);
}

/**
 * Pairs validation repairs with the warnings they resolved by field
 * reference. The generator emits a warning and its repair in lockstep (the
 * warning text names the repaired field), but external callers — the REST
 * surface accepts arbitrary diagnostics — may send unrelated combinations,
 * so pairing is by content: positional subtraction would erase unrelated
 * warnings from both the score and the report.
 */
export function partitionValidationWarnings(
  warnings: string[],
  repairs: EvalValidationRepair[]
): { resolvedWarnings: string[]; unresolvedWarnings: string[] } {
  const unresolvedWarnings = [...warnings];
  const resolvedWarnings: string[] = [];
  for (const repair of repairs) {
    const field = repair.field?.trim().toLowerCase();
    if (!field) {
      continue;
    }
    const index = unresolvedWarnings.findIndex((warning) => warning.toLowerCase().includes(field));
    if (index >= 0) {
      resolvedWarnings.push(...unresolvedWarnings.splice(index, 1));
    }
  }
  return { resolvedWarnings, unresolvedWarnings };
}

export function collectValidationDetailLines(
  diagnostics: EvalDiagnosticsInput,
  copy: GeoQualityCopy
): string[] {
  const repairs = (diagnostics.validationRepairs ?? [])
    .filter((repair) => !isDisabledHtmlContentValidationScope(repair.field));
  const repairLines = repairs.map((repair, index) => copy.validationRepairDetail(
    index + 1,
    compactQualityText(repair.field),
    compactQualityText(repair.source ?? ""),
    compactQualityText(repair.issue ?? ""),
    compactQualityText(repair.action ?? "")
  ));
  const warnings = diagnostics.validationWarnings
    .filter((warning) => !isDisabledHtmlContentValidationScope(warning));
  const { unresolvedWarnings } = partitionValidationWarnings(warnings, repairs);
  const warningLines = unresolvedWarnings.map((warning, index) => copy.validationWarningDetail(
    repairLines.length + index + 1,
    compactQualityText(warning)
  ));
  const lines = uniqueQualityItems([...repairLines, ...warningLines]);

  return limitQualityValidationLines(lines, copy);
}

export function collectValidationImprovementLines(
  diagnostics: EvalDiagnosticsInput,
  copy: GeoQualityCopy
): string[] {
  const repairs = (diagnostics.validationRepairs ?? [])
    .filter((repair) => !isDisabledHtmlContentValidationScope(repair.field));
  const warnings = diagnostics.validationWarnings
    .filter((warning) => !isDisabledHtmlContentValidationScope(warning));
  const { unresolvedWarnings } = partitionValidationWarnings(warnings, repairs);
  const scopes = unresolvedWarnings.length > 0 ? unresolvedWarnings : warnings;
  const directions = uniqueQualityItems(scopes.flatMap((scope) => {
    const direction = inferValidationDirection(scope, copy);
    return direction ? [direction] : [];
  }));

  if (directions.length > 0) {
    return directions;
  }

  return warnings.length > 0 ? [copy.validationGenericDirection] : [];
}

export function inferValidationDirection(
  value: string,
  copy: GeoQualityCopy
): string | undefined {
  const scope = value.toLowerCase();

  if (/(?:additionalproperty|propertyvalue|additional property|property value)/.test(scope)) {
    return copy.propertyValidationDirection;
  }
  if (/(?:howto|how-to|how_to|howtouse|how to use|\bstep\b|사용\s*방법)/.test(scope)) {
    return copy.howToValidationDirection;
  }
  if (/(?:faq|question|answer|mainentity|acceptedanswer|질문|답변)/.test(scope)) {
    return copy.faqValidationDirection;
  }
  if (/(?:description|webpage|product\.description|페이지\s*설명|상품\s*설명)/.test(scope)) {
    return copy.descriptionValidationDirection;
  }
  if (/(?:html|markup|script|style|dom|마크업)/.test(scope)) {
    return copy.htmlValidationDirection;
  }
  if (/(?:metric|claim|evidence|sample|period|agreement|percent|%|수치|표본|기간|측정)/.test(scope)) {
    return copy.claimValidationDirection;
  }
  if (/(?:ingredient|benefit|positive|effect|efficacy|성분|효능|효과|피부\s*타입)/.test(scope)) {
    return copy.factValidationDirection;
  }
  if (/(?:korean|spacing|particle|grammar|copy|awkward|문법|띄어쓰기|조사|어색)/.test(scope)) {
    return copy.copyValidationDirection;
  }

  return undefined;
}



function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function collectSchemaIdReferences(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectSchemaIdReferences);
  }
  if (!isRecord(value)) {
    return [];
  }

  const id = getRecordString(value, "@id").trim();
  return id ? [id] : [];
}
