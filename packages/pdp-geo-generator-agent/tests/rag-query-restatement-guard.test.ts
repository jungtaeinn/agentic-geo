import { describe, expect, it } from "vitest";
import { createPdpGeoRagQuery, createPdpGeoRagQueryPlan } from "../src/rag/retrieval";
import { exampleluxeNormalizedProduct } from "./fixtures/exampleluxe-normalized-product";
import type { PdpGeoRagUpdateTarget, PdpProductSignal } from "../src/types";

/**
 * Recurrence-prevention gate for the retrieval-query side of contract
 * canonicalization (d2532a4, 2026-08-27).
 *
 * A query that spells out a contract's own wording turns retrieval into a
 * self-fulfilling match: the documents that paraphrase the contract score
 * highest, so canonicalizing a rule into one document lowers its
 * retrievability. Removing four CEP restatements while the query still carried
 * the description stage order once dropped webPageDescription claim recall by
 * 0.458; rewriting the queries to name the contracts they need broke that
 * coupling (measured after: 0.000 / -0.048).
 *
 * The corpus side of that fix is guarded by rag-corpus-lint.test.ts. This is
 * the query side, which carried the criterion only in a commit message and a
 * code comment: queries state the information need (which evidence and
 * guidance is required) and never the rule itself — no ordering arrow chains,
 * no must/never obligations, no prohibition enumerations.
 */

const product = exampleluxeNormalizedProduct as unknown as PdpProductSignal;

/** Every target the query builder can emit, not just the default full-generation set. */
const allUpdateTargets: PdpGeoRagUpdateTarget[] = [
  "productDescription",
  "webPageDescription",
  "quickFacts",
  "benefits",
  "ingredients",
  "howToUse",
  "faq",
  "schema",
  "breadcrumbs",
  "reviews"
];

/**
 * Rule-shaped language, as named by the criterion. `only when`/`only if` are
 * listed rather than a bare `only` because "Update only Product.description"
 * is a scope statement, which is exactly the information need a query is
 * supposed to carry.
 */
const ruleFormPatterns: Array<{ label: string; pattern: RegExp }> = [
  { label: "ordering arrow chain", pattern: /->|→/ },
  { label: "must/required obligation", pattern: /\bmust\b|\brequired\b|\bshall\b/i },
  { label: "never/do-not prohibition", pattern: /\bnever\b|\bdo not\b|\bdon['’]t\b|\bcannot\b/i },
  { label: "prohibition enumeration", pattern: /\bexclude\b|\bavoid\b|\bprohibit/i },
  { label: "conditional rule clause", pattern: /\bonly when\b|\bonly if\b/i }
];

function assertCarriesNoRuleForm(label: string, query: string): void {
  const violations = ruleFormPatterns
    .filter(({ pattern }) => pattern.test(query))
    .map(({ label: form }) => form);
  expect(violations, `${label} restates a rule (${violations.join(", ")}):\n${query}`).toEqual([]);
}

describe("RAG query restatement guard", () => {
  it("keeps the base query free of rule-shaped language", () => {
    assertCarriesNoRuleForm("base query", createPdpGeoRagQuery(product, "ko-KR", "KR"));
  });

  it("keeps every target subquery free of rule-shaped language", () => {
    const plan = createPdpGeoRagQueryPlan(
      product,
      "ko-KR",
      "KR",
      { queryPlanning: { updateTargets: allUpdateTargets, maxSubqueries: allUpdateTargets.length + 1 } },
      []
    );

    // Guard the guard: a builder change that stopped emitting targets would
    // otherwise make this suite pass by checking nothing.
    expect(plan.queries.length).toBe(allUpdateTargets.length + 1);
    for (const subquery of plan.queries) {
      assertCarriesNoRuleForm(`subquery "${subquery.target}"`, subquery.query);
    }
  });

  it("still names the contracts and policy concepts each target needs", () => {
    const plan = createPdpGeoRagQueryPlan(
      product,
      "ko-KR",
      "KR",
      { queryPlanning: { updateTargets: allUpdateTargets, maxSubqueries: allUpdateTargets.length + 1 } },
      []
    );
    const byTarget = new Map(plan.queries.map((subquery) => [subquery.target, subquery.query]));

    // Removing restatement must not degrade a query into bare product facts:
    // the contract/concept anchors are what route retrieval to the right docs.
    expect(byTarget.get("productDescription")).toMatch(/contract/i);
    expect(byTarget.get("webPageDescription")).toMatch(/contract/i);
    expect(byTarget.get("howToUse")).toMatch(/contract/i);
    expect(byTarget.get("reviews")).toMatch(/contract|guidance|requirements/i);
  });
});
