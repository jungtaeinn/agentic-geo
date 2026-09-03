import { describe, expect, it } from "vitest";
import { parseImageOcrPayloadText } from "../src/llm/providers/shared";
import { geminiImageOcrResponseSchema, imageOcrJsonSchema } from "../src/llm/schemas";

const URLS = ["https://img.example.com/a.png"];

/**
 * 전사 계약은 이미지의 텍스트와 함께 레이아웃 관계를 싣는다. 여기서 보는 것은
 * 계약의 경계다 — 모델이 보고한 구조 중 무엇을 받아들이고 무엇을 버리는가.
 */
describe("parseImageOcrPayloadText — layout groups", () => {
  it("reads groups, nullable fields, and line roles", () => {
    const raw = JSON.stringify({
      images: [{
        index: 1,
        imageUrl: URLS[0],
        confidence: 0.98,
        text: "효능\n1\n장벽 손상 방어",
        groups: [
          {
            id: "g1", parentId: null, title: "효능", ordinal: null, annotates: null,
            lines: [{ text: "효능", role: "title", pairedLabel: null }]
          },
          {
            id: "g2", parentId: "g1", title: null, ordinal: 1, annotates: null,
            lines: [{ text: "장벽 손상 방어", role: "body", pairedLabel: null }]
          }
        ]
      }]
    });

    const parsed = parseImageOcrPayloadText(raw, URLS);

    expect(parsed.images[0]?.groups).toEqual([
      { id: "g1", title: "효능", lines: [{ text: "효능", role: "title" }] },
      { id: "g2", parentId: "g1", ordinal: 1, lines: [{ text: "장벽 손상 방어", role: "body" }] }
    ]);
  });

  it("keeps a payload without groups usable", () => {
    const raw = JSON.stringify({ images: [{ index: 1, imageUrl: URLS[0], confidence: 0.9, text: "사용법 1 손에 덜어 거품을 냅니다." }] });

    const parsed = parseImageOcrPayloadText(raw, URLS);

    expect(parsed.images[0]?.text).toBe("사용법 1 손에 덜어 거품을 냅니다.");
    expect(parsed.images[0]?.groups).toBeUndefined();
  });

  it("drops a line whose role is not a layout function", () => {
    const raw = JSON.stringify({
      images: [{
        index: 1, imageUrl: URLS[0], confidence: 0.9, text: "효능",
        groups: [{
          id: "g1", parentId: null, title: null, ordinal: null, annotates: null,
          lines: [{ text: "효능", role: "headline", pairedLabel: null }]
        }]
      }]
    });

    expect(parseImageOcrPayloadText(raw, URLS).images[0]?.groups).toEqual([{ id: "g1", lines: [] }]);
  });

  it("keeps a value line's paired label", () => {
    const raw = JSON.stringify({
      images: [{
        index: 1, imageUrl: URLS[0], confidence: 0.9, text: "+84.3%\n사용 4주 후",
        groups: [{
          id: "g1", parentId: null, title: null, ordinal: null, annotates: null,
          lines: [{ text: "+84.3%", role: "value", pairedLabel: "사용 4주 후" }]
        }]
      }]
    });

    expect(parseImageOcrPayloadText(raw, URLS).images[0]?.groups?.[0]?.lines[0]).toEqual({
      text: "+84.3%", role: "value", pairedLabel: "사용 4주 후"
    });
  });

  it("drops a group that reports no id", () => {
    const raw = JSON.stringify({
      images: [{
        index: 1, imageUrl: URLS[0], confidence: 0.9, text: "효능",
        groups: [{ id: "", parentId: null, title: "효능", ordinal: null, annotates: null, lines: [] }]
      }]
    });

    expect(parseImageOcrPayloadText(raw, URLS).images[0]?.groups).toEqual([]);
  });
});

describe("OCR 계약 스키마", () => {
  it("asks every provider for layout groups", () => {
    const properties = imageOcrJsonSchema.properties.images.items.properties as Record<string, unknown>;

    expect(Object.keys(properties)).toContain("groups");
    expect(imageOcrJsonSchema.properties.images.items.required).toContain("groups");
  });

  it("states line roles as the five layout functions", () => {
    const groups = imageOcrJsonSchema.properties.images.items.properties.groups as any;

    expect(groups.items.properties.lines.items.properties.role.enum).toEqual([
      "title", "body", "label", "value", "footnote"
    ]);
  });

  it("keeps the Gemini subset free of nullable unions", () => {
    // Gemini OpenAPI 서브셋은 type 배열을 받지 않는다. nullable 표기로 옮겨야 한다.
    const flatten = (value: unknown): unknown[] =>
      Array.isArray(value)
        ? value.flatMap(flatten)
        : typeof value === "object" && value !== null
          ? [value, ...Object.values(value).flatMap(flatten)]
          : [value];

    const nodes = flatten(geminiImageOcrResponseSchema).filter(
      (node): node is Record<string, unknown> => typeof node === "object" && node !== null && !Array.isArray(node)
    );

    expect(nodes.some((node) => Array.isArray(node.type))).toBe(false);
    expect(nodes.some((node) => node.nullable === true)).toBe(true);
  });
});
