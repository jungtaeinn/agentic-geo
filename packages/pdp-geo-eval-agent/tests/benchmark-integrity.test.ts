import { describe, expect, it } from "vitest";
import { evalProducts, type EvalProductId } from "../src/benchmark/fixtures";
import { geoEvalDistractors } from "../src/benchmark/distractors";
import { GEO_EVAL_TARGET_SLOT, geoEvalGoldens } from "../src/benchmark/goldens";
import { aggregateGeoScores, buildSourceSet, type GeoEvalGoldenResult } from "../src/benchmark/runner";
import { buildVanillaSourceText } from "../src/citation/source-text";
import { buildGeneratedSourceText } from "../src/citation/probe";

/**
 * Deterministic integrity checks for the benchmark's frozen corpus and the
 * counterfactual source assembly. The paid engine harness is opt-in and never
 * runs in CI.
 */

describe("benchmark goldens", () => {
  it("covers every fixture product with all four CEP dimensions", () => {
    const productIds = Object.keys(evalProducts) as EvalProductId[];
    for (const productId of productIds) {
      const focuses = geoEvalGoldens
        .filter((golden) => golden.productId === productId)
        .map((golden) => golden.cepFocus)
        .sort();
      expect(focuses, `product ${productId}`).toEqual(["concern", "need", "routine", "selection"]);
    }
  });

  it("has unique ids and locale/market consistency", () => {
    const ids = geoEvalGoldens.map((golden) => golden.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const golden of geoEvalGoldens) {
      expect(golden.market).toBe(golden.locale === "ko-KR" ? "KR" : "US");
    }
  });
});

describe("benchmark distractors", () => {
  it("provides exactly four frozen distractors per product, none naming the product", () => {
    for (const [productId, product] of Object.entries(evalProducts)) {
      const distractors = geoEvalDistractors[productId as EvalProductId];
      expect(distractors, `product ${productId}`).toHaveLength(4);
      for (const doc of distractors) {
        expect(doc.trim().length).toBeGreaterThan(100);
        expect(doc.toLowerCase(), `product ${productId}`).not.toContain(product.name.toLowerCase());
      }
    }
  });
});

describe("counterfactual source assembly", () => {
  it("keeps the target document in the fixed slot with distractor order preserved", () => {
    const sources = buildSourceSet("examplederma-capsule-toner", "TARGET-DOC");
    expect(sources).toHaveLength(5);
    expect(sources[GEO_EVAL_TARGET_SLOT]).toBe("TARGET-DOC");
    const withoutTarget = sources.filter((_, index) => index !== GEO_EVAL_TARGET_SLOT);
    expect(withoutTarget).toEqual(geoEvalDistractors["examplederma-capsule-toner"]);
  });

  it("builds a non-empty vanilla source text from every fixture", () => {
    for (const [productId, product] of Object.entries(evalProducts)) {
      const text = buildVanillaSourceText(product);
      expect(text.length, `product ${productId}`).toBeGreaterThan(200);
      expect(text).toContain(product.name);
    }
  });

  it("flattens generated sections while dropping empty ones", () => {
    const text = buildGeneratedSourceText({
      productName: "Name",
      description: "Description body.",
      quickFacts: "",
      benefits: "Benefit line.",
      ingredients: "",
      howToUse: "",
      faq: ""
    });
    expect(text).toBe("Name\n\nDescription body.\n\nBenefit line.");
  });
});

describe("aggregateGeoScores", () => {
  const score = (overrides: Partial<GeoEvalGoldenResult>): GeoEvalGoldenResult => ({
    goldenId: "X",
    productId: "examplederma-capsule-toner",
    locale: "ko-KR",
    cepFocus: "need",
    query: "q",
    vanilla: { wordpos: 0.2, word: 0.2, pos: 0.2, citedSentenceCount: 3, sentenceCount: 4, hallucinatedCitations: [], cachedAnswer: false },
    generated: { wordpos: 0.4, word: 0.3, pos: 0.5, citedSentenceCount: 4, sentenceCount: 4, hallucinatedCitations: [], cachedAnswer: false },
    delta: { wordpos: 0.2, word: 0.1, pos: 0.3 },
    gate: { pass: true, failures: [], skippedChecks: [] },
    ...overrides
  });

  it("averages paired shares and groups by locale and CEP focus", () => {
    const aggregates = aggregateGeoScores([
      score({ goldenId: "A" }),
      score({ goldenId: "B", locale: "en-US", cepFocus: "routine", delta: { wordpos: 0, word: 0, pos: 0 }, gate: { pass: false, failures: ["x"], skippedChecks: [] } })
    ], "azure-openai:test");

    expect(aggregates.goldens).toBe(2);
    expect(aggregates.delta.wordpos).toBeCloseTo(0.1, 10);
    expect(aggregates.byLocale["ko-KR"]!.goldens).toBe(1);
    expect(aggregates.gate).toEqual({ evaluated: 2, passed: 1 });
  });
});
