import { describe, expect, it } from "vitest";
import { generatePdpGeo } from "../src/agent";
import { planPdpGeoContent } from "../src/content-planner";
import type {
  JsonObject,
  PdpGeoContentArtifact,
  PdpGeoContentPlanner,
  PdpGeoContentPlanningRequest,
  PdpGeoSchemaMarkup,
  PdpProductSignal
} from "../src/types";
import { validateAndRepairPdpGeoArtifacts } from "../src/validate";

const emptySections: PdpGeoContentArtifact = {
  html: "",
  sections: {
    productName: "",
    description: "",
    quickFacts: "",
    benefits: "",
    ingredients: "",
    howToUse: "",
    faq: ""
  }
};

function schemaMarkupOf(graph: Array<Record<string, unknown>>): PdpGeoSchemaMarkup {
  const jsonLd = { "@context": "https://schema.org", "@graph": graph } as unknown as JsonObject;
  return { jsonLd, scriptTag: `<script type="application/ld+json">${JSON.stringify(jsonLd, null, 2)}</script>` };
}

describe("sentence punctuation spacing", () => {
  it("keeps a dotted product technology abbreviation intact", () => {
    const repaired = validateAndRepairPdpGeoArtifacts({
      schemaMarkup: schemaMarkupOf([
        {
          "@type": "Product",
          "@id": "https://example.com/p#product",
          name: "Essential Activating Serum",
          description: "The formula includes E.G.R.3 Technology™ and a Vitamin C Derivative."
        }
      ]),
      content: emptySections,
      fallbackProductName: "Essential Activating Serum",
      fallbackDescription: "The formula includes E.G.R.3 Technology™ and a Vitamin C Derivative.",
      locale: "en-US"
    });

    const product = (repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, unknown>>)[0];
    expect(product?.description).toContain("E.G.R.3 Technology™");
    expect(repaired.validationRepairs.map((repair) => repair.after ?? "").join(" ")).not.toContain("E. G. R. 3");
  });
});

describe("HowTo planning", () => {
  const usageProduct: PdpProductSignal = {
    name: "Essential Activating Serum",
    description: "A lightweight serum.",
    brand: "ExampleLuxe",
    category: "Serum",
    images: [],
    options: [],
    benefits: [],
    effects: [],
    ingredients: [],
    usage: [
      "After your morning and evening cleansing ritual, apply three pumps to damp skin with your fingertips and press serum into skin with an open palm for increased absorption.",
      "Gently pat 2-3 pumps onto skin morning and night."
    ],
    metrics: [],
    faq: [],
    reviews: { items: [], keywords: [] },
    breadcrumbs: [],
    sourceTexts: [
      "ESSENTIAL ACTIVATING SERUM SÉRUM ESSENTIEL ACTIVATEUR ExampleLuxe EXAMPLELUXE EXAMPLELUXE EXAMPLELUXE ExampleLuxe ESSENTIAL CARE ACTIVATING SERUM EX 1997 2004 2009 2015 2020 2023 BEFORE AFTER 4WEEKS HYDRATED, MORE EVEN TONED SKIN UNRETOUCHED GENTLY PAT 2-3 PUMPS ONTO SKIN MORNING & NIGHT"
    ]
  };

  const request: PdpGeoContentPlanningRequest = {
    product: usageProduct,
    locale: "en-US",
    ragChunks: [],
    evidenceLedger: [
      { id: "ev-usage-1", role: "usage", text: usageProduct.usage[0]!, sourcePath: "product.usage[0]", locale: "en-US", productScope: "product", confidence: 0.98 },
      { id: "ev-usage-2", role: "usage", text: usageProduct.usage[1]!, sourcePath: "product.usage[1]", locale: "en-US", productScope: "product", confidence: 0.98 },
      { id: "ev-usage-3", role: "usage", text: usageProduct.sourceTexts[0]!, sourcePath: "product.sourceTexts[0]", locale: "en-US", productScope: "product", confidence: 0.82 }
    ]
  };

  it("does not warn that HowTo was omitted when the plan still emits HowTo steps", async () => {
    const modelPlanner: PdpGeoContentPlanner = {
      planContent: () => ({
        plan: {
          mode: "model",
          locale: "en-US",
          productDescription: { include: false, text: "", intent: "", evidenceIds: [], confidence: 0, omitReason: "" },
          webPageDescription: { include: false, text: "", intent: "", evidenceIds: [], confidence: 0, omitReason: "" },
          faq: [],
          // The model claims an eligible HowTo whose only step cites no usage
          // evidence, so the gate rejects it and pushes the omission warning.
          howTo: {
            eligible: true,
            ordered: true,
            goal: "How to use Essential Activating Serum",
            steps: [{ position: 1, name: "Apply", text: "Apply the serum to the face.", evidenceIds: [] }],
            evidenceIds: [],
            confidence: 0.7,
            omitReason: ""
          },
          cep: [],
          warnings: []
        },
        warnings: []
      })
    };

    const result = await planPdpGeoContent(request, { customContentPlanner: modelPlanner });

    const omissionWarning = result.plan.warnings.some((warning) => warning.startsWith("HowTo was omitted"));
    expect(omissionWarning && result.plan.howTo.steps.length > 0).toBe(false);
  });

  it("never promotes a raw page-text block into a usage step", async () => {
    const result = await planPdpGeoContent(request, { contentPlanning: { enabled: false } });

    for (const step of result.plan.howTo.steps) {
      expect(step.text).not.toMatch(/SÉRUM ACTIVATEUR|EXAMPLELUXE|1997 2004 2009/u);
      expect(step.name).not.toMatch(/SÉRUM ACTIVATEUR|EXAMPLELUXE|1997 2004 2009/u);
    }
  });

  it("still emits HowTo for a single source-backed usage instruction", async () => {
    const singleInstruction = "Gently pat 2-3 pumps onto skin morning and night.";
    const result = await planPdpGeoContent({
      product: { ...usageProduct, usage: [singleInstruction], sourceTexts: [] },
      locale: "en-US",
      ragChunks: [],
      evidenceLedger: [
        { id: "ev-usage-1", role: "usage", text: singleInstruction, sourcePath: "product.usage[0]", locale: "en-US", productScope: "product", confidence: 0.98 }
      ]
    }, { contentPlanning: { enabled: false } });

    expect(result.plan.howTo.steps).toHaveLength(1);
    expect(result.plan.howTo.steps[0]?.text).toBe(singleInstruction);
  });
});

const surveyProduct: PdpProductSignal = {
  name: "Essential Activating Serum",
  description: "A lightweight, fast-absorbing serum.",
  brand: "ExampleLuxe",
  category: "Serum",
  images: [],
  options: [],
  benefits: ["Lightweight, fast-absorbing formula."],
  effects: [],
  ingredients: ["500-Hour Fermented Ginseng"],
  usage: ["Gently pat 2-3 pumps onto skin morning and night."],
  metrics: [
    "After 4 weeks of use, 92% of 600 women agreed skin looked clear and bright, 86% agreed fine lines looked reduced, and 96% agreed skin texture felt smoother in a home usage test survey with daily use."
  ],
  faq: [],
  reviews: { items: [], keywords: [] },
  breadcrumbs: [],
  sourceTexts: [],
  semanticFacts: {
    ingredients: [],
    benefits: [],
    effects: [],
    skinTypes: [],
    usageSteps: [],
    safetyTests: [],
    evidenceSentences: [],
    ingredientBenefitLinks: [],
    citations: [],
    metricClaims: [
      { label: "Clear and bright skin", subject: "600 women", value: "92", unit: "%", metric: "agreed skin looked clear and bright", timing: "after 4 weeks of use", period: "4 weeks", sample: "600 women", method: "Home usage test survey", evidenceGroup: "4-week home usage test survey", caveat: "with daily use", sentence: "After 4 weeks of use, 92% agreed skin looked clear and bright." },
      { label: "Fine lines", subject: "600 women", value: "86", unit: "%", metric: "agreed fine lines looked reduced", timing: "after 4 weeks of use", period: "4 weeks", sample: "600 women", method: "Home usage test survey", evidenceGroup: "4-week home usage test survey", caveat: "with daily use", sentence: "After 4 weeks of use, 86% agreed fine lines looked reduced." },
      { label: "Skin texture", subject: "600 women", value: "96", unit: "%", metric: "agreed skin texture felt smoother", timing: "after 4 weeks of use", period: "4 weeks", sample: "600 women", method: "Home usage test survey", evidenceGroup: "4-week home usage test survey", caveat: "with daily use", sentence: "After 4 weeks of use, 96% agreed skin texture felt smoother." }
    ]
  }
};

function graphFieldTexts(jsonLd: unknown): string[] {
  const texts: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      texts.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === "object") {
      Object.values(node as Record<string, unknown>).forEach(walk);
    }
  };
  walk(jsonLd);
  return texts;
}

describe("reported metric narratives", () => {
  it("states shared study context once per field for claims in the same evidence group", async () => {
    const run = await generatePdpGeo({ product: surveyProduct, hints: { locale: "en-US", market: "US" } });

    for (const text of graphFieldTexts(run.result.schemaMarkup.jsonLd)) {
      const occurrences = text.match(/In a home usage test survey/gi)?.length ?? 0;
      expect(occurrences).toBeLessThanOrEqual(1);
    }
  });

  it("never upgrades a consumer-perception survey into an unquantified efficacy statement", async () => {
    const run = await generatePdpGeo({ product: surveyProduct, hints: { locale: "en-US", market: "US" } });
    const publicTexts = [
      JSON.stringify(run.result.schemaMarkup.jsonLd),
      Object.values(run.result.content.sections).join("\n")
    ].join("\n");

    expect(publicTexts).not.toMatch(/the product showed firmness and visible-aging care/i);
  });
});

describe("entity role separation", () => {
  it("does not repeat a long Product.description claim sentence verbatim in WebPage.description", async () => {
    const run = await generatePdpGeo({ product: surveyProduct, hints: { locale: "en-US", market: "US" } });
    const graph = (run.result.schemaMarkup.jsonLd["@graph"] ?? []) as Array<Record<string, unknown>>;
    const typeOf = (node: Record<string, unknown>): string[] => Array.isArray(node["@type"]) ? node["@type"] as string[] : [String(node["@type"] ?? "")];
    const productDescription = String(graph.find((node) => typeOf(node).includes("Product"))?.description ?? "");
    const webPageDescription = String(graph.find((node) => typeOf(node).includes("WebPage"))?.description ?? "");
    if (!productDescription || !webPageDescription) return;

    const longSentences = productDescription
      .split(/(?<=\.)\s+/)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length >= 80);
    for (const sentence of longSentences) {
      expect(webPageDescription).not.toContain(sentence);
    }
  });
});

describe("HowTo presence for a source HOW TO USE section", () => {
  const howToSectionText = "After your morning and evening cleansing ritual, apply three pumps to damp skin with your fingertips and press serum into skin with an open palm for increased absorption.";
  const sectionProduct: PdpProductSignal = {
    name: "Essential Activating Serum",
    description: "A lightweight serum.",
    brand: "ExampleLuxe",
    category: "Serum",
    images: [],
    options: [],
    benefits: [],
    effects: [],
    ingredients: [],
    // The PDP exposes one HOW TO USE section; OCR and ritual copy add further
    // unordered usage notes that must not become a synthetic procedure.
    usage: [
      howToSectionText,
      "GENTLY PAT 2-3 PUMPS ONTO SKIN MORNING & NIGHT",
      "Warm 2-3 pumps of Essential Care Activating Serum to the palm of your hands.",
      "Using the palm of your hands, gently press the serum to cheeks, forehead, around the eyes, and chin until completely absorbed."
    ],
    metrics: [],
    faq: [],
    reviews: { items: [], keywords: [] },
    breadcrumbs: [],
    sourceTexts: []
  };

  it("keeps HowTo for the primary usage instruction when the source order is unmarked", async () => {
    const result = await planPdpGeoContent({
      product: sectionProduct,
      locale: "en-US",
      ragChunks: [],
      evidenceLedger: sectionProduct.usage.map((text, index) => ({
        id: `ev-usage-${index + 1}`,
        role: "usage" as const,
        text,
        sourcePath: `product.usage[${index}]`,
        locale: "en-US" as const,
        productScope: "product" as const,
        confidence: 0.98
      }))
    }, { contentPlanning: { enabled: false } });

    expect(result.plan.howTo.eligible).toBe(true);
    expect(result.plan.howTo.ordered).toBe(false);
    expect(result.plan.howTo.steps).toHaveLength(1);
    expect(result.plan.howTo.steps[0]?.text).toContain(howToSectionText);
  });
});

import { exampleluxeNormalizedProduct } from "./fixtures/exampleluxe-normalized-product";

describe("shared study context", () => {
  it("states one evidence group's study population once per rendered field", async () => {
    const run = await generatePdpGeo({
      product: { geoProduct: exampleluxeNormalizedProduct as unknown as PdpProductSignal },
      hints: { locale: "en-US", market: "US" }
    });

    for (const text of graphFieldTexts(run.result.schemaMarkup.jsonLd)) {
      expect(text.match(/In an? home usage test survey/gi)?.length ?? 0).toBeLessThanOrEqual(1);
      expect(text.match(/In an? instrumental result/gi)?.length ?? 0).toBeLessThanOrEqual(1);
    }
  });
});

describe("HowTo rendering", () => {
  it("emits a HowTo node when the source documents usage without an explicit order", async () => {
    const run = await generatePdpGeo({
      product: { geoProduct: exampleluxeNormalizedProduct as unknown as PdpProductSignal },
      hints: { locale: "en-US", market: "US" }
    });
    const graph = (run.result.schemaMarkup.jsonLd["@graph"] ?? []) as Array<Record<string, unknown>>;
    const howTo = graph.find((node) => node["@type"] === "HowTo");

    expect(howTo).toBeDefined();
    expect(Array.isArray(howTo?.step) ? howTo.step : []).toHaveLength(1);
  });
});
