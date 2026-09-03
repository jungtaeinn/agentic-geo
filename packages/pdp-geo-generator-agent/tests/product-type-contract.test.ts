import { describe, expect, it } from "vitest";
import { createPdpGeoEvidenceLedger, generatePdpGeo, type JsonValue } from "../src";
import { normalizePdpProduct } from "../src/normalize";

/**
 * The pipeline reads the product form from the product name to publish
 * `Product.category`. Normalization must read it from the same contract, or a
 * run publishes a category for which it holds no evidence atom — and copy
 * naming that category then cannot be supported.
 */
describe("product type contract", () => {
  it("fills a missing category from the form the product name states", () => {
    const { product } = normalizePdpProduct({
      name: "모이베리어 365 크림 미스트",
      brand: "EXAMPLEDERMA",
      description: "10,000ppm 함유된 고함량 세라마이드 미세분사로 피부장벽을 보호하는",
      benefits: ["수분 충전과 동시에 보습막을 형성"],
      ingredients: ["세라마이드 10,000ppm"]
    }, { hints: { locale: "ko-KR" } });

    expect(product.category).toBe("크림 미스트");
    // Without the atom the category is published but not citable.
    expect(createPdpGeoEvidenceLedger(product, "ko-KR")
      .filter((item) => item.sourcePath === "product.category")
      .map((item) => item.text)).toEqual(["크림 미스트"]);
  });

  it("uses the market wording of the requested locale", () => {
    const { product } = normalizePdpProduct({
      name: "Hydra Cream Mist",
      brand: "TestLab",
      description: "A fine-mist moisturizer."
    }, { hints: { locale: "en-US" } });

    expect(product.category).toBe("Cream Mist");
  });

  it("never overrides a category the source states", () => {
    const { product } = normalizePdpProduct({
      name: "모이베리어 365 크림 미스트",
      category: "보습 미스트",
      brand: "EXAMPLEDERMA",
      description: "세라마이드 함유 미스트입니다."
    }, { hints: { locale: "ko-KR" } });

    expect(product.category).toBe("보습 미스트");
  });

  it("leaves the published schema category unchanged", async () => {
    const run = await generatePdpGeo({
      product: {
        name: "모이베리어 365 크림 미스트",
        brand: "EXAMPLEDERMA",
        description: "세라마이드 함유 미스트입니다.",
        benefits: ["수분 충전"],
        ingredients: ["세라마이드 10,000ppm"]
      },
      source: { url: "https://example.com/p" },
      hints: { locale: "ko-KR", market: "KR" }
    });
    const graph = run.result.schemaMarkup.jsonLd["@graph"] as JsonValue[];
    const productNode = graph.find((node): node is Record<string, JsonValue> =>
      typeof node === "object" && node !== null && !Array.isArray(node) && node["@type"] === "Product")!;

    expect(productNode.category).toBe("크림 미스트");
  });
});
