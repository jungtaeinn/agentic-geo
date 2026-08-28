import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiKeywordClassifier } from "../src/llm/providers/gemini";

function generateContentResponse(content: unknown, usageMetadata?: unknown): Response {
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: JSON.stringify(content) }] } }],
    ...(usageMetadata ? { usageMetadata } : {})
  }), { status: 200 });
}

describe("GeminiKeywordClassifier", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests structured JSON output with a responseSchema for keyword classification", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      generateContentResponse({
        keywords: [{ keyword: "피부 장벽", category: "benefit", confidence: 0.9 }],
        sentenceInsights: [],
        semanticFacts: {
          ingredients: [],
          benefits: ["피부 장벽 보습"],
          effects: [],
          skinTypes: [],
          usageSteps: [],
          metricClaims: [],
          evidenceSentences: [],
          ingredientBenefitLinks: []
        },
        summary: "classified"
      }, { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const classifier = new GeminiKeywordClassifier({
      provider: "gemini",
      apiKey: "gemini-key",
      model: "gemini-3-flash"
    });
    const result = await classifier.classifyKeywords({
      source: "https://example.com/products/cream",
      productName: "Cream",
      imageTexts: [{ imageUrl: "https://example.com/cream#1", text: "피부 장벽 보습 크림" }]
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}"));

    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema.type).toBe("OBJECT");
    expect(body.systemInstruction.parts[0].text).toContain("You classify product-detail-page OCR");
    expect(result.keywords[0]?.keyword).toBe("피부 장벽");
    expect(result.usage?.totalTokens).toBe(15);
  });

  it("downloads images and extracts text via inline base64 vision OCR", async () => {
    const imageUrl = "https://cdn.example.com/pdp/detail-long.png";
    const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) => {
      const href = String(url);

      if (href === imageUrl) {
        return new Response(Buffer.from("fake-png"), {
          status: 200,
          headers: { "Content-Type": "image/png" }
        });
      }

      return generateContentResponse({
        images: [
          {
            index: 1,
            imageUrl,
            text: "고농축 세라마이드 캡슐\n피부 장벽 보습 강화",
            confidence: 0.93
          }
        ]
      }, { promptTokenCount: 40, candidatesTokenCount: 12, totalTokenCount: 52 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const classifier = new GeminiKeywordClassifier({
      provider: "gemini",
      apiKey: "gemini-key",
      model: "gemini-3-flash"
    });
    const result = await classifier.extractImageTexts({
      source: "https://example.com/products/cream",
      productName: "Cream",
      imageUrls: [imageUrl]
    });
    const generateCall = fetchMock.mock.calls.find(([url]) => String(url).includes(":generateContent"));
    const body = JSON.parse(String(generateCall?.[1]?.body ?? "{}"));
    const inlinePart = body.contents[0].parts.find((part: { inline_data?: unknown }) => part.inline_data);

    expect(inlinePart.inline_data.mime_type).toBe("image/png");
    expect(inlinePart.inline_data.data).toBe(Buffer.from("fake-png").toString("base64"));
    expect(body.generationConfig.responseSchema.type).toBe("OBJECT");
    expect(result.images[0]).toEqual({
      imageUrl,
      text: "고농축 세라마이드 캡슐\n피부 장벽 보습 강화",
      confidence: 0.93
    });
    expect(result.usage?.totalTokens).toBe(52);
  });

  it("retries without responseSchema when the model rejects structured output", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: "Invalid JSON payload received. Unknown name \"response_schema\"" }
      }), { status: 400 }))
      .mockResolvedValueOnce(generateContentResponse({
        keywords: [{ keyword: "탄력", category: "effect", confidence: 0.8 }],
        summary: "classified"
      }));
    vi.stubGlobal("fetch", fetchMock);

    const classifier = new GeminiKeywordClassifier({
      provider: "gemini",
      apiKey: "gemini-key",
      model: "gemini-legacy"
    });
    const result = await classifier.classifyKeywords({
      source: "https://example.com/products/cream",
      imageTexts: [{ imageUrl: "https://example.com/cream#1", text: "탄력 개선 크림" }]
    });
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}"));
    const retryBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body ?? "{}"));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(firstBody.generationConfig.responseSchema).toBeDefined();
    expect(retryBody.generationConfig.responseSchema).toBeUndefined();
    expect(retryBody.generationConfig.responseMimeType).toBe("application/json");
    expect(result.keywords[0]?.keyword).toBe("탄력");
  });
});
