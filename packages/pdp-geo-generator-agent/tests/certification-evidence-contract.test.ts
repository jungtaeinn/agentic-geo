import { describe, expect, it } from "vitest";
import { generatePdpGeo } from "../src";
import {
  containsSerializedMetadata,
  selectAtomicFunctionalCertificationValues
} from "../src/contracts/certification-contract";

/**
 * Serialized commerce metadata (metafield key/value dumps, tag lists, SEO
 * title chains, price/currency tokens) legitimately enters the retrieval and
 * planning evidence pool, but it never functions as a completed-test fact a
 * source states in prose. These cases pin the contract boundary: an atomic
 * certification survives, serialized metadata and cross-value chimera
 * fragments never reach public copy.
 */
describe("functional certification evidence contract", () => {
  it("keeps only atomic completed-test facts from mixed English prose", () => {
    const values = selectAtomicFunctionalCertificationValues(
      "Ectoin WORKS BEST FOR All skin types - Dermatologically and hypoallergenic tested",
      "en-US"
    );
    expect(values).toContain("Dermatologically and hypoallergenic tested");
    expect(values.some((value) => /WORKS BEST FOR/i.test(value))).toBe(false);
  });

  it("rejects serialized metafield dumps even when they contain certification keywords", () => {
    const dump =
      "ExampleLuxe Malaysia Staging Cream 124, google_product_category: 2592 benefit: :firming "
      + "benefit: :hypoallergenic collection: :essential_comfort skin_benefit: : Hypoallergenic "
      + "skin_type: :all_types MYR Essential Firming Cream EX | Best Face Firming Cream | EXAMPLELUXE";
    expect(selectAtomicFunctionalCertificationValues(dump, "en-US")).toEqual([]);
  });

  it("rejects chimera fragments that span multiple source values", () => {
    const chimera =
      "Ectoin WORKS BEST FOR All skin types - Dermatologically and hypoallergenic tested "
      + "ExampleLuxe Malaysia Staging Cream 124";
    const values = selectAtomicFunctionalCertificationValues(chimera, "en-US");
    expect(values.some((value) => /ExampleLuxe|Cream 124/i.test(value))).toBe(false);
  });

  it("keeps the Korean canonical closed-set behavior unchanged", () => {
    expect(selectAtomicFunctionalCertificationValues(
      "피부과 테스트 완료 및 하이포알러제닉 테스트 완료를 마친 저자극 포뮬러",
      "ko-KR"
    )).toEqual(["피부과 테스트 완료", "하이포알러제닉 테스트 완료"]);
  });

  it("classifies serialized metadata by structure, not vocabulary", () => {
    expect(containsSerializedMetadata("google_product_category: 2592")).toBe(true);
    expect(containsSerializedMetadata("benefit: :firming")).toBe(true);
    expect(containsSerializedMetadata("skin_benefit: : Hypoallergenic")).toBe(true);
    expect(containsSerializedMetadata("Essential Firming Cream EX | Best Face Firming Cream | EXAMPLELUXE")).toBe(true);
    expect(containsSerializedMetadata("Dermatologically and hypoallergenic tested")).toBe(false);
    expect(containsSerializedMetadata("Hydrating cream for skin barrier moisture care.")).toBe(false);
  });

  it("never publishes metafield dumps inside Product.description for commerce payloads", async () => {
    const { result } = await generatePdpGeo({
      product: {
        title: "[GEO-TEST] Essential Firming Cream EX",
        vendor: "ExampleLuxe Malaysia Staging",
        product_type: "Cream",
        price: "124",
        currency: "MYR",
        tags: "cream, dryness, essential, gift",
        seo_title: "Essential Firming Cream EX | Best Face Firming Cream | EXAMPLELUXE",
        body_html:
          "A creamy face cream. Achieve visibly firmer, smoother skin. Hydrating, Firming, Smoothing, Soothing, Moisturizing. "
          + "Korean Herb Extract and the JISUN Firming Complex, plus Ginseng Berry, and Ectoin "
          + "WORKS BEST FOR All skin types - Dermatologically and hypoallergenic tested",
        metafields: {
          google_product_category: "2592",
          "benefit: ": ":firming",
          "benefit:  ": ":hydrating",
          "skin_benefit: ": ": Hypoallergenic",
          "skin_type: ": ":all_types"
        }
      },
      hints: {
        locale: "en-US",
        market: "US"
      }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const description = String(product.description);

    expect(description).not.toMatch(/google_product_category|benefit:\s*:|skin_type|essential_comfort/i);
    expect(description).not.toMatch(/\s\|\s/);
    expect(description).not.toMatch(/Cream 124|MYR/);

    // The FAQ contract still holds for the same payload: benefit-backed
    // anchors exist, so the graph keeps a FAQPage node.
    expect(graph.some((node) => node["@type"] === "FAQPage")).toBe(true);
  });
});
