import type { JsonValue, PdpGeoContentSections, PdpGeoLocale, PdpGeoValidationRepair } from "./types";

type SchemaNode = Record<string, unknown>;

const localizedCreativeWorkTypes = new Set(["WebPage", "FAQPage", "HowTo"]);

export interface GraphIntegrityResult {
  graph: SchemaNode[];
  repairs: PdpGeoValidationRepair[];
}

export interface StructuredContentParityResult {
  sections: PdpGeoContentSections;
  repairs: PdpGeoValidationRepair[];
}

export interface StructuredContentSnapshot {
  faqNodePresent: boolean;
}

/** Records optional schema presence needed to clear stale FAQ copy on pruning. */
export function captureStructuredContentSnapshot(graph: SchemaNode[]): StructuredContentSnapshot {
  return { faqNodePresent: graph.some((node) => node["@type"] === "FAQPage") };
}

/**
 * Enforces graph-level invariants after individual nodes have been validated.
 *
 * JSON-LD permits references to external nodes, so hasPart cleanup is deliberately
 * limited to references that are known to have been removed or that point at a
 * missing node in the current page's own fragment namespace.
 */
export function repairPdpSchemaGraphIntegrity(
  graph: SchemaNode[],
  locale: PdpGeoLocale
): GraphIntegrityResult {
  const repairs: PdpGeoValidationRepair[] = [];
  const removedIds = new Set<string>();
  const retained: SchemaNode[] = [];

  for (const node of graph) {
    const type = stringValue(node["@type"]);
    const emptyCollectionField = type === "FAQPage"
      ? "mainEntity"
      : type === "HowTo"
        ? "step"
        : undefined;

    const hasValidPublicItems = type === "FAQPage"
      ? hasValidFaqItems(node.mainEntity)
      : type === "HowTo"
        ? hasValidHowToSteps(node.step)
        : true;

    if (emptyCollectionField && !hasValidPublicItems) {
      const id = stringValue(node["@id"]);
      if (id) {
        removedIds.add(id);
      }
      repairs.push({
        field: type ?? "@graph",
        source: "schema-validator",
        issue: `${type} had no valid ${emptyCollectionField} items after field validation.`,
        action: `Removed the empty ${type} node instead of publishing an inapplicable structured-data entity.`,
        before: toJsonValue(node),
        after: null,
        evidence: [`${type}.${emptyCollectionField}`, "post-validation graph integrity"]
      });
      continue;
    }

    retained.push(node);
  }

  const definedIds = new Set(retained
    .map((node) => stringValue(node["@id"]))
    .filter((id): id is string => Boolean(id)));

  const repairedGraph = retained.map((node) => {
    let next = node;
    const type = stringValue(node["@type"]);

    if (type && localizedCreativeWorkTypes.has(type) && node.inLanguage !== locale) {
      const before = node.inLanguage;
      next = { ...next, inLanguage: locale };
      repairs.push({
        field: `${type}.inLanguage`,
        source: "schema-validator",
        issue: `${type}.inLanguage was missing or did not match the requested output locale.`,
        action: `Set ${type}.inLanguage to the validated artifact locale.`,
        before: toJsonValue(before),
        after: locale,
        evidence: ["requested output locale", `${type}.inLanguage`]
      });
    }

    if (type === "WebPage" && next.hasPart !== undefined) {
      const before = next.hasPart;
      const parts = Array.isArray(before) ? before : [before];
      const webPageId = stringValue(next["@id"]);
      const after = parts.filter((part) => !isDanglingLocalReference(part, webPageId, definedIds, removedIds));
      if (after.length !== parts.length) {
        next = { ...next };
        if (after.length > 0) {
          next.hasPart = Array.isArray(before) ? after : after[0];
        } else {
          delete next.hasPart;
        }
        repairs.push({
          field: "WebPage.hasPart",
          source: "schema-validator",
          issue: "WebPage.hasPart referenced schema nodes that were removed or were missing from the page graph.",
          action: "Removed dangling local references while preserving valid graph and external references.",
          before: toJsonValue(before),
          after: after.length > 0 ? toJsonValue(after) : null,
          evidence: ["@graph @id index", "WebPage.hasPart", "post-validation graph integrity"]
        });
      }
    }

    return next;
  });

  return { graph: repairedGraph, repairs };
}

/**
 * Uses retained schema nodes as the source of truth for their visible FAQ and
 * HowTo copy. A single source-backed application instruction is a valid
 * one-step HowTo; structured data and visible usage must retain the same count.
 */
export function synchronizeStructuredContentWithGraph(input: {
  sections: PdpGeoContentSections;
  graph: SchemaNode[];
  snapshot: StructuredContentSnapshot;
}): StructuredContentParityResult {
  const repairs: PdpGeoValidationRepair[] = [];
  const sections = { ...input.sections };

  const faqText = renderFaqText(input.graph);
  const finalFaqPresent = input.graph.some((node) => node["@type"] === "FAQPage");
  if (finalFaqPresent && sections.faq !== faqText) {
    const before = sections.faq;
    sections.faq = faqText;
    repairs.push({
      field: "content.sections.faq",
      source: "field-contract-validator",
      issue: "Visible FAQ copy did not match the final validated FAQPage.mainEntity items.",
      action: "Rebuilt visible FAQ copy from the final validated FAQPage node.",
      before,
      after: faqText,
      evidence: ["FAQPage.mainEntity", "structured-data and visible-content parity"]
    });
  }
  if (input.snapshot.faqNodePresent && !finalFaqPresent && sections.faq !== "") {
    const before = sections.faq;
    sections.faq = "";
    repairs.push({
      field: "content.sections.faq",
      source: "field-contract-validator",
      issue: "Visible FAQ copy remained after its invalid FAQPage node was removed.",
      action: "Cleared stale FAQ copy after the invalid FAQPage node was pruned.",
      before,
      after: "",
      evidence: ["FAQPage.mainEntity", "structured-data and visible-content parity"]
    });
  }

  const howToText = renderHowToText(input.graph);
  const finalHowToPresent = input.graph.some((node) => node["@type"] === "HowTo");
  if (finalHowToPresent && sections.howToUse !== howToText) {
    const before = sections.howToUse;
    sections.howToUse = howToText;
    repairs.push({
      field: "content.sections.howToUse",
      source: "field-contract-validator",
      issue: "Visible usage copy did not match the final validated HowTo.step items.",
      action: "Rebuilt visible usage copy from the final validated HowTo node.",
      before,
      after: howToText,
      evidence: ["HowTo.step", "structured-data and visible-content parity"]
    });
  }

  return { sections, repairs };
}

function renderFaqText(graph: SchemaNode[]): string {
  return graph
    .filter((node) => node["@type"] === "FAQPage")
    .flatMap((node) => collectionItems(node.mainEntity))
    .flatMap((item) => {
      const question = stringValue(item.name);
      const answer = isRecord(item.acceptedAnswer) ? stringValue(item.acceptedAnswer.text) : undefined;
      return question && answer ? [`Q. ${question}\nA. ${answer}`] : [];
    })
    .join("\n\n");
}

function renderHowToText(graph: SchemaNode[]): string {
  const steps = graph
    .filter((node) => node["@type"] === "HowTo")
    .flatMap((node) => collectionItems(node.step))
    .map((step) => stringValue(step.text))
    .filter((text): text is string => Boolean(text));

  return steps.map((text, index) => `${index + 1}. ${text}`).join("\n");
}

function hasValidFaqItems(value: unknown): boolean {
  return collectionItems(value).some((item) => {
    const acceptedAnswer = isRecord(item.acceptedAnswer) ? item.acceptedAnswer : undefined;
    return Boolean(stringValue(item.name) && stringValue(acceptedAnswer?.text));
  });
}

function hasValidHowToSteps(value: unknown): boolean {
  return collectionItems(value).filter((item) => Boolean(stringValue(item.text))).length >= 1;
}

function collectionItems(value: unknown): SchemaNode[] {
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }
  return isRecord(value) ? [value] : [];
}

function isDanglingLocalReference(
  value: unknown,
  webPageId: string | undefined,
  definedIds: Set<string>,
  removedIds: Set<string>
): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const referenceId = stringValue(value["@id"]);
  if (!referenceId || definedIds.has(referenceId)) {
    return false;
  }
  if (removedIds.has(referenceId) || referenceId.startsWith("#")) {
    return true;
  }
  if (!webPageId) {
    return false;
  }
  return documentId(referenceId) === documentId(webPageId);
}

function documentId(value: string): string {
  const fragmentIndex = value.indexOf("#");
  return fragmentIndex >= 0 ? value.slice(0, fragmentIndex) : value;
}

function isRecord(value: unknown): value is SchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => toJsonValue(item))
      .filter((item): item is JsonValue => item !== undefined);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, item]) => [key, toJsonValue(item)] as const)
        .filter(([, item]) => item !== undefined)
    ) as JsonValue;
  }
  return String(value);
}
