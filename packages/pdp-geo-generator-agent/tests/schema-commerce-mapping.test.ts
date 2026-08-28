import { describe, expect, it } from "vitest";
import { generatePdpGeo } from "../src";
import { validateAndRepairPdpGeoArtifacts } from "../src/validate";
import {
  gtinPropertyName,
  normalizeAvailabilityToken,
  normalizeItemConditionToken,
  sanitizeGtinValue,
  sanitizeSkuValue
} from "../src/schema-values";

describe("schema-values (commerce contract shared commerce normalization)", () => {
  it("maps canonical, URL, cased, and merchant-phrase availability values to the official enum", () => {
    expect(normalizeAvailabilityToken("InStock")).toBe("InStock");
    expect(normalizeAvailabilityToken("IN_STOCK")).toBe("InStock");
    expect(normalizeAvailabilityToken("in stock")).toBe("InStock");
    expect(normalizeAvailabilityToken("https://schema.org/InStock")).toBe("InStock");
    expect(normalizeAvailabilityToken("판매중")).toBe("InStock");
    expect(normalizeAvailabilityToken("품절")).toBe("SoldOut");
    expect(normalizeAvailabilityToken("sold out")).toBe("SoldOut");
    expect(normalizeAvailabilityToken("일시 품절 (재입고 예정)")).toBe("BackOrder");
    expect(normalizeAvailabilityToken("예약 판매")).toBe("PreOrder");
    expect(normalizeAvailabilityToken("단종")).toBe("Discontinued");
    expect(normalizeAvailabilityToken("out of stock")).toBe("OutOfStock");
    expect(normalizeAvailabilityToken("currently not available")).toBe("OutOfStock");
    expect(normalizeAvailabilityToken(true)).toBe("InStock");
    expect(normalizeAvailabilityToken(false)).toBe("OutOfStock");
  });

  it("is fail-closed for unmappable availability values (never defaults to InStock)", () => {
    expect(normalizeAvailabilityToken("special order maybe")).toBeUndefined();
    expect(normalizeAvailabilityToken("")).toBeUndefined();
    expect(normalizeAvailabilityToken(123)).toBeUndefined();
    expect(normalizeAvailabilityToken(undefined)).toBeUndefined();
  });

  it("validates GTIN length and GS1 check digit per schema.org/gtin", () => {
    // 880123456789 + check digit 3 is a valid EAN-13.
    expect(sanitizeGtinValue("8801234567893")).toBe("8801234567893");
    expect(sanitizeGtinValue("880-1234-56789-3")).toBe("8801234567893");
    expect(sanitizeGtinValue("8801234567890")).toBeUndefined(); // wrong check digit
    expect(sanitizeGtinValue("12345")).toBeUndefined(); // invalid length
    expect(sanitizeGtinValue("ABC1234567893")).toBeUndefined(); // non-numeric
    expect(gtinPropertyName("8801234567893")).toBe("gtin13");
  });

  it("sanitizes explicit merchant SKUs and rejects placeholders", () => {
    expect(sanitizeSkuValue("SKU-12345")).toBe("SKU-12345");
    expect(sanitizeSkuValue(" 11 0770 0524 ")).toBe("110770 0524".replace(/\s+/g, ""));
    expect(sanitizeSkuValue("product")).toBeUndefined();
    expect(sanitizeSkuValue("ab")).toBeUndefined();
  });

  it("maps item condition signals to the official OfferItemCondition enum, fail-closed", () => {
    expect(normalizeItemConditionToken("NewCondition")).toBe("NewCondition");
    expect(normalizeItemConditionToken("https://schema.org/NewCondition")).toBe("NewCondition");
    expect(normalizeItemConditionToken("new")).toBe("NewCondition");
    expect(normalizeItemConditionToken("새상품")).toBe("NewCondition");
    expect(normalizeItemConditionToken("리퍼")).toBe("RefurbishedCondition");
    expect(normalizeItemConditionToken("중고")).toBe("UsedCondition");
    expect(normalizeItemConditionToken("brand new sealed maybe")).toBeUndefined();
    expect(normalizeItemConditionToken(123)).toBeUndefined();
  });
});

describe("generatePdpGeo commerce mapping (commerce contract)", () => {
  const baseProduct = {
    name: "Barrier Hydro Soothing Cream",
    description: "Hydrating cream for dry skin and skin barrier care.",
    category: "Cream",
    benefits: ["hydration"],
    ingredients: ["Ceramide"],
    price: "32,000원",
    currency: "KRW"
  };

  it("maps input skuId, gtin, and availability to Product.sku, Product.gtin(+gtin13), and Offer.availability", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          ...baseProduct,
          skuId: "SKU-A100",
          gtin: "8801234567893",
          availability: "InStock"
        }
      },
      hints: { locale: "ko-KR", market: "KR" }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;

    expect(product.sku).toBe("SKU-A100");
    expect(product.gtin).toBe("8801234567893");
    expect(product.gtin13).toBe("8801234567893");
    const offer = product.offers as Record<string, any>;
    expect(offer["@type"]).toBe("Offer");
    expect(offer.availability).toBe("https://schema.org/InStock");
  });

  it("omits availability entirely when the input value is unmappable (fail-closed)", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          ...baseProduct,
          availability: "maybe later"
        }
      },
      hints: { locale: "ko-KR", market: "KR" }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const offer = product.offers as Record<string, any>;
    expect(offer.availability).toBeUndefined();
  });

  it("emits per-variant Offer array (Tier 2) and suppresses flattened Options/Variant comparison", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          ...baseProduct,
          variants: [
            { title: "50ml", sku: "SKU-A050", price: "32000", currency: "KRW", availability: "InStock" },
            { title: "80ml", sku: "SKU-A080", price: "45000", currency: "KRW", availability: "SoldOut" }
          ]
        }
      },
      hints: { locale: "ko-KR", market: "KR" }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const offers = product.offers as Array<Record<string, any>>;

    expect(Array.isArray(offers)).toBe(true);
    expect(offers).toHaveLength(2);
    expect(offers[0]?.sku).toBe("SKU-A050");
    expect(offers[0]?.availability).toBe("https://schema.org/InStock");
    expect(offers[1]?.price).toBe(45000);
    expect(offers[1]?.availability).toBe("https://schema.org/SoldOut");

    const additionalNames = ((product.additionalProperty ?? []) as Array<Record<string, any>>)
      .map((property) => String(property.name));
    expect(additionalNames).not.toContain("Options");
    expect(additionalNames).not.toContain("Variant comparison");
  });

  it("maps product-level boolean stock flags when no textual status exists", async () => {
    const soldOutRun = await generatePdpGeo({
      product: { geoProduct: { ...baseProduct, soldOut: true } },
      hints: { locale: "ko-KR", market: "KR" }
    });
    expect(soldOutRun.result.diagnostics.normalizedProduct.availability).toBe("SoldOut");

    const inStockRun = await generatePdpGeo({
      product: { geoProduct: { ...baseProduct, soldOut: false } },
      hints: { locale: "ko-KR", market: "KR" }
    });
    expect(inStockRun.result.diagnostics.normalizedProduct.availability).toBe("InStock");

    const unavailableRun = await generatePdpGeo({
      product: { geoProduct: { ...baseProduct, available: false } },
      hints: { locale: "ko-KR", market: "KR" }
    });
    expect(unavailableRun.result.diagnostics.normalizedProduct.availability).toBe("OutOfStock");
  });

  it("recommends supplying availability when it is missing, and stays silent when mapped", async () => {
    const missing = await generatePdpGeo({
      product: { geoProduct: { ...baseProduct } },
      hints: { locale: "ko-KR", market: "KR" }
    });
    expect(missing.result.diagnostics.recommendations.some(
      (item) => item.field === "offers.availability"
    )).toBe(true);

    const mapped = await generatePdpGeo({
      product: { geoProduct: { ...baseProduct, availability: "InStock" } },
      hints: { locale: "ko-KR", market: "KR" }
    });
    expect(mapped.result.diagnostics.recommendations.some(
      (item) => item.field === "offers.availability"
    )).toBe(false);
  });

  it("preserves variant gtin and url on Tier-2 offers after GS1 validation", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          ...baseProduct,
          variants: [
            {
              title: "50ml",
              sku: "SKU-A050",
              gtin: "8801234567893",
              url: "https://example.com/products/cream?variant=50ml",
              price: "32000",
              currency: "KRW",
              availability: "InStock"
            },
            {
              title: "80ml",
              sku: "SKU-A080",
              gtin: "8801234567890", // invalid check digit → dropped, offer still valid
              price: "45000",
              currency: "KRW",
              availability: "InStock"
            }
          ]
        }
      },
      hints: { locale: "ko-KR", market: "KR" }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const offers = product.offers as Array<Record<string, any>>;

    expect(offers).toHaveLength(2);
    expect(offers[0]?.gtin).toBe("8801234567893");
    expect(offers[0]?.url).toBe("https://example.com/products/cream?variant=50ml");
    expect(offers[1]?.gtin).toBeUndefined();
  });

  it("keeps a validated variant Offer array intact through the repair validator", () => {
    const repaired = validateAndRepairPdpGeoArtifacts({
      schemaMarkup: {
        jsonLd: {
          "@context": "https://schema.org",
          "@graph": [
            {
              "@type": "Product",
              "@id": "https://example.com/products/cream#product",
              name: "Barrier Hydro Soothing Cream",
              description: "Hydrating cream for dry skin and skin barrier care.",
              offers: [
                { "@type": "Offer", name: "50ml", sku: "SKU-A050", price: 32000, priceCurrency: "KRW", availability: "https://schema.org/InStock" },
                { "@type": "Offer", name: "no-currency", price: 10000 },
                { "@type": "Offer", name: "80ml", sku: "SKU-A080", price: 45000, priceCurrency: "KRW", availability: "https://schema.org/SoldOut" }
              ]
            }
          ]
        },
        scriptTag: ""
      },
      content: {
        sections: {
          productName: "Barrier Hydro Soothing Cream",
          description: "Hydrating cream for dry skin and skin barrier care.",
          quickFacts: "Type: moisturizing cream",
          benefits: "hydration",
          ingredients: "Ceramide",
          howToUse: "",
          faq: ""
        },
        html: ""
      },
      fallbackProductName: "Barrier Hydro Soothing Cream",
      fallbackDescription: "Hydrating cream for dry skin and skin barrier care.",
      locale: "en-US"
    });

    const graph = repaired.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    const offers = product.offers as Array<Record<string, any>>;

    expect(Array.isArray(offers)).toBe(true);
    expect(offers).toHaveLength(2);
    expect(offers.map((offer) => offer.sku)).toEqual(["SKU-A050", "SKU-A080"]);
  });

  it("falls back to a single Offer when variants are not differentiated or trustworthy", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          ...baseProduct,
          variants: [
            { title: "50ml" }, // no price → untrustworthy
            { title: "80ml", price: "45000", currency: "KRW" }
          ]
        }
      },
      hints: { locale: "ko-KR", market: "KR" }
    });

    const graph = result.schemaMarkup.jsonLd["@graph"] as Array<Record<string, any>>;
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, any>;
    expect(Array.isArray(product.offers)).toBe(false);
  });
});
