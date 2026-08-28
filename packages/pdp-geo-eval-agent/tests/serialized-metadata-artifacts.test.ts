import { describe, expect, it } from "vitest";
import { containsSerializedMetadata, findSerializedMetadataArtifact } from "../src/contracts/serialized-metadata";
import { evaluateGeoQuality } from "../src/quality/evaluate";
import type { EvalDiagnosticsInput, GeoQualityEvalInput } from "../src/types";

/**
 * A live incident shipped a Product.description carrying a serialized
 * metafield dump ("google_product_category: 2592 benefit: :firming ...") and
 * the rubric still scored GEO 95 / EEAT 93. Serialized machine metadata in
 * public copy is a public-artifact defect: it must lower every dimension and
 * surface as an actionable improvement, detected by structure rather than by
 * a vocabulary list.
 */

const PAGE_ID = "https://example.com/p#webpage";
const PRODUCT_ID = "https://example.com/p#product";

const POLLUTED_DESCRIPTION =
  "Essential Firming Cream EX is a cream. The product's documented testing includes Hypoallergenic tested, "
  + "google_product_category: 2592 benefit: :firming benefit: :hydrating skin_type: :all_types "
  + "MYR Essential Firming Cream EX | Best Face Firming Cream | EXAMPLELUXE.";

function makeInput(productDescription: string): GeoQualityEvalInput {
  const diagnostics: EvalDiagnosticsInput = {
    normalizedProduct: {
      name: "Essential Firming Cream EX",
      images: [],
      breadcrumbs: [],
      ingredients: ["Ceramide"],
      benefits: ["Firming"],
      effects: []
    },
    validationWarnings: [],
    validationRepairs: [],
    evidence: [{ field: "product.name", source: "input", value: "Essential Firming Cream EX" }],
    ragUsage: [
      { principle: "evidence-backed claims", enabled: true, references: [{ kind: "eeat", fieldTargets: ["Product.description"] }] },
      { principle: "target customer context", enabled: true, references: [{ kind: "cep", fieldTargets: ["Product.additionalProperty"] }] }
    ],
    evidenceLedger: [{ id: "ev-1", role: "benefit", text: "Firming" }],
    contentPlan: {
      mode: "model",
      productDescription: { include: true, evidenceIds: ["ev-1"] },
      webPageDescription: { include: false, evidenceIds: [] },
      faq: [],
      howTo: { eligible: false, steps: [] },
      cep: [{ situation: "dry skin", need: "firming care", evidenceIds: ["ev-1"] }]
    }
  };
  return {
    jsonLd: {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "WebPage",
          "@id": PAGE_ID,
          name: "Essential Firming Cream EX",
          description: "Product page for Essential Firming Cream EX.",
          dateModified: "2026-08-01"
        },
        {
          "@type": "Product",
          "@id": PRODUCT_ID,
          name: "Essential Firming Cream EX",
          description: productDescription,
          offers: { "@type": "Offer", price: 124, priceCurrency: "MYR" }
        }
      ]
    },
    diagnostics
  };
}

describe("serialized metadata public artifacts", () => {
  it("classifies serialized metadata by structure and stays quiet on prose and URLs", () => {
    expect(containsSerializedMetadata("google_product_category: 2592")).toBe(true);
    expect(containsSerializedMetadata("benefit: :firming")).toBe(true);
    expect(containsSerializedMetadata("A | B | C")).toBe(true);
    expect(containsSerializedMetadata("A rich, whipped cream that delivers lasting hydration.")).toBe(false);
    expect(containsSerializedMetadata("See https://example.com/p#product for details.")).toBe(false);

    expect(findSerializedMetadataArtifact(POLLUTED_DESCRIPTION)).toBeTruthy();
    expect(findSerializedMetadataArtifact("Clinically shown to deliver 72-hour hydration.")).toBeUndefined();
  });

  it("penalizes every dimension when public copy carries a serialized metadata dump", () => {
    const clean = evaluateGeoQuality(
      makeInput("Essential Firming Cream EX is a firming cream for all skin types with ceramide-based barrier care."),
      "en"
    );
    const polluted = evaluateGeoQuality(makeInput(POLLUTED_DESCRIPTION), "en");

    const dim = (evaluation: typeof clean, id: string) =>
      evaluation.dimensions.find((d) => d.id === id)?.score ?? -1;

    expect(dim(polluted, "geo")).toBeLessThan(dim(clean, "geo"));
    expect(dim(polluted, "cep")).toBeLessThan(dim(clean, "cep"));
    expect(dim(polluted, "eeat")).toBeLessThan(dim(clean, "eeat"));

    const geoImprovements = polluted.dimensions.find((d) => d.id === "geo")?.improvements.join("\n") ?? "";
    expect(geoImprovements).toMatch(/google_product_category|serialized|메타데이터/i);
  });

  it("does not flag a clean run", () => {
    const clean = evaluateGeoQuality(
      makeInput("Essential Firming Cream EX is a firming cream for all skin types with ceramide-based barrier care."),
      "en"
    );
    const improvements = clean.dimensions.flatMap((d) => d.improvements).join("\n");
    expect(improvements).not.toMatch(/serialized|메타데이터/i);
  });
});
