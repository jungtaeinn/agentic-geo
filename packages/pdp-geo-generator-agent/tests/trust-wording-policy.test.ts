import { describe, expect, it } from "vitest";
import { generatePdpGeo } from "../src/agent";
import type { JsonObject, PdpProductSignal } from "../src/types";
import { validatePdpGeoArtifacts } from "../src/validate";

const sections = {
  productName: "Test Cream",
  description: "Test Cream is a moisturizer.",
  quickFacts: "",
  benefits: "",
  ingredients: "",
  howToUse: "",
  faq: ""
};

function validateGraph(graph: JsonObject[], sourceProduct?: PdpProductSignal) {
  const jsonLd: JsonObject = { "@context": "https://schema.org", "@graph": graph };
  return validatePdpGeoArtifacts({
    schemaMarkup: {
      jsonLd,
      scriptTag: `<script type="application/ld+json">${JSON.stringify(jsonLd, null, 2)}</script>`
    },
    content: { sections, html: "" },
    fallbackProductName: sections.productName,
    fallbackDescription: sections.description,
    locale: "en-US",
    sourceProduct
  });
}

function minimalSourceProduct(overrides: Partial<PdpProductSignal> = {}): PdpProductSignal {
  return {
    name: "Test Cream",
    images: [],
    options: [],
    benefits: [],
    effects: [],
    ingredients: [],
    usage: [],
    metrics: [],
    faq: [],
    reviews: { items: [], keywords: [] },
    breadcrumbs: [],
    sourceTexts: [],
    ...overrides
  };
}

const productBase = {
  "@type": "Product",
  "@id": "https://example.com/p/1#product",
  name: "Test Cream",
  description: "Test Cream is a moisturizer."
};

describe("claim-modality wording findings", () => {
  it("flags self-assessment agreement upgraded to an objective improvement claim", () => {
    const result = validateGraph([{
      ...productBase,
      description: "In a self-assessment from clinical of 31 women who used the product daily, 96% of participants showed improvement in skin After 6 weeks of use."
    }]);
    expect(result.validationWarnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/upgraded to an objective improvement claim/i),
      expect.stringMatching(/attributed to a clinical method/i)
    ]));
  });

  it("keeps preserved self-assessment modality clean", () => {
    const result = validateGraph([{
      ...productBase,
      description: "Test Cream is a moisturizer. In a self-assessment with 31 women, 96% agreed skin felt smoother after 6 weeks."
    }]);
    expect(result.validationWarnings).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/upgraded to an objective improvement claim/i)
    ]));
  });

  it("suggests renaming a self-assessment summary labeled Clinical result summary", () => {
    const result = validateGraph([{
      ...productBase,
      additionalProperty: [{
        "@type": "PropertyValue",
        name: "Clinical result summary",
        value: "In a self-assessment with 31 women who used the product daily, 96% of participants agreed skin felt smoother after 6 weeks."
      }]
    }]);
    expect(result.validationWarnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/labeled "Clinical result summary"/i)
    ]));
  });
});

describe("Key ingredients evidence findings", () => {
  it("flags broken tokens and ingredients missing from the product source", () => {
    const sourceProduct = minimalSourceProduct({
      ingredients: ["Ginseng Peptide", "Squalane"],
      sourceTexts: ["Test Cream combines Ginseng Peptide and Squalane."]
    });
    const result = validateGraph([{
      ...productBase,
      additionalProperty: [{
        "@type": "PropertyValue",
        name: "Key ingredients",
        value: "Ginseng Peptide, Squalane, Retinol, What"
      }]
    }], sourceProduct);
    expect(result.validationWarnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/non-ingredient token \("What"\)/i),
      expect.stringMatching(/"Retinol", which does not appear in this product's source evidence/i)
    ]));
    expect(result.validationWarnings).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/"Squalane", which does not appear/i)
    ]));
  });
});

describe("skin-type scope consistency", () => {
  it("flags 'all skin types' coexisting with an enumerated recommendation", () => {
    const result = validateGraph([{
      ...productBase,
      additionalProperty: [
        {
          "@type": "PropertyValue",
          name: "Recommended skin type",
          value: "Works best for dry skin, normal skin, and combination skin"
        },
        {
          "@type": "PropertyValue",
          name: "Customer situation",
          value: "All skin types. · 24-hour hydration, visible firming, and care for the look of fine lines"
        }
      ]
    }]);
    expect(result.validationWarnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/all skin types.*narrower recommended skin-type list/i)
    ]));
  });
});

describe("description role separation", () => {
  it("flags one long claim sentence duplicated across WebPage and Product descriptions", () => {
    const sharedSentence = "In an instrumental result with 31 women using the cream daily, 100% showed improvement in wrinkles, plumpness, and skin barrier after 6 weeks.";
    const result = validateGraph([
      {
        "@type": "WebPage",
        "@id": "https://example.com/p/1#webpage",
        name: "Test Cream",
        description: `The Test Cream product page presents a moisturizer and its options. ${sharedSentence}`
      },
      {
        ...productBase,
        description: `Test Cream is a moisturizer with squalane for daily hydration. ${sharedSentence}`
      }
    ]);
    expect(result.validationWarnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/duplicated verbatim across WebPage\.description and Product\.description/i)
    ]));
  });
});

describe("page typing", () => {
  it("types the PDP page node as ItemPage alongside WebPage by default", async () => {
    const run = await generatePdpGeo({
      product: { name: "Test Cream", description: "Test Cream is a moisturizer." }
    });
    const webPage = (run.result.schemaMarkup.jsonLd["@graph"] as JsonObject[])
      .find((node) => Array.isArray(node["@type"]) && (node["@type"] as string[]).includes("WebPage"));
    expect(webPage?.["@type"]).toEqual(["WebPage", "ItemPage"]);
    expect(webPage?.inLanguage).toBeDefined();
  });

  it("honors hints.pageType for collection and about pages", async () => {
    const run = await generatePdpGeo({
      product: { name: "Test Brand Story", description: "About the brand." },
      hints: { pageType: "AboutPage" }
    });
    const webPage = (run.result.schemaMarkup.jsonLd["@graph"] as JsonObject[])
      .find((node) => Array.isArray(node["@type"]) && (node["@type"] as string[]).includes("WebPage"));
    expect(webPage?.["@type"]).toEqual(["WebPage", "AboutPage"]);
  });
});

describe("source-backed freshness and routine synergy", () => {
  it("emits WebPage.dateModified only from a source-provided date", async () => {
    const withDate = await generatePdpGeo({
      product: {
        name: "Test Cream",
        description: "Test Cream is a moisturizer with squalane.",
        dateModified: "2026-08-01T09:30:00Z"
      }
    });
    const webPageWithDate = (withDate.result.schemaMarkup.jsonLd["@graph"] as JsonObject[])
      .find((node) => Array.isArray(node["@type"]) ? (node["@type"] as string[]).includes("WebPage") : (Array.isArray(node["@type"]) ? node["@type"].includes("WebPage") : node["@type"] === "WebPage"));
    expect(webPageWithDate?.dateModified).toBe("2026-08-01T09:30:00Z");

    const withoutDate = await generatePdpGeo({
      product: {
        name: "Test Cream",
        description: "Test Cream is a moisturizer with squalane."
      }
    });
    const webPageWithoutDate = (withoutDate.result.schemaMarkup.jsonLd["@graph"] as JsonObject[])
      .find((node) => Array.isArray(node["@type"]) ? (node["@type"] as string[]).includes("WebPage") : (Array.isArray(node["@type"]) ? node["@type"].includes("WebPage") : node["@type"] === "WebPage"));
    expect(webPageWithoutDate ? "dateModified" in webPageWithoutDate : false).toBe(false);
  });

  it("rejects invalid, future, or non-date freshness values", async () => {
    for (const bad of ["2026-02-31", "2099-12-31", "yesterday", "1723363200000"]) {
      const run = await generatePdpGeo({
        product: { name: "Test Cream", description: "Test Cream is a moisturizer.", dateModified: bad }
      });
      const webPage = (run.result.schemaMarkup.jsonLd["@graph"] as JsonObject[])
        .find((node) => Array.isArray(node["@type"]) ? (node["@type"] as string[]).includes("WebPage") : (Array.isArray(node["@type"]) ? node["@type"].includes("WebPage") : node["@type"] === "WebPage"));
      expect(webPage ? "dateModified" in webPage : false, `should reject ${bad}`).toBe(false);
    }
  });

  it("canonicalizes entity @id/url by stripping variant and tracking params", async () => {
    const run = await generatePdpGeo({
      product: { name: "Test Cream", description: "Test Cream is a moisturizer with squalane." },
      source: {
        type: "pdp-extractor",
        url: "https://us.example.com/products/test-cream?variant=43202379644973&utm_source=newsletter&prdSeq=1149"
      }
    });
    const graph = run.result.schemaMarkup.jsonLd["@graph"] as JsonObject[];
    const product = graph.find((node) => node["@type"] === "Product");
    expect(product?.["@id"]).toBe("https://us.example.com/products/test-cream?prdSeq=1149#product");
    expect(product?.url).toBe("https://us.example.com/products/test-cream?prdSeq=1149");
  });

  it("never appends usage guidance to the Routine synergy property", async () => {
    const run = await generatePdpGeo({
      product: {
        name: "Test Cream",
        description: "Test Cream is a moisturizer for a skincare layering routine after serum.",
        usage: ["After serum, apply a pea-sized amount evenly over the face and neck."],
        sourceTexts: ["Use Test Cream after serum in your toner, essence, and serum layering routine."]
      },
      hints: { locale: "en-US" }
    });
    expect(JSON.stringify(run.result.schemaMarkup.jsonLd)).not.toMatch(/usage guidance says to/i);
  });
});
