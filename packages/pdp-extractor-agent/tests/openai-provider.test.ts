import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIKeywordClassifier } from "../src/llm/providers/openai";

describe("OpenAIKeywordClassifier image OCR", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends keyword classification RAG policy as instructions and evidence as user input", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({
        output_text: JSON.stringify({
          keywords: [
            {
              keyword: "피부 자생력",
              category: "benefit",
              confidence: 0.82,
              source: "llm"
            }
          ],
          summary: "classified"
        })
      }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const classifier = new OpenAIKeywordClassifier({
      provider: "openai",
      apiKey: "test-key",
      model: "gpt-5.4-mini"
    });
    const result = await classifier.classifyKeywords({
      source: "https://example.com/products/ginseng-cream",
      productName: "Ginseng Cream",
      analysisPrompt: "효능은 상품 가치 문장만 benefits로 분류합니다.",
      ragDocuments: [
        {
          name: "geo-classification-rules_v2.md",
          content: "혜택 적용가, 배송, 반품 문구는 상품 효능에서 제외합니다."
        }
      ],
      imageTexts: [
        {
          imageUrl: "https://example.com/products/ginseng-cream#section-1",
          text: "[효능] 피부 자생력과 고밀도 탄력을 지원합니다."
        }
      ]
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));

    expect(body.instructions).toContain("Runtime RAG profile");
    expect(body.instructions).toContain("geo-classification-rules_v2.md");
    expect(body.input).toContain("[효능] 피부 자생력과 고밀도 탄력을 지원합니다.");
    expect(body.input).not.toContain("geo-classification-rules_v2.md");
    expect(result.keywords[0]?.keyword).toBe("피부 자생력");
  });

  it("sends Responses image inputs without an unsupported detail field", async () => {
    const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({
        output_text: JSON.stringify({
          images: [
            {
              imageUrl: "https://example.com/detail.jpg",
              text: "AFTER 6 WEEKS OF USE\n100%"
            }
          ]
        })
      }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const classifier = new OpenAIKeywordClassifier({
      provider: "openai",
      apiKey: "test-key",
      model: "gpt-5.4-mini"
    });
    const result = await classifier.extractImageTexts({
      source: "https://example.com/products/serum",
      productName: "Serum",
      imageUrls: ["https://example.com/detail.jpg"]
    });
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const imagePart = body.input[0].content.find((part: { type: string }) => part.type === "input_image");

    expect(imagePart).toEqual({
      type: "input_image",
      image_url: "https://example.com/detail.jpg"
    });
    expect(result.images[0]?.text).toContain("AFTER 6 WEEKS");
  });

  it("falls back to a downloaded base64 data URL when remote image OCR is rejected", async () => {
    const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) => {
      const href = String(url);

      if (href === "https://api.openai.com/v1/responses") {
        const responseCallCount = fetchMock.mock.calls.filter(([calledUrl]) => String(calledUrl) === href).length;

        if (responseCallCount < 3) {
          return new Response(JSON.stringify({
            error: {
              message: "invalid image_url"
            }
          }), { status: 400 });
        }

        return new Response(JSON.stringify({
          output_text: JSON.stringify({
            images: [
              {
                imageUrl: "https://cdn.example.com/detail.jpg",
                text: "자음생크림\n인삼 안티에이징"
              }
            ]
          })
        }), { status: 200 });
      }

      return new Response(Buffer.from("fake-jpeg"), {
        status: 200,
        headers: { "Content-Type": "image/jpeg" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const classifier = new OpenAIKeywordClassifier({
      provider: "openai",
      apiKey: "test-key",
      model: "gpt-5.4-mini"
    });
    const result = await classifier.extractImageTexts({
      source: "https://example.com/products/serum",
      productName: "Serum",
      imageUrls: ["https://cdn.example.com/detail.jpg"]
    });
    const finalOpenAiCall = fetchMock.mock.calls
      .filter(([url]) => String(url) === "https://api.openai.com/v1/responses")
      .at(-1);
    const finalBody = JSON.parse(String(finalOpenAiCall?.[1]?.body));
    const finalImagePart = finalBody.input[0].content.find((part: { type: string }) => part.type === "input_image");

    expect(finalImagePart.image_url).toMatch(/^data:image\/jpeg;base64,/);
    expect(result.images[0]).toEqual({
      imageUrl: "https://cdn.example.com/detail.jpg",
      text: "자음생크림\n인삼 안티에이징"
    });
  });

  it("falls back to a downloaded base64 data URL when remote image OCR returns no text", async () => {
    const imageUrl = "https://cdn.example.com/detail-empty-first.jpg";
    let openAiCallCount = 0;
    const fetchMock = vi.fn(async (url: string | URL, _init?: RequestInit) => {
      const href = String(url);

      if (href === "https://api.openai.com/v1/responses") {
        openAiCallCount += 1;

        if (openAiCallCount <= 2) {
          return new Response(JSON.stringify({
            output_text: JSON.stringify({ images: [] })
          }), { status: 200 });
        }

        return new Response(JSON.stringify({
          output_text: JSON.stringify({
            images: [
              {
                imageUrl,
                text: "고밀도 세라마이드 캡슐\n피부 장벽 보습"
              }
            ]
          })
        }), { status: 200 });
      }

      return new Response(Buffer.from("fake-jpeg"), {
        status: 200,
        headers: { "Content-Type": "image/jpeg" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const classifier = new OpenAIKeywordClassifier({
      provider: "openai",
      apiKey: "test-key",
      model: "gpt-5.4-mini"
    });
    const result = await classifier.extractImageTexts({
      source: "https://example.com/products/toner",
      productName: "Toner",
      imageUrls: [imageUrl]
    });
    const finalOpenAiCall = fetchMock.mock.calls
      .filter(([url]) => String(url) === "https://api.openai.com/v1/responses")
      .at(-1);
    const finalBody = JSON.parse(String(finalOpenAiCall?.[1]?.body));
    const finalImagePart = finalBody.input[0].content.find((part: { type: string }) => part.type === "input_image");

    expect(finalImagePart.image_url).toMatch(/^data:image\/jpeg;base64,/);
    expect(result.images[0]).toEqual({
      imageUrl,
      text: "고밀도 세라마이드 캡슐\n피부 장벽 보습"
    });
  });
});
