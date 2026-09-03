import { describe, expect, it } from "vitest";
import { extractImageOcrEvidence } from "../src";
import { assembleImageOcrEvidence, buildImageOcrRuntimeUsage } from "../src/agent";
import type { OcrExtraction, RuntimePipelineStep } from "../src/types";

const IMG = "https://cdn.example.com/detail.png";

describe("assembleImageOcrEvidence", () => {
  it("assembles public blocks with image lineage from extracted texts", () => {
    const ocr: OcrExtraction = {
      imagesScanned: 1,
      extractedTexts: [{
        imageUrl: IMG,
        imageUrls: [IMG],
        text: "세라마이드 10,000ppm이 피부 장벽을 강화하고 보습력을 98% 개선합니다",
        confidence: 0.9,
        keywords: [{ keyword: "세라마이드", category: "ingredient", confidence: 0.9, source: "ocr" }],
        sentenceInsights: [{
          text: "세라마이드 10,000ppm이 피부 장벽을 강화하고 보습력을 98% 개선합니다",
          category: "benefit",
          keywords: ["세라마이드"],
          confidence: 0.9,
          source: "llm",
          imageUrls: [IMG],
          attribution: "declared"
        }]
      }]
    };
    const assembled = assembleImageOcrEvidence(ocr, {
      metricClaims: [{ sentence: "보습력을 98% 개선", sourceText: "보습력을 98% 개선", imageUrls: [IMG] }]
    }, [], "예시더마 모이베리어365 크림");

    expect(assembled.ocr.imageTexts).toEqual([
      { imageUrl: IMG, imageUrls: [IMG], text: ocr.extractedTexts[0]!.text, confidence: 0.9 }
    ]);
    expect(assembled.ocr.textBlocks).toEqual([ocr.extractedTexts[0]!.text]);
    expect(assembled.ocr.sentenceInsights[0]?.imageUrls).toEqual([IMG]);
    expect(assembled.ocr.semanticFacts?.metricClaims.some((claim) => claim.imageUrls?.[0] === IMG)).toBe(true);
    expect(assembled.keywords.ingredient).toContain("세라마이드");
  });
});

describe("buildImageOcrRuntimeUsage", () => {
  it("collapses steps sharing a label into one row with summed token usage", () => {
    const steps: RuntimePipelineStep[] = [
      {
        stage: "ocr",
        label: "OCR/structure extraction",
        called: true,
        tokenUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        details: "batch 1"
      },
      {
        stage: "ocr",
        label: "OCR/structure extraction",
        called: true,
        tokenUsage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 },
        details: "batch 2"
      }
    ];

    const usage = buildImageOcrRuntimeUsage(steps);

    expect(usage?.steps).toHaveLength(1);
    expect(usage?.steps[0]?.tokenUsage).toEqual({ inputTokens: 150, outputTokens: 30, totalTokens: 180 });
    expect(usage?.tokenTotals).toEqual({ inputTokens: 150, outputTokens: 30, totalTokens: 180 });
  });
});

describe("extractImageOcrEvidence", () => {
  it("returns a well-formed empty result with a provider warning under the mock provider", async () => {
    const result = await extractImageOcrEvidence(
      { source: "https://example.com/p/1", productName: "테스트", imageUrls: [IMG] },
      { provider: "mock" }
    );

    expect(result.ocr.imageTexts).toEqual([]);
    expect(result.ocr.textBlocks).toEqual([]);
    expect(result.diagnostics.warnings.some((warning) => warning.code === "IMAGE_OCR_PROVIDER_NOT_CONFIGURED")).toBe(true);
    expect(result.diagnostics.ocr?.provider).toBe("mock");
    expect(typeof result.generatedAt).toBe("string");
  });

  it("rejects non-http image urls with a warning instead of sending them", async () => {
    const result = await extractImageOcrEvidence(
      { source: "https://example.com/p/1", imageUrls: ["data:image/png;base64,AAAA", IMG] },
      { provider: "mock" }
    );
    expect(result.diagnostics.warnings.some((warning) => warning.code === "IMAGE_OCR_TARGET_SKIPPED")).toBe(true);
  });
});
