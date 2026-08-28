import { describe, expect, it } from "vitest";
import { generatePdpGeo } from "../src/agent";
import { pdpGeoGenerationInputs } from "./fixtures/pdp-extractor-live-products";

/**
 * Regression tests for the ingredient-surface defects observed in the live
 * ExampleLuxe activating-serum run (2026-08-11):
 *
 * 1. Alias duplication — "500-Hour Fermented Ginseng" (explicit ingredient)
 *    and "500-hour aged ginseng" (haystack-detected surface) are the same
 *    entity but carried different entity keys, so "Key ingredients" listed
 *    the hero ingredient twice.
 * 2. Truncated fragments — a candidate that only occurs in the source as a
 *    prefix of a longer word run ("SCUTELLARIA BAICALENS" from "SCUTELLARIA
 *    BAICALENSIS ROOT EXTRACT") surfaced as an ingredient list item.
 * 3. Article/interrogative-led fragments — sentence shards like "The changes"
 *    or "What" surfaced as ingredient list items.
 */

export const activatingSerumLikeProduct = {
  name: "Essential Activating Serum",
  brand: "TestBrand",
  category: "Serum",
  description: "A lightweight serum for dryness, dullness, and visible fine lines.",
  benefits: ["Delivers immediate hydration while improving dryness, dullness, and overall tone."],
  effects: [],
  ingredients: ["500-Hour Fermented Ginseng", "Korean Herb Extract", "Vitamin C Derivative", "SCUTELLARIA BAICALENS", "The changes"],
  usage: ["Gently pat 2-3 pumps onto skin morning and night."],
  metrics: [],
  sourceTexts: [
    "KEY INGREDIENTS: 500-HOUR FERMENTED GINSENG: Supports a healthy skin barrier, helping visibly improve fine lines and wrinkles.",
    "500-HOUR AGED GINSENG Supports the skin barrier, helping improve visible fine lines and wrinkles KOREAN HERB EXTRACT Improves hydration, visibly firms, and addresses visible signs of aging",
    "INGREDIENTS: WATER / AQUA / EAU, ALCOHOL DENAT., BUTYLENE GLYCOL, BETAINE, SCUTELLARIA BAICALENSIS ROOT EXTRACT, ADENOSINE, TOCOPHEROL, CITRIC ACID",
    "The changes are evolutionary rather than a complete reformulation."
  ],
  semanticFacts: {
    ingredients: ["500-Hour Fermented Ginseng", "Korean Herb Extract", "500-Hour Aged Ginseng Extract (LYMPHANAX™)", "SCUTELLARIA BAICALENS"],
    benefits: [],
    effects: [],
    skinTypes: ["dry skin"],
    usageSteps: ["Gently pat 2-3 pumps onto skin morning and night."],
    safetyTests: [],
    metricClaims: [],
    evidenceSentences: [],
    ingredientBenefitLinks: [],
    citations: []
  }
};

function ingredientSurfaces(run: Awaited<ReturnType<typeof generatePdpGeo>>): {
  keyIngredientValues: string[];
  sectionLines: string[];
  all: string;
} {
  const graph = (run.result.schemaMarkup.jsonLd["@graph"] ?? []) as Array<Record<string, unknown>>;
  const product = graph.find((node) => node["@type"] === "Product"
    || (Array.isArray(node["@type"]) && (node["@type"] as string[]).includes("Product")));
  const keyIngredientValues = ((product?.additionalProperty ?? []) as Array<Record<string, unknown>>)
    .filter((property) => typeof property.name === "string" && /^Key ingredients/i.test(property.name as string))
    .map((property) => String(property.value ?? ""));
  const sectionLines = run.result.content.sections.ingredients.split("\n");
  return {
    keyIngredientValues,
    sectionLines,
    all: `${keyIngredientValues.join("\n")}\n${run.result.content.sections.ingredients}`
  };
}

describe("ingredient surface quality (live-run defects)", () => {
  it("collapses ingredient aliases that share a numeric spec and head noun", async () => {
    const run = await generatePdpGeo({
      product: activatingSerumLikeProduct,
      hints: { locale: "en-US", market: "US" }
    });
    const { keyIngredientValues, sectionLines } = ingredientSurfaces(run);
    const alias = /500[-\s]?hour[^,\n(]*ginseng/gi;

    // Each Key ingredients property may carry at most one surface form of the
    // same numeric-spec + head-noun entity.
    for (const value of keyIngredientValues) {
      expect((value.match(alias) ?? []).length).toBeLessThanOrEqual(1);
    }
    // The ingredients section's short name-only list items must not list the
    // same entity twice (detail sentences may still reference it).
    const nameOnlyItems = sectionLines
      .map((line) => line.trim())
      .filter((line) => /^- /.test(line) && line.length <= 60 && !/:/.test(line));
    expect(nameOnlyItems.filter((line) => alias.test(line)).length).toBeLessThanOrEqual(1);
  });

  it("drops candidates that only occur as a truncated prefix of a longer source word", async () => {
    const run = await generatePdpGeo({
      product: activatingSerumLikeProduct,
      hints: { locale: "en-US", market: "US" }
    });
    const { all } = ingredientSurfaces(run);

    // "SCUTELLARIA BAICALENS" only appears in the source inside "SCUTELLARIA
    // BAICALENSIS ROOT EXTRACT" — a truncation artifact, not an ingredient.
    // The full INCI statement line legitimately contains the full form.
    expect(all).not.toMatch(/SCUTELLARIA BAICALENS(?!I)/i);
  });

  it("drops article-led sentence shards from ingredient surfaces", async () => {
    const run = await generatePdpGeo({
      product: activatingSerumLikeProduct,
      hints: { locale: "en-US", market: "US" }
    });
    const { all } = ingredientSurfaces(run);

    expect(all).not.toMatch(/^-?\s*The changes\s*$/im);
    expect(all).not.toMatch(/(?:^|, )The changes(?:,|$)/im);
  });

  it("keeps thousands separators inside ingredient names when normalizing comma lists", async () => {
    // Live examplederma run (2026-08-11): "세라마이드(10,000ppm 고함량)" was split at
    // the thousands-separator comma and rejoined as "세라마이드(10, 000ppm 고함량)"
    // in "Key ingredients" and in the Korean ingredient-link sentence.
    const run = await generatePdpGeo(pdpGeoGenerationInputs["examplederma-cream-mist"]);
    const graph = (run.result.schemaMarkup.jsonLd["@graph"] ?? []) as Array<Record<string, unknown>>;
    const product = graph.find((node) => node["@type"] === "Product"
      || (Array.isArray(node["@type"]) && (node["@type"] as string[]).includes("Product"))) as Record<string, unknown>;
    const properties = (product.additionalProperty ?? []) as Array<{ name: string; value: string }>;

    const keyIngredients = properties.find((property) => property.name === "Key ingredients")?.value ?? "";
    expect(keyIngredients).toContain("10,000ppm");

    for (const property of properties) {
      expect(property.value, `additionalProperty "${property.name}"`).not.toMatch(/\d, \d{3}/);
    }
    expect(JSON.stringify(run.result.schemaMarkup.jsonLd)).not.toMatch(/\d, \d{3}(?:ppm|\s*ppm)/);
  });
});
