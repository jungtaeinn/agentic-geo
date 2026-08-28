import { deriveSchemaTypes, computeResultHash } from "../src/geo/schema-types.util";

describe("deriveSchemaTypes", () => {
  it("collects @type from @graph nodes (dedup, array types flattened)", () => {
    const jsonLd = {
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "Product" },
        { "@type": ["WebPage", "FAQPage"] },
        { "@type": "Product" },
      ],
    };
    expect(deriveSchemaTypes(jsonLd).sort()).toEqual(["FAQPage", "Product", "WebPage"]);
  });

  it("handles top-level @type without @graph", () => {
    expect(deriveSchemaTypes({ "@type": "Product" })).toEqual(["Product"]);
  });

  it("returns [] for missing types", () => {
    expect(deriveSchemaTypes({})).toEqual([]);
  });
});

describe("computeResultHash", () => {
  it("is stable regardless of key order", () => {
    const a = computeResultHash({ a: 1, b: 2 });
    const b = computeResultHash({ b: 2, a: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
