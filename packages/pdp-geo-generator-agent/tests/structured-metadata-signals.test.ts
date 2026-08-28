import { describe, expect, it } from "vitest";
import { generatePdpGeo } from "../src";
import { inferPdpEvidenceRoles } from "../src/normalize";

/**
 * A serialized metadata entry carries its meaning in two halves: the key
 * names the semantic role and the value carries the fact — "benefit::firming"
 * states that firming is a benefit. The normalizer must parse the pair into a
 * role-correct atomic signal instead of either treating the joined string as
 * prose (the old pollution path) or discarding it as noise. Machine
 * identifiers and SEO title chains carry no product fact and stay out.
 */
describe("structured metadata signal parsing", () => {
  const geoProduct = {
    name: "[GEO-TEST] Essential Firming Cream EX",
    brand: "ExampleLuxe Malaysia Staging",
    category: "Cream",
    description:
      "A rich, whipped cream that delivers lasting hydration while visibly firming and smoothing skin. "
      + "Dermatologically and hypoallergenic tested, it’s ideal for all skin types.",
    effects: ["Hydrating, Firming, Smoothing, Soothing, Moisturizing"],
    sourceTexts: [
      "shopify.texture: Creamy",
      "global.title_tag: Essential Firming Cream EX | Best Face Firming Cream | EXAMPLELUXE",
      "shopify.skin-care-effect: Hydrating, Firming, Smoothing, Soothing, Moisturizing",
      "shopify.skin-care-features: Moisturizing, Long lasting, Soothing",
      "mm-google-shopping.google_product_category: 2592",
      "benefit::firming",
      "benefit::hydrating",
      "benefit::hypoallergenic",
      "skin_benefit::Nourishing",
      "collection::essential_comfort",
      "skin_type::all_types",
      "MYR"
    ]
  };

  it("promotes key/value metadata into role-correct atomic benefit and effect signals", async () => {
    const { result } = await generatePdpGeo({
      product: { geoProduct },
      hints: { locale: "en-US", market: "US" }
    });

    const normalized = result.diagnostics.normalizedProduct;
    const benefits = normalized.benefits.map((value: string) => value.toLowerCase());
    expect(benefits).toContain("firming");
    expect(benefits).toContain("hydrating");
    // Hypoallergenic names the low-irritation property of the product — a
    // benefit, exactly like the Korean 저자극 — not a completed-test claim.
    expect(benefits).toContain("hypoallergenic");

    const facts = [...normalized.benefits, ...normalized.effects];
    expect(facts.some((value: string) => /2592|google_product_category/i.test(value))).toBe(false);
    expect(facts.some((value: string) => /\|/.test(value))).toBe(false);
    expect(facts.some((value: string) => /essential_comfort|collection/i.test(value))).toBe(false);
    expect(facts.some((value: string) => /::/.test(value))).toBe(false);
  });

  it("restores FAQ generation once metadata-backed benefit atoms exist", async () => {
    const { result } = await generatePdpGeo({
      product: { geoProduct },
      hints: { locale: "en-US", market: "US" }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    expect(graph.some((node) => node["@type"] === "FAQPage")).toBe(true);
    expect(result.content.sections.faq.length).toBeGreaterThan(0);
  });

  it("classifies safety by verification function, not by property vocabulary", () => {
    // The bare property term states what the product is like — a benefit.
    expect(inferPdpEvidenceRoles("hypoallergenic").roles).toContain("benefit");
    expect(inferPdpEvidenceRoles("hypoallergenic").roles).not.toContain("safety");
    // The verification claim states what was tested — safety, never benefit.
    expect(inferPdpEvidenceRoles("hypoallergenic tested").roles).toContain("safety");
    expect(inferPdpEvidenceRoles("hypoallergenic tested").roles).not.toContain("benefit");
    expect(inferPdpEvidenceRoles("하이포알러제닉 테스트 완료").roles).toContain("safety");
  });

  it("keeps raw serialized strings in the ledger as retrieval context, not benefit evidence", async () => {
    const { result } = await generatePdpGeo({
      product: { geoProduct },
      hints: { locale: "en-US", market: "US" }
    });

    const ledger = result.diagnostics.evidenceLedger as Array<{ role: string; text: string }>;
    const serializedBenefitAtoms = ledger.filter((item) =>
      item.role === "benefit" && /::|\w+\.\w+\s*:|\s\|\s/.test(item.text)
    );
    expect(serializedBenefitAtoms).toEqual([]);

    // The parsed atomic facts carry the benefit role instead.
    expect(ledger.some((item) => item.role === "benefit" && /^firming$/i.test(item.text))).toBe(true);
  });
});
