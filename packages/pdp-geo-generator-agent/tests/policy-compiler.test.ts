import { describe, expect, it } from "vitest";
import {
  compilePdpGeoPolicyChecklist,
  formatPolicyChecklistPayload,
  formatPolicyComplianceRecap
} from "../src/rag/policy-compiler";
import { readPdpGeoGeneratorRagProfile } from "../src/rag/profile";
import { generatePdpGeo } from "../src";
import type { PdpGeoCopyRefinementRequest, PdpGeoPolicyRule } from "../src/types";

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

  it("compiles the full default RAG profile with complete critical coverage", async () => {
    const profile = await readPdpGeoGeneratorRagProfile();
    const compiled = compilePdpGeoPolicyChecklist(profile.documents.map((document) => ({
      name: document.name,
      content: document.content,
      version: document.version
    })));

    expect(compiled.coverage.totalRules).toBeGreaterThan(150);
    expect(compiled.coverage.criticalCoverageRatio).toBe(1);
    const compiledDocuments = compiled.coverage.documents.map((entry) => entry.document);
    for (const core of ["best-practice_v1.md", "eeat_v1.md", "cep_v1.md", "geo-research_v1.md", "schema-org-product_v1.md"]) {
      expect(compiledDocuments).toContain(core);
    }
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

    // Aestura brand-identity critical density must drop from the pre-narrative baseline of 45.
    const aesturaIdentity = compiled.coverage.documents.find((entry) => entry.document === "brands/aestura/brand-identity_v1.md");
    expect(aesturaIdentity).toBeDefined();
    expect(aesturaIdentity!.criticalRules).toBeLessThan(45);
    expect(aesturaIdentity!.narrativeRules).toBeGreaterThan(0);
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
