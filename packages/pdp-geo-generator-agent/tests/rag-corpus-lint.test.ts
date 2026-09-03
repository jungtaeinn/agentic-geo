import { describe, expect, it } from "vitest";
import { readPdpGeoGeneratorRagProfile } from "../src/rag/profile";
import { pdpGeoGeneratorRagManifest } from "../src/rag/manifest";
import { pdpGeoRagIndex } from "../src/rag/rag-index";
import { extractPolicyRules, normalizeRuleKey } from "../src/rag/policy-compiler";
import { tokenize, lexicalSimilarity } from "../src/rag/retrieval";
import { productNormalizationRagPriority, selectProductNormalizationRagDocuments } from "../src/product-normalizer";
import type { PdpGeoPolicyDocumentInput } from "../src/rag/policy-compiler";
import type { PdpGeoPolicyRule } from "../src/types";

/**
 * Recurrence-prevention gate for Phase 2 contract canonicalization: the
 * common corpus + brand overlays must not regrow near-duplicate policy rules
 * across documents, checkedAt metadata must stay parseable, and no document
 * may reference another corpus document by its versioned filename (contracts
 * cross-reference each other in prose so a future version bump cannot leave
 * a stale filename embedded in the text).
 */

const NEAR_DUPLICATE_THRESHOLD = 0.8;
const CONTRADICTION_REPORT_MIN = 0.5;

interface RuleWhitelistEntry {
  /** Matches when both rule ids appear in this pair, in either order. */
  ruleIds: [string, string];
  reason: string;
  /**
   * First 40 chars of normalizeRuleKey(rule.text) for each id, in the same
   * order as ruleIds — a content fingerprint, not just an existence check.
   * Positional rule ids are assigned by counting list items in extraction
   * order, so a corpus edit that adds/removes/reorders a bullet before one
   * of these ids can leave the id alive but pointing at a DIFFERENT rule.
   * The liveness test below re-derives this fingerprint from the current
   * extraction and fails if it no longer matches, catching silent
   * re-pointing that a bare "does this id exist" check would miss.
   */
  textFingerprints: [string, string];
}

// Explicit, justified intentional near-duplicate pairs. Each entry names the
// exact rule-id pair (not a document-level blanket exemption) plus why the
// overlap is intentional rather than drift. Add an entry here only with a
// concrete justification; do not widen this to a document- or pattern-level
// exemption.
const KNOWN_INTENTIONAL_DUPLICATE_PAIRS: RuleWhitelistEntry[] = [
  {
    // The canonical Description Composition Contract's "usage belongs in
    // Usage/HowTo" clause is deliberately echoed by best-practice_v1.md's
    // field-usage guidance (Task 3 fix intentionally generated this restatement
    // as a locally-scoped reminder next to the field's own composition list).
    // The canonical document is authoritative; best-practice's copy is kept in
    // sync manually and reviewed here instead of being converted to a prose
    // cross-reference, because it functions as a checklist bullet in place.
    // Currently below threshold (~0.786) — whitelisted anyway so a future
    // wording drift that pushes it over 0.8 does not become a surprise
    // failure; it is a known, reviewed duplicate either way.
    // Re-pointed from -008 to -010 when the composition contract gained the two
    // named-technology bullets ahead of this one, and from -010 to -013 when
    // Task 7b/7d added the question-chain, concern-mechanism, and source-stated
    // contrast bullets ahead of it; the fingerprint below is what caught each
    // shift, which is what it is there for.
    ruleIds: ["CONTENT-FIELD-CONTRACTS-013", "BEST-PRACTICE-044"],
    reason:
      "content-field-contracts_v1.md Description Composition Contract usage clause vs best-practice_v1.md:110 field-usage bullet — intentional echo from the Task 3 fix; canonical document is authoritative.",
    textFingerprints: ["usagecontextbelongsinusagehowtoandmustno", "usagecontextbelongsinusagehowtosoitdoesn"]
  },
  {
    // brand-identity_v1.md is a shared per-brand template (see its own "Optional
    // future ... documents" naming-convention section): every brand overlay
    // fills the same scaffold sections ("Brand Evidence Scope and RAG Use",
    // "E-E-A-T Application") with brand-specific vocabulary. The resulting
    // structural symmetry across sibling brand files is intentional design,
    // not policy-contract restatement drift between common documents.
    ruleIds: ["BRANDS-EXAMPLEDERMA-BRAND-IDENTI-005", "BRANDS-EXAMPLELUXE-BRAND-IDENTIT-005"],
    reason:
      "brands/examplederma/brand-identity_v1.md vs brands/exampleluxe/brand-identity_v1.md § Brand Evidence Scope and RAG Use — shared brand-identity template scaffold, brand-specific vocabulary substituted per brand.",
    textFingerprints: ["usethisdocumenttoinferbrandimagebrandton", "usethisdocumenttoinferbrandimagebrandton"]
  },
  {
    ruleIds: ["BRANDS-EXAMPLEDERMA-BRAND-IDENTI-006", "BRANDS-EXAMPLELUXE-BRAND-IDENTIT-006"],
    reason:
      "brands/examplederma/brand-identity_v1.md vs brands/exampleluxe/brand-identity_v1.md § Brand Evidence Scope and RAG Use (invented-claim guardrail bullet) — same shared brand-identity template scaffold.",
    textFingerprints: ["donotusethisdocumenttoinventproductspeci", "donotusethisdocumenttoinventproductspeci"]
  },
  {
    ruleIds: ["BRANDS-EXAMPLEDERMA-BRAND-IDENTI-122", "BRANDS-EXAMPLELUXE-BRAND-IDENTIT-062"],
    reason:
      "brands/examplederma/brand-identity_v1.md vs brands/exampleluxe/brand-identity_v1.md § E-E-A-T Application (Experience bullet) — same shared brand-identity template scaffold.",
    textFingerprints: ["experienceconnectresearchcontexttodrynes", "experienceconnectresearchcontexttoroutin"]
  },
  {
    // Both brand files now point at the same canonical Evidence Routing
    // Contract clause (content-field-contracts_v1.md) with the identical
    // clean prose pointer sentence, on purpose: an earlier version gave each
    // brand deliberately different wording to dodge this exact lint check,
    // which review correctly called out as bending the corpus to satisfy the
    // linter instead of the other way around. A pointer sentence that
    // restates none of the underlying rule's content is exactly the case the
    // whitelist mechanism exists for — the near-dup gate should not force
    // artificial wording variance onto a sentence that says nothing but
    // "see the canonical contract."
    ruleIds: ["BRANDS-EXAMPLEDERMA-BRAND-IDENTI-113", "BRANDS-EXAMPLELUXE-BRAND-IDENTIT-051"],
    reason:
      "brands/examplederma/brand-identity_v1.md vs brands/exampleluxe/brand-identity_v1.md § Claim Safety — both are the identical clean prose pointer to the Evidence Routing Contract in content-field-contracts_v1.md (no rule content restated), unified across brands intentionally rather than kept artificially distinct to dodge the lint.",
    textFingerprints: ["reportaclinicalorconsumertestmetriconlyw", "reportaclinicalorconsumertestmetriconlyw"]
  }
];

// Untruncated: the production compiler truncates rule text to a prompt-budget
// character count (260 by default), which can cut off a "Preferred example"
// whitelist marker mid-sentence and produce false positives/negatives here.
// The lint needs the full bullet text to compare and classify correctly.
const LINT_RULE_TEXT_MAX_CHARS = 100_000;

async function loadAllPolicyDocuments(): Promise<PdpGeoPolicyDocumentInput[]> {
  const profile = await readPdpGeoGeneratorRagProfile();
  return [
    { name: pdpGeoGeneratorRagManifest.analysisPrompt, content: profile.analysisPrompt },
    ...profile.documents.map((document) => ({ name: document.name, content: document.content }))
  ];
}

// extractPolicyRules dedupes globally across every document it is handed
// (policy-compiler.ts's `seen` set spans the whole call), so a rule that is
// an exact verbatim (or case-only) copy in a second document is silently
// dropped rather than surfaced as a same-text rule in that document — it
// never gets a chance to appear as a near-duplicate PAIR at all. Extracting
// document-by-document and concatenating keeps each document's own exact
// copy alive so the cross-document comparison below can actually compare it
// against its twin instead of only ever seeing the first document's copy.
// Deliberately does NOT filter out rule.extraction === "narrative" entries.
// The brief's pseudocode sketch mentioned excluding narrative-marked sections
// from the near-dup scan, but narrative rules can still be exact/near
// verbatim copies worth catching (see BOILERPLATE_PATTERNS below, which
// exempts the narrative-marked naming-convention path templates by content
// rather than by extraction kind). Keeping narrative rules in the comparison
// is the stricter behavior and produced zero false positives once the
// boilerplate/preferred-example/known-pair whitelists were in place, so this
// is an intentional deviation from the brief, not an oversight.
function extractRulesPerDocument(documents: PdpGeoPolicyDocumentInput[]): PdpGeoPolicyRule[] {
  return documents.flatMap((document) => extractPolicyRules([document], LINT_RULE_TEXT_MAX_CHARS));
}

function isWhitelistedPreferredExample(a: PdpGeoPolicyRule, b: PdpGeoPolicyRule): boolean {
  // AND, not OR: only exempt when BOTH sides carry the marker. An OR here
  // would exempt any pair where just one side happens to contain a
  // "Preferred example" bullet elsewhere in a longer merged rule, even if the
  // other side is an unrelated rule that never earned the exemption.
  const marker = /preferred example|권장 예시/i;
  return marker.test(a.text) && marker.test(b.text);
}

interface BoilerplatePattern {
  pattern: RegExp;
  reason: string;
}

// Pattern-based (not pair-based) whitelist for structural boilerplate: lines
// that carry no reusable policy content of their own — a bibliography-list
// intro stamped with a checked-on date, a document's own metadata header
// fields, or a file-naming-convention path template. These recur by
// construction every time a sibling document/brand-overlay is added, so
// pinning them to specific rule-id pairs would just churn on every corpus
// edit. A pair is exempt only when BOTH sides match the SAME pattern, so a
// real rule that happens to share a few words with boilerplate is never
// accidentally waved through.
const BOILERPLATE_PATTERNS: BoilerplatePattern[] = [
  {
    pattern: /^sources checked on \d{4}-\d{2}-\d{2}:?$/i,
    reason: "Bare \"Sources checked on <date>:\" bibliography-list intro line — no content of its own, only a provenance-date stamp each document sets independently before its own source list."
  },
  {
    // Anchored to the SHAPE of a bare citation line — "<short label>: <one or
    // more https:// URLs>." and nothing else — with a lookahead requiring the
    // Google Search Central / Product structured-data domain somewhere in it.
    // An earlier version of this pattern was a bare substring test for
    // "developers.google.com/search/docs" anywhere in the rule text, which
    // also exempted substantive critical rules that merely CITE that URL
    // inside a longer instruction (verified false-exemption at 0.920/0.818
    // similarity in review). Requiring the whole rule text to be just the
    // citation line — no instruction verbs, no trailing clause — keeps real
    // policy sentences that happen to reference the same URL out of scope.
    pattern: /^(?=.*developers\.google\.com)[\w .\/&()-]{0,70}:\s*(?:https:\/\/[^\s,]+,?\s*)+\.?$/i,
    reason: "Official Google Search Central / Product structured-data doc citation, independently listed in each document's own sources-checked bibliography — provenance of what that document's authors reviewed, not policy-rule content."
  },
  {
    pattern: /^brand identity source role: package-managed brand context\.?$/i,
    reason: "Brand-identity template metadata header field (source role) — identical by construction across every brand overlay."
  },
  {
    pattern: /^checked date: \d{4}-\d{2}-\d{2}\.?$/i,
    reason: "Brand-identity template metadata header field (checked date) — identical by construction across every brand overlay reviewed on the same pass."
  },
  {
    pattern: /^primary intents: /i,
    reason: "Brand-identity template metadata header field (primary intents) — identical by construction across every brand overlay."
  },
  {
    pattern: /^primary field targets: /i,
    reason: "Brand-identity template metadata header field (primary field targets) — identical by construction across every brand overlay."
  },
  {
    pattern: /^(?:optional future .*? documents?: )?src\/rag\/brands\/\{brand-slug\}/i,
    reason: "File-naming-convention path template (with a {brand-slug} placeholder) documented identically in every brand-identity file — describes the naming scheme itself, not a cross-document policy reference."
  }
];

function isWhitelistedBoilerplate(a: PdpGeoPolicyRule, b: PdpGeoPolicyRule): boolean {
  return BOILERPLATE_PATTERNS.some(({ pattern }) => pattern.test(a.text) && pattern.test(b.text));
}

function isKnownIntentionalPair(a: PdpGeoPolicyRule, b: PdpGeoPolicyRule): RuleWhitelistEntry | undefined {
  return KNOWN_INTENTIONAL_DUPLICATE_PAIRS.find(
    (entry) =>
      (entry.ruleIds[0] === a.id && entry.ruleIds[1] === b.id) ||
      (entry.ruleIds[0] === b.id && entry.ruleIds[1] === a.id)
  );
}

interface RulePairSimilarity {
  a: PdpGeoPolicyRule;
  b: PdpGeoPolicyRule;
  similarity: number;
}

function computeCrossDocumentSimilarities(rules: PdpGeoPolicyRule[]): RulePairSimilarity[] {
  const tokenized = rules.map((rule) => tokenize(rule.text));
  const results: RulePairSimilarity[] = [];

  for (let i = 0; i < rules.length; i += 1) {
    for (let j = i + 1; j < rules.length; j += 1) {
      const a = rules[i]!;
      const b = rules[j]!;
      if (a.document === b.document) {
        continue;
      }
      const similarity = lexicalSimilarity(tokenized[i]!, tokenized[j]!);
      if (similarity >= CONTRADICTION_REPORT_MIN) {
        results.push({ a, b, similarity });
      }
    }
  }

  return results;
}

describe("rag corpus lint", () => {
  it("has no un-whitelisted near-duplicate policy rules across documents (jaccard >= 0.8)", async () => {
    const documents = await loadAllPolicyDocuments();
    const rules = extractRulesPerDocument(documents);
    const pairs = computeCrossDocumentSimilarities(rules).filter((pair) => pair.similarity >= NEAR_DUPLICATE_THRESHOLD);

    const offending = pairs.filter((pair) => {
      if (isWhitelistedPreferredExample(pair.a, pair.b)) {
        return false;
      }
      if (isWhitelistedBoilerplate(pair.a, pair.b)) {
        return false;
      }
      if (isKnownIntentionalPair(pair.a, pair.b)) {
        return false;
      }
      return true;
    });

    const report = offending
      .map(
        (pair) =>
          `[${pair.similarity.toFixed(3)}] ${pair.a.id} (${pair.a.document} § ${pair.a.heading}) <-> ${pair.b.id} (${pair.b.document} § ${pair.b.heading})\n  A: ${pair.a.text}\n  B: ${pair.b.text}`
      )
      .join("\n\n");

    expect(offending, `Near-duplicate policy rules found across documents (jaccard >= ${NEAR_DUPLICATE_THRESHOLD}):\n\n${report}`).toEqual([]);
  });

  it("reports contradiction-candidate rule pairs (jaccard 0.5-0.8) for human review (non-failing)", async () => {
    const documents = await loadAllPolicyDocuments();
    const rules = extractRulesPerDocument(documents);
    const pairs = computeCrossDocumentSimilarities(rules).filter(
      (pair) => pair.similarity >= CONTRADICTION_REPORT_MIN && pair.similarity < NEAR_DUPLICATE_THRESHOLD
    );

    if (pairs.length > 0) {
      const report = pairs
        .sort((left, right) => right.similarity - left.similarity)
        .map(
          (pair) =>
            `[${pair.similarity.toFixed(3)}] ${pair.a.id} (${pair.a.document} § ${pair.a.heading}) <-> ${pair.b.id} (${pair.b.document} § ${pair.b.heading})`
        )
        .join("\n");
      // eslint-disable-next-line no-console
      console.log(`\nContradiction-candidate rule pairs (0.5-0.8 similarity, human review):\n${report}\n`);
    }

    expect(true).toBe(true);
  });

  it("keeps every rag-index checkedAt entry in YYYY-MM-DD format", () => {
    const malformed = pdpGeoRagIndex
      .filter((entry) => !/^\d{4}-\d{2}-\d{2}$/.test(entry.checkedAt))
      .map((entry) => `${entry.document}: "${entry.checkedAt}"`);

    expect(malformed, `Malformed rag-index checkedAt entries:\n${malformed.join("\n")}`).toEqual([]);
  });

  it("forbids cross-document references to another corpus document's versioned filename", async () => {
    const profile = await readPdpGeoGeneratorRagProfile();
    const allDocuments = [
      { name: pdpGeoGeneratorRagManifest.analysisPrompt, content: profile.analysisPrompt },
      ...profile.documents.map((document) => ({ name: document.name, content: document.content }))
    ];
    const markdownDocuments = allDocuments.filter((document) => /\.md$/i.test(document.name));

    const versionSuffixPattern = /[A-Za-z0-9_/-]*_v\d+\.md/g;
    // Backtick-fenced source-path templates (e.g. naming-convention examples
    // such as `src/rag/brands/{brand-slug}/brand-identity_v1.md`) are allowed:
    // they describe the file-naming convention itself, not a live
    // cross-document reference, and use a `{...}` placeholder segment so they
    // can never resolve to a concrete other document.
    const pathTemplatePattern = /`src\/rag\/[^`]*\{[^`]*\}[^`]*_v\d+\.md`/;

    const violations: string[] = [];

    for (const document of markdownDocuments) {
      const lines = document.content.split(/\r?\n/);
      lines.forEach((line, index) => {
        const matches = line.match(versionSuffixPattern);
        if (!matches) {
          return;
        }
        for (const match of matches) {
          const selfReference = match === document.name || document.name.endsWith(`/${match}`);
          if (selfReference) {
            continue;
          }
          const templateSurroundingMatch = line.match(pathTemplatePattern);
          if (templateSurroundingMatch && templateSurroundingMatch[0].includes(match)) {
            continue;
          }
          violations.push(`${document.name}:${index + 1}: references "${match}" — ${line.trim()}`);
        }
      });
    }

    expect(violations, `Corpus documents must not reference other documents by versioned filename (use prose references instead):\n${violations.join("\n")}`).toEqual([]);
  });

  it("keeps normalizeRuleKey deterministic for pure dedupe lookups (sanity check for the near-dup harness)", () => {
    expect(normalizeRuleKey("Do NOT expose internal labels.")).toBe(normalizeRuleKey("do not expose internal labels"));
  });

  it("keeps the content-field-contracts normalizer priority at 79 (below official-ai-search, above the recognized-document floor, and never falling through to the unrecognized-document catch-all)", () => {
    // Regression guard for the Task 5 fix: the un-anchored guard clause at the
    // top of productNormalizationRagPriority only recognizes a document as
    // "policy" (and lets it reach its dedicated branch below) when its name
    // matches one of a fixed list of substrings. If a future rename drops
    // "content-field-contracts" from that list, the document silently falls
    // through to the 115 catch-all meant for unrecognized custom documents —
    // which would rank it above analysis-prompt (110) instead of dead last
    // among recognized policy documents.
    const contractsPriority = productNormalizationRagPriority("content-field-contracts_v1.md");
    const officialSearchPriority = productNormalizationRagPriority("official-ai-search-platform-docs_v1.md");
    const analysisPromptPriority = productNormalizationRagPriority("analysis-prompt_v1.md");
    const unrecognizedDocumentPriority = productNormalizationRagPriority("some-unrecognized-custom-document.md");

    expect(contractsPriority).toBe(79);
    expect(contractsPriority).toBeGreaterThan(70); // documented floor below every recognized policy document
    expect(contractsPriority).toBeLessThan(officialSearchPriority); // 80: lowest-ranked of the other recognized policy documents
    expect(contractsPriority).toBeLessThan(analysisPromptPriority); // must not outrank analysis-prompt's field-routing role
    expect(contractsPriority).toBeLessThan(unrecognizedDocumentPriority); // must not silently regress to the 115 fallthrough
  });

  it("keeps every known-intentional-pair whitelist entry pointed at rule ids that still exist AND still hold the same rule text", async () => {
    // Positional rule ids (e.g. "BEST-PRACTICE-044") are assigned by counting
    // list items in extraction order. A corpus edit that adds, removes, or
    // reorders a bullet before one of these ids shifts every id after it —
    // silently turning a whitelist entry into a no-op (if the id vanishes)
    // or, worse, into an accidental exemption for an unrelated rule that now
    // happens to reuse that id and number. A bare "does this id exist" check
    // would miss the second failure mode entirely, so this also re-derives
    // each entry's stored textFingerprints (normalizeRuleKey prefix) from the
    // current extraction and requires an exact prefix match.
    const documents = await loadAllPolicyDocuments();
    const rules = extractRulesPerDocument(documents);
    const ruleById = new Map(rules.map((rule) => [rule.id, rule]));

    const problems = KNOWN_INTENTIONAL_DUPLICATE_PAIRS.flatMap((entry) =>
      entry.ruleIds.flatMap((ruleId, index) => {
        const rule = ruleById.get(ruleId);
        const pairLabel = `${entry.ruleIds.join(" <-> ")}: ${entry.reason}`;
        if (!rule) {
          return [`${ruleId} no longer exists (from pair ${pairLabel})`];
        }
        const currentFingerprint = normalizeRuleKey(rule.text).slice(0, entry.textFingerprints[index]!.length);
        if (currentFingerprint !== entry.textFingerprints[index]) {
          return [
            `${ruleId} now resolves to different text than the whitelist entry expects — stale positional id likely re-pointed at an unrelated rule (from pair ${pairLabel})\n` +
              `  expected fingerprint: ${entry.textFingerprints[index]}\n` +
              `  current text:         ${rule.text}`
          ];
        }
        return [];
      })
    );

    expect(problems, `Whitelist entries reference rule ids that no longer exist or no longer hold the expected text — re-derive current ids/fingerprints and update KNOWN_INTENTIONAL_DUPLICATE_PAIRS:\n${problems.join("\n")}`).toEqual([]);
  });

  it("excludes content-field-contracts from the default normalization RAG budget (8) but includes it once the budget grows to 10", async () => {
    // Direct behavioral guard for the 79-priority fix: a priority number in
    // isolation doesn't prove the document actually participates in (or is
    // correctly excluded from) real document selection. This exercises the
    // actual selector the agent pipeline calls, using the real corpus.
    const profile = await readPdpGeoGeneratorRagProfile();
    const documents = profile.documents.map((document) => ({ name: document.name, content: document.content }));
    const contractsDocumentName = pdpGeoGeneratorRagManifest.documents.contentFieldContracts;

    const atDefaultBudget = selectProductNormalizationRagDocuments(documents, 8).map((document) => document.name);
    const atLargerBudget = selectProductNormalizationRagDocuments(documents, 10).map((document) => document.name);

    expect(atDefaultBudget).not.toContain(contractsDocumentName);
    expect(atLargerBudget).toContain(contractsDocumentName);
  });

  it("seats each family's common document rather than a higher-priority brand overlay", async () => {
    // A brand overlay outranks its common counterpart (best-practice: 105 vs
    // 102) and used to take the family slot, so the deltas reached the
    // normalization prompt while the base rules they modify never did. This is
    // the same canonical-first invariant selectFinalRagChunks holds on the
    // retrieval side; measured before the fix, best-practice_v1.md was absent
    // from the selection at budgets 8, 10 and 12 alike.
    const profile = await readPdpGeoGeneratorRagProfile();
    const documents = profile.documents.map((document) => ({ name: document.name, content: document.content }));
    const commonBestPractice = pdpGeoGeneratorRagManifest.documents.bestPractice;
    const brandBestPractices = Object.values(pdpGeoGeneratorRagManifest.brandBestPractices);

    for (const budget of [8, 10, 12]) {
      const selected = selectProductNormalizationRagDocuments(documents, budget).map((document) => document.name);
      expect(selected, `budget ${budget}`).toContain(commonBestPractice);
      // The overlay is not banned — it may still arrive through the
      // same-family fill — but never ahead of the document it modifies.
      for (const overlay of brandBestPractices.filter((name) => selected.includes(name))) {
        expect(selected.indexOf(commonBestPractice), `budget ${budget}: ${overlay}`)
          .toBeLessThan(selected.indexOf(overlay));
      }
    }
  });

  // Regression guard for the "sehydration" corpus defect: src/rag/locale-terminology-map_v1.json's
  // en-US/en-GB hydration concept had avoid: ["cure"], and applyAvoidTerms (src/generate.ts) does a
  // boundary-less `next.split(avoid).join(replacement)` — so any public field containing "secure",
  // "procedure", or "manicure" was silently rewritten to "sehydration", "prohydration", or
  // "manihydration" in productName, descriptions, benefits, ingredients, howToUse, and FAQ text. A short
  // bare word like "cure" is a substring of ordinary English vocabulary and is unsafe as an avoid term
  // until applyAvoidTerms gets locale-aware word-boundary matching — tracked as a Phase 3 fix, deliberately
  // NOT made here (this lint only guards corpus data, it does not touch generate.ts). Until that lands,
  // every en-US/en-GB avoid term must either be multi-word (a multi-word phrase is implausible as an
  // accidental substring of an unrelated English word) or sit on the explicit, individually reviewed
  // allowlist below.
  const REVIEWED_SHORT_AVOID_TERMS = new Set<string>([
    // "whitening" (default map, brightening concept): a single distinctive 9-char word, not a substring
    // fragment of other common English vocabulary (unlike "cure"). Reviewed and kept as-is rather than
    // rephrased into a multi-word form.
    "whitening"
  ]);

  it("keeps every en-US/en-GB avoid term multi-word or on the explicit reviewed allowlist (prevents boundary-less substring corruption like the 'cure' -> 'sehydration' incident)", async () => {
    const profile = await readPdpGeoGeneratorRagProfile();
    const terminologyMapDocuments = profile.documents.filter((document) =>
      /(^|\/)locale-terminology-map_v\d+\.json$/.test(document.name)
    );

    const violations: string[] = [];

    for (const document of terminologyMapDocuments) {
      let parsed: { concepts?: Array<{ concept: string; avoid?: Partial<Record<string, string[]>> }> };
      try {
        parsed = JSON.parse(document.content);
      } catch (error) {
        violations.push(`${document.name}: failed to parse as JSON (${(error as Error).message})`);
        continue;
      }
      for (const concept of parsed.concepts ?? []) {
        for (const locale of ["en-US", "en-GB"] as const) {
          for (const term of concept.avoid?.[locale] ?? []) {
            if (!term.includes(" ") && !REVIEWED_SHORT_AVOID_TERMS.has(term)) {
              violations.push(
                `${document.name} concept "${concept.concept}" ${locale} avoid term "${term}" is a single short word not on the reviewed allowlist`
              );
            }
          }
        }
      }
    }

    expect(
      violations,
      `en-US/en-GB avoid terms must be multi-word or explicitly reviewed (single short words risk boundary-less substring corruption via applyAvoidTerms):\n${violations.join("\n")}`
    ).toEqual([]);
  });
});
