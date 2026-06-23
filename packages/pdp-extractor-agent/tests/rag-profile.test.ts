import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  createKeywordClassificationPrompt,
  createKeywordClassificationPromptParts
} from "../src/llm/prompt";
import {
  readProductExtractorRagProfile,
  resetProductExtractorRagProfile,
  writeProductExtractorRagProfile
} from "../src/rag/profile";
import {
  createProductExtractorRagQuery,
  retrieveProductExtractorRagDocuments
} from "../src/rag/retrieval";

describe("RAG profile synchronization", () => {
  it("injects runtime analysis prompt and RAG files into the LLM classification prompt", () => {
    const request = {
      source: "https://example.com/product",
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
          imageUrl: "https://example.com/product#section-1",
          text: "[효능] 피부 자생력과 고밀도 탄력을 지원합니다."
        }
      ]
    };
    const prompt = createKeywordClassificationPrompt(request);
    const promptParts = createKeywordClassificationPromptParts(request);

    expect(prompt).toContain("효능은 상품 가치 문장만 benefits로 분류합니다.");
    expect(prompt).toContain("geo-classification-rules_v2.md");
    expect(prompt).toContain("혜택 적용가, 배송, 반품 문구는 상품 효능에서 제외합니다.");
    expect(prompt).toContain("[효능] 피부 자생력과 고밀도 탄력을 지원합니다.");
    expect(promptParts.system).toContain("Runtime RAG profile");
    expect(promptParts.system).toContain("효능은 상품 가치 문장만 benefits로 분류합니다.");
    expect(promptParts.system).toContain("geo-classification-rules_v2.md");
    expect(promptParts.system).not.toContain("[효능] 피부 자생력과 고밀도 탄력을 지원합니다.");
    expect(promptParts.user).toContain("[효능] 피부 자생력과 고밀도 탄력을 지원합니다.");
    expect(promptParts.user).not.toContain("geo-classification-rules_v2.md");
  });

  it("reads, writes, and resets package-managed RAG profile files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentic-geo-rag-"));
    const resetProfile = await resetProductExtractorRagProfile(directory);

    expect(resetProfile.analysisPrompt).toContain("상품 상세 페이지");
    expect(resetProfile.documents.some((document) => document.name === "product-normalization_v1.md")).toBe(true);

    const writtenProfile = await writeProductExtractorRagProfile({
      analysisPrompt: "커스텀 분석 프롬프트",
      documents: [
        ...resetProfile.documents.map((document) => ({
          name: document.name,
          version: document.version,
          content: document.content
        })),
        {
          name: "amoremall-field-rules.md",
          version: "v1",
          content: "혜택 적용가는 benefits가 아닙니다."
        }
      ]
    }, directory);

    expect(writtenProfile.analysisPrompt).toBe("커스텀 분석 프롬프트\n");
    expect(writtenProfile.documents.some((document) => document.path === "custom/amoremall-field-rules_v1.md")).toBe(true);

    const rereadProfile = await readProductExtractorRagProfile(directory);
    expect(rereadProfile.documents.some((document) => document.content.includes("혜택 적용가는 benefits가 아닙니다."))).toBe(true);
  });

  it("retrieves RAG policy chunks with product evidence instead of attaching full files blindly", async () => {
    const query = createProductExtractorRagQuery({
      source: "https://example.com/product",
      productName: "Hydra Barrier Cream",
      imageTexts: [
        {
          imageUrl: "https://example.com/product#section-1",
          text: "[How to Use] Apply morning and night after toner."
        },
        {
          imageUrl: "https://example.com/product#section-2",
          text: "[Coupon] Delivery and exchange notices are not product benefits."
        }
      ]
    });
    const retrieved = await retrieveProductExtractorRagDocuments({
      query,
      documents: [
        {
          name: "ocr-policy.md",
          content: [
            "# OCR Policy",
            "",
            "Classify usage instructions, benefits, ingredients, and sentence-level OCR evidence.",
            "Exclude cart, coupon, delivery, exchange, refund, legal, and page chrome text from product benefit fields."
          ].join("\n")
        },
        {
          name: "unrelated.md",
          content: "# Brand Voice\n\nUse short copy."
        }
      ],
      settings: {
        maxChunks: 1,
        scoreThreshold: 0
      }
    });

    expect(retrieved).toHaveLength(1);
    expect(retrieved[0]?.sourceDocument).toBe("ocr-policy.md");
    expect(retrieved[0]?.content).toContain("Retrieved RAG policy chunk");
    expect(retrieved[0]?.content).toContain("Exclude cart, coupon, delivery");
  });
});
