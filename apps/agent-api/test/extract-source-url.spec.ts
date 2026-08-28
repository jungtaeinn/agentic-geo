import { extractSourceUrl } from "../src/geo/generation.service";

describe("extractSourceUrl", () => {
  it("prefers canonicalUrl from the product contract", () => {
    expect(
      extractSourceUrl({
        canonicalUrl: "https://store.example.com/products/cream",
        offerUrl: "https://store.example.com/products/cream?variant=1",
      }),
    ).toBe("https://store.example.com/products/cream");
  });

  it("falls back to offerUrl when canonicalUrl is missing or blank", () => {
    expect(
      extractSourceUrl({ canonicalUrl: "  ", offerUrl: "https://store.example.com/p/1" }),
    ).toBe("https://store.example.com/p/1");
    expect(extractSourceUrl({ offerUrl: "https://store.example.com/p/1" })).toBe(
      "https://store.example.com/p/1",
    );
  });

  it("returns undefined for null, non-object, or url-less products", () => {
    expect(extractSourceUrl(null)).toBeUndefined();
    expect(extractSourceUrl("not-an-object")).toBeUndefined();
    expect(extractSourceUrl({ productName: "Cream" })).toBeUndefined();
    expect(extractSourceUrl({ canonicalUrl: 123 })).toBeUndefined();
  });
});
