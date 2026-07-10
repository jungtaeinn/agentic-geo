import { describe, expect, it } from "vitest";
import { createPdpGeoGeneratorRestHandler } from "../src/rest";

describe("createPdpGeoGeneratorRestHandler", () => {
  it("returns generated artifacts for a product payload", async () => {
    const handler = createPdpGeoGeneratorRestHandler();
    const response = await handler(new Request("https://example.com/api/generate", {
      method: "POST",
      body: JSON.stringify({
        product: {
          name: "Hydra Barrier Cream",
          description: "Daily hydration cream for moisture barrier care.",
          benefits: ["hydration"],
          ingredients: ["Ceramide"],
          usage: ["Apply after serum."]
        },
        hints: {
          locale: "en-US"
        }
      })
    }));
    const payload = await response.json() as {
      results: Array<{
        content: {
          html: string;
        };
        schemaMarkup: {
          scriptTag: string;
        };
      }>;
      failures: unknown[];
    };

    expect(response.status).toBe(200);
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0]?.schemaMarkup.scriptTag).toContain("application/ld+json");
    expect(payload.results[0]?.content.html).toContain("geo-content-accordion");
    expect(payload.failures).toEqual([]);
  });

  it("rejects a request endpoint override that would reuse a server-managed key", async () => {
    const handler = createPdpGeoGeneratorRestHandler({
      provider: "azure-openai",
      apiKey: "server-secret",
      endpoint: "https://trusted.openai.azure.com",
      deployment: "reasoning"
    });
    const response = await handler(new Request("https://example.com/api/generate", {
      method: "POST",
      body: JSON.stringify({
        product: { name: "Hydra Serum" },
        llm: { endpoint: "https://attacker.example" }
      })
    }));
    const payload = await response.json() as { error?: string };

    expect(response.status).toBe(400);
    expect(payload.error).toMatch(/server-managed API key/i);
  });
});
