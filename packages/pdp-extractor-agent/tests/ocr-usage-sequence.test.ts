import { describe, expect, it } from "vitest";
import { extractProductFromHtml } from "../src";

// Real merged OCR blob shape from https://shop.example.com/web/product/view.do?prdSeq=1027
// (editor detail image, 7 slices joined): package label noise + "사용법 1 ... 2 ..." sequence.
const mergedUsageBlob = "크림 Step 5 모이베리어365 크림 미스트 EXAMPLEDERMA BARRIERCARE 365 CREAM MIST Ceramide 10,000 ppm Moisturizing & strengthening skin's moisture barrier For dry & weakened skin 4.05 fl.oz / 120 mL 사용법 1 연약하고 건조해진 피부 부위에 미세 분사를 합니다. 2 피부에 건조함이 느껴질 때 수시로 뿌려줍니다. EXAMPLEDERMA BARRIERCARE 365 CREAM MIST Ceramide 10,000 ppm Moisturizing & strengthening skin's moisture barrier For dry & weakened skin 4.05 fl.oz / 120 mL 철저히 검증한 피부 안전성 테스트";

const html = `
<!doctype html>
<html>
  <head>
    <title>모이베리어 365 크림 미스트</title>
    <meta name="description" content="10,000ppm 함유된 고함량 세라마이드 미세분사로 피부장벽을 보호하는" />
  </head>
  <body>
    <main>
      <h1>모이베리어 365 크림 미스트</h1>
      <img src="https://image.example.com/upload/editor/detail.png" data-ocr-text="${mergedUsageBlob}" />
    </main>
  </body>
</html>
`;

describe("explicit numbered usage sequence rescue from merged OCR blocks", () => {
  it("extracts spray-type usage steps with their explicit source numbering preserved", async () => {
    const { result } = await extractProductFromHtml(html, "https://shop.example.com/web/product/view.do?prdSeq=1027");
    const usage = result.geoProduct.usage;

    const firstIndex = usage.findIndex((text: string) => /^1[.)]\s*연약하고 건조해진 피부 부위에 미세 분사를 합니다/.test(text));
    const secondIndex = usage.findIndex((text: string) => /^2[.)]\s*피부에 건조함이 느껴질 때 수시로 뿌려줍니다/.test(text));

    expect(firstIndex).toBeGreaterThanOrEqual(0);
    expect(secondIndex).toBeGreaterThan(firstIndex);
    // Package label noise around the sequence must not leak into usage.
    expect(usage.some((text: string) => text.includes("CREAM MIST"))).toBe(false);
  });

  it("keeps the numbered steps as usage sentence insights in source order", async () => {
    const { result } = await extractProductFromHtml(html, "https://shop.example.com/web/product/view.do?prdSeq=1027");
    const usageSteps = result.geoProduct.semanticFacts?.usageSteps ?? [];

    expect(usageSteps.some((text: string) => /^1[.)]\s*연약하고/.test(text))).toBe(true);
    expect(usageSteps.some((text: string) => /^2[.)]\s*피부에 건조함/.test(text))).toBe(true);
  });
});
