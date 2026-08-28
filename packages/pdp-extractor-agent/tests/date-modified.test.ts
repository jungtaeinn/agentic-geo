import { describe, expect, it } from "vitest";
import { extractProductFromHtml } from "../src/agent";

const baseHtml = (head: string, body = "") => `<!doctype html>
<html><head><title>Test Cream</title>${head}</head>
<body><h1>Test Cream</h1><p>A moisturizer with squalane for daily hydration.</p>${body}</body></html>`;

describe("source-provided dateModified extraction", () => {
  it("extracts a page modified date from meta tags", async () => {
    const run = await extractProductFromHtml(
      baseHtml(`<meta property="article:modified_time" content="2026-08-01T09:30:00Z" />`),
      "https://example.com/products/test-cream"
    );
    expect(run.result.geoProduct.dateModified).toBe("2026-08-01T09:30:00Z");
    expect(run.diagnostics.evidence.some((item) => item.field === "product.dateModified")).toBe(true);
  });

  it("extracts an embedded Shopify-style updated_at from page JSON", async () => {
    const run = await extractProductFromHtml(
      baseHtml("", `<script type="application/json">{"product":{"title":"Test Cream","updated_at":"2026-07-30T11:00:00-04:00"}}</script>`),
      "https://example.com/products/test-cream"
    );
    expect(run.result.geoProduct.dateModified).toBe("2026-07-30T11:00:00-04:00");
  });

  it("omits the field when the source has no recognizable date", async () => {
    const run = await extractProductFromHtml(
      baseHtml(`<meta property="og:updated_time" content="yesterday" />`),
      "https://example.com/products/test-cream"
    );
    expect(run.result.geoProduct.dateModified).toBeUndefined();
  });
});
