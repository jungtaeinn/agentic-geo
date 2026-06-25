import { afterEach, describe, expect, it, vi } from "vitest";
import { AistudioKeywordClassifier } from "../src/llm/providers/aistudio";

function chatCompletionResponse(content: unknown): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(content) } }]
  }), { status: 200 });
}

function chatCompletionResponseWithUsage(content: unknown, usage: unknown): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(content) } }],
    usage
  }), { status: 200 });
}

function unsupportedTemperatureResponse(): Response {
  return new Response(JSON.stringify({
    error: {
      message: "Unsupported value: 'temperature' does not support 0.0 with this model. Only the default (1) value is supported.",
      type: "invalid_request_error",
      param: "temperature",
      code: "unsupported_value"
    }
  }), { status: 400 });
}

describe("AistudioKeywordClassifier", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls the Azure-style deployment path with Bearer auth and omits api-version when unset", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      chatCompletionResponse({
        keywords: [{ keyword: "탄력", category: "benefit", confidence: 0.8, source: "llm" }],
        summary: "classified"
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const classifier = new AistudioKeywordClassifier({
      provider: "aistudio",
      apiKey: "studio-key",
      endpoint: "https://dev-aistudio.example.com:8082/v1/agent/abc",
      deployments: { reasoning: "gpt-5.5" }
    });
    const result = await classifier.classifyKeywords({
      source: "https://example.com/products/cream",
      productName: "Cream",
      imageTexts: [{ imageUrl: "https://example.com/cream#1", text: "[효능] 탄력 지원" }]
    });

    const [calledUrl, init] = fetchMock.mock.calls[0]!;
    expect(String(calledUrl)).toBe("https://dev-aistudio.example.com:8082/v1/agent/abc/openai/deployments/gpt-5.5/chat/completions");
    expect(String(calledUrl)).not.toContain("api-version");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer studio-key");
    expect(headers["api-key"]).toBeUndefined();
    expect(result.keywords[0]?.keyword).toBe("탄력");
  });

  it("omits temperature from the request body when unset so gpt-5.5 is not rejected", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      chatCompletionResponse({ keywords: [], summary: "ok" })
    );
    vi.stubGlobal("fetch", fetchMock);

    const classifier = new AistudioKeywordClassifier({
      provider: "aistudio",
      apiKey: "studio-key",
      endpoint: "https://dev-aistudio.example.com:8082/v1/agent/abc",
      deployments: { reasoning: "gpt-5.5" }
    });
    await classifier.classifyKeywords({
      source: "https://example.com/products/cream",
      imageTexts: [{ imageUrl: "https://example.com/cream#1", text: "내용" }]
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    expect("temperature" in body).toBe(false);
  });

  it("includes temperature in the request body only when explicitly configured", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      chatCompletionResponse({ keywords: [], summary: "ok" })
    );
    vi.stubGlobal("fetch", fetchMock);

    const classifier = new AistudioKeywordClassifier({
      provider: "aistudio",
      apiKey: "studio-key",
      endpoint: "https://dev-aistudio.example.com:8082/v1/agent/abc",
      deployments: { reasoning: "gpt-5.5" },
      temperature: 0.1
    });
    await classifier.classifyKeywords({
      source: "https://example.com/products/cream",
      imageTexts: [{ imageUrl: "https://example.com/cream#1", text: "내용" }]
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    expect(body.temperature).toBe(0.1);
  });

  it("retries chat completions without temperature when the deployment only accepts the default", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(unsupportedTemperatureResponse())
      .mockResolvedValueOnce(chatCompletionResponseWithUsage(
        {
          keywords: [{ keyword: "firmness", category: "benefit", confidence: 0.8, source: "llm" }],
          summary: "ok"
        },
        {
          input_tokens: 11,
          output_tokens: 7
        }
      ));
    vi.stubGlobal("fetch", fetchMock);

    const classifier = new AistudioKeywordClassifier({
      provider: "aistudio",
      apiKey: "studio-key",
      endpoint: "https://dev-aistudio.example.com:8082/v1/agent/abc",
      deployments: { reasoning: "gpt-5.5" },
      temperature: 0
    });
    const result = await classifier.classifyKeywords({
      source: "https://example.com/products/cream",
      imageTexts: [{ imageUrl: "https://example.com/cream#1", text: "firming serum" }]
    });

    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}")) as Record<string, unknown>;
    const retryBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body ?? "{}")) as Record<string, unknown>;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(firstBody.temperature).toBe(0);
    expect("temperature" in retryBody).toBe(false);
    expect(result.keywords[0]?.keyword).toBe("firmness");
    expect(result.usage?.inputTokens).toBe(11);
    expect(result.usage?.outputTokens).toBe(7);
    expect(result.usage?.totalTokens).toBe(18);
  });

  it("retries image OCR without temperature when the deployment only accepts the default", async () => {
    const imageUrl = "https://example.com/detail.jpg";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(unsupportedTemperatureResponse())
      .mockResolvedValueOnce(chatCompletionResponseWithUsage(
        {
          images: [{ imageUrl, text: "Ginseng Peptide supports visible firmness." }]
        },
        {
          input_tokens: 20,
          output_tokens: 6
        }
      ));
    vi.stubGlobal("fetch", fetchMock);

    const classifier = new AistudioKeywordClassifier({
      provider: "aistudio",
      apiKey: "studio-key",
      endpoint: "https://dev-aistudio.example.com:8082/v1/agent/abc",
      deployments: { ocr: "gpt-5.5" },
      temperature: 0
    });
    const result = await classifier.extractImageTexts?.({
      source: "https://example.com/products/serum",
      productName: "Serum",
      imageUrls: [imageUrl]
    });

    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}")) as Record<string, unknown>;
    const retryBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body ?? "{}")) as Record<string, unknown>;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(firstBody.temperature).toBe(0);
    expect("temperature" in retryBody).toBe(false);
    expect(result?.images[0]?.text).toContain("Ginseng Peptide");
    expect(result?.usage?.totalTokens).toBe(26);
  });

  it("appends api-version only when explicitly provided", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      chatCompletionResponse({ keywords: [], summary: "ok" })
    );
    vi.stubGlobal("fetch", fetchMock);

    const classifier = new AistudioKeywordClassifier({
      provider: "aistudio",
      apiKey: "studio-key",
      endpoint: "https://dev-aistudio.example.com:8082/v1/agent/abc/",
      apiVersion: "2024-10-21",
      deployments: { reasoning: "gpt-5.5" }
    });
    await classifier.classifyKeywords({
      source: "https://example.com/products/cream",
      imageTexts: [{ imageUrl: "https://example.com/cream#1", text: "내용" }]
    });

    const [calledUrl] = fetchMock.mock.calls[0]!;
    expect(String(calledUrl)).toBe("https://dev-aistudio.example.com:8082/v1/agent/abc/openai/deployments/gpt-5.5/chat/completions?api-version=2024-10-21");
  });
});
