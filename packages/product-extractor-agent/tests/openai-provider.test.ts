import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIKeywordClassifier } from "../src/llm/providers/openai";

describe("OpenAIKeywordClassifier image OCR", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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
});
