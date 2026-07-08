import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  prepareImageOcrInputs,
  readImageDimensions,
  sliceDisplayUrl,
  stripSliceFragment
} from "../src/llm/providers/image-slicing";
import { extractProductFromHtml } from "../src/index";

async function createPng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 250, g: 250, b: 250 }
    }
  }).png().toBuffer();
}

function imageResponse(buffer: Buffer, contentType = "image/png"): Response {
  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: { "Content-Type": contentType }
  });
}

describe("readImageDimensions", () => {
  it("parses PNG and JPEG headers", async () => {
    const png = await createPng(320, 4800);
    expect(readImageDimensions(png)).toEqual({ width: 320, height: 4800 });

    const jpeg = await sharp(await createPng(200, 900)).jpeg().toBuffer();
    expect(readImageDimensions(jpeg)).toEqual({ width: 200, height: 900 });
  });

  it("parses GIF headers and rejects non-image bytes", () => {
    const gif = Buffer.concat([
      Buffer.from("GIF89a", "ascii"),
      Buffer.from([0x40, 0x01, 0xf4, 0x01, 0, 0, 0, 0])
    ]);
    expect(readImageDimensions(gif)).toEqual({ width: 320, height: 500 });
    expect(readImageDimensions(Buffer.from("not an image"))).toBeUndefined();
  });
});

describe("slice display URLs", () => {
  it("round-trips slice fragments", () => {
    const display = sliceDisplayUrl("https://cdn.example.com/pdp/detail.png", 3, 12);
    expect(display).toBe("https://cdn.example.com/pdp/detail.png#ocr-slice-3of12");
    expect(stripSliceFragment(display)).toBe("https://cdn.example.com/pdp/detail.png");
    expect(stripSliceFragment("https://cdn.example.com/pdp/detail.png#gallery")).toBe("https://cdn.example.com/pdp/detail.png#gallery");
  });
});

describe("prepareImageOcrInputs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("slices a tall scroll image into overlapping vertical segments", async () => {
    const imageUrl = "https://cdn.example.com/pdp/tall-detail.png";
    const tallPng = await createPng(200, 5000);
    const fetchMock = vi.fn(async () => imageResponse(tallPng));
    vi.stubGlobal("fetch", fetchMock);

    const prepared = await prepareImageOcrInputs(imageUrl);

    // step = 1400 * 0.85 = 1190px: tops 0/1190/2380/3570/4760 -> 5 slices
    expect(prepared.sliced).toBe(true);
    expect(prepared.inputs).toHaveLength(5);
    expect(prepared.inputs[0]?.displayUrl).toBe(`${imageUrl}#ocr-slice-1of5`);
    expect(prepared.inputs.every((input) => input.inputUrl.startsWith("data:image/jpeg;base64,"))).toBe(true);

    const firstSlice = await sharp(Buffer.from(prepared.inputs[0]!.inputUrl.split(",")[1]!, "base64")).metadata();
    const lastSlice = await sharp(Buffer.from(prepared.inputs[4]!.inputUrl.split(",")[1]!, "base64")).metadata();
    expect({ width: firstSlice.width, height: firstSlice.height }).toEqual({ width: 200, height: 1400 });
    expect({ width: lastSlice.width, height: lastSlice.height }).toEqual({ width: 200, height: 240 });
  });

  it("passes non-tall images through untouched", async () => {
    const imageUrl = "https://cdn.example.com/pdp/square-detail.png";
    const fetchMock = vi.fn(async () => imageResponse(await createPng(800, 1200)));
    vi.stubGlobal("fetch", fetchMock);

    const prepared = await prepareImageOcrInputs(imageUrl);

    expect(prepared.sliced).toBe(false);
    expect(prepared.inputs).toEqual([{ displayUrl: imageUrl, inputUrl: imageUrl }]);
  });

  it("passes through when the image cannot be probed", async () => {
    const imageUrl = "https://cdn.example.com/pdp/broken.png";
    const fetchMock = vi.fn(async () => new Response("not found", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const prepared = await prepareImageOcrInputs(imageUrl);

    expect(prepared.sliced).toBe(false);
    expect(prepared.inputs).toEqual([{ displayUrl: imageUrl, inputUrl: imageUrl }]);
  });
});

describe("tall image slicing through the extraction pipeline", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("OCRs slices as separate inputs and rejoins overlapping texts into one evidence block", async () => {
    const imageUrl = "https://cdn.example.com/pdp/technical-description/tall-detail.png";
    const tallPng = await createPng(200, 5000);

    // Five slice transcriptions; adjacent slices share a boundary line so the
    // overlap-aware merge can rejoin them into one continuous text.
    const boundary = (index: number) => `구간 ${index} 경계 문장으로 피부 보습 장벽 개선 결과를 설명합니다`;
    const sliceTexts = [
      ["고농축 세라마이드 캡슐 테크놀로지 소개", boundary(1)].join("\n"),
      [boundary(1), "히알루론산 보습 레이어 성분 설명", boundary(2)].join("\n"),
      [boundary(2), "임상시험 결과 피부 장벽 보습력이 32% 개선되었습니다", boundary(3)].join("\n"),
      [boundary(3), "민감 피부 대상 4주 사용 테스트를 완료했습니다", boundary(4)].join("\n"),
      [boundary(4), "아침 저녁 세안 후 적당량을 부드럽게 펴 바릅니다"].join("\n")
    ];

    const ocrImageParts: string[][] = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);

      if (href === imageUrl) {
        return imageResponse(tallPng);
      }

      if (href === "https://api.openai.com/v1/responses") {
        const body = JSON.parse(String(init?.body ?? "{}"));

        if (Array.isArray(body.input)) {
          const content = body.input[0]?.content ?? [];
          const displayUrls: string[] = content
            .filter((part: { type?: string; text?: string }) => part.type === "input_text" && /#ocr-slice-\d+of\d+$/.test(part.text?.split(": ").pop() ?? ""))
            .map((part: { text?: string }) => String(part.text).replace(/^Image \d+: /, ""));
          ocrImageParts.push(content
            .filter((part: { type?: string }) => part.type === "input_image")
            .map((part: { image_url?: string }) => String(part.image_url).slice(0, 30)));

          return new Response(JSON.stringify({
            output_text: JSON.stringify({
              images: displayUrls.map((displayUrl, index) => {
                const sliceNumber = Number(displayUrl.match(/#ocr-slice-(\d+)of\d+$/)?.[1] ?? 0);
                return {
                  index: index + 1,
                  imageUrl: displayUrl,
                  text: sliceTexts[sliceNumber - 1] ?? "",
                  confidence: 0.9
                };
              })
            })
          }), { status: 200 });
        }

        return new Response(JSON.stringify({
          output_text: JSON.stringify({ keywords: [], sentenceInsights: [], summary: "ok" })
        }), { status: 200 });
      }

      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result, diagnostics } = await extractProductFromHtml(
      `
        <main>
          <h1>Barrier Hydro Cream</h1>
          <section class="product-detail technical-description">
            <h2>Ingredients and effects</h2>
            <img data-src="${imageUrl}" alt="ingredient technology detail" />
          </section>
        </main>
      `,
      "https://brand.example.com/products/barrier-hydro-cream",
      { provider: "openai", apiKey: "test-key", model: "gpt-5-mini" }
    );

    const sentInputImages = ocrImageParts.flat();
    expect(sentInputImages).toHaveLength(5);
    expect(sentInputImages.every((inputUrl) => inputUrl.startsWith("data:image/jpeg"))).toBe(true);

    const geo = result.geoProduct as { ocr: { textBlocks: string[] }; sourceExtraction: { ocr: { imageTexts: Array<{ imageUrl: string }> } } };
    expect(geo.ocr.textBlocks).toHaveLength(1);
    const joined = geo.ocr.textBlocks[0] ?? "";
    expect(joined).toContain("고농축 세라마이드 캡슐 테크놀로지 소개");
    expect(joined).toContain("임상시험 결과 피부 장벽 보습력이 32% 개선되었습니다");
    expect(joined).toContain("아침 저녁 세안 후 적당량을 부드럽게 펴 바릅니다");
    expect(joined.match(/구간 2 경계 문장/g)).toHaveLength(1);
    expect(geo.sourceExtraction.ocr.imageTexts[0]?.imageUrl).toBe(imageUrl);
    expect(diagnostics.warnings.some((warning) => warning.code === "IMAGE_SLICING_UNAVAILABLE")).toBe(false);
  });
});
