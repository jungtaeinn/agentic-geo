import { describe, expect, it } from "vitest";
import { generatePdpGeo } from "../src";

/**
 * A comma-separated enumeration of short outcome tokens ("Hydrating, Firming,
 * Smoothing, Soothing, Moisturizing") is a list of atomic facts, not one
 * prose claim. The normalizer must atomize it so downstream consumers (FAQ
 * anchors, evidence ledger, additionalProperty) receive the same atoms the
 * description composer already extracts. Prose sentences that merely contain
 * commas keep their sentence boundary.
 */
describe("enumeration signal atomization", () => {
  it("atomizes a joined effects enumeration and restores FAQ anchors from it", async () => {
    const run = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "[GEO-TEST] Essential Firming Cream EX",
          brand: "ExampleLuxe Malaysia Staging",
          category: "Cream",
          description: "A rich, whipped cream that delivers lasting hydration while visibly firming and smoothing skin.",
          effects: ["Hydrating, Firming, Smoothing, Soothing, Moisturizing"]
        }
      },
      hints: { locale: "en-US", market: "US" }
    });

    const effects = run.diagnostics.normalizedProduct.effects;
    expect(effects).toContain("Firming");
    expect(effects.length).toBeGreaterThanOrEqual(3);
    expect(effects.some((value: string) => value.includes(","))).toBe(false);

    const graph = run.result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    expect(graph.some((node) => node["@type"] === "FAQPage")).toBe(true);
  });

  it("keeps comma-bearing prose as one sentence unit", async () => {
    const proseBenefit = "restores hydration, strengthens the skin barrier over several weeks, and calms visible redness";
    const run = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "Barrier Hydro Soothing Cream",
          category: "Cream",
          benefits: [proseBenefit]
        }
      },
      hints: { locale: "en-US", market: "US" }
    });

    const benefits = run.diagnostics.normalizedProduct.benefits;
    expect(benefits.some((value: string) => value.includes("over several weeks"))).toBe(true);
    expect(benefits).not.toContain("restores hydration");
  });
});
