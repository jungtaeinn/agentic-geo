import { afterEach, describe, expect, it, vi } from "vitest";
import { extractProductFromHtml } from "../src";

const IMAGE = "https://assets.example.com/upload/editor/foam-summary.png";
const SOURCE = "https://shop.example.com/web/product/view.do?prdSeq=1145";
const PROVIDER = { provider: "openai" as const, apiKey: "test-key", model: "gpt-test" };

/**
 * 모델이 보고한 레이아웃 관계가 상품 필드 배치까지 이어지는지 본다.
 *
 * 절 제목이 이미 역할을 선언했으므로 본문 어휘로 역할을 다시 추측하지 않는다.
 * 구조가 없는 응답에서는 줄 파서가 같은 일을 하므로 결과가 같아야 한다 —
 * 오늘 동작이 하한선이다.
 */
function ocrOnlyFetchMock(images: unknown[]) {
  return vi.fn(async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const content = body.input?.[0]?.content;
    const hasImage = Array.isArray(content) && content.some((part: { type?: string }) => part.type === "input_image");

    if (hasImage) {
      return new Response(JSON.stringify({ output_text: JSON.stringify({ images }) }), { status: 200 });
    }
    // 분류 호출: 목업 프로바이더처럼 아무 것도 보고하지 않아, 관계 경로만 남긴다.
    return new Response(JSON.stringify({
      output_text: JSON.stringify({ keywords: [], sentenceInsights: [], summary: "no classification" })
    }), { status: 200 });
  });
}

const SUMMARY_TEXT = [
  "효능",
  "1",
  "약산성 아미노산 유래 세정 성분으로",
  "장벽 손상 방어",
  "2",
  "가벼운 메이크업 세정력",
  "핵심 성분",
  "Barrier Protective Formula",
  "(판테놀, 베타인, 보타온)"
].join("\n");

const SUMMARY_GROUPS = [
  { id: "g1", parentId: null, title: "효능", ordinal: null, annotates: null, lines: [{ text: "효능", role: "title", pairedLabel: null }] },
  {
    id: "g2", parentId: "g1", title: null, ordinal: 1, annotates: null,
    lines: [
      { text: "1", role: "label", pairedLabel: null },
      { text: "약산성 아미노산 유래 세정 성분으로", role: "body", pairedLabel: null },
      { text: "장벽 손상 방어", role: "body", pairedLabel: null }
    ]
  },
  {
    id: "g3", parentId: "g1", title: null, ordinal: 2, annotates: null,
    lines: [
      { text: "2", role: "label", pairedLabel: null },
      { text: "가벼운 메이크업 세정력", role: "body", pairedLabel: null }
    ]
  },
  {
    id: "g4", parentId: null, title: "핵심 성분", ordinal: null, annotates: null,
    lines: [
      { text: "핵심 성분", role: "title", pairedLabel: null },
      { text: "Barrier Protective Formula", role: "body", pairedLabel: null },
      { text: "(판테놀, 베타인, 보타온)", role: "body", pairedLabel: null }
    ]
  }
];


const CHART_TEXT = [
  "피부 각질층 내 세라마이드 함량 분석",
  "+63.6%",
  "+84.3%",
  "자사 알칼리 폼",
  "예시더마 클렌징폼",
  "사용 후",
  "사용 2주 후",
  "※In vitro 시험 결과"
].join("\n");

const CHART_GROUPS = [
  {
    id: "g1", parentId: null, title: "피부 각질층 내 세라마이드 함량 분석", ordinal: null, annotates: null,
    lines: [{ text: "피부 각질층 내 세라마이드 함량 분석", role: "title", pairedLabel: null }]
  },
  {
    id: "g2", parentId: "g1", title: null, ordinal: null, annotates: null,
    lines: [
      { text: "+63.6%", role: "value", pairedLabel: "사용 후" },
      { text: "+84.3%", role: "value", pairedLabel: "사용 2주 후" },
      { text: "자사 알칼리 폼", role: "label", pairedLabel: null },
      { text: "예시더마 클렌징폼", role: "label", pairedLabel: null },
      { text: "사용 후", role: "label", pairedLabel: null },
      { text: "사용 2주 후", role: "label", pairedLabel: null }
    ]
  },
  {
    id: "g3", parentId: "g1", title: null, ordinal: null, annotates: "g2",
    lines: [{ text: "※In vitro 시험 결과", role: "footnote", pairedLabel: null }]
  }
];

const html = `<main><h1>예시더마 모이베리어365 클렌징폼</h1><img src="${IMAGE}" /></main>`;

describe("레이아웃 관계가 필드 배치를 이끈다", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("routes a 핵심 성분 group to ingredients", async () => {
    vi.stubGlobal("fetch", ocrOnlyFetchMock([
      { index: 1, imageUrl: IMAGE, confidence: 0.98, text: SUMMARY_TEXT, groups: SUMMARY_GROUPS }
    ]));

    const { result } = await extractProductFromHtml(html, SOURCE, PROVIDER);

    expect(result.geoProduct.ingredients.some((text) => text.includes("판테놀") && text.includes("보타온"))).toBe(true);
    expect(result.geoProduct.benefits.some((text) => text.includes("판테놀"))).toBe(false);
  });

  it("keeps each numbered 효능 item as its own claim", async () => {
    vi.stubGlobal("fetch", ocrOnlyFetchMock([
      { index: 1, imageUrl: IMAGE, confidence: 0.98, text: SUMMARY_TEXT, groups: SUMMARY_GROUPS }
    ]));

    const { result } = await extractProductFromHtml(html, SOURCE, PROVIDER);
    const claims = [...result.geoProduct.benefits, ...result.geoProduct.effects];

    expect(claims).toContain("약산성 아미노산 유래 세정 성분으로 장벽 손상 방어");
    expect(claims).toContain("가벼운 메이크업 세정력");
  });

  it("never publishes a section heading as a value", async () => {
    vi.stubGlobal("fetch", ocrOnlyFetchMock([
      { index: 1, imageUrl: IMAGE, confidence: 0.98, text: SUMMARY_TEXT, groups: SUMMARY_GROUPS }
    ]));

    const { result } = await extractProductFromHtml(html, SOURCE, PROVIDER);
    const values = [
      ...result.geoProduct.benefits,
      ...result.geoProduct.effects,
      ...result.geoProduct.ingredients,
      ...result.geoProduct.usage
    ];

    expect(values).not.toContain("핵심 성분");
    expect(values).not.toContain("효능");
  });

  it("falls back to the line parser when the model reports no groups", async () => {
    vi.stubGlobal("fetch", ocrOnlyFetchMock([
      { index: 1, imageUrl: IMAGE, confidence: 0.98, text: SUMMARY_TEXT }
    ]));

    const { result } = await extractProductFromHtml(html, SOURCE, PROVIDER);
    const claims = [...result.geoProduct.benefits, ...result.geoProduct.effects];

    expect(claims).toContain("약산성 아미노산 유래 세정 성분으로 장벽 손상 방어");
    expect(result.geoProduct.ingredients.some((text) => text.includes("판테놀"))).toBe(true);
  });

  it("falls back when the reported structure is not backed by the transcription", async () => {
    // 전사에 없는 문장으로 채운 구조는 관계가 아니라 환각이다.
    vi.stubGlobal("fetch", ocrOnlyFetchMock([
      {
        index: 1, imageUrl: IMAGE, confidence: 0.98, text: SUMMARY_TEXT,
        groups: [{
          id: "g1", parentId: null, title: "핵심 성분", ordinal: null, annotates: null,
          lines: [
            { text: "휘경보건 피부과에서 검증한 성분", role: "body", pairedLabel: null },
            { text: "존재하지 않는 임상 문장", role: "body", pairedLabel: null }
          ]
        }]
      }
    ]));

    const { result } = await extractProductFromHtml(html, SOURCE, PROVIDER);
    const values = [...result.geoProduct.benefits, ...result.geoProduct.effects, ...result.geoProduct.ingredients];

    expect(values.some((text) => text.includes("휘경보건"))).toBe(false);
    // 폴백이 걸리므로 줄 파서 결과가 그대로 나온다.
    expect(values).toContain("약산성 아미노산 유래 세정 성분으로 장벽 손상 방어");
  });

  it("does not turn a chart's own caption into a claim", async () => {
    // 차트 항목명은 무엇을 재었는지를 가리키는 이름이지 상품의 주장이 아니다.
    // 줄 파서는 이 줄을 본문으로 볼 수밖에 없어 benefit으로 실었다 — 그 줄이
    // 제목이고 나머지가 눈금·값이라는 사실은 레이아웃만 알고 있다.
    vi.stubGlobal("fetch", ocrOnlyFetchMock([
      { index: 1, imageUrl: IMAGE, confidence: 0.98, text: CHART_TEXT, groups: CHART_GROUPS }
    ]));

    const { result } = await extractProductFromHtml(html, SOURCE, PROVIDER);
    const values = [
      ...result.geoProduct.benefits,
      ...result.geoProduct.effects,
      ...result.geoProduct.ingredients,
      ...result.geoProduct.usage
    ];

    expect(values.some((text) => text.includes("세라마이드 함량 분석"))).toBe(false);
    expect(values.some((text) => /63\.6|84\.3/.test(text))).toBe(false);
    expect(values.some((text) => text.includes("자사 알칼리 폼"))).toBe(false);
  });

  it("shows what the line parser cannot know about the same chart", async () => {
    // 대조군. 구조가 없으면 줄 파서는 이 줄을 본문으로 볼 수밖에 없고, "세라마이드"가
    // 들어 있으니 성분으로 발행된다 — 시험 항목명이 상품 성분이 되는 오배치다.
    // 이 차이가 계약 확장이 실제로 사는 지점이다.
    vi.stubGlobal("fetch", ocrOnlyFetchMock([
      { index: 1, imageUrl: IMAGE, confidence: 0.98, text: CHART_TEXT }
    ]));

    const { result } = await extractProductFromHtml(html, SOURCE, PROVIDER);

    expect(result.geoProduct.ingredients).toContain("피부 각질층 내 세라마이드 함량 분석");
  });
});
