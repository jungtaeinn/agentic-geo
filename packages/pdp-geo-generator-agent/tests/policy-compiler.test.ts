import { describe, expect, it } from "vitest";
import {
  compilePdpGeoPolicyChecklist,
  defaultPolicyRuleBudget,
  formatPolicyChecklistPayload,
  formatPolicyComplianceRecap,
  type PdpGeoPolicyDocumentInput
} from "../src/rag/policy-compiler";
import { pdpGeoGeneratorRagManifest } from "../src/rag/manifest";
import { readPdpGeoGeneratorRagProfile, type StoredPdpGeoGeneratorRagProfile } from "../src/rag/profile";
import { generatePdpGeo } from "../src";
import type { PdpGeoCopyRefinementRequest, PdpGeoPolicyRule } from "../src/types";

/** Injection slots that must stay available for guidance rules in every production scope. */
const guidanceSlotMargin = 10;

/**
 * Rebuilds the document set the agent compiles for one product: the analysis
 * prompt, the default corpus, and the single brand overlay that matches the
 * product (agent.ts resolves at most one brand, never several at once).
 */
function productionPolicyDocuments(
  profile: StoredPdpGeoGeneratorRagProfile,
  brandSlug?: string
): PdpGeoPolicyDocumentInput[] {
  return [
    { name: pdpGeoGeneratorRagManifest.analysisPrompt, content: profile.analysisPrompt, version: "v1" },
    ...profile.documents
      .filter((document) => {
        const path = document.name.replace(/\\/g, "/");
        return !path.startsWith("brands/") || (brandSlug !== undefined && path.startsWith(`brands/${brandSlug}/`));
      })
      .map((document) => ({ name: document.name, content: document.content, version: document.version }))
  ];
}

const fixtureDocument = {
  name: "fixture-policy_v1.md",
  version: "v1",
  content: [
    "# Fixture Policy v1",
    "",
    "## Claim Safety",
    "",
    "- Do not invent claims, ingredients, metrics, study details, prices, awards, or certifications in any public field.",
    "- Prefer source-backed specificity over broad marketing language when composing descriptions.",
    "- Do not invent claims, ingredients, metrics, study details, prices, awards, or certifications in any public field.",
    "",
    "## Usage Rules",
    "",
    "1. Usage fields must contain only actionable directions such as dispense, apply, spread, pat, rinse, or absorb.",
    "2. Concrete application steps belong in HowTo and Usage,",
    "   not in Product.description or WebPage.description.",
    "",
    "```",
    "- this bullet lives in a code fence and must be ignored by the compiler",
    "```",
    "",
    "| column | this table row must be ignored |",
    "",
    "- short",
    ""
  ].join("\n")
};

describe("compilePdpGeoPolicyChecklist", () => {
  it("extracts atomic rules with severity, dedupe, continuation merge, and code-fence/table skipping", () => {
    const compiled = compilePdpGeoPolicyChecklist([fixtureDocument]);
    const texts = compiled.rules.map((rule) => rule.text);

    expect(compiled.rules).toHaveLength(4);
    expect(texts.filter((text) => text.startsWith("Do not invent claims"))).toHaveLength(1);
    expect(texts).toContain("Concrete application steps belong in HowTo and Usage, not in Product.description or WebPage.description.");
    expect(texts.some((text) => text.includes("code fence"))).toBe(false);
    expect(texts.some((text) => text.includes("table row"))).toBe(false);

    const critical = compiled.rules.filter((rule) => rule.severity === "critical");
    expect(critical.map((rule) => rule.text)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Do not invent claims"),
        expect.stringContaining("must contain only actionable directions")
      ])
    );
    expect(compiled.rules.every((rule) => rule.id.startsWith("FIXTURE-POLICY-"))).toBe(true);
    expect(compiled.rules.every((rule) => rule.heading === "Claim Safety" || rule.heading === "Usage Rules")).toBe(true);
  });

  it("always injects every critical rule and reports coverage accounting", () => {
    const compiled = compilePdpGeoPolicyChecklist([fixtureDocument], { maxRules: 2 });

    expect(compiled.coverage.mode).toBe("compiled-policy-checklist");
    expect(compiled.coverage.criticalCoverageRatio).toBe(1);
    expect(compiled.coverage.injectedCriticalRules).toBe(compiled.coverage.criticalRules);
    expect(compiled.coverage.totalRules).toBe(4);
    expect(compiled.coverage.injectedRules + compiled.coverage.excludedRuleIds.length).toBe(compiled.coverage.totalRules);
    expect(compiled.coverage.documents).toHaveLength(1);
    expect(compiled.coverage.documents[0]?.document).toBe("fixture-policy_v1.md");
  });

  it("reserves one representative per RAG document before filling a small rule budget", () => {
    const documents = ["geo-research_v1.md", "eeat_v1.md", "cep_v1.md"].map((name, index) => ({
      name,
      content: [
        `# Policy ${index + 1}`,
        "",
        `- This document must retain its source-backed strategic rule ${index + 1} in constrained prompts.`,
        `- Do not replace document ${index + 1} with a rule from another source.`
      ].join("\n")
    }));
    const compiled = compilePdpGeoPolicyChecklist(documents, { maxRules: 3 });

    expect(compiled.injectedRules).toHaveLength(3);
    expect(new Set(compiled.injectedRules.map((rule) => rule.document))).toEqual(new Set(documents.map((document) => document.name)));
  });

  it("keeps complete critical coverage on every production document set the agent can assemble", async () => {
    const profile = await readPdpGeoGeneratorRagProfile();

    for (const scope of [undefined, ...Object.keys(pdpGeoGeneratorRagManifest.brandIdentities)]) {
      const compiled = compilePdpGeoPolicyChecklist(productionPolicyDocuments(profile, scope));
      const label = scope ?? "no brand";

      expect(compiled.coverage.totalRules, label).toBeGreaterThan(150);
      // The whole point of the compiled checklist is that no critical rule is
      // silently dropped, so this must hold for the set the agent actually
      // builds: the analysis prompt plus the default corpus plus at most one
      // brand overlay. Measuring only part of it (the default corpus alone, or
      // every brand at once) hides both a real gap and a fake one.
      expect(compiled.coverage.criticalCoverageRatio, label).toBe(1);
      expect(compiled.coverage.injectedCriticalRules, label).toBe(compiled.coverage.criticalRules);

      // Coverage degrades silently once critical rules alone can fill the
      // injection budget. Asserting `criticalRules <= budget` would be dead
      // weight — the ratio check above already implies it — so this keeps a
      // margin and fires while coverage is still intact. The margin also
      // guarantees the checklist never degenerates into critical-only: at
      // least this many injection slots stay available for guidance rules.
      // Worst case measured on the examplederma overlay is 221 of 240, so the
      // margin is the largest round number that currently holds; treat a
      // failure here as "the corpus is about to outgrow the budget", not as a
      // broken invariant.
      expect(compiled.coverage.criticalRules, label).toBeLessThanOrEqual(defaultPolicyRuleBudget - guidanceSlotMargin);

      const compiledDocuments = compiled.coverage.documents.map((entry) => entry.document);
      for (const core of [
        pdpGeoGeneratorRagManifest.analysisPrompt,
        pdpGeoGeneratorRagManifest.documents.contentFieldContracts,
        pdpGeoGeneratorRagManifest.documents.bestPractice,
        pdpGeoGeneratorRagManifest.documents.eeat,
        pdpGeoGeneratorRagManifest.documents.cep,
        pdpGeoGeneratorRagManifest.documents.geoResearch,
        pdpGeoGeneratorRagManifest.documents.schemaOrgProduct
      ]) {
        expect(compiledDocuments, label).toContain(core);
      }
    }
  });

  it("evicts brand tone guidance before the analysis prompt's own rules when the budget is squeezed", async () => {
    const profile = await readPdpGeoGeneratorRagProfile();
    // A budget just under the scope's critical count forces real eviction. The
    // pipeline's operating contract must survive it: without an explicit kind
    // rank the analysis prompt sorts last and supplies most of the casualties.
    const compiled = compilePdpGeoPolicyChecklist(productionPolicyDocuments(profile, "examplederma"), { maxRules: 200 });
    const excluded = new Set(compiled.coverage.excludedRuleIds);
    // Scoped to authoring rules: a rule whose every field target is retrieval
    // or diagnostics is held back because it is not actionable for a model
    // writing copy, which is not eviction under budget pressure. The analysis
    // prompt owns two such critical rules ("Normalize source product JSON…",
    // "Prioritize RAG chunks with hybrid retrieval…"), so counting them here
    // would report the pipeline's own contract as a budget casualty.
    const evictedCritical = compiled.rules.filter((rule) =>
      rule.severity === "critical"
      && excluded.has(rule.id)
      && !(rule.fieldTargets.length > 0
        && rule.fieldTargets.every((target) => target === "retrieval" || target === "diagnostics")));

    expect(evictedCritical.length).toBeGreaterThan(0);
    expect(evictedCritical.map((rule) => rule.document)).not.toContain(pdpGeoGeneratorRagManifest.analysisPrompt);
    expect(evictedCritical.map((rule) => rule.document)).not.toContain(pdpGeoGeneratorRagManifest.documents.contentFieldContracts);
  });

  it("demotes brand-identity narrative sections to low-priority guidance instead of critical rules", async () => {
    const profile = await readPdpGeoGeneratorRagProfile();
    const compiled = compilePdpGeoPolicyChecklist(profile.documents.map((document) => ({
      name: document.name,
      content: document.content,
      version: document.version
    })));

    const brandIdentityRules = compiled.rules.filter((rule) => rule.document.includes("brand-identity"));
    const narrative = brandIdentityRules.filter((rule) => rule.extraction === "narrative");
    expect(narrative.length).toBeGreaterThan(10);
    for (const rule of narrative) {
      expect(rule.severity).toBe("guidance");
      expect(rule.priority).toBeLessThanOrEqual(0.6);
    }

    // Genuine guardrails inside rule sections must stay critical-capable.
    const claimSafetyCritical = brandIdentityRules.filter(
      (rule) => rule.extraction === "rules" && rule.severity === "critical"
    );
    expect(claimSafetyCritical.length).toBeGreaterThan(0);

    // ExampleDerma brand-identity critical density must drop from the pre-narrative baseline of 45.
    const exampledermaIdentity = compiled.coverage.documents.find((entry) => entry.document === "brands/examplederma/brand-identity_v1.md");
    expect(exampledermaIdentity).toBeDefined();
    expect(exampledermaIdentity!.criticalRules).toBeLessThan(45);
    expect(exampledermaIdentity!.narrativeRules).toBeGreaterThan(0);
  });
});

describe("policy checklist prompt formatting", () => {
  it("groups rules by field target with critical rules first and builds a compliance recap", () => {
    const compiled = compilePdpGeoPolicyChecklist([fixtureDocument]);
    const payload = formatPolicyChecklistPayload(compiled.injectedRules) as {
      instruction: string[];
      groups: Array<{ field: string; rules: string[] }>;
    };

    expect(payload).toBeDefined();
    expect(payload.groups.length).toBeGreaterThan(0);
    const allRules = payload.groups.flatMap((group) => group.rules);
    expect(allRules.some((line) => /\[FIXTURE-POLICY-\d{3}\]\[critical\]/.test(line))).toBe(true);
    for (const group of payload.groups) {
      const firstGuidance = group.rules.findIndex((line) => line.includes("][guidance]"));
      const lastCritical = group.rules.reduce((last, line, index) => (line.includes("][critical]") ? index : last), -1);
      if (firstGuidance !== -1 && lastCritical !== -1) {
        expect(lastCritical).toBeLessThan(firstGuidance);
      }
    }

    const recap = formatPolicyComplianceRecap(compiled.injectedRules) as { criticalRuleIds: string[] };
    expect(recap.criticalRuleIds.length).toBeGreaterThan(0);
    expect(formatPolicyComplianceRecap([])).toBeUndefined();
  });
});

describe("generatePdpGeo policy checklist integration", () => {
  it("passes compiled policy rules to the copy refiner and records coverage diagnostics", async () => {
    let receivedRules: PdpGeoPolicyRule[] | undefined;
    const { result } = await generatePdpGeo(
      {
        product: {
          geoProduct: {
            name: "Barrier Hydro Soothing Cream",
            description: "Hydrating cream for skin barrier moisture care.",
            benefits: ["hydration"],
            ingredients: ["Compressed Hyaluronic Acid"]
          }
        }
      },
      {
        customCopyRefiner: {
          refineCopy(request: PdpGeoCopyRefinementRequest) {
            receivedRules = request.policyRules;
            return { warnings: [] };
          }
        }
      }
    );

    expect(receivedRules).toBeDefined();
    expect(receivedRules!.length).toBeGreaterThan(50);
    expect(receivedRules!.some((rule) => rule.severity === "critical")).toBe(true);

    const coverage = result.diagnostics.policyCoverage;
    expect(coverage).toBeDefined();
    expect(coverage!.criticalCoverageRatio).toBe(1);
    expect(coverage!.injectedRules).toBe(receivedRules!.length);
  });
});
