import { describe, expect, it } from "vitest";
import { extractProductFromHtml } from "../src";
import { joinSliceCandidates, mergeOcrCandidates, type OcrTextCandidate } from "../src/agent";
import { keywordClassificationJsonSchema } from "../src/llm/schemas";
import { createKeywordClassificationPromptParts } from "../src/prompts/keyword-classification";
import { MockKeywordClassifier } from "../src/llm/providers/mock";

const IMG = "https://cdn.example.com/detail.png";

describe("joinSliceCandidates", () => {
  it("joins adjacent slices in slice order even when overlap text does not match", () => {
    const candidates: OcrTextCandidate[] = [
      { imageUrl: IMG, text: "세라마이드 10,000ppm 함유", sliceIndex: 1, sliceCount: 3, confidence: 0.9, sourceOrder: 0 },
      { imageUrl: IMG, text: "피부 장벽을 강화합니다", sliceIndex: 2, sliceCount: 3, confidence: 0.8, sourceOrder: 0 },
      { imageUrl: IMG, text: "사용법 1 아침 저녁 도포", sliceIndex: 3, sliceCount: 3, confidence: 0.95, sourceOrder: 0 }
    ];
    const joined = joinSliceCandidates(candidates);

    expect(joined).toHaveLength(1);
    expect(joined[0]?.text).toBe("세라마이드 10,000ppm 함유\n피부 장벽을 강화합니다\n사용법 1 아침 저녁 도포");
    expect(joined[0]?.imageUrl).toBe(IMG);
    expect(joined[0]?.imageUrls).toEqual([IMG]);
    expect(joined[0]?.confidence).toBe(0.8);
    expect(joined[0]?.sliceIndex).toBeUndefined();
    expect(joined[0]?.sliceCount).toBe(3);
    expect(joined[0]?.sourceOrder).toBe(0);
  });

  it("prefers overlap-aware joining when the boundary text repeats", () => {
    const overlap = "이 문장은 슬라이스 경계에 걸쳐 양쪽 모두에 등장하는 스무 자 이상의 문장입니다";
    const candidates: OcrTextCandidate[] = [
      { imageUrl: IMG, text: `첫 슬라이스 본문\n${overlap}`, sliceIndex: 1, sliceCount: 2 },
      { imageUrl: IMG, text: `${overlap}\n둘째 슬라이스 본문`, sliceIndex: 2, sliceCount: 2 }
    ];
    const joined = joinSliceCandidates(candidates);

    expect(joined).toHaveLength(1);
    expect(joined[0]?.text).toBe(`첫 슬라이스 본문\n${overlap}\n둘째 슬라이스 본문`);
  });

  it("sorts out-of-order slices before joining and passes non-sliced candidates through", () => {
    const other: OcrTextCandidate = { imageUrl: "https://cdn.example.com/other.png", text: "다른 이미지 텍스트", sourceOrder: 1 };
    const candidates: OcrTextCandidate[] = [
      { imageUrl: IMG, text: "두번째 조각", sliceIndex: 2, sliceCount: 2, sourceOrder: 0 },
      other,
      { imageUrl: IMG, text: "첫번째 조각", sliceIndex: 1, sliceCount: 2, sourceOrder: 0 }
    ];
    const joined = joinSliceCandidates(candidates);

    expect(joined).toHaveLength(2);
    expect(joined[0]?.text).toBe("첫번째 조각\n두번째 조각");
    expect(joined[1]).toEqual(other);
  });
});

describe("mergeOcrCandidates lineage and ordering", () => {
  it("unions imageUrls when a duplicate from another image is absorbed", () => {
    const text = "세라마이드 10,000ppm이 피부 장벽을 강화하고 수분을 지켜줍니다";
    const merged = mergeOcrCandidates([
      { imageUrl: "https://cdn.example.com/a.png", text, sourceOrder: 0 },
      { imageUrl: "https://cdn.example.com/b.png", text, sourceOrder: 1 }
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.imageUrl).toBe("https://cdn.example.com/a.png");
    expect(merged[0]?.imageUrls).toEqual([
      "https://cdn.example.com/a.png",
      "https://cdn.example.com/b.png"
    ]);
  });

  it("keeps page reading order after capping by score", () => {
    // 점수가 낮은 짧은 텍스트가 첫 번째(sourceOrder 0), 높은 근거성 텍스트가 뒤(sourceOrder 1,2).
    const merged = mergeOcrCandidates(
      [
        { imageUrl: "https://cdn.example.com/1.png", text: "브랜드 로고", sourceOrder: 0 },
        { imageUrl: "https://cdn.example.com/2.png", text: "세라마이드 10,000ppm 함유로 피부 장벽 개선 효과 시험 완료", sourceOrder: 1 },
        { imageUrl: "https://cdn.example.com/3.png", text: "사용법 1 아침 저녁 얼굴에 도포합니다 2 건조 부위에 덧바릅니다", sourceOrder: 2 }
      ],
      undefined,
      2
    );

    expect(merged).toHaveLength(2);
    // 상한 선별은 점수 기준이지만, 반환 순서는 페이지 읽기 순서를 유지해야 한다.
    expect(merged.map((item) => item.sourceOrder)).toEqual([1, 2]);
  });

  it("clears sliceIndex (but keeps same-image sliceCount) when overlap-joining two slice candidates", () => {
    const overlap = "이 문장은 슬라이스 경계에 걸쳐 양쪽 모두에 등장하는 스무 자 이상의 문장입니다";
    const merged = mergeOcrCandidates([
      { imageUrl: IMG, text: `첫 슬라이스 본문\n${overlap}`, sliceIndex: 1, sliceCount: 2, sourceOrder: 0 },
      { imageUrl: IMG, text: `${overlap}\n둘째 슬라이스 본문`, sliceIndex: 2, sliceCount: 2, sourceOrder: 0 }
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.text).toBe(`첫 슬라이스 본문\n${overlap}\n둘째 슬라이스 본문`);
    // 조인된 텍스트는 더 이상 "하나의" 슬라이스가 아니므로 sliceIndex는 사라져야 한다.
    expect(merged[0]?.sliceIndex).toBeUndefined();
    // 같은 이미지에서 나온 조인이므로 sliceCount(총 조각 수)는 유지된다.
    expect(merged[0]?.sliceCount).toBe(2);
  });
});

describe("evidenceIndex classification contract", () => {
  it("requires evidenceIndex on sentence insights and semantic fact claims", () => {
    const insightProps = (keywordClassificationJsonSchema.properties.sentenceInsights.items as any);
    expect(insightProps.properties).toHaveProperty("evidenceIndex");
    expect(insightProps.required).toContain("evidenceIndex");

    const facts = (keywordClassificationJsonSchema.properties.semanticFacts.properties as any);
    for (const key of ["metricClaims", "ingredientBenefitLinks", "citations"] as const) {
      expect(facts[key].items.properties).toHaveProperty("evidenceIndex");
      expect(facts[key].items.required).toContain("evidenceIndex");
    }
  });

  it("instructs the model to echo the evidence number in the system prompt", () => {
    const prompt = createKeywordClassificationPromptParts({
      source: "https://example.com",
      productName: "테스트 크림",
      imageTexts: [{ imageUrl: "https://cdn.example.com/a.png", text: "세라마이드 함유" }]
    });
    expect(prompt.system).toMatch(/evidenceIndex/);
    expect(prompt.system).toMatch(/Evidence/);
  });

  it("mock classifier declares the 1-based evidence index per source text", async () => {
    const classifier = new MockKeywordClassifier();
    const response = await classifier.classifyKeywords({
      source: "https://example.com",
      productName: "테스트 크림",
      imageTexts: [
        { imageUrl: "https://cdn.example.com/a.png", text: "세라마이드 10,000ppm이 피부 장벽을 강화합니다" },
        { imageUrl: "https://cdn.example.com/b.png", text: "사용법 1 아침 저녁 얼굴에 도포합니다" }
      ]
    });

    const insights = response.sentenceInsights ?? [];
    expect(insights.length).toBeGreaterThan(0);
    for (const insight of insights) {
      expect(insight.evidenceIndex === 1 || insight.evidenceIndex === 2).toBe(true);
    }
    const barrier = insights.find((item) => item.text.includes("장벽"));
    const usage = insights.find((item) => item.text.includes("도포"));
    expect(barrier?.evidenceIndex).toBe(1);
    expect(usage?.evidenceIndex).toBe(2);
  });
});

const relationHtml = `
<!doctype html>
<html>
  <head><title>모이베리어 365 크림</title></head>
  <body>
    <main>
      <h1>모이베리어 365 크림</h1>
      <img src="https://cdn.example.com/ingredient.png" data-ocr-text="세라마이드 10,000ppm이 피부 장벽을 강화하고 보습력을 98% 개선합니다" />
      <img src="https://cdn.example.com/usage.png" data-ocr-text="사용법 1 아침 저녁 세안 후 얼굴에 도포합니다 2 건조 부위에 수시로 덧바릅니다" />
    </main>
  </body>
</html>
`;

/**
 * 두 이미지가 같은 어휘(피부·장벽·세라마이드)를 공유해, 선언이 없으면 두 번째 이미지의 문장이
 * 첫 번째 이미지로 퍼지 귀속되는 fixture.
 */
const overlappingHtml = `
<!doctype html>
<html>
  <head><title>모이베리어 365 크림</title></head>
  <body>
    <main>
      <h1>모이베리어 365 크림</h1>
      <img src="https://cdn.example.com/ingredient.png" data-ocr-text="세라마이드 10,000ppm이 피부 장벽을 강화합니다" />
      <img src="https://cdn.example.com/usage.png" data-ocr-text="피부 장벽이 약해진 부위에 세라마이드 크림을 덧발라 주세요" />
    </main>
  </body>
</html>
`;

describe("declared image attribution end-to-end", () => {
  it("attributes each sentence insight to the image the model declared", async () => {
    const { result } = await extractProductFromHtml(relationHtml, "https://example.com/product/1");
    const insights = result.geoProduct.sourceExtraction.ocr.sentenceInsights;

    const barrier = insights.find((item) => item.text.includes("장벽"));
    const usage = insights.find((item) => item.text.includes("도포"));

    expect(barrier?.imageUrl).toBe("https://cdn.example.com/ingredient.png");
    expect(usage?.imageUrl).toBe("https://cdn.example.com/usage.png");
    expect(barrier?.imageUrls).toEqual(["https://cdn.example.com/ingredient.png"]);
  });

  it("keeps a declared sentence on its own image even when another image shares its vocabulary", async () => {
    const { result } = await extractProductFromHtml(overlappingHtml, "https://example.com/product/2");
    const insights = result.geoProduct.sourceExtraction.ocr.sentenceInsights;

    const reapply = insights.find((item) => item.text.includes("덧발라"));

    expect(reapply?.imageUrl).toBe("https://cdn.example.com/usage.png");
  });
});

describe("public artifact image lineage", () => {
  it("exposes imageUrls on imageTexts and semantic fact claims", async () => {
    const { result } = await extractProductFromHtml(relationHtml, "https://example.com/product/1");
    const ocr = result.geoProduct.sourceExtraction.ocr;

    for (const entry of ocr.imageTexts) {
      expect(entry.imageUrls?.length).toBeGreaterThan(0);
    }

    const metricClaims = result.geoProduct.semanticFacts?.metricClaims ?? [];
    const declaredMetric = metricClaims.find((claim) => claim.sentence?.includes("10,000ppm"));
    expect(declaredMetric?.imageUrls).toEqual(["https://cdn.example.com/ingredient.png"]);
  });

  it("exposes per-image transcription confidence on imageTexts", async () => {
    const { result } = await extractProductFromHtml(relationHtml, "https://example.com/product/1");
    for (const entry of result.geoProduct.sourceExtraction.ocr.imageTexts) {
      expect(typeof entry.confidence === "number" || entry.confidence === undefined).toBe(true);
    }
    expect(result.geoProduct.sourceExtraction.ocr.imageTexts.some((entry) => typeof entry.confidence === "number")).toBe(true);
  });
});

describe("relation diagnostics", () => {
  it("records every sentence with its image attribution and counts semantic fact links", async () => {
    const { diagnostics } = await extractProductFromHtml(relationHtml, "https://example.com/product/1");
    const relations = diagnostics.ocr?.relations;

    expect(relations).toBeDefined();
    expect(relations?.sentences.length).toBeGreaterThan(0);
    for (const sentence of relations?.sentences ?? []) {
      expect(sentence.imageUrls.length).toBeGreaterThan(0);
      expect(["declared", "fuzzy", "local"]).toContain(sentence.attribution);
    }
    const counts = relations?.attributionCounts;
    expect((counts?.declared ?? 0) + (counts?.fuzzy ?? 0) + (counts?.local ?? 0)).toBe(relations?.sentences.length);
    expect(relations?.semanticFactLinks.metricClaims.withImage).toBeGreaterThan(0);
  });
});
