import { describe, expect, it } from "vitest";
import { generatePdpGeo } from "../src";

// GEO-128: agent-api가 전달하는 GEO 입력 계약 확장 필드(variants/metafields 등)를
// signal 구조 변경 없이 기존 options/price/sourceTexts로 파생 반영하는지 검증한다.
// (PdpProductSignal 구조 확장 및 JSON-LD gtin/Offer.availability 반영은
//  TODO(GEO-128)로 보류 — 사용자 결정)

const variantInStock = JSON.stringify({
  sku: "GT-50",
  gtin: "8801111111111",
  title: "50ml",
  options: ["Volume: 50ml"],
  price: "32000",
  listPrice: "40000",
  availability: "InStock"
});

const variantOutOfStock = JSON.stringify({
  sku: "GT-100",
  title: "100ml",
  options: ["Volume: 100ml"],
  price: "58000",
  availability: "OutOfStock"
});

describe("enriched GEO input contract fields (GEO-128)", () => {
  it("derives variant titles/options into internal options and backfills price from the first variant", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "Barrier Hydro Soothing Cream",
          description: "Hydrating cream for skin barrier moisture care.",
          brand: "EXAMPLEDERMA",
          category: "Cream",
          gtin: "8800000000000",
          availability: "InStock",
          tags: ["vegan", "sensitive skin"],
          seoTitle: "Barrier Hydro Soothing Cream - EXAMPLEDERMA",
          seoDescription: "A soothing barrier cream for dry and sensitive skin.",
          benefits: ["hydration"],
          ingredients: ["Ceramide"],
          variants: [variantInStock, variantOutOfStock, "not-json{{"],
          metafields: {
            "shopify.suitable-for-skin-type": "Dry, Sensitive",
            "custom.full-ingredients": "Water, Glycerin, Ceramide NP"
          }
        }
      },
      hints: { locale: "en-US", market: "US" }
    });

    const normalized = result.diagnostics.normalizedProduct;

    // a) variant JSON 문자열이 파싱되어 title/options가 내부 options로 파생된다.
    expect(normalized.options).toContain("50ml");
    expect(normalized.options).toContain("100ml");
    expect(normalized.options).toContain("Volume: 50ml");
    expect(normalized.options).toContain("Volume: 100ml");

    // b) variants JSON 원문 문자열이 options에 그대로 들어가지 않는다(파싱 실패 원소 포함).
    expect(normalized.options.some((option) => option.includes('"sku"'))).toBe(false);
    expect(normalized.options.some((option) => option.includes("not-json"))).toBe(false);

    // c) product price가 비어 있으면 첫 variant price로 보충된다.
    expect(normalized.price?.raw).toBe("32000");

    // d) metafields는 key가 소실되지 않게 "key: value" 문자열로 sourceTexts에 유입된다.
    expect(normalized.sourceTexts.some((text) =>
      text.includes("shopify.suitable-for-skin-type") && text.includes("Dry"))).toBe(true);
    expect(normalized.sourceTexts.some((text) =>
      text.includes("custom.full-ingredients") && text.includes("Glycerin"))).toBe(true);

    // tags/seoTitle/seoDescription도 근거 텍스트로 유입된다(기존 allStrings 재귀 수집 경로).
    expect(normalized.sourceTexts.some((text) => text.includes("sensitive skin"))).toBe(true);
    expect(normalized.sourceTexts.some((text) =>
      text.includes("A soothing barrier cream for dry and sensitive skin."))).toBe(true);
  });

  it("keeps an explicit product price over variant-derived prices", async () => {
    const { result } = await generatePdpGeo({
      product: {
        geoProduct: {
          name: "Barrier Hydro Soothing Cream",
          description: "Hydrating cream for skin barrier moisture care.",
          price: "45000",
          currency: "KRW",
          variants: [variantInStock]
        }
      },
      hints: { locale: "en-US", market: "KR" }
    });

    expect(result.diagnostics.normalizedProduct.price?.raw).toBe("45000");
  });
});
