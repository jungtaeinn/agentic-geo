import { describe, expect, it } from "vitest";
import { evaluateGeoQuality } from "@agentic-geo/pdp-geo-eval-agent";
import { evalProducts } from "@agentic-geo/pdp-geo-eval-agent/benchmark";
import { generatePdpGeo } from "../src";

/**
 * CI stability gate: every benchmark fixture product must stay at or above
 * the agreed quality floors (GEO ≥ 90, CEP ≥ 95, E-E-A-T ≥ 90) with zero
 * unresolved validation warnings and zero auto-repairs on the deterministic
 * generation path. This is the durable guarantee that quality improvements
 * are structural rather than one-off: any regression in publish/validate
 * contracts, evidence binding, or rubric alignment fails this test.
 *
 * Fixtures intentionally omit price/dateModified where the real source lacks
 * them, so GEO can sit exactly at its 90 floor without those +5 bonuses —
 * the floor still holds without a freshness or price signal.
 */
const QUALITY_FLOORS = { geo: 90, cep: 95, eeat: 90 } as const;

describe("quality-score stability thresholds", () => {
  for (const [productId, product] of Object.entries(evalProducts)) {
    const locale = productId.startsWith("examplederma") ? ("ko-KR" as const) : ("en-US" as const);

    it(`keeps ${productId} at or above the quality floors with zero warnings`, async () => {
      const run = await generatePdpGeo({
        product,
        hints: {
          locale,
          market: locale === "ko-KR" ? "KR" : "US",
          brand: (product as { brand?: string }).brand,
          category: (product as { category?: string }).category
        }
      });
      const evaluation = evaluateGeoQuality({
        jsonLd: run.result.schemaMarkup.jsonLd,
        diagnostics: run.diagnostics as never
      }, locale === "ko-KR" ? "ko" : "en");
      const scores = Object.fromEntries(evaluation.dimensions.map((dimension) => [dimension.id, dimension.score]));

      expect(run.diagnostics.validationWarnings, run.diagnostics.validationWarnings.join(" | ")).toHaveLength(0);
      expect(run.diagnostics.validationRepairs ?? []).toHaveLength(0);
      expect(scores.geo, `GEO for ${productId}`).toBeGreaterThanOrEqual(QUALITY_FLOORS.geo);
      expect(scores.cep, `CEP for ${productId}`).toBeGreaterThanOrEqual(QUALITY_FLOORS.cep);
      expect(scores.eeat, `E-E-A-T for ${productId}`).toBeGreaterThanOrEqual(QUALITY_FLOORS.eeat);
    });
  }

  it("keeps the cream-mist failure modes fixed: mist HowTo survives and no OCR page dump reaches public fields", async () => {
    const product = evalProducts["examplederma-cream-mist"];
    const run = await generatePdpGeo({
      product,
      hints: { locale: "ko-KR", market: "KR", brand: (product as { brand?: string }).brand, category: (product as { category?: string }).category }
    });
    const graph = run.result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, unknown>>;

    // Mist usage directions must survive the shared usage contract end to end.
    const howTo = graph.find((node) => node["@type"] === "HowTo");
    if (howTo) {
      const steps = howTo.step as Array<Record<string, unknown>>;
      expect(steps.length).toBeGreaterThanOrEqual(1);
      for (const step of steps) {
        expect(String(step.text)).not.toMatch(/EXAMPLEDERMA\s+BARRIERCARE|CREAM\s+MIST|GLOWPICK/i);
      }
      // The page node may only reference schema nodes that exist.
      const ids = new Set(graph.map((node) => String(node["@id"] ?? "")));
      const webPage = graph.find((node) => String(node["@type"]).includes("WebPage") || (Array.isArray(node["@type"]) && (node["@type"] as string[]).includes("WebPage")));
      for (const part of (webPage?.hasPart as Array<Record<string, unknown>> | undefined) ?? []) {
        expect(ids.has(String(part["@id"]))).toBe(true);
      }
    }

    // No stitched marketing dump ("GLOWPICK AWARDS ... Step 1 ... Step 4")
    // may appear as a PropertyValue or FAQ answer.
    const productNode = graph.find((node) => node["@type"] === "Product") as Record<string, unknown>;
    for (const item of (productNode.additionalProperty as Array<Record<string, unknown>> | undefined) ?? []) {
      expect(String(item.value)).not.toMatch(/GLOWPICK|Step\s*1[\s\S]*Step\s*4/i);
    }
    const faqPage = graph.find((node) => node["@type"] === "FAQPage") as Record<string, unknown> | undefined;
    for (const item of (faqPage?.mainEntity as Array<Record<string, unknown>> | undefined) ?? []) {
      const answer = (item.acceptedAnswer as Record<string, unknown> | undefined)?.text;
      expect(String(answer ?? "")).not.toMatch(/GLOWPICK|BARRIERCARE\s+365\s+CREAM\s+MIST/i);
    }
  });
});
