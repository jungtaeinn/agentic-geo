import { describe, expect, it } from "vitest";
import { generatePdpGeo } from "../src";

/**
 * OCR은 한 문장을 화면 폭에 맞춰 여러 줄로 끊어 보낸다. 줄바꿈은 시각적
 * 줄바꿈일 뿐인데, 줄 이어짐 판정을 내용 어휘 목록으로 하고 있어 목록에 없는
 * 낱말로 끝난 줄이 제목으로 읽혔다.
 *
 * 1027 실측(2026-09-03): 원문은 이렇게 줄이 끊겨 있다.
 *
 *   사용법 / 1 / 연약하고 건조해진 / 피부 부위에 미세 분사를 합니다. /
 *   2 / 피부에 건조함이 느껴질 때 / 수시로 뿌려줍니다.
 *
 * `연약하고 건조해진`이 제목으로 오판되어 뒤 줄과 마침표로 이어붙었고,
 * `연약하고 건조해진. 피부 부위에 미세 분사를 합니다.`라는 깨진 문장이
 * HowTo 1단계로 발행됐다. 2단계는 사라졌다.
 */
const USAGE_BLOCK = [
  "사용법",
  "1",
  "연약하고 건조해진",
  "피부 부위에 미세 분사를 합니다.",
  "2",
  "피부에 건조함이 느껴질 때",
  "수시로 뿌려줍니다."
].join("\n");

/**
 * 줄이 살아 있는 OCR 블록은 `sourceExtraction.ocr`로 들어온다. 그 경로에만
 * OCR 전용 문장 조립이 걸리므로, 시험도 실제 형태를 그대로 써야 한다.
 */
async function generateMist(ocrBlock: string) {
  const { result } = await generatePdpGeo({
    product: {
      geoProduct: {
        name: "모이베리어 365 크림 미스트",
        description: "건조하고 민감한 피부를 위한 크림 미스트입니다.",
        brand: "EXAMPLEDERMA",
        category: "미스트",
        benefits: ["보습"],
        ingredients: ["세라마이드"],
        usage: [],
        sourceExtraction: {
          ocr: {
            imageTexts: [{ imageUrl: "https://cdn.example.com/upload/product/1027_885_DSPIMG_L.png", text: ocrBlock, confidence: 0.93 }],
            textBlocks: [ocrBlock]
          }
        }
      }
    },
    source: { type: "pdp-extractor" as const, url: "https://shop.example.com/web/product/view.do?prdSeq=1027" },
    hints: { locale: "ko-KR" as const, market: "KR" as const }
  } as never);
  return result;
}

describe("OCR 줄바꿈과 문장 조립", () => {
  it("does not insert a period inside a wrapped Korean sentence", async () => {
    const result = await generateMist(USAGE_BLOCK);

    const usageAtoms = (result.diagnostics.evidenceLedger ?? [])
      .filter((atom) => atom.role === "usage")
      .map((atom) => atom.text);

    expect(usageAtoms.some((text) => text.includes("건조해진."))).toBe(false);
  });

  it("keeps both numbered usage steps from a line-wrapped block", async () => {
    const result = await generateMist(USAGE_BLOCK);

    const howToUse = result.content.sections.howToUse;
    expect(howToUse).toContain("연약하고 건조해진 피부 부위에 미세 분사");
    expect(howToUse).toContain("수시로 뿌려줍니다");
  });
});
