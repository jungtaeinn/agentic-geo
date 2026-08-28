import { describe, expect, it } from "vitest";
import { createKeywordClassificationPromptParts } from "../src/llm/prompt";

describe("OCR transcription confidence propagation", () => {
  const baseRequest = {
    source: "https://example.com/product",
    productName: "Capsule Toner",
    imageTexts: [
      {
        imageUrl: "https://example.com/detail.png#ocr-slice-4of10",
        text: "사용 3일 후 320 사용 7일 후 200",
        confidence: 0.42
      },
      {
        imageUrl: "https://example.com/detail.png#ocr-slice-1of10",
        text: "세안 후 약해진 피부장벽을 강화하는 장벽보습 캡슐 토너"
      }
    ]
  };

  it("annotates each evidence block with its transcription confidence when available", () => {
    const promptParts = createKeywordClassificationPromptParts(baseRequest);

    expect(promptParts.user).toContain("Evidence 1 (transcription confidence: 0.42)");
    expect(promptParts.user).toContain("Evidence 2:");
    expect(promptParts.user).not.toContain("Evidence 2 (transcription confidence");
  });

  it("instructs the classifier to treat low-confidence numeric evidence as unreliable", () => {
    const promptParts = createKeywordClassificationPromptParts(baseRequest);

    expect(promptParts.system).toContain("transcription confidence");
    expect(promptParts.system).toMatch(/metricClaims/);
  });
});
