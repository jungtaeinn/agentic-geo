import { GenerationService } from "../src/geo/generation.service";

describe("GenerationService (mock provider)", () => {
  const service = new GenerationService();

  it("generates schema markup for a product with mock provider", async () => {
    const artifact = await service.generate({
      geoGenerationId: "11111111-1111-1111-1111-111111111111",
      locale: "ko-KR",
      product: { item: { title: "Hydra Barrier Cream", body: "Daily cream for dry skin." } },
    });

    expect(artifact.jsonLd).toBeDefined();
    expect(typeof artifact.scriptTag).toBe("string");
    expect(artifact.scriptTag).toContain("application/ld+json");
    expect(Array.isArray(artifact.schemaTypes)).toBe(true);
    expect(artifact.resultHash).toMatch(/^[0-9a-f]{64}$/);
    expect(["SUCCEEDED", "SUCCEEDED_WITH_WARNINGS"]).toContain(artifact.resultStatus);
    expect(typeof artifact.ragProfile).toBe("string");
  });
});

describe("GenerationService brand identity", () => {
  const service = new GenerationService();

  it("emits Brand.sameAs from the caller's official brand entity URLs", async () => {
    const artifact = await service.generate({
      geoGenerationId: "33333333-3333-3333-3333-333333333333",
      locale: "ko-KR",
      product: { item: { title: "Hydra Barrier Cream", brand: "ExampleLuxe", body: "Daily cream for dry skin." } },
      brandSameAs: ["https://www.exampleluxe.com/"],
    });

    const graph = (artifact.jsonLd as { "@graph"?: Array<Record<string, unknown>> })["@graph"] ?? [];
    const product = graph.find((node) => node["@type"] === "Product") as Record<string, unknown> | undefined;
    const brand = product?.brand as Record<string, unknown> | undefined;

    expect(brand?.sameAs).toEqual(["https://www.exampleluxe.com/"]);
  });
});
