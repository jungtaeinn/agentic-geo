import { buildGeneratorRequest } from "../src/geo/generation.service";

describe("buildGeneratorRequest", () => {
  it("hands the generator a description with the style block already removed", () => {
    const request = buildGeneratorRequest({
      geoGenerationId: "22222222-2222-2222-2222-222222222222",
      locale: "ko-KR",
      product: {
        productName: "Hydra Barrier Cream",
        description: "<style>.pdp{font-family:var(--font)}</style><p>Daily cream.</p>",
      },
    });

    expect((request.product as Record<string, unknown>).description).toBe("<p>Daily cream.</p>");
  });

  it("resolves the source url from the untouched product contract", () => {
    const request = buildGeneratorRequest({
      geoGenerationId: "22222222-2222-2222-2222-222222222222",
      locale: "ko-KR",
      product: {
        canonicalUrl: "https://store.example.com/products/cream",
        description: "<script>track()</script><p>Cream</p>",
      },
    });

    expect(request.source).toEqual({
      type: "manual-json",
      url: "https://store.example.com/products/cream",
    });
    expect(request.hints).toEqual({ locale: "ko-KR" });
  });
});

describe("brand identity hints (Brand.sameAs wiring)", () => {
  it("carries official brand entity URLs through to the generator", () => {
    const request = buildGeneratorRequest({
      geoGenerationId: "22222222-2222-2222-2222-222222222222",
      locale: "ko-KR",
      product: { productName: "Hydra Barrier Cream" },
      brandSameAs: ["https://shop.example.com/", "https://www.wikidata.org/wiki/Q12599012"],
    });

    // Brand.sameAs is what links the product to a brand the engine already
    // knows; without it the graph is an island and the generator has no other
    // source for official identity URLs.
    expect(request.hints.brandSameAs).toEqual([
      "https://shop.example.com/",
      "https://www.wikidata.org/wiki/Q12599012",
    ]);
  });

  it("omits the hint entirely when the caller supplies nothing", () => {
    const request = buildGeneratorRequest({
      geoGenerationId: "22222222-2222-2222-2222-222222222222",
      locale: "ko-KR",
      product: { productName: "Hydra Barrier Cream" },
    });

    expect(request.hints).toEqual({ locale: "ko-KR" });
  });
});

describe("brand identity transport (controller → queue → worker)", () => {
  it("keeps the brand hint on the job payload the worker receives", async () => {
    const { GeoController } = await import("../src/geo/geo.controller");
    const seen: Array<Record<string, unknown>> = [];
    const controller = new GeoController({
      accept: async (dto: Record<string, unknown>) => {
        seen.push(dto);
        return "enqueued" as const;
      },
    } as never);

    await controller.submit({
      geoGenerationId: "44444444-4444-4444-4444-444444444444",
      locale: "ko-KR",
      product: { productName: "Hydra Barrier Cream" },
      brandSameAs: ["https://shop.example.com/"],
    } as never);

    // The hint has to survive the queue hop: validating it at the edge and then
    // dropping it before the worker leaves the graph exactly as unlinked as
    // before, with no error to show for it.
    expect(seen[0]?.brandSameAs).toEqual(["https://shop.example.com/"]);
  });
});
