import { afterEach, describe, expect, it, vi } from "vitest";
import { createPdpGeoGeneratorRestHandler } from "../src/rest";

describe("createPdpGeoGeneratorRestHandler", () => {
  afterEach(() => vi.restoreAllMocks());
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
    expect(payload.results[0]?.content.html).toBe("");
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

  it("rejects a same-origin different-path endpoint when it would reuse a server-managed key", async () => {
    const handler = createPdpGeoGeneratorRestHandler({
      provider: "aistudio",
      apiKey: "server-secret",
      endpoint: "https://models.example/tenant-a/agent",
      deployment: "reasoning"
    });
    const response = await handler(new Request("https://example.com/api/generate", {
      method: "POST",
      body: JSON.stringify({
        product: { name: "Hydra Serum" },
        llm: { endpoint: "https://models.example/tenant-b/agent" }
      })
    }));
    const payload = await response.json() as { error?: string };

    expect(response.status).toBe(400);
    expect(payload.error).toMatch(/configured provider endpoint/i);
  });

  it("forwards the independent finalProofreading configuration through the REST adapter", async () => {
    let called = false;
    const handler = createPdpGeoGeneratorRestHandler({
      finalProofreading: { enabled: true, provider: "custom" },
      customFinalProofreader: {
        proofread(request) {
          called = true;
          return {
            edits: request.fields.map((field) => ({
              fieldPath: field.fieldPath,
              sourceHash: field.sourceHash,
              action: "keep" as const,
              revisedText: field.text,
              issueCodes: []
            })),
            warnings: []
          };
        }
      }
    });
    const response = await handler(new Request("https://example.com/api/generate", {
      method: "POST",
      body: JSON.stringify({
        product: {
          name: "Hydra Serum",
          description: "A serum for dry skin.",
          usage: ["Step 1: Apply Hydra Serum to clean skin.", "Step 2: Press gently until absorbed."]
        },
        hints: { locale: "en-US" }
      })
    }));
    const payload = await response.json() as {
      results: Array<{ diagnostics?: { finalProofreading?: { called?: boolean } } }>;
    };

    expect(response.status).toBe(200);
    expect(called).toBe(true);
    expect(payload.results[0]?.diagnostics?.finalProofreading?.called).toBe(true);
  });

  it("rejects a finalProofreading endpoint override that would reuse a server-managed key", async () => {
    const handler = createPdpGeoGeneratorRestHandler({
      provider: "azure-openai",
      apiKey: "server-secret",
      endpoint: "https://trusted.openai.azure.com",
      finalProofreading: {
        enabled: true,
        provider: "azure-openai",
        endpoint: "https://trusted.openai.azure.com",
        deployment: "gpt-5.5"
      }
    });
    const response = await handler(new Request("https://example.com/api/generate", {
      method: "POST",
      body: JSON.stringify({
        product: { name: "Hydra Serum" },
        finalProofreading: { endpoint: "https://attacker.example" }
      })
    }));
    const payload = await response.json() as { error?: string };

    expect(response.status).toBe(400);
    expect(payload.error).toMatch(/finalProofreading\.endpoint.*server-managed API key/i);
  });

  it("rejects a finalProofreading provider override that would reuse another provider's server key", async () => {
    const handler = createPdpGeoGeneratorRestHandler({
      provider: "azure-openai",
      apiKey: "azure-server-secret",
      endpoint: "https://trusted.openai.azure.com",
      finalProofreading: {
        enabled: true,
        provider: "azure-openai",
        deployment: "gpt-5.5"
      }
    });
    const response = await handler(new Request("https://example.com/api/generate", {
      method: "POST",
      body: JSON.stringify({
        product: { name: "Hydra Serum" },
        finalProofreading: { provider: "gemini", model: "gemini-test" }
      })
    }));
    const payload = await response.json() as { error?: string };

    expect(response.status).toBe(400);
    expect(payload.error).toMatch(/finalProofreading\.provider.*server-managed API key/i);
  });

  it("does not treat llm.apiKey as a final-proofreading key when the requested providers differ", async () => {
    const handler = createPdpGeoGeneratorRestHandler();
    const response = await handler(new Request("https://example.com/api/generate", {
      method: "POST",
      body: JSON.stringify({
        product: { name: "Hydra Serum" },
        llm: { provider: "azure-openai", apiKey: "azure-request-key" },
        finalProofreading: { enabled: true, provider: "gemini", model: "gemini-test" }
      })
    }));
    const payload = await response.json() as { error?: string };

    expect(response.status).toBe(400);
    expect(payload.error).toMatch(/requires its own API key/i);
  });

  it("requires provider-specific keys for every pre-proofreading model stage", async () => {
    const handler = createPdpGeoGeneratorRestHandler({
      provider: "azure-openai",
      apiKey: "azure-server-secret",
      endpoint: "https://trusted.openai.azure.com",
      deployment: "azure-reasoning"
    });
    for (const stage of ["productNormalization", "keywordNormalization", "contentPlanning", "copyRefinement"] as const) {
      const response = await handler(new Request("https://example.com/api/generate", {
        method: "POST",
        body: JSON.stringify({
          product: { name: "Hydra Serum" },
          [stage]: {
            enabled: true,
            provider: stage === "keywordNormalization" ? "aistudio" : "gemini",
            endpoint: stage === "keywordNormalization" ? "https://attacker.example/agent" : undefined,
            model: "foreign-model"
          }
        })
      }));
      const payload = await response.json() as { error?: string };
      expect(response.status, stage).toBe(400);
      expect(payload.error, stage).toMatch(/server-managed API key|requires its own API key/i);
    }
  });

  it("uses the request key rather than a configured server key when a finalProofreading endpoint is overridden", async () => {
    let seenApiKey = "";
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seenApiKey = headers.get("api-key") ?? "";
      const body = JSON.parse(String(init?.body)) as { messages?: Array<{ role?: string; content?: string }> };
      const user = body.messages?.find((message) => message.role === "user")?.content ?? "{}";
      const fields = (JSON.parse(user) as { fields?: Array<{ fieldPath: string; sourceHash: string; text: string }> }).fields ?? [];
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          edits: fields.map((field) => ({
            fieldPath: field.fieldPath,
            sourceHash: field.sourceHash,
            action: "keep",
            revisedText: field.text,
            issueCodes: []
          })),
          warnings: []
        }) } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const handler = createPdpGeoGeneratorRestHandler({
      provider: "mock",
      finalProofreading: {
        enabled: true,
        provider: "azure-openai",
        apiKey: "server-secret",
        endpoint: "https://trusted.openai.azure.com",
        deployment: "gpt-5.5"
      }
    });
    const response = await handler(new Request("https://example.com/api/generate", {
      method: "POST",
      body: JSON.stringify({
        product: {
          name: "Hydra Serum",
          description: "A serum for dry skin.",
          usage: ["Step 1: Apply Hydra Serum to clean skin.", "Step 2: Press gently until absorbed."]
        },
        finalProofreading: {
          endpoint: "https://request-owned.openai.azure.com",
          apiKey: "request-secret"
        }
      })
    }));

    expect(response.status).toBe(200);
    expect(seenApiKey).toBe("request-secret");
  });

  it("keeps an implicit final provider aligned with the request provider and never sends its key to a foreign endpoint", async () => {
    const seenUrls: string[] = [];
    let seenGoogleKey = "";
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      seenUrls.push(String(url));
      seenGoogleKey = new Headers(init?.headers).get("x-goog-api-key") ?? "";
      const body = JSON.parse(String(init?.body)) as { contents?: Array<{ parts?: Array<{ text?: string }> }> };
      const user = body.contents?.[0]?.parts?.[0]?.text ?? "{}";
      const fields = (JSON.parse(user) as { fields?: Array<{ fieldPath: string; sourceHash: string; text: string }> }).fields ?? [];
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify({
          edits: fields.map((field) => ({
            fieldPath: field.fieldPath,
            sourceHash: field.sourceHash,
            action: "keep",
            revisedText: field.text,
            issueCodes: []
          })),
          warnings: []
        }) }] } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const handler = createPdpGeoGeneratorRestHandler({
      provider: "azure-openai",
      apiKey: "azure-server-secret",
      endpoint: "https://trusted.openai.azure.com",
      deployment: "azure-reasoning"
    });
    const response = await handler(new Request("https://example.com/api/generate", {
      method: "POST",
      body: JSON.stringify({
        product: { name: "Hydra Serum", usage: ["Apply Hydra Serum to clean skin."] },
        llm: { provider: "gemini", apiKey: "gemini-request-key", model: "gemini-test" },
        finalProofreading: {
          enabled: true,
          endpoint: "https://attacker.example/foreign-agent",
          deployment: "evil"
        }
      })
    }));

    expect(response.status).toBe(200);
    expect(seenUrls.length).toBeGreaterThan(0);
    expect(seenUrls.every((url) => url.includes("generativelanguage.googleapis.com"))).toBe(true);
    expect(seenUrls.every((url) => !url.includes("attacker.example"))).toBe(true);
    expect(seenGoogleKey).toBe("gemini-request-key");
  });
});
