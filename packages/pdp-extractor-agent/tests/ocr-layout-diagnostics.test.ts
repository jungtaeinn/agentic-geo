import { afterEach, describe, expect, it, vi } from "vitest";
import { extractImageOcrEvidence } from "../src";

const IMAGE = "https://cdn.example.com/upload/product/1145_1058.png";
const PROVIDER = { provider: "openai" as const, apiKey: "test-key", model: "gpt-test" };

const TEXT = [
  "효능",
  "1",
  "약산성 아미노산 유래 세정 성분으로",
  "장벽 손상 방어"
].join("\n");

const GROUPS = [
  { id: "g1", parentId: null, title: "효능", ordinal: null, annotates: null, lines: [{ text: "효능", role: "title", pairedLabel: null }] },
  {
    id: "g2", parentId: "g1", title: null, ordinal: 1, annotates: null,
    lines: [
      { text: "1", role: "label", pairedLabel: null },
      { text: "약산성 아미노산 유래 세정 성분으로", role: "body", pairedLabel: null },
      { text: "장벽 손상 방어", role: "body", pairedLabel: null }
    ]
  }
];

function ocrFetchMock(images: unknown[]) {
  return vi.fn(async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const content = body.input?.[0]?.content;
    const hasImage = Array.isArray(content) && content.some((part: { type?: string }) => part.type === "input_image");

    if (hasImage) {
      return new Response(JSON.stringify({ output_text: JSON.stringify({ images }) }), { status: 200 });
    }
    return new Response(JSON.stringify({
      output_text: JSON.stringify({ keywords: [], sentenceInsights: [], summary: "" })
    }), { status: 200 });
  });
}

/**
 * 관계가 채택됐는지 폐기됐는지는 실측으로만 알 수 있다. 프로바이더가 슬라이스
 * 마다 구조를 성실히 내는지, 경계 스티칭이 실제로 붙는지는 이 기록을 보고
 * 판단한다 — agent-api는 이 블록을 그대로 저장한다.
 */
describe("OCR 레이아웃 진단", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("records how many groups were reported, kept, and what roles their lines had", async () => {
    vi.stubGlobal("fetch", ocrFetchMock([{ index: 1, imageUrl: IMAGE, confidence: 0.98, text: TEXT, groups: GROUPS }]));

    const result = await extractImageOcrEvidence(
      { source: "agent-api:manual-json", productName: "예시더마 모이베리어365 클렌징폼", imageUrls: [IMAGE] },
      PROVIDER
    );

    expect(result.diagnostics.ocr?.layout).toEqual({
      groupsReported: 2,
      groupsKept: 2,
      lineRoles: { title: 1, body: 2, label: 1, value: 0, footnote: 0 },
      sliceStitches: 0,
      structureDiscarded: []
    });
  });

  it("records the image whose structure the transcription did not back", async () => {
    vi.stubGlobal("fetch", ocrFetchMock([{
      index: 1,
      imageUrl: IMAGE,
      confidence: 0.98,
      text: TEXT,
      groups: [{
        id: "g1", parentId: null, title: null, ordinal: null, annotates: null,
        lines: [
          { text: "존재하지 않는 문장 하나입니다", role: "body", pairedLabel: null },
          { text: "존재하지 않는 문장 둘입니다", role: "body", pairedLabel: null }
        ]
      }]
    }]));

    const result = await extractImageOcrEvidence(
      { source: "agent-api:manual-json", productName: "예시더마 모이베리어365 클렌징폼", imageUrls: [IMAGE] },
      PROVIDER
    );

    expect(result.diagnostics.ocr?.layout?.structureDiscarded).toEqual([
      { imageUrl: IMAGE, reason: "quorum" }
    ]);
    expect(result.diagnostics.ocr?.layout?.groupsKept).toBe(0);
  });

  it("reports no layout block when the provider reported no structure", async () => {
    vi.stubGlobal("fetch", ocrFetchMock([{ index: 1, imageUrl: IMAGE, confidence: 0.98, text: TEXT }]));

    const result = await extractImageOcrEvidence(
      { source: "agent-api:manual-json", productName: "예시더마 모이베리어365 클렌징폼", imageUrls: [IMAGE] },
      PROVIDER
    );

    expect(result.diagnostics.ocr?.layout).toBeUndefined();
  });
});
