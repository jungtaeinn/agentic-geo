import { afterEach, describe, expect, it, vi } from "vitest";
import { createProductExtractorRestHandler } from "../src/rest";

const originalFetch = globalThis.fetch;

describe("createProductExtractorRestHandler", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("returns JSON results through a Web API compatible REST handler", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          product: {
            name: "API Cream",
            price: "12000",
            benefits: ["hydration"],
            ocrTexts: ["hydration barrier niacinamide"]
          },
          reviews: {
            rating: 4.5,
            reviewCount: 12,
            items: [{ body: "smooth and satisfied", rating: 5 }]
          }
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    ) as typeof fetch;
    const handler = createProductExtractorRestHandler({ provider: "mock" });
    const response = await handler(
      new Request("https://agentic-geo.local/extract", {
        method: "POST",
        body: JSON.stringify({
          sourceType: "restApi",
          sources: ["https://example.com/api/product"]
        })
      })
    );

    const payload = await response.json() as {
      results?: Array<{
        source: string;
        process?: unknown;
        product?: unknown;
        reviews?: unknown;
        ocr?: unknown;
        ragChunks?: unknown;
        geoProduct?: { name: string };
      }>;
      logs?: Array<{ source: string; process: Array<{ id: string; status: string }> }>;
    };

    expect(response.status).toBe(200);
    expect(payload.results?.[0]?.source).toBe("https://example.com/api/product");
    expect(payload.results?.[0]?.geoProduct?.name).toBe("API Cream");
    expect(payload.results?.[0]?.product).toBeUndefined();
    expect(payload.results?.[0]?.reviews).toBeUndefined();
    expect(payload.results?.[0]?.ocr).toBeUndefined();
    expect(payload.results?.[0]?.ragChunks).toBeUndefined();
    expect(payload.results?.[0]?.process).toBeUndefined();
    expect(payload.logs?.[0]?.source).toBe("https://example.com/api/product");
    expect(payload.logs?.[0]?.process.find((step) => step.id === "json")?.status).toBe("done");
  });

  it("returns source-level failures without failing the whole REST response", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("Access Denied", { status: 403 })
    ) as typeof fetch;
    const handler = createProductExtractorRestHandler({ provider: "mock" });
    const response = await handler(
      new Request("https://agentic-geo.local/extract", {
        method: "POST",
        body: JSON.stringify({
          sourceType: "url",
          sources: ["https://www.sephora.com/product/example-P123"]
        })
      })
    );

    const payload = await response.json() as {
      results?: unknown[];
      failures?: Array<{ source: string; error: string }>;
      logs?: Array<{ source: string; process: Array<{ id: string; status: string }> }>;
    };

    expect(response.status).toBe(207);
    expect(payload.results).toEqual([]);
    expect(payload.failures?.[0]?.source).toBe("https://www.sephora.com/product/example-P123");
    expect(payload.failures?.[0]?.error).toContain("403");
    expect(payload.logs?.[0]?.process.find((step) => step.id === "fetch")?.status).toBe("error");
  });
});
