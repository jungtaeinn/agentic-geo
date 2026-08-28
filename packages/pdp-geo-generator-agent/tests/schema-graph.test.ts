import { describe, expect, it } from "vitest";
import { resolvePrimaryProductNode, resolveProductGroupNode } from "../src/schema-graph";

describe("schema graph entity resolution", () => {
  it("resolves the current Product through WebPage.mainEntity regardless of graph order", () => {
    const graph = [
      {
        "@type": "ProductGroup",
        "@id": "https://example.com/p#group",
        hasVariant: [
          { "@id": "https://example.com/p#other" },
          { "@id": "https://example.com/p#product" }
        ]
      },
      {
        "@type": "Product",
        "@id": "https://example.com/p#other",
        sku: "OTHER",
        isVariantOf: { "@id": "https://example.com/p#group" }
      },
      {
        "@type": "WebPage",
        "@id": "https://example.com/p#webpage",
        mainEntity: { "@id": "https://example.com/p#product" }
      },
      {
        "@type": "Product",
        "@id": "https://example.com/p#product",
        sku: "CURRENT",
        isVariantOf: { "@id": "https://example.com/p#group" }
      }
    ];

    expect(resolvePrimaryProductNode(graph)?.sku).toBe("CURRENT");
    expect(resolveProductGroupNode(graph)?.["@id"]).toBe("https://example.com/p#group");
  });
});
