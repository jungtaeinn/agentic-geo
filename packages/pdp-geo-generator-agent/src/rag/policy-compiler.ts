import { findPdpGeoRagIndexEntry, findPdpGeoRagSectionEntry, type PdpGeoRagSectionIndexEntry } from "./rag-index";
import type {
  PdpGeoPolicyChecklistSettings,
  PdpGeoPolicyCoverage,
  PdpGeoPolicyCoverageDocument,
  PdpGeoPolicyRule,
  PdpGeoRagFieldTarget,
  PdpGeoRagIntent
} from "../types";

export interface PdpGeoPolicyDocumentInput {
  name: string;
  content: string;
  version?: string;
}

export interface PdpGeoCompiledPolicyChecklist {
  rules: PdpGeoPolicyRule[];
  injectedRules: PdpGeoPolicyRule[];
  coverage: PdpGeoPolicyCoverage;
}

const defaultMaxRules = 240;
const defaultMaxRuleChars = 260;
const minRuleChars = 24;
const narrativePriorityCap = 0.6;

const criticalRulePattern = /(?:\bmust\b|\bmust not\b|\bnever\b|\bdo not\b|\bdon['’]t\b|\bcannot\b|\bnot allowed\b|\bprohibit(?:ed|s)?\b|\bforbidden\b|\breject\b|\bavoid\b|\bexclude\b|\brequired\b|\bonly when\b|\bonly if\b|금지|반드시|하지 마|하지 않|해야 합니다|없어야|제외)/i;

const listItemPattern = /^\s{0,6}(?:[-*+]|\d{1,2}[.)])\s+(.+)$/;
const headingPattern = /^(#{1,4})\s+(.+?)\s*$/;

/**
 * Deterministically compiles every loaded RAG document into an atomic,
 * deduplicated policy-rule checklist so the reasoning model receives the full
 * requirement set instead of only the retrieved top-K chunks.
 */
export function compilePdpGeoPolicyChecklist(
  documents: PdpGeoPolicyDocumentInput[],
  settings?: PdpGeoPolicyChecklistSettings
): PdpGeoCompiledPolicyChecklist {
  const maxRules = settings?.maxRules ?? defaultMaxRules;
  const maxRuleChars = settings?.maxRuleChars ?? defaultMaxRuleChars;
  const rules = settings?.enabled === false ? [] : extractPolicyRules(documents, maxRuleChars);
  const { injected, excludedRuleIds } = selectPolicyRulesForInjection(rules, maxRules);
  return {
    rules,
    injectedRules: injected,
    coverage: createPolicyCoverage(rules, injected, excludedRuleIds)
  };
}

function extractPolicyRules(documents: PdpGeoPolicyDocumentInput[], maxRuleChars: number): PdpGeoPolicyRule[] {
  const rules: PdpGeoPolicyRule[] = [];
  const seen = new Set<string>();

  for (const document of documents) {
    if (!isPolicyDocument(document.name)) {
      continue;
    }
    const indexEntry = findPdpGeoRagIndexEntry(document.name);
    const idPrefix = createRuleIdPrefix(document.name);
    // Heading stack (### inherits ## section metadata when the subsection has
    // no index entry of its own).
    let headingStack: Array<{ level: number; heading: string }> = [];
    let inCodeFence = false;
    let pendingRule: string | undefined;
    let counter = 0;

    const flush = () => {
      if (!pendingRule) {
        return;
      }
      const text = cleanRuleText(pendingRule, maxRuleChars);
      pendingRule = undefined;
      if (text.length < minRuleChars) {
        return;
      }
      const dedupeKey = normalizeRuleKey(text);
      if (seen.has(dedupeKey)) {
        return;
      }
      seen.add(dedupeKey);
      counter += 1;
      const heading = headingStack[headingStack.length - 1]?.heading ?? "General";
      const section = resolveSectionEntry(document.name, headingStack);
      const extraction = section?.ruleExtraction ?? indexEntry?.ruleExtraction ?? "rules";
      const basePriority = section?.priority ?? indexEntry?.priority ?? 0.8;
      rules.push({
        id: `${idPrefix}-${String(counter).padStart(3, "0")}`,
        document: document.name,
        version: document.version,
        kind: indexEntry?.kind ?? "custom",
        heading,
        text,
        intents: section?.intents ?? indexEntry?.intents ?? ["general"],
        fieldTargets: section?.fieldTargets ?? indexEntry?.fieldTargets ?? [],
        severity: extraction === "narrative" ? "guidance" : (criticalRulePattern.test(text) ? "critical" : "guidance"),
        extraction,
        priority: extraction === "narrative" ? Math.min(basePriority, narrativePriorityCap) : basePriority
      });
    };

    for (const line of document.content.split(/\r?\n/)) {
      if (/^\s*```/.test(line)) {
        flush();
        inCodeFence = !inCodeFence;
        continue;
      }
      if (inCodeFence) {
        continue;
      }
      const headingMatch = line.match(headingPattern);
      if (headingMatch) {
        flush();
        const level = headingMatch[1]?.length ?? 1;
        headingStack = headingStack.filter((entry) => entry.level < level);
        headingStack.push({ level, heading: headingMatch[2] ?? "General" });
        continue;
      }
      if (/^\s*\|/.test(line)) {
        flush();
        continue;
      }
      const listMatch = line.match(listItemPattern);
      if (listMatch) {
        flush();
        pendingRule = listMatch[1];
        continue;
      }
      if (pendingRule && line.trim().length > 0 && /^\s{2,}/.test(line)) {
        pendingRule = `${pendingRule} ${line.trim()}`;
        continue;
      }
      flush();
    }
    flush();
  }

  return rules;
}

function selectPolicyRulesForInjection(
  rules: PdpGeoPolicyRule[],
  maxRules: number
): { injected: PdpGeoPolicyRule[]; excludedRuleIds: string[] } {
  const promptRelevant = rules.filter((rule) => !isRetrievalOnlyRule(rule));
  const budget = Math.max(0, maxRules);
  const critical = promptRelevant
    .filter((rule) => rule.severity === "critical")
    .sort(comparePolicyRuleForCoverage);
  const guidance = promptRelevant
    .filter((rule) => rule.severity === "guidance")
    .sort(comparePolicyRuleForCoverage);

  // Small prompt budgets previously either exceeded maxRules or let whichever
  // document had the most critical bullets crowd out the rest. Reserve one
  // representative per document (strategic GEO/E-E-A-T/CEP first), then fill
  // by severity and priority while keeping the hard budget.
  const documentRepresentatives = [...promptRelevant]
    .sort((left, right) =>
      Number(right.severity === "critical") - Number(left.severity === "critical")
      || comparePolicyRuleForCoverage(left, right))
    .filter((rule, index, candidates) => candidates.findIndex((candidate) => candidate.document === rule.document) === index)
    .slice(0, budget);
  const injected: PdpGeoPolicyRule[] = [...documentRepresentatives];
  const injectedIds = new Set(injected.map((rule) => rule.id));
  for (const rule of critical) {
    if (injected.length >= budget) break;
    if (!injectedIds.has(rule.id)) {
      injected.push(rule);
      injectedIds.add(rule.id);
    }
  }

  for (const rule of guidance) {
    if (injected.length >= budget) break;
    if (!injectedIds.has(rule.id)) {
      injected.push(rule);
      injectedIds.add(rule.id);
    }
  }
  return {
    injected,
    excludedRuleIds: rules.filter((rule) => !injectedIds.has(rule.id)).map((rule) => rule.id)
  };
}

function comparePolicyRuleForCoverage(left: PdpGeoPolicyRule, right: PdpGeoPolicyRule): number {
  const kindPriority: Record<string, number> = {
    "geo-research": 100,
    eeat: 99,
    cep: 98,
    schema: 90,
    "best-practice": 88,
    locale: 82,
    terminology: 80,
    "official-docs": 78
  };
  return (kindPriority[right.kind] ?? 0) - (kindPriority[left.kind] ?? 0)
    || right.priority - left.priority
    || left.document.localeCompare(right.document)
    || left.id.localeCompare(right.id);
}

function createPolicyCoverage(
  rules: PdpGeoPolicyRule[],
  injected: PdpGeoPolicyRule[],
  excludedRuleIds: string[]
): PdpGeoPolicyCoverage {
  const injectedIds = new Set(injected.map((rule) => rule.id));
  const documents = new Map<string, PdpGeoPolicyCoverageDocument>();
  for (const rule of rules) {
    const entry = documents.get(rule.document) ?? {
      document: rule.document,
      kind: rule.kind,
      totalRules: 0,
      injectedRules: 0,
      criticalRules: 0,
      injectedCriticalRules: 0,
      narrativeRules: 0
    };
    entry.totalRules += 1;
    if (rule.severity === "critical") {
      entry.criticalRules += 1;
    }
    if (rule.extraction === "narrative") {
      entry.narrativeRules += 1;
    }
    if (injectedIds.has(rule.id)) {
      entry.injectedRules += 1;
      if (rule.severity === "critical") {
        entry.injectedCriticalRules += 1;
      }
    }
    documents.set(rule.document, entry);
  }
  const criticalRules = rules.filter((rule) => rule.severity === "critical").length;
  const injectedCriticalRules = injected.filter((rule) => rule.severity === "critical").length;
  return {
    mode: "compiled-policy-checklist",
    totalRules: rules.length,
    injectedRules: injected.length,
    criticalRules,
    injectedCriticalRules,
    criticalCoverageRatio: criticalRules === 0 ? 1 : injectedCriticalRules / criticalRules,
    documents: [...documents.values()],
    excludedRuleIds
  };
}

/**
 * Groups injected rules for the prompt payload: critical first inside each
 * output-field group so position bias cannot drop guardrails.
 */
export function formatPolicyChecklistPayload(rules: PdpGeoPolicyRule[]): Record<string, unknown> | undefined {
  if (rules.length === 0) {
    return undefined;
  }
  const groups = new Map<string, PdpGeoPolicyRule[]>();
  for (const rule of rules) {
    const key = primaryFieldGroup(rule.fieldTargets);
    const bucket = groups.get(key) ?? [];
    bucket.push(rule);
    groups.set(key, bucket);
  }
  return {
    instruction: [
      "policyChecklist is the budget-bounded compiled requirement set selected across the loaded RAG policy documents; it is authoritative over any looser summary of the same selected rules.",
      "The selector preserves cross-document coverage before filling remaining capacity by severity and priority; apply each included rule without assuming that an omitted rule was contradicted.",
      "Apply every [critical] rule as a hard constraint on the requested fields. Apply [guidance] rules unless product evidence makes them inapplicable.",
      "[brand-context] entries are brand positioning/tone background, not requirements: use them for vocabulary and mood, and never convert them into product claims or facts.",
      "Before returning JSON, re-check each [critical] rule against your draft and report any rule you could not satisfy in ruleCompliance.violatedRuleIds."
    ],
    groups: [...groups.entries()].map(([field, groupRules]) => ({
      field,
      rules: [...groupRules]
        .sort((a, b) => severityRank(a) - severityRank(b) || b.priority - a.priority)
        .map((rule) => `[${rule.id}][${rule.extraction === "narrative" ? "brand-context" : rule.severity}] ${rule.text} (${rule.document} § ${rule.heading})`)
    }))
  };
}

/** Short end-of-prompt recap so critical rules also occupy the recency position. */
export function formatPolicyComplianceRecap(rules: PdpGeoPolicyRule[]): Record<string, unknown> | undefined {
  const criticalIds = rules.filter((rule) => rule.severity === "critical").map((rule) => rule.id);
  if (criticalIds.length === 0) {
    return undefined;
  }
  return {
    instruction: "Final check before answering: verify the draft against every critical rule id below, fix violations, then list any remaining unsatisfied ids in ruleCompliance.violatedRuleIds with a short note in ruleCompliance.notes.",
    criticalRuleIds: criticalIds
  };
}

function resolveSectionEntry(
  documentName: string,
  headingStack: Array<{ level: number; heading: string }>
): PdpGeoRagSectionIndexEntry | undefined {
  for (let index = headingStack.length - 1; index >= 0; index -= 1) {
    const entry = findPdpGeoRagSectionEntry(documentName, headingStack[index]?.heading);
    if (entry) {
      return entry;
    }
  }
  return undefined;
}

function isRetrievalOnlyRule(rule: PdpGeoPolicyRule): boolean {
  return rule.fieldTargets.length > 0 && rule.fieldTargets.every((target) => target === "retrieval");
}

function primaryFieldGroup(fieldTargets: PdpGeoRagFieldTarget[]): string {
  const publicTargets = fieldTargets.filter((target) => target !== "diagnostics" && target !== "retrieval");
  if (publicTargets.length === 0) {
    return "General / cross-field";
  }
  if (publicTargets.length > 2) {
    return "General / cross-field";
  }
  return publicTargets.join(" & ");
}

function severityRank(rule: PdpGeoPolicyRule): number {
  return rule.severity === "critical" ? 0 : 1;
}

function isPolicyDocument(name: string): boolean {
  return /\.(md|markdown|txt)$/i.test(name) || !/\.[a-z0-9]+$/i.test(name);
}

function createRuleIdPrefix(documentName: string): string {
  return documentName
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/_v\d+$/i, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toUpperCase()
    .slice(0, 32) || "POLICY";
}

function cleanRuleText(raw: string, maxRuleChars: number): string {
  const text = raw
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= maxRuleChars) {
    return text;
  }
  const truncated = text.slice(0, maxRuleChars);
  const lastBreak = Math.max(truncated.lastIndexOf(". "), truncated.lastIndexOf("; "));
  return `${lastBreak > maxRuleChars * 0.6 ? truncated.slice(0, lastBreak + 1) : truncated}…`.trim();
}

function normalizeRuleKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9가-힣]+/g, "");
}
